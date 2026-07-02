# Extraction eval

Measures how well the pipeline's LLM step (`extraction-prompt.md` + `claude -p`)
turns a raw Hebrew Facebook post into the locked listing schema. The cache and
`listings-db.json` are the model's *own* output, so they can't grade it — this
harness scores the model against an **independent, hand-labelled gold set**.

## Files

| File | What it is |
|---|---|
| `gold.jsonl` | Source of truth. One `{id, note, raw_text, expected}` per line. **Labels are partial** — assert only fields you're sure of; unlabelled fields are skipped. |
| `seed-gold.mjs` | Regenerates `gold.jsonl` from the bundled `apify example input.json` sample. Run once to seed / reset; after that edit `gold.jsonl` (or this file) directly. |
| `score.mjs` | Pure scoring: classification confusion matrix + typed field comparison. No I/O. |
| `score.test.js` | Unit tests for the scorer (`node --test eval/score.test.js`). |
| `run-eval.mjs` | Runs the real `extract()` over the gold set, scores, prints a report, writes `last-report.json`. |
| `predictions.json` | Per-(model + post) prediction cache, so re-scoring costs no tokens. Gitignored. |
| `last-report.json` | Full machine-readable results of the last run. Gitignored. |

## Run

```bash
node eval/run-eval.mjs                 # run haiku (the pipeline's model) over the gold set
node eval/run-eval.mjs --model sonnet  # compare a stronger model on the same gold
node eval/run-eval.mjs --no-run        # re-score cached predictions only (0 tokens)
node eval/run-eval.mjs --refresh       # ignore cache, re-extract everything
node eval/run-eval.mjs --limit 3       # first 3 examples only
node --test eval/score.test.js         # scorer unit tests
```

Extraction uses your Claude subscription via `claude -p` (same as the pipeline),
so a full run is a handful of cheap Haiku calls.

## Reading the report

- **Classification (`is_rental_offer`)** — the gate that decides keep vs. drop.
  Recall matters most (a false negative silently loses a real listing); precision
  keeps junk off the map. Reported as a confusion matrix + precision/recall/F1.
- **Field accuracy** — scored only on true positives (gold *and* prediction agree
  it's an offer). Broken down by type so you can see *what kind* of field is weak:
  - `numeric` price/rooms/floor — exact match (null-aware: "no price" ≠ 0)
  - `text_norm` city/neighborhood/street — matched after stripping niqqud/quotes/
    dashes/case (so "תל-אביב" == "תל אביב"), but **Hebrew ≠ English** ("Tel Aviv"
    counts as wrong — the UI is Hebrew-only)
  - `enum` listing_kind/property_type — exact
  - `tristate` amenities + includes_* — `true`/`false`/`null` are all distinct, so
    "said no elevator" (false) ≠ "didn't mention it" (null)
  - `phone` — digits only
- **Misses** are printed concretely (`expected X got Y`) so you can decide whether
  to fix the **prompt**, the **gold label**, or accept the disagreement.

## Adding / fixing gold examples

Append a line to `gold.jsonl`:

```json
{"id":"ex11","note":"why this one is interesting","raw_text":"…the raw post…","expected":{"is_rental_offer":true,"location":{"city":"חיפה"},"price":{"amount":4200}}}
```

Only include fields you're confident about. Good examples to add: tricky cities,
ambiguous "sublet with contract" posts, English/Russian bilingual posts, posts
with prices in ranges, and any real post the pipeline got wrong in production
(copy its `source.raw_text` from `listings-db.json`).

## Loop

`run-eval` → look at the misses → change `extraction-prompt.md` (or a gold label)
→ `run-eval --refresh` → confirm the number moved. The first run of this harness
found Haiku returning **English** place names ("Tel Aviv" instead of "תל אביב"),
which is why the prompt now pins location output to Hebrew.
