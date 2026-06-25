/**
 * Build geo/il-places.json from GeoNames dumps — full-country coverage
 * (every Israeli city / town / settlement, incl. Judea & Samaria).
 *
 * Get the source data (free, no key):
 *   curl -sL https://download.geonames.org/export/dump/IL.zip -o IL.zip
 *   curl -sL https://download.geonames.org/export/dump/PS.zip -o PS.zip   # West Bank settlements
 *   # unzip both, then point this script at the folder holding IL/IL.txt + PS/PS.txt
 *
 * Usage:  node geo/build-gazetteer.mjs [srcDir]   (srcDir default: ".tmp")
 *
 * Output keys are Hebrew place names, normalised (niqqud/dashes stripped) the
 * same way lib/geocode.js normalises queries, so post text matches.
 * Curated neighborhoods (with parent city) are preserved and take precedence.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normPlace } from "../lib/text.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || join(__dirname, "..", ".tmp");
const OUT = join(__dirname, "il-places.json");
const HEB = /[֐-׿]/;

// Live populated-place codes go to "cities"; PPLX (city quarter/section) -> "neighborhoods".
// Skip abandoned/destroyed/historical so old depopulated names don't shadow modern ones.
const SKIP = new Set(["PPLQ", "PPLW", "PPLH"]);

function loadRows(file) {
  if (!existsSync(file)) { console.error("missing:", file); process.exit(1); }
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
}

function hebKeys(r) {
  const cands = [r[1], r[2], ...(r[3] ? r[3].split(",") : [])];
  const keys = new Set();
  for (const c of cands) {
    if (!HEB.test(c)) continue;
    const k = normPlace(c);
    if (k && HEB.test(k)) keys.add(k);
  }
  return [...keys];
}

const rows = [...loadRows(join(SRC, "IL", "IL.txt")), ...loadRows(join(SRC, "PS", "PS.txt"))];

const cities = {};
const neighborhoods = {};
let placed = 0;

for (const r of rows) {
  if (r[6] !== "P") continue;            // populated places only
  const code = r[7];
  if (SKIP.has(code)) continue;
  const keys = hebKeys(r);
  if (!keys.length) continue;
  const lat = +(+r[4]).toFixed(5), lng = +(+r[5]).toFixed(5);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  const pop = parseInt(r[14], 10) || 0;   // population — used for search ranking
  const target = code === "PPLX" ? neighborhoods : cities;
  let added = false;
  for (const k of keys) {
    if (!(k in target)) { target[k] = code === "PPLX" ? { lat, lng, city: null, pop } : { lat, lng, pop }; added = true; }
  }
  if (added) placed++;
}

// Preserve curated entries (better coords/aliases + neighborhood parents).
if (existsSync(OUT)) {
  const cur = JSON.parse(readFileSync(OUT, "utf8"));
  for (const [name, c] of Object.entries(cur.cities || {})) if (!(normPlace(name) in cities)) cities[normPlace(name)] = c;
  for (const [name, h] of Object.entries(cur.neighborhoods || {})) neighborhoods[normPlace(name)] = h; // curated wins (has city parent)
}

const out = {
  _comment: `Auto-built from GeoNames (IL + PS) by geo/build-gazetteer.mjs. ${Object.keys(cities).length} city/town/settlement keys, ${Object.keys(neighborhoods).length} neighborhood keys. Hebrew name -> {lat,lng}. Re-run after refreshing the GeoNames dumps.`,
  cities,
  neighborhoods,
};
writeFileSync(OUT, JSON.stringify(out, null, 0));
console.log(`placed ${placed} places -> ${Object.keys(cities).length} city keys, ${Object.keys(neighborhoods).length} neighborhood keys`);
console.log(`wrote ${OUT}`);
