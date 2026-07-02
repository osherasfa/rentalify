/**
 * Rentalify — publish step (accumulator).
 *
 * The scraper (normalize.js) only emits the posts seen in ONE run. This step
 * maintains the real, growing database and produces the site's data:
 *
 *   1. Load the master store  (listings-db.json) — all live listings, keyed by id.
 *   2. Merge in the newest run's listings. For each NEW listing, download its
 *      Facebook photos (while the links are still valid) and re-host them on
 *      Cloudflare R2, replacing the expiring URLs with permanent ones.
 *   3. Prune: drop listings whose post date is older than MAX_AGE_MONTHS, and
 *      delete those listings' images from R2.
 *   4. Write the master store back, and publish all live listings to
 *      web/public/listings.json (+ sync the gazetteer for the search box).
 *
 * If R2 isn't configured (no secrets), images keep their original Facebook URLs
 * — everything still works, the photos just expire over time.
 *
 *   node publish.mjs
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { r2Enabled, uploadImage, deleteKeys, keyFromUrl } from "./lib/r2.js";
import { geocode } from "./lib/geocode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
const DB_PATH = join(__dirname, "listings-db.json");
const PUBLIC_DIR = join(__dirname, "web", "public");
const DEST = join(PUBLIC_DIR, "listings.json");
const GAZ_SRC = join(__dirname, "geo", "il-places.json");
const GAZ_DEST = join(PUBLIC_DIR, "il-places.json");

const STRIP_CONTACT = true;    // true = drop phone/name from the PUBLIC copy (repo+Pages are public); users reach listers via the original FB post link. listings-db.json keeps contacts.
const MAX_AGE_MONTHS = 5;      // listings older than this are deleted (with their images)
const MAX_IMAGES = 4;          // cap images re-hosted per listing (storage control)

// The LLM sometimes emits English place names; the UI should always show Hebrew.
// Map the ones we've seen (keyed case-insensitively) back to their Hebrew form.
const HE_PLACE = {
  "tel aviv": "תל אביב", "ramat gan": "רמת גן", "bat yam": "בת ים", "jerusalem": "ירושלים",
  "kfar yona": "כפר יונה", "petah tikva": "פתח תקווה", "petach tikva": "פתח תקווה",
  "givat shmuel": "גבעת שמואל", "holon": "חולון", "pardesiya": "פרדסייה", "netanya": "נתניה",
  "ashkelon": "אשקלון", "herzliya": "הרצליה", "rishon lezion": "ראשון לציון", "rishon letzion": "ראשון לציון",
  "beer sheva": "באר שבע", "haifa": "חיפה", "rehovot": "רחובות", "kfar saba": "כפר סבא", "raanana": "רעננה",
  "hod hasharon": "הוד השרון", "ganei tikva": "גני תקווה", "or yehuda": "אור יהודה", "bnei brak": "בני ברק",
  // neighborhoods
  "baka": "בקעה", "beit hakerem": "בית הכרם", "ramat aviv": "רמת אביב", "ramat hahayil": "רמת החייל",
  "old north": "צפון הישן", "sharona": "שרונה", "green herzliya": "הרצליה הירוקה", "afridar": "אפרידר", "merkaz afriddar": "אפרידר",
};
const toHebrew = (s) => (typeof s === "string" && HE_PLACE[s.trim().toLowerCase()]) || s;

function cutoffMs() {
  const d = new Date();
  d.setMonth(d.getMonth() - MAX_AGE_MONTHS);
  return d.getTime();
}
const listingDateMs = (l) => Date.parse(l.source?.posted_at || l.source?.scraped_at || "") || 0;

// Collapse reposts: the same listing re-posted under a different post id (so id
// dedup misses it) shows up as identical post text. Keep one card per distinct
// text — the newest. Listings with no text can't be compared, so keep them all.
// Expects `listings` already sorted newest-first.
function dedupByContent(listings) {
  const seen = new Set();
  const out = [];
  for (const l of listings) {
    const key = (l.source?.raw_text || "").replace(/\s+/g, " ").trim();
    if (key && seen.has(key)) continue; // older repost — drop from the published set
    if (key) seen.add(key);
    out.push(l);
  }
  return out;
}

// Re-host a new listing's photos on R2, replacing the Facebook URLs in place.
async function rehostImages(l) {
  if (!r2Enabled()) return;
  const src = Array.isArray(l.source.images) ? l.source.images.slice(0, MAX_IMAGES) : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (keyFromUrl(src[i])) { out.push(src[i]); continue; } // already on R2
    try {
      const res = await fetch(src[i]);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type") || "image/jpeg";
      const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
      out.push(await uploadImage(buf, `${l.source.post_id}/${i}.${ext}`, ct));
    } catch (e) {
      console.warn(`  image upload failed (${l.id} #${i}): ${e.message}`);
    }
  }
  l.source.images = out;
}

async function main() {
  const runs = existsSync(OUT_DIR)
    ? readdirSync(OUT_DIR).filter((f) => /^listings-\d+\.json$/.test(f)).sort()
    : [];
  // No run files is fine: re-publish the existing DB (e.g. after a gazetteer
  // update). We only need a run file when there are new listings to merge.
  if (!runs.length && !existsSync(DB_PATH)) {
    console.error("nothing to publish: no out/listings-*.json and no listings-db.json.");
    process.exit(1);
  }

  const db = existsSync(DB_PATH) ? JSON.parse(readFileSync(DB_PATH, "utf8")) : { listings: {} };
  db.listings = db.listings || {};

  // 1) merge every run file present into the master DB (idempotent — new ids
  // dedup against what's already stored, re-hosting only new listings' images).
  // In CI a fresh checkout has only the current run's file (older ones are
  // gitignored/not committed), so this merges just that one; locally several may
  // accumulate and merging all of them prevents losing un-published runs.
  let added = 0;
  let lastRun = null;
  for (const runFile of runs) {
    const run = JSON.parse(readFileSync(join(OUT_DIR, runFile), "utf8"));
    lastRun = run;
    for (const l of run.listings || []) {
      if (db.listings[l.id]) continue; // already have it
      await rehostImages(l);
      db.listings[l.id] = l;
      added++;
    }
  }

  // 2) prune listings older than MAX_AGE_MONTHS, deleting their R2 images
  const cutoff = cutoffMs();
  const orphanKeys = [];
  let pruned = 0;
  for (const [id, l] of Object.entries(db.listings)) {
    const t = listingDateMs(l);
    if (t && t < cutoff) {
      for (const url of l.source.images || []) { const k = keyFromUrl(url); if (k) orphanKeys.push(k); }
      delete db.listings[id];
      pruned++;
    }
  }
  if (orphanKeys.length) { try { await deleteKeys(orphanKeys); } catch (e) { console.warn("R2 delete failed:", e.message); } }

  // 2a) normalize English place names to Hebrew so the UI is consistently Hebrew.
  let hebrewized = 0;
  for (const l of Object.values(db.listings)) {
    if (!l.location) continue;
    const c = toHebrew(l.location.city), nb = toHebrew(l.location.neighborhood);
    if (c !== l.location.city) { l.location.city = c; hebrewized++; }
    if (nb !== l.location.neighborhood) l.location.neighborhood = nb;
  }

  // 2b) (re-)geocode against the current gazetteer. Backfills listings that never
  // geocoded (lat/lng baked in as null before a gazetteer entry existed) AND
  // corrects listings whose stored coords no longer match the offline geocoder —
  // e.g. a place text that used to resolve to a since-removed generic entry
  // ("מרכז" -> Eilat, ~280km off). The geocoder is deterministic, so recomputing
  // is self-healing; we only overwrite when it yields a real point (never wipe a
  // good coord back to null).
  let regeocoded = 0;
  for (const l of Object.values(db.listings)) {
    if (!l.location) continue;
    const geo = geocode(l.location.city, l.location.neighborhood);
    if (geo.lat == null) continue;
    const moved = geo.lat !== l.location.lat || geo.lng !== l.location.lng;
    if (!moved && l.location.lat != null) continue;
    l.location.lat = geo.lat;
    l.location.lng = geo.lng;
    if (!l.location.city && geo.city) l.location.city = geo.city;
    l.location.geocode_source = geo.source;
    regeocoded++;
  }

  // 3) write the master store
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

  // 4) publish all live listings (newest first), with reposts collapsed
  const sorted = Object.values(db.listings).sort((a, b) => listingDateMs(b) - listingDateMs(a));
  const listings = dedupByContent(sorted);
  const collapsed = sorted.length - listings.length;
  if (STRIP_CONTACT) {
    for (const l of listings) {
      l.contact = { phone: null, whatsapp: null, contact_name: null, preferred_method: l.contact?.preferred_method ?? null };
      if (l.source) l.source.author_name = null;
    }
  }
  // Prefer the newest run's metadata; when re-publishing with no new run, keep
  // the last published metadata, else synthesize a minimal schema-valid stub.
  let runMeta = lastRun?.run_metadata;
  if (!runMeta && existsSync(DEST)) {
    try { runMeta = JSON.parse(readFileSync(DEST, "utf8")).run_metadata; } catch {}
  }
  if (!runMeta) {
    runMeta = {
      run_id: "republish", schema_version: "1.1.0",
      run_started_at: new Date().toISOString(), is_initial_backfill: false,
      sources: [], totals: { posts_fetched: 0, rental_posts_kept: 0, non_rental_filtered_out: 0, duplicates_skipped: 0 },
    };
  }
  const output = { run_metadata: runMeta, listings };
  mkdirSync(PUBLIC_DIR, { recursive: true });
  writeFileSync(DEST, JSON.stringify(output, null, 2));
  if (existsSync(GAZ_SRC)) copyFileSync(GAZ_SRC, GAZ_DEST);

  console.log(`published ${listings.length} live listings (${collapsed} reposts collapsed; added ${added}, pruned ${pruned}, re-geocoded ${regeocoded}, hebrewized ${hebrewized}) -> web/public/listings.json`);
  console.log(`images: ${r2Enabled() ? "re-hosted on R2" : "kept Facebook URLs (R2 not configured)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
