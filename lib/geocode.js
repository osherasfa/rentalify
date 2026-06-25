/**
 * Offline geocoder: Hebrew city / neighborhood text -> { lat, lng, source }.
 *
 * No network. Backed by geo/il-places.json (a bundled gazetteer of one point
 * per place). Resolution order: neighborhood (most specific) -> city -> none.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normPlace } from "./text.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAZ_PATH = join(__dirname, "..", "geo", "il-places.json");

const gaz = JSON.parse(readFileSync(GAZ_PATH, "utf8"));

// Pre-normalize keys once for forgiving matching.
const cityIndex = new Map();
for (const [name, c] of Object.entries(gaz.cities)) {
  cityIndex.set(normPlace(name), c);
}
const hoodIndex = new Map();
for (const [name, h] of Object.entries(gaz.neighborhoods)) {
  const key = normPlace(name);
  if (!hoodIndex.has(key)) hoodIndex.set(key, []);
  hoodIndex.get(key).push(h);
}

/** Strip a leading Hebrew "ב"/"ה" prefix as a fallback (e.g. "בהדר" -> "הדר"). */
function stripPrefix(key) {
  return key.startsWith("ב") || key.startsWith("ה") ? key.slice(1) : key;
}

function lookupCity(cityText) {
  if (!cityText) return null;
  const key = normPlace(cityText);
  return cityIndex.get(key) || cityIndex.get(stripPrefix(key)) || null;
}

function lookupHood(hoodText, cityText) {
  if (!hoodText) return null;
  const key = normPlace(hoodText);
  let candidates = hoodIndex.get(key) || hoodIndex.get(stripPrefix(key));
  if (!candidates || !candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  // Multiple cities share this neighborhood name — disambiguate by city if given.
  const cityKey = normPlace(cityText || "");
  const match = candidates.find((c) => normPlace(c.city) === cityKey);
  return match || candidates[0];
}

/**
 * @returns {{lat:number,lng:number,source:"neighborhood"|"city"}|{lat:null,lng:null,source:"none"}}
 */
export function geocode(cityText, hoodText) {
  // Most specific first: a real neighborhood match.
  const h = lookupHood(hoodText, cityText);
  if (h) return { lat: h.lat, lng: h.lng, source: "neighborhood" };
  // A city/town match from the city field.
  const c = lookupCity(cityText);
  if (c) return { lat: c.lat, lng: c.lng, source: "city" };
  // Fallbacks — the LLM may have put the place in the "other" field:
  // a town name sitting in the neighborhood field...
  const c2 = lookupCity(hoodText);
  if (c2) return { lat: c2.lat, lng: c2.lng, source: "city" };
  // ...or a quarter name sitting in the city field.
  const h2 = lookupHood(cityText, null);
  if (h2) return { lat: h2.lat, lng: h2.lng, source: "neighborhood" };
  return { lat: null, lng: null, source: "none" };
}
