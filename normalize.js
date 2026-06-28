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
 *   Each item has { url, time, id, facebookId, text, attachments?, user, ... }:
 *     url        = permalink to the post        time       = ISO publish time
 *     id         = the POST id                  facebookId = the GROUP id (NOT the post!)
 *   post identity is item.id (or the id in the permalink); we fall back to a
 *   hash of (user.id + text) only when those are missing. The watermark advances
 *   from item.time; the onlyPostsNewerThan window + id dedup handle incrementality.
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
const BACKFILL_MONTHS = 3;      // window used only the very first time (no watermark yet)
const OVERLAP_DAYS = 2;         // small re-fetch overlap before the watermark so border posts aren't missed
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
    resultsLimit: 120, // cap per run — generous for a few days of incremental posts
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
function isoMinusDays(iso, n) {
  const d = new Date(iso);
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
const REUSE_MAX_AGE_HOURS = 12; // reuse a recent run's dataset instead of paying to re-scrape

// Apify's .call() ALWAYS starts a new (pay-per-post) scrape, but every run's
// dataset is retained on the platform. So before scraping we look for a recent
// SUCCEEDED run of this actor, for the same group, whose window already reaches
// at least as far back as ours — and reuse its dataset for free if we find one.
async function findReusableRun(source, onlyNewerThanDay) {
  try {
    const { items: runs } = await apify.actor(ACTOR_ID).runs().list({ desc: true, limit: 10 });
    const minFinished = Date.now() - REUSE_MAX_AGE_HOURS * 3600_000;
    for (const r of runs) {
      if (r.status !== "SUCCEEDED" || !r.defaultDatasetId) continue;
      if (new Date(r.finishedAt).getTime() < minFinished) continue;
      const rec = await apify.keyValueStore(r.defaultKeyValueStoreId).getRecord("INPUT");
      const inp = rec?.value;
      if (!inp) continue;
      const sameGroup = (inp.startUrls?.[0]?.url ?? "") === source.source_url;
      // string compare on YYYY-MM-DD: its window must start on/before ours
      const coversWindow = typeof inp.onlyPostsNewerThan === "string" && inp.onlyPostsNewerThan <= onlyNewerThanDay;
      if (sameGroup && coversWindow) return r;
    }
  } catch (e) {
    console.warn(`reuse check failed (${e.message}) — will run the actor`);
  }
  return null;
}

async function fetchPosts(source, onlyNewerThan, forceScrape = false) {
  const onlyNewerThanDay = onlyNewerThan.slice(0, 10); // actor expects YYYY-MM-DD

  const reuse = forceScrape ? null : await findReusableRun(source, onlyNewerThanDay);
  let datasetId;
  if (reuse) {
    console.log(`reusing recent actor run ${reuse.id} (finished ${reuse.finishedAt}) — no new scrape`);
    datasetId = reuse.defaultDatasetId;
  } else {
    const run = await apify.actor(ACTOR_ID).call({
      startUrls: [{ url: source.source_url }],
      resultsLimit: source.resultsLimit ?? 100,
      viewOption: "CHRONOLOGICAL",
      onlyPostsNewerThan: onlyNewerThanDay,
    });
    datasetId = run.defaultDatasetId;
  }

  const { items } = await apify.dataset(datasetId).listItems();
  // A reused run may have a wider window than we need — trim to ours so we don't
  // re-extract older posts. Keep items with no timestamp (can't place them).
  return reuse ? items.filter((it) => !it.time || it.time >= onlyNewerThan) : items;
}

// Pull the numeric post id out of a permalink, e.g.
//   .../groups/608.../permalink/36811611815151206/  ->  "36811611815151206"
//   .../groups/608.../posts/36811611815151206       ->  "36811611815151206"
function postIdFromUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/\/(?:permalink|posts)\/(\d+)/);
  return m ? m[1] : null;
}

// The actor's item.id is Facebook's base64 "feedback" id, e.g.
//   "UzpfST..." -> decoded "S:_I100004357066991:VK:36811611815151206"
// which EMBEDS the numeric post id (the trailing number). Pull that out so the
// id matches the one in the permalink, regardless of which field the actor gives.
function numericPostId(item) {
  const fromUrl = postIdFromUrl(item.url);
  if (fromUrl) return fromUrl;
  if (typeof item.id === "string") {
    let s = item.id;
    try { const d = Buffer.from(item.id, "base64").toString("utf8"); if (/[:_]/.test(d)) s = d; } catch {}
    const nums = s.match(/\d{5,}/g);
    if (nums) return nums[nums.length - 1];
  }
  return item.postId ? String(item.postId) : null;
}

// Map a raw Apify item to the fields we rely on.
// The actor returns a post permalink ("url"), publish time ("time"), the POST id
// ("id", a base64 feedback id) and the GROUP id ("facebookId" — NOT the post).
// post_id is the NUMERIC post id (from the permalink, or extracted from item.id),
// never facebookId (which collapses every post to the group id). We fall back to
// a text hash only if all of those are missing, so partial data still works.
function readRaw(item) {
  const text = item.text ?? "";
  const userId = item.user?.id ?? "";
  const post_id = String(
    numericPostId(item) ??
    createHash("sha1").update(userId + "|" + text).digest("hex").slice(0, 16)
  );

  const attachments = Array.isArray(item.attachments) ? item.attachments : [];
  const images = attachments
    .map((a) => a?.image?.uri ?? a?.thumbnail)
    .filter((u) => typeof u === "string");
  const ocr = attachments
    .map((a) => a?.ocrText)
    .filter((t) => typeof t === "string" && t.trim());

  return {
    post_id,
    post_url: item.url ?? item.postUrl ?? null,   // direct permalink to the post
    author_name: item.user?.name ?? null,
    posted_at: item.time ?? item.date ?? null,    // ISO publish time
    text,
    ocr,                                          // image-burned text, appended to the LLM input
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
  // Manual-run toggles (set as env by the workflow's workflow_dispatch inputs):
  //   BACKFILL=true     -> ignore the watermark + seen ids, pull the full window
  //   FORCE_SCRAPE=true -> always run the actor, never reuse a recent run
  const forcedBackfill = process.env.BACKFILL === "true";
  const forceScrape = process.env.FORCE_SCRAPE === "true";
  const isBackfill = forcedBackfill || Object.keys(state).length === 0;

  const listings = [];
  const sourceStats = [];
  const totals = { posts_fetched: 0, rental_posts_kept: 0, non_rental_filtered_out: 0, duplicates_skipped: 0 };

  for (const source of SOURCES) {
    const key = `${source.platform}:${source.source_id}`;
    // A forced backfill behaves like a first run: ignore the saved watermark + seen ids.
    const prev = (forcedBackfill ? null : state[key]) ?? { last_posted_at: null, seen_post_ids: [] };
    const seen = new Set(prev.seen_post_ids);

    // Window = everything since the newest post we already have (minus a small
    // overlap). First time (no watermark): a one-off backfill.
    const windowFrom = prev.last_posted_at
      ? isoMinusDays(prev.last_posted_at, OVERLAP_DAYS)
      : isoMonthsAgo(BACKFILL_MONTHS);
    const windowTo = new Date().toISOString();

    const items = await fetchPosts(source, windowFrom, forceScrape);

    // Pre-filter cheaply BEFORE any LLM spend: parse raw, advance the watermark
    // from every fetched post's date, drop empty / non-Hebrew / already-seen.
    let dropped = 0, dups = 0, failed = 0;
    let maxPosted = prev.last_posted_at;
    const candidates = [];
    for (const item of items) {
      const raw = readRaw(item);
      if (raw.posted_at && (!maxPosted || raw.posted_at > maxPosted)) maxPosted = raw.posted_at;
      if (!raw.text || !hasHebrew(raw.text)) { dropped++; continue; }
      if (seen.has(raw.post_id)) { dups++; continue; }
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
      if (!extracted) { failed++; return; }        // error -> leave UN-seen so it retries next run
      seen.add(raw.post_id);                        // definitively handled this post
      if (extracted.is_rental_offer !== true) { dropped++; return; }
      listings.push(normalize(raw, source, extracted));
      kept++;
    });
    if (failed) console.warn(`  ${failed} post(s) failed extraction — will retry next run`);

    state[key] = { last_posted_at: maxPosted, seen_post_ids: [...seen] };
    sourceStats.push({
      platform: source.platform,
      source_id: source.source_id,
      source_url: source.source_url ?? null,
      window_from: windowFrom,
      window_to: windowTo,
      watermark_used: prev.last_posted_at,
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
