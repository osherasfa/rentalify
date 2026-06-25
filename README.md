# Rentalify — Rental Listings Aggregator + Map

Scrapes Facebook rental groups via Apify, cleans each post into a normalized
rental-listing JSON using the **Claude Code CLI** (your subscription login — no
per-token API key), geocodes it offline, and serves it on a static **Hebrew map
of Israel** where you draw an area to filter.

Designed to run on a schedule (e.g. 3×/week): the first run backfills ~3 months,
every run after pulls a recent window and dedups.

## Architecture (two independent halves)

| Half | What runs | Where |
|---|---|---|
| **Pipeline** | `normalize.js` + the `claude` CLI → produces `out/listings-*.json`, then `publish.mjs` copies the newest to `web/public/listings.json` | Your machine **or GitHub Actions** (cron) |
| **Frontend** | `web/` — MapLibre GL map (Terra Draw + Turf + Supercluster), reads `listings.json` as a static asset | **GitHub Pages** (static) |

The frontend never calls Claude. It only reads JSON the pipeline already produced.
That's why a static host (Pages) is enough for it.

## Files

| File | What it is |
|---|---|
| `rental-listings.schema.json` | Locked output format (JSON Schema, draft 2020-12), **v1.1.0** (adds `location.lat/lng/geocode_source`). |
| `example-output.json` | Filled sample with 3 listings showing every decision. |
| `extraction-prompt.md` | Instructions that turn one raw post into one structured object. Tune this first on real data. |
| `normalize.js` | Pipeline: Apify fetch → drop non-Hebrew/seen → `claude -p` extract → normalize + geocode → write output + `state.json`. |
| `publish.mjs` | Copies the newest `out/` file to `web/public/listings.json`. |
| `validate.mjs` | Checks any output file against the schema. |
| `lib/text.js`, `lib/geocode.js` | Hebrew detection + offline geocoder (niqqud/dash-aware matching; tries each field as city or neighborhood). |
| `geo/il-places.json` | Offline gazetteer (Hebrew name → lat/lng). **~1,670 town/settlement + ~445 neighborhood keys**, full-country incl. Judea & Samaria, auto-built from GeoNames. |
| `geo/build-gazetteer.mjs` | Rebuilds `geo/il-places.json` from GeoNames `IL.zip` + `PS.zip` dumps (see header for the download commands). Curated neighborhoods are preserved. |
| `web/` | The static frontend (Vite + MapLibre GL). |
| `state.json` | Created on first run. Holds `seen_post_ids` per source (the dedup set). Delete it to force a full backfill. |
| `out/` | One timestamped output file per run, plus `unmatched-*.json` listing place names that didn't geocode (so you can extend the gazetteer). |

## ⚠️ Important: the real actor output has no id / timestamp / post URL

The Apify actor returns items with **only** `{ facebookUrl, text, attachments?, user, likesCount, commentsCount }`.
There is **no** native post id, **no** timestamp, and `facebookUrl` is the **group**
URL (not the post). Consequences, already handled in `normalize.js`:

- **Identity** = `sha1(user.id + text)` (a stable hash), since there's no post id.
- **No time-based watermark.** Incrementality comes from the actor's server-side
  `onlyPostsNewerThan` window + hash dedup (`seen_post_ids`). The first run uses a
  3-month window; later runs use a 7-day window.
- **Images** come from `attachments[].image.uri`; `attachments[].ocrText` (text
  burned into images) is appended to the LLM input.
- **Non-Hebrew posts are dropped** before any LLM spend (`lib/text.js`).

If a fresh live run surfaces fields not in the sample (e.g. timestamps on some
posts), update `readRaw()` in `normalize.js`.

## How extraction is billed

Extraction runs through `claude -p`, using your **Claude Pro/Max subscription**
login — not a pay-per-token API key. If `ANTHROPIC_API_KEY` is set, Claude Code
would bill the API instead; `normalize.js` strips it from the child process.

> This is *your own* low-volume automation, on the acceptable side of Anthropic's
> credential-use policy. When **Rentalify itself** later serves many end-users live,
> that path needs an API key, not your subscription.

## Setup

1. **Node 18+** and **Claude Code** installed.
2. Log Claude Code in:
   ```bash
   claude login          # interactive; confirm with /status that it's the subscription
   ```
   For a **headless server / CI**, generate a long-lived token:
   ```bash
   claude setup-token    # prints a CLAUDE_CODE_OAUTH_TOKEN
   export CLAUDE_CODE_OAUTH_TOKEN="..."
   ```
3. Install deps + set your Apify token:
   ```bash
   npm install
   export APIFY_TOKEN="apify_api_..."
   ```
4. Set the group(s) you want in `SOURCES` inside `normalize.js`.

## Run (pipeline)

```bash
npm start                              # node normalize.js  -> out/listings-*.json
npm run publish                        # copy newest run -> web/public/listings.json
npm run validate web/public/listings.json   # optional schema check
```

First run = ~3-month backfill. After that it's a 7-day incremental window + dedup.

## Run (frontend, locally)

```bash
cd web
npm install
npm run dev        # http://localhost:5173 (or the port shown)
npm run build      # static bundle in web/dist
```

The frontend is built on **MapLibre GL** (the open-source MapboxGL engine) with
**OpenFreeMap** vector tiles (free, no API key) — a detailed, Google-Maps-like
street map. Labels are forced to **Hebrew** (`name:he`) via a style patch, and an
RTL-text plugin shapes them correctly. Covers all of Israel **plus Judea &
Samaria** (the West Bank label is relabeled "יהודה ושומרון"). Tech: `maplibre-gl`,
`terra-draw` (+ its MapLibre adapter), `@turf/*`, `supercluster`.

**Drawing tools** (on-map panel, bottom-right, icon-only): choose a mode — add
(**＋**) or subtract (**−**) — then draw any number of **circles / polygons /
rectangles** with **Terra Draw**. Overlapping *add* shapes are **merged** into one
area; *subtract* shapes are **cut out** (real boolean geometry via Turf.js — union
/ difference). Undo / clear are the ↶ / 🗑 buttons.

**Markers & search**: nearby listings **cluster** into one counted dot
(Supercluster, main-thread — clicking a cluster lists its cards); the **search box**
(top-left) autocompletes Israeli place names from the gazetteer and flies there.
Clicking any dot or card opens a single popup (only one at a time). The sidebar
filters by price / rooms / type / review; listings without a geocoded location are
counted separately and not placed on the map.

> The basemap tiles + the RTL-text plugin load over the network at view time
> (© OpenStreetMap, OpenFreeMap / OpenMapTiles). The geocoding/gazetteer stays
> fully offline — only the map background needs internet. To self-host the tiles
> (no third-party dependency) or guarantee terms, swap `STYLE_URL` in
> `web/src/main.js` for a Protomaps `.pmtiles` file or a keyed provider (MapTiler
> `language=he`).

## Deploy

- **Frontend → GitHub Pages.** `.github/workflows/deploy.yml` builds `web/` and
  deploys to Pages on pushes to `main` that touch `web/**`. Enable Pages in repo
  Settings → Pages → "GitHub Actions".
- **Pipeline → GitHub Actions (cron).** `.github/workflows/pipeline.yml` runs
  Sun/Tue/Thu 03:00 UTC: installs the Claude CLI, runs the pipeline, commits the
  refreshed `web/public/listings.json` (which then triggers the deploy).
  Add two repo **secrets**: `APIFY_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`.

### 🔒 Privacy note
`web/public/listings.json` is served **publicly** on Pages and contains scraped
names and phone numbers. Before going live, decide one of:
- keep the repo/site private or access-controlled, **or**
- strip `contact.*` (and `source.author_name`) from the published copy in
  `publish.mjs`.
