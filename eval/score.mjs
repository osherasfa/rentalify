/**
 * Pure scoring for the extraction eval. No I/O, no network — so it can be
 * unit-tested (eval/score.test.js) and reused by the runner (run-eval.mjs).
 *
 * Two levels:
 *   1. Classification gate — is_rental_offer as a binary decision across the
 *      whole suite (precision / recall / F1 + confusion matrix). This is the
 *      metric that matters most: a false negative silently drops a real
 *      listing, a false positive puts junk on the map.
 *   2. Field accuracy — for the true positives (gold AND pred agree it's an
 *      offer), compare every field the gold LABELS. Fields absent from the gold
 *      are skipped, so partial labels are fine.
 */
import { normPlace } from "../lib/text.js";

// dot-path -> comparison type. Anything a gold label asserts but isn't listed
// here falls back to strict-equality ("exact").
export const FIELD_TYPES = {
  "listing_kind": "enum",
  "location.city": "text_norm",
  "location.neighborhood": "text_norm",
  "location.street": "text_norm",
  "property.rooms": "numeric",
  "property.size_sqm": "numeric",
  "property.floor": "numeric",
  "property.total_floors": "numeric",
  "property.property_type": "enum",
  "price.amount": "numeric",
  "price.period": "enum",
  "price.currency": "enum",
  "price.includes_arnona": "tristate",
  "price.includes_vaad_bait": "tristate",
  "availability.min_lease_months": "numeric",
  "availability.is_short_term": "tristate",
  "amenities.furnished": "tristate",
  "amenities.air_conditioning": "tristate",
  "amenities.elevator": "tristate",
  "amenities.parking": "tristate",
  "amenities.balcony": "tristate",
  "amenities.safe_room_mamad": "tristate",
  "amenities.storage": "tristate",
  "amenities.renovated": "tristate",
  "amenities.pets_allowed": "tristate",
  "amenities.accessible": "tristate",
  "contact.phone": "phone",
  "contact.contact_name": "text_norm",
  "contact.preferred_method": "enum",
};

const getPath = (obj, path) =>
  path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Flatten an expected object to leaf dot-paths (explicit nulls included, since
// "must be null" is a real assertion — e.g. price.amount when no price is given).
export function leafPaths(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) out.push(...leafPaths(v, path));
    else out.push(path);
  }
  return out;
}

const digits = (v) => (v == null ? "" : String(v).replace(/\D/g, ""));

// Compare one field by its type. Returns true iff predicted matches expected.
export function compareField(type, expected, predicted) {
  const pred = predicted === undefined ? null : predicted;
  switch (type) {
    case "numeric":
      return (expected == null ? null : Number(expected)) === (pred == null ? null : Number(pred));
    case "text_norm":
      return normPlace(expected) === normPlace(pred);
    case "phone":
      return digits(expected) === digits(pred);
    case "tristate":
    case "enum":
    default:
      return expected === pred; // strict: true/false/null are all distinct
  }
}

// Score one example's fields (only the paths the gold asserts). Returns
// [{ path, type, expected, predicted, ok }].
export function scoreFields(expected, predicted) {
  const results = [];
  for (const path of leafPaths(expected)) {
    if (path === "is_rental_offer") continue; // handled by the classification gate
    const type = FIELD_TYPES[path] || "exact";
    const exp = getPath(expected, path);
    const pred = getPath(predicted, path);
    results.push({ path, type, expected: exp, predicted: pred ?? null, ok: compareField(type, exp, pred) });
  }
  return results;
}

// Aggregate a whole suite. `rows` = [{ id, note, expected, predicted }].
export function scoreSuite(rows) {
  const cm = { tp: 0, fp: 0, fn: 0, tn: 0 }; // is_rental_offer confusion matrix
  const fieldResults = [];   // flat list of every scored field across TPs
  const perExample = [];

  for (const { id, note, expected, predicted } of rows) {
    const goldOffer = expected.is_rental_offer === true;
    const predOffer = predicted?.is_rental_offer === true;
    if (goldOffer && predOffer) cm.tp++;
    else if (!goldOffer && predOffer) cm.fp++;
    else if (goldOffer && !predOffer) cm.fn++;
    else cm.tn++;

    // Only score fields when both agree it's an offer — fields are meaningless
    // for a dropped post.
    const fields = goldOffer && predOffer ? scoreFields(expected, predicted) : [];
    for (const f of fields) fieldResults.push({ id, ...f });
    perExample.push({ id, note, goldOffer, predOffer, classOk: goldOffer === predOffer, fields });
  }

  const prec = cm.tp + cm.fp ? cm.tp / (cm.tp + cm.fp) : null;
  const rec = cm.tp + cm.fn ? cm.tp / (cm.tp + cm.fn) : null;
  const f1 = prec != null && rec != null && prec + rec ? (2 * prec * rec) / (prec + rec) : null;
  const total = cm.tp + cm.fp + cm.fn + cm.tn;

  // Per-type and per-field-path accuracy.
  const byType = {};
  const byPath = {};
  for (const f of fieldResults) {
    (byType[f.type] ||= { ok: 0, n: 0 });
    byType[f.type].n++; if (f.ok) byType[f.type].ok++;
    (byPath[f.path] ||= { ok: 0, n: 0 });
    byPath[f.path].n++; if (f.ok) byPath[f.path].ok++;
  }
  const fieldOk = fieldResults.filter((f) => f.ok).length;

  return {
    classification: {
      ...cm,
      accuracy: total ? (cm.tp + cm.tn) / total : null,
      precision: prec, recall: rec, f1,
    },
    fields: {
      total: fieldResults.length,
      correct: fieldOk,
      accuracy: fieldResults.length ? fieldOk / fieldResults.length : null,
      byType, byPath,
    },
    perExample,
  };
}
