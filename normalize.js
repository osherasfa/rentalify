/**
 * Rentalify — rental listings pipeline
 * ------------------------------------------------------------------
 * Runs on a schedule. First run = ~3-month backfill, later runs pull a short
 * recent window and dedup against what's already been seen.
 *
 * Extraction is done by shelling out to the Claude Code CLI (`claude -p`),
 * which uses your Claude subscription login — NOT a pay-per-token API key.
 *
 * Flow per source:
 *   1. Read seen post-hashes from state.json
 *   2. Build Apify input (onlyPostsNewerThan = lookback window, or -3 months on first run)
 *   3. Run the actor, fetch raw items
 *   4. Drop non-Hebrew posts and already-seen posts (dedup) BEFORE spending any LLM call
 *   5. Send each survivor to `claude -p` with the extraction instructions
 *   6. Drop non-offers; normalize + geocode the rest into the locked schema
 *   7. Write the output JSON + update state.json (new seen hashes)
 *
 * The output validates against rental-listings.schema.json (v1.1.0).
 *
 * IMPORTANT about the actor output shape:
 *   The real actor returns items with ONLY { facebookUrl, text, attachments?, user, likesCount, commentsCount }.
 *   There is NO native post id, NO timestamp, and NO per-post URL (facebookUrl is the GROUP url).
 *   So: post identity is a hash of (user.id + text); there is no time-based watermark —
 *   incrementality comes from the actor's onlyPostsNewerThan window + hash dedup.
 *
 * Prerequisites:
 *   - Node 18+
 *   - Apify token in env:  APIFY_TOKEN
 *   - Claude Code installed and logged in (`claude login`), or a
 *     CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` for a headless server / CI.
 *   - Do NOT set ANTHROPIC_API_KEY — if set, Claude Code bills the API instead of
 *     your subscription. This script strips it from the child process to be safe.
 */

import { ApifyClient } from "apify-client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { hasHebrew } from "./lib/text.js";
import { geocode } from "./lib/geocode.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const ACTOR_ID = "2chN8UQcH1CfxLRNE";
const MODEL = "haiku";          // CLI alias; cheap + good enough for per-post extraction
const BACKFILL_MONTHS = 3;      // first run window
const LOOKBACK_DAYS = 7;        // routine-run window (re-scraped each time; dedup cleans overlap)
const CONCURRENCY = 4;          // parallel `claude -p` processes
const SCHEMA_VERSION = "1.1.0";

// Paths anchored to this file so cron can run from anywhere safely.
const PROMPT_PATH = join(__dirname, "extraction-prompt.md");
const STATE_PATH = join(__dirname, "state.json");
const OUT_DIR = join(__dirname, "out");

// Add more groups here over time — the rest of the pipeline is group-agnostic.
const SOURCES = [
  {
    platform: "facebook_group",
    source_id: "608325962573249",
    source_url: "https://www.facebook.com/groups/608325962573249",
    resultsLimit: 5, // TEST RUN — tiny on purpose. Bump back up (e.g. 1000) after the first run works.
  },
];

const apify = new ApifyClient({ token: process.env.APIFY_TOKEN });
const PROMPT = readFileSync(PROMPT_PATH, "utf8");

// ---------- state helpers ----------
function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}
function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function isoMonthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString();
}
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ---------- concurrency ----------
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- Apify ----------
async function fetchPosts(source, onlyNewerThan) {
  const input = {
    startUrls: [{ url: source.source_url }],
    resultsLimit: source.resultsLimit ?? 100,
    viewOption: "CHRONOLOGICAL",
    onlyPostsNewerThan: onlyNewerThan.slice(0, 10), // actor expects YYYY-MM-DD
  };
  const run = await apify.actor(ACTOR_ID).call(input);
  const { items } = await apify.dataset(run.defaultDatasetId).listItems();
  return items;
}

// Map a raw Apify item to the fields we rely on.
// The actor gives no post id / timestamp / post url, so we synthesize a stable
// id by hashing user id + text, and capture images from attachments[].image.uri.
function readRaw(item) {
  const text = item.text ?? "";
  const userId = item.user?.id ?? "";
  const post_id = createHash("sha1").update(userId + "|" + text).digest("hex").slice(0, 16);

  const attachments = Array.isArray(item.attachments) ? item.attachments : [];
  const images = attachments
    .map((a) => a?.image?.uri ?? a?.thumbnail)
    .filter((u) => typeof u === "string");
  const ocr = attachments
    .map((a) => a?.ocrText)
    .filter((t) => typeof t === "string" && t.trim());

  return {
    post_id,
    post_url: null,                       // actor only exposes the group url
    author_name: item.user?.name ?? null,
    posted_at: null,                      // not provided by the actor
    text,
    ocr,                                  // image-burned text, appended to the LLM input
    images,
  };
}

// ---------- LLM extraction via Claude Code CLI ----------
async function extract(raw) {
  // Strip ANTHROPIC_API_KEY so Claude Code uses your subscription (OAuth) login
  // and never silently bills the API.
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;

  // We embed the extraction instructions directly in the prompt rather than
  // relying on a --system-prompt flag whose name varies across CLI versions.
  // `-p` is already one-shot (no agentic looping), so this is robust everywhere.
  const ocrBlock = raw.ocr.length ? `\n\nטקסט מתוך התמונות (OCR):\n${raw.ocr.join("\n")}` : "";
  const fullPrompt = `${PROMPT}\n\n---\nPOST:\n${raw.text}${ocrBlock}\n---\nReturn ONLY the JSON object.`;

  const args = ["-p", fullPrompt, "--model", MODEL, "--output-format", "text"];

  const { stdout } = await execFileAsync("claude", args, {
    env: childEnv,
    maxBuffer: 8 * 1024 * 1024,
  });

  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`no JSON in CLI output: ${stdout.slice(0, 200)}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

// ---------- normalization ----------
const DEFAULTS = {
  location: { city: null, neighborhood: null, street: null, raw_location_text: null, lat: null, lng: null, geocode_source: null },
  property: { rooms: null, size_sqm: null, floor: null, total_floors: null, property_type: null },
  price: { amount: null, currency: "ILS", period: "month", includes_arnona: null, includes_vaad_bait: null, raw_price_text: null },
  amenities: { furnished: null, air_conditioning: null, elevator: null, parking: null, balcony: null, safe_room_mamad: null, storage: null, renovated: null, pets_allowed: null, accessible: null },
  availability: { available_from: null, min_lease_months: null, is_short_term: null },
  contact: { phone: null, whatsapp: null, contact_name: null, preferred_method: null },
};

// Distinct place texts that failed to geocode this run (text -> count).
const UNMATCHED = new Map();

function collectMissing(obj, prefix, acc) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null) acc.push(`${prefix}.${k}`);
  }
}

function normalize(raw, source, extracted) {
  const id = `${source.platform}:${source.source_id}:${raw.post_id}`;

  const location = { ...DEFAULTS.location, ...(extracted.location ?? {}) };
  const property = { ...DEFAULTS.property, ...(extracted.property ?? {}) };
  const price = { ...DEFAULTS.price, ...(extracted.price ?? {}) };
  const amenities = { ...DEFAULTS.amenities, ...(extracted.amenities ?? {}) };
  const availability = { ...DEFAULTS.availability, ...(extracted.availability ?? {}) };
  const contact = { ...DEFAULTS.contact, ...(extracted.contact ?? {}) };

  // Geocode from the structured place fields (offline gazetteer).
  const geo = geocode(location.city, location.neighborhood);
  location.lat = geo.lat;
  location.lng = geo.lng;
  location.geocode_source = geo.source;

  // Track place texts we couldn't geocode, so the gazetteer can be extended.
  if (geo.source === "none" && (location.city || location.neighborhood)) {
    const key = [location.city, location.neighborhood].filter(Boolean).join(" / ");
    UNMATCHED.set(key, (UNMATCHED.get(key) ?? 0) + 1);
  }

  const missing = [];
  collectMissing(location, "location", missing);
  collectMissing(property, "property", missing);
  collectMissing(price, "price", missing);
  collectMissing(amenities, "amenities", missing);
  collectMissing(availability, "availability", missing);
  collectMissing(contact, "contact", missing);

  return {
    id,
    source: {
      platform: source.platform,
      source_id: source.source_id,
      post_id: raw.post_id,
      post_url: raw.post_url,
      author_name: raw.author_name,
      posted_at: raw.posted_at,
      scraped_at: new Date().toISOString(),
      raw_text: raw.text,
      images: raw.images,
    },
    classification: {
      is_rental_offer: true,
      listing_kind: extracted.listing_kind ?? "apartment_rent",
      confidence: extracted.confidence ?? null,
    },
    location,
    property,
    price,
    amenities,
    availability,
    contact,
    extraction: {
      schema_version: SCHEMA_VERSION,
      missing_fields: missing,
      needs_review: extracted.needs_review ?? false,
    },
  };
}

// ---------- main ----------
async function main() {
  const state = loadState();
  const isBackfill = Object.keys(state).length === 0;

  const listings = [];
  const sourceStats = [];
  const totals = { posts_fetched: 0, rental_posts_kept: 0, non_rental_filtered_out: 0, duplicates_skipped: 0 };

  for (const source of SOURCES) {
    const key = `${source.platform}:${source.source_id}`;
    const prev = state[key] ?? { seen_post_ids: [] };
    const seen = new Set(prev.seen_post_ids);

    const windowFrom = isBackfill ? isoMonthsAgo(BACKFILL_MONTHS) : isoDaysAgo(LOOKBACK_DAYS);
    const windowTo = new Date().toISOString();

    const items = await fetchPosts(source, windowFrom);

    // Pre-filter cheaply BEFORE any LLM spend: parse raw, drop empty / non-Hebrew / seen.
    let dropped = 0, dups = 0;
    const candidates = [];
    for (const item of items) {
      const raw = readRaw(item);
      if (!raw.text || !hasHebrew(raw.text)) { dropped++; continue; }
      if (seen.has(raw.post_id)) { dups++; continue; }
      seen.add(raw.post_id); // mark seen now so we never re-spend on it, kept or not
      candidates.push(raw);
    }

    // Extract in parallel (bounded).
    const extractedAll = await mapLimit(candidates, CONCURRENCY, async (raw) => {
      try {
        return await extract(raw);
      } catch (e) {
        console.error(`extract failed for ${raw.post_id}:`, e.message);
        return null;
      }
    });

    let kept = 0;
    candidates.forEach((raw, idx) => {
      const extracted = extractedAll[idx];
      if (!extracted) { dropped++; return; }       // extraction error -> treat as filtered
      if (extracted.is_rental_offer !== true) { dropped++; return; }
      listings.push(normalize(raw, source, extracted));
      kept++;
    });

    state[key] = { seen_post_ids: [...seen] };
    sourceStats.push({
      platform: source.platform,
      source_id: source.source_id,
      source_url: source.source_url ?? null,
      window_from: windowFrom,
      window_to: windowTo,
      watermark_used: null,
      posts_fetched: items.length,
      rental_posts_kept: kept,
      non_rental_filtered_out: dropped,
      duplicates_skipped: dups,
    });
    totals.posts_fetched += items.length;
    totals.rental_posts_kept += kept;
    totals.non_rental_filtered_out += dropped;
    totals.duplicates_skipped += dups;
  }

  const output = {
    run_metadata: {
      run_id: randomUUID(),
      schema_version: SCHEMA_VERSION,
      run_started_at: new Date().toISOString(),
      run_finished_at: new Date().toISOString(),
      is_initial_backfill: isBackfill,
      sources: sourceStats,
      totals,
    },
    listings,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, `listings-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  saveState(state);
  console.log(`done. kept ${totals.rental_posts_kept} listings -> ${outFile}`);

  // Report place names that didn't geocode, so geo/il-places.json can grow.
  if (UNMATCHED.size) {
    const sorted = [...UNMATCHED.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\n${UNMATCHED.size} place name(s) did not geocode — add the real ones to geo/il-places.json:`);
    for (const [k, n] of sorted.slice(0, 30)) console.log(`  ${n}×  ${k}`);
    const unmatchedFile = join(OUT_DIR, `unmatched-${Date.now()}.json`);
    writeFileSync(unmatchedFile, JSON.stringify(sorted.map(([place, count]) => ({ place, count })), null, 2));
    console.log(`  full list -> ${unmatchedFile}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
