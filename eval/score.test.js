/**
 * Unit tests for the eval scorer — the comparison logic that decides whether an
 * extracted field counts as "correct". Getting this wrong would make every eval
 * number meaningless, so it's tested independently of any LLM call.
 *
 *   node --test eval/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareField, leafPaths, scoreFields, scoreSuite } from "./score.mjs";

test("compareField: numeric is null-aware and coerces strings", () => {
  assert.equal(compareField("numeric", 2550, 2550), true);
  assert.equal(compareField("numeric", 2550, "2550"), true);
  assert.equal(compareField("numeric", null, null), true);
  assert.equal(compareField("numeric", null, 0), false); // "no price" ≠ "0"
  assert.equal(compareField("numeric", 4, 5), false);
});

test("compareField: text_norm ignores niqqud/quotes/dashes/case", () => {
  assert.equal(compareField("text_norm", "תל אביב", "תל-אביב"), true);
  assert.equal(compareField("text_norm", 'ממ"ד', "ממד"), true);
  assert.equal(compareField("text_norm", "תל אביב", "בת ים"), false);
});

test("compareField: tristate keeps false and null distinct", () => {
  assert.equal(compareField("tristate", false, false), true);
  assert.equal(compareField("tristate", false, null), false); // said "no elevator" but model left it null
  assert.equal(compareField("tristate", true, true), true);
  assert.equal(compareField("tristate", null, false), false);
});

test("compareField: phone compares digits only", () => {
  assert.equal(compareField("phone", "0525622256", "052-562-2256"), true);
  assert.equal(compareField("phone", "0525622256", "0525622257"), false);
});

test("leafPaths flattens nested objects but keeps explicit nulls as leaves", () => {
  const paths = leafPaths({ is_rental_offer: true, price: { amount: null, includes_arnona: true } });
  assert.deepEqual(paths.sort(), ["is_rental_offer", "price.amount", "price.includes_arnona"].sort());
});

test("scoreFields only scores labelled paths and skips the classification gate", () => {
  const expected = { is_rental_offer: true, location: { city: "בת ים" }, price: { amount: 2900 } };
  const predicted = { is_rental_offer: true, location: { city: "בת ים", neighborhood: "לא נבדק" }, price: { amount: 3000 } };
  const res = scoreFields(expected, predicted);
  assert.equal(res.length, 2); // city + amount only (is_rental_offer excluded, neighborhood not labelled)
  assert.equal(res.find((r) => r.path === "location.city").ok, true);
  assert.equal(res.find((r) => r.path === "price.amount").ok, false);
});

test("scoreSuite computes the classification confusion matrix + F1", () => {
  const rows = [
    { id: "a", expected: { is_rental_offer: true }, predicted: { is_rental_offer: true } },   // TP
    { id: "b", expected: { is_rental_offer: false }, predicted: { is_rental_offer: false } }, // TN
    { id: "c", expected: { is_rental_offer: true }, predicted: { is_rental_offer: false } },  // FN
  ];
  const r = scoreSuite(rows);
  assert.equal(r.classification.tp, 1);
  assert.equal(r.classification.tn, 1);
  assert.equal(r.classification.fn, 1);
  assert.equal(r.classification.recall, 0.5);
  assert.equal(r.classification.precision, 1);
});

test("scoreSuite scores fields only on true positives", () => {
  const rows = [
    // gold offer but predicted dropped -> a false negative, fields NOT scored
    { id: "a", expected: { is_rental_offer: true, price: { amount: 100 } }, predicted: { is_rental_offer: false } },
    // both agree offer -> field scored
    { id: "b", expected: { is_rental_offer: true, price: { amount: 100 } }, predicted: { is_rental_offer: true, price: { amount: 100 } } },
  ];
  const r = scoreSuite(rows);
  assert.equal(r.fields.total, 1);
  assert.equal(r.fields.correct, 1);
});
