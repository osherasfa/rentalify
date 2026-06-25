/**
 * Rentalify — publish step.
 * Builds the static frontend's data from the newest pipeline run:
 *   - web/public/listings.json   (latest run, with contact info stripped for the
 *                                  public site — see STRIP_CONTACT below)
 *   - web/public/il-places.json  (gazetteer, for the location search box)
 *
 * Run after `node normalize.js`:  node publish.mjs
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
const PUBLIC_DIR = join(__dirname, "web", "public");
const DEST = join(PUBLIC_DIR, "listings.json");
const GAZ_SRC = join(__dirname, "geo", "il-places.json");
const GAZ_DEST = join(PUBLIC_DIR, "il-places.json");

// The published copy is served PUBLICLY on GitHub Pages. Scraped phone numbers
// and names should not be exposed there. Set to false only if the site is private.
const STRIP_CONTACT = true;

if (!existsSync(OUT_DIR)) {
  console.error("no out/ directory — run `node normalize.js` first.");
  process.exit(1);
}

const files = readdirSync(OUT_DIR)
  .filter((f) => /^listings-\d+\.json$/.test(f))
  .sort();

if (!files.length) {
  console.error("no listings-*.json in out/ — nothing to publish.");
  process.exit(1);
}

const newest = files[files.length - 1];
const data = JSON.parse(readFileSync(join(OUT_DIR, newest), "utf8"));

if (STRIP_CONTACT) {
  for (const l of data.listings ?? []) {
    l.contact = { phone: null, whatsapp: null, contact_name: null, preferred_method: l.contact?.preferred_method ?? null };
    if (l.source) l.source.author_name = null;
  }
}

mkdirSync(PUBLIC_DIR, { recursive: true });
writeFileSync(DEST, JSON.stringify(data, null, 2));
if (existsSync(GAZ_SRC)) copyFileSync(GAZ_SRC, GAZ_DEST);

const n = data.listings?.length ?? 0;
console.log(`published ${newest} -> web/public/listings.json (${n} listings${STRIP_CONTACT ? ", contact stripped" : ""})`);
console.log(`synced gazetteer -> web/public/il-places.json`);
