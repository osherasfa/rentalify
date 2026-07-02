/**
 * Extraction eval runner.
 *
 * Runs the pipeline's REAL extraction (normalize.js `extract`) over the gold set
 * (eval/gold.jsonl), scores it (eval/score.mjs), prints a report, and writes
 * eval/last-report.json.
 *
 *   node eval/run-eval.mjs                 # run haiku over the gold set
 *   node eval/run-eval.mjs --model sonnet  # compare a stronger model
 *   node eval/run-eval.mjs --limit 3       # only the first 3 examples
 *   node eval/run-eval.mjs --refresh       # ignore the prediction cache
 *   node eval/run-eval.mjs --no-run        # score cached predictions only (no LLM spend)
 *
 * Predictions are cached in eval/predictions.json keyed by (model + post text),
 * so iterating on the SCORER costs zero tokens — same philosophy as the
 * pipeline's extract-cache. Uses your Claude subscription via `claude -p`, so a
 * full run costs a handful of cheap Haiku calls.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { extract } from "../normalize.js";
import { scoreSuite } from "./score.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLD = join(__dirname, "gold.jsonl");
const PRED_CACHE = join(__dirname, "predictions.json");
const REPORT = join(__dirname, "last-report.json");

// ---------- args ----------
const argv = process.argv.slice(2);
const argVal = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const model = argVal("--model", "haiku");
const limit = Number(argVal("--limit", "0")) || 0;
const refresh = argv.includes("--refresh");
const noRun = argv.includes("--no-run");
const CONCURRENCY = 4;

const pct = (x) => (x == null ? "  –  " : `${(x * 100).toFixed(0)}%`.padStart(4));
const bar = (ok, n) => `${ok}/${n}`.padEnd(7) + ` (${n ? Math.round((ok / n) * 100) : 0}%)`;

async function mapLimit(items, lim, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(lim, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

function loadGold() {
  if (!existsSync(GOLD)) throw new Error("no eval/gold.jsonl — run `node eval/seed-gold.mjs` first");
  const rows = readFileSync(GOLD, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return limit ? rows.slice(0, limit) : rows;
}

const cacheKey = (raw_text) => `${model}:${createHash("sha1").update(raw_text).digest("hex").slice(0, 16)}`;

async function main() {
  const gold = loadGold();
  const cache = existsSync(PRED_CACHE) ? JSON.parse(readFileSync(PRED_CACHE, "utf8")) : {};
  let ran = 0, hits = 0, errs = 0;

  const rows = await mapLimit(gold, CONCURRENCY, async (g) => {
    const key = cacheKey(g.raw_text);
    let predicted = !refresh && cache[key] ? (hits++, cache[key]) : undefined;
    if (predicted === undefined) {
      if (noRun) { errs++; return { ...g, predicted: null }; } // no cached prediction, and --no-run
      try {
        predicted = await extract({ text: g.raw_text, ocr: [] }, { model });
        cache[key] = predicted;
        ran++;
      } catch (e) {
        console.error(`  extract failed for ${g.id}: ${e.message}`);
        errs++; predicted = null;
      }
    }
    return { ...g, predicted };
  });

  if (ran) writeFileSync(PRED_CACHE, JSON.stringify(cache, null, 2));

  const report = scoreSuite(rows);
  printReport(report, { model, n: gold.length, ran, hits, errs });
  writeFileSync(REPORT, JSON.stringify({ model, generatedAt: new Date().toISOString(), ...report }, null, 2));
  console.log(`\nfull report -> eval/last-report.json`);
}

function printReport(r, { model, n, ran, hits, errs }) {
  const c = r.classification;
  console.log(`\nExtraction eval — model: ${model} — ${n} example(s)  (ran ${ran}, cached ${hits}${errs ? `, errors ${errs}` : ""})`);
  console.log(`\nClassification (is_rental_offer)`);
  console.log(`  accuracy ${pct(c.accuracy)}   precision ${pct(c.precision)}   recall ${pct(c.recall)}   F1 ${c.f1 == null ? " – " : c.f1.toFixed(2)}`);
  console.log(`  confusion: TP ${c.tp}  FP ${c.fp}  FN ${c.fn}  TN ${c.tn}`);

  const f = r.fields;
  console.log(`\nField accuracy (over ${c.tp} true-positive offer(s))`);
  console.log(`  overall: ${bar(f.correct, f.total)}`);
  if (Object.keys(f.byType).length) {
    console.log(`  by type:`);
    for (const [t, v] of Object.entries(f.byType).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n)) {
      console.log(`    ${t.padEnd(11)} ${bar(v.ok, v.n)}`);
    }
    // weakest individual fields (those with any miss), worst first
    const weak = Object.entries(f.byPath).filter(([, v]) => v.ok < v.n).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n);
    if (weak.length) {
      console.log(`  weakest fields:`);
      for (const [p, v] of weak) console.log(`    ${p.padEnd(26)} ${bar(v.ok, v.n)}`);
    }
  }

  // Concrete misses so the prompt can be improved.
  const classMiss = r.perExample.filter((e) => !e.classOk);
  if (classMiss.length) {
    console.log(`\nClassification misses:`);
    for (const e of classMiss) console.log(`  ${e.id}  gold offer=${e.goldOffer} pred offer=${e.predOffer}  — ${e.note}`);
  }
  const fieldMiss = r.perExample.flatMap((e) => e.fields.filter((x) => !x.ok).map((x) => ({ id: e.id, ...x })));
  if (fieldMiss.length) {
    console.log(`\nField misses (gold ≠ predicted):`);
    for (const m of fieldMiss) console.log(`  ${m.id}  ${m.path.padEnd(26)} expected ${JSON.stringify(m.expected)}  got ${JSON.stringify(m.predicted)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
