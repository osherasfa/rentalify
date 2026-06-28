# Rentalify — project guide for Claude

Rental-listings aggregator for Israel. Scrapes Hebrew Facebook rental groups,
uses AI to turn messy posts into structured data, geocodes them, and shows them
as pins on an interactive Hebrew map. Self-maintaining.

- **Live site:** https://osherasfa.github.io/rentalify/
- **Repo:** github.com/osherasfa/rentalify (public, branch `main`)
- **Owner:** Osher · Windows machine (PowerShell + Git-Bash available)

## Architecture — two independent halves
1. **Pipeline** (GitHub Actions, cron 3×/week): `normalize.js` (Apify scrape →
   `claude -p` AI extract → geocode) → `publish.mjs` (accumulate into master DB,
   re-host images to R2, prune >5 months) → commits the results.
2. **Frontend** (`web/`, static → GitHub Pages): MapLibre GL map. Never calls AI —
   it only reads the published JSON.

## Pipeline
- **Scraper:** Apify actor `apify/facebook-groups-scraper` (id `2chN8UQcH1CfxLRNE`).
  Per post it returns `url` (permalink), `time` (ISO date), `id` (the **post** id),
  `facebookId` (the **group** id — NOT the post!), `text`, `attachments`, `user`.
  ⚠️ Use `item.id` (or the id inside the permalink) for the post id — never
  `facebookId`, which collapses every post to the group id. ⚠️ The early 20-item
  `apify example input.json` sample was **stripped** of `url`/`time` — the real
  output has them; trust the real run.
- **AI extraction:** `claude -p` (Claude Code CLI, auto-installed in the workflow),
  Haiku model, subscription auth via `CLAUDE_CODE_OAUTH_TOKEN`. Prompt is
  `extraction-prompt.md`. The instructions are embedded in the prompt (no
  `--system-prompt` flag, which varies by CLI version). Non-Hebrew posts are
  dropped before any AI call (`lib/text.js`).
- **Incremental (watermark):** `state.json` stores `last_posted_at` + `seen_post_ids`
  per source. Each run fetches `onlyPostsNewerThan = last_posted_at − 2 days`
  (overlap; dedup cleans it). First-ever run = `BACKFILL_MONTHS` window. Failed
  extractions are left **un-seen** so they retry next run.
- **Geocoding:** offline gazetteer `geo/il-places.json` (~1,670 towns + ~445
  neighborhoods from GeoNames, with population for search ranking; rebuilt by
  `geo/build-gazetteer.mjs`). `lib/geocode.js` / `lib/text.js`. **Town/neighborhood
  level only** — the AI extracts place *names*, the gazetteer turns them into
  coords. The AI must NOT guess coordinates. Unmatched names are reported in
  `out/unmatched-*.json`.
- **Master DB:** `listings-db.json` accumulates all live listings keyed by id.
  `publish.mjs` merges new ones, prunes listings older than `MAX_AGE_MONTHS` (5),
  and publishes all live → `web/public/listings.json` (+ syncs the gazetteer).
- **Images → Cloudflare R2** (`lib/r2.js`): bucket `rentalify-images`, public base
  `https://pub-6f3616047fef4f4887070a43494479e4.r2.dev`. New listings' photos are
  downloaded from Facebook (links expire) and re-hosted to R2. No-ops to Facebook
  URLs if R2 secrets are absent.
- **Schema:** `rental-listings.schema.json` (v1.1.0), checked by `validate.mjs`.
- `STRIP_CONTACT = false` in `publish.mjs` → phone/name are shown (deliberate;
  privacy tradeoff on a public site).

## Frontend (`web/`, Vite + MapLibre GL)
- **Map:** OpenFreeMap "positron" vector tiles (free, no key); labels patched to
  Hebrew (`name:he`) + RTL text plugin; West Bank relabeled **"יהודה ושומרון"**.
- **Drawing:** Terra Draw + Turf — circles / polygons / rectangles, add/subtract
  modes; overlapping *add* shapes merge (union), *subtract* carves out
  (difference). On-map icon-only panel, bottom-right.
- **Clustering:** Supercluster on the main thread (MapLibre's native
  `getClusterLeaves` silently hangs — do not rely on it). Click a cluster → card
  list.
- **Search box** (top-left): autocompletes from the gazetteer, population-ranked,
  flies there. **GovMap live-address search is wired but dormant** — paste a token
  into `web/src/config.js` to activate; `web/src/govmap.js` handles the SDK +
  proj4 ITM(EPSG:2039)→WGS84.
- **Cards** are minimal; clicking one (or a pin) opens a **detail modal** with an
  image slider, full specs/amenities, clickable phone/WhatsApp, the full original
  post text, and a link to the exact Facebook post (`post_url`).

## Deployment
- `.github/workflows/pipeline.yml` — cron Sun/Tue/Thu 03:00 UTC + manual. Commits
  `out/ state.json listings-db.json web/public/listings.json`.
- `.github/workflows/deploy.yml` — builds `web/` → Pages. Triggers on push to
  `web/**` **and `workflow_run` after the pipeline** ⚠️ (a bot commit using the
  default `GITHUB_TOKEN` can't fire a push event, so the deploy must listen for the
  pipeline completing).
- **GitHub Secrets:** `APIFY_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` (set to the full
  `https://….r2.cloudflarestorage.com` URL — `lib/r2.js` accepts either form).

## Gotchas / open items
- **GovMap** token is pending approval → search stays town-level until pasted into
  `config.js`. GovMap is browser-only (no server API) so it **can't** geocode the
  pipeline's posts; street-level posts would need a REST geocoder (Google/MapTiler).
  GovMap also won't work on `localhost` (token domain-locked to the github.io domain).
- **Cost/limits:** keep AI runs small (incremental) — blasting hundreds of
  `claude -p` calls can hit the subscription rate limit. Apify is pay-per-post
  (~free tier); R2 free tier (5-month prune keeps storage bounded).

## Conventions
- Free / no-key stack where possible. Build forward (no big backfill) to avoid
  Claude rate-limit blocks. Don't let the AI invent coordinates. Verify frontend
  changes in a browser preview; pipeline changes only run in Actions.
- Commit/push only when asked. End commit messages with the Co-Authored-By trailer.
