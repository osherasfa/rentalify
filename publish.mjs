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

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
const DB_PATH = join(__dirname, "listings-db.json");
const PUBLIC_DIR = join(__dirname, "web", "public");
const DEST = join(PUBLIC_DIR, "listings.json");
const GAZ_SRC = join(__dirname, "geo", "il-places.json");
const GAZ_DEST = join(PUBLIC_DIR, "il-places.json");

const STRIP_CONTACT = false;   // false = show phone/name (you chose this)
const MAX_AGE_MONTHS = 5;      // listings older than this are deleted (with their images)
const MAX_IMAGES = 4;          // cap images re-hosted per listing (storage control)

function cutoffMs() {
  const d = new Date();
  d.setMonth(d.getMonth() - MAX_AGE_MONTHS);
  return d.getTime();
}
const listingDateMs = (l) => Date.parse(l.source?.posted_at || l.source?.scraped_at || "") || 0;

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
  if (!existsSync(OUT_DIR)) { console.error("no out/ directory — run normalize.js first."); process.exit(1); }
  const runs = readdirSync(OUT_DIR).filter((f) => /^listings-\d+\.json$/.test(f)).sort();
  if (!runs.length) { console.error("no listings-*.json in out/."); process.exit(1); }

  const db = existsSync(DB_PATH) ? JSON.parse(readFileSync(DB_PATH, "utf8")) : { listings: {} };
  db.listings = db.listings || {};

  // 1) merge the newest run's listings + re-host their images. The master DB is
  // the source of truth, so we only consume the latest run file — older run files
  // are already merged (and are gitignored/disposable). New ids dedup against the DB.
  const latestRun = runs[runs.length - 1];
  const run = JSON.parse(readFileSync(join(OUT_DIR, latestRun), "utf8"));
  let added = 0;
  for (const l of run.listings || []) {
    if (db.listings[l.id]) continue; // already have it
    await rehostImages(l);
    db.listings[l.id] = l;
    added++;
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

  // 3) write the master store
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

  // 4) publish all live listings
  const listings = Object.values(db.listings).sort((a, b) => listingDateMs(b) - listingDateMs(a));
  if (STRIP_CONTACT) {
    for (const l of listings) {
      l.contact = { phone: null, whatsapp: null, contact_name: null, preferred_method: l.contact?.preferred_method ?? null };
      if (l.source) l.source.author_name = null;
    }
  }
  const output = { run_metadata: run.run_metadata, listings };
  mkdirSync(PUBLIC_DIR, { recursive: true });
  writeFileSync(DEST, JSON.stringify(output, null, 2));
  if (existsSync(GAZ_SRC)) copyFileSync(GAZ_SRC, GAZ_DEST);

  console.log(`published ${listings.length} live listings (added ${added}, pruned ${pruned}) -> web/public/listings.json`);
  console.log(`images: ${r2Enabled() ? "re-hosted on R2" : "kept Facebook URLs (R2 not configured)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
