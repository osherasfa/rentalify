/**
 * Unit tests for the pipeline's pure helpers — the bits most likely to silently
 * corrupt data if they regress: post-id derivation, AI-value coercion/clamping,
 * Hebrew detection, place-name normalization, and offline geocoding.
 *
 *   node --test     (or: npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { postIdFromUrl, numericPostId, clampNum, clampEnum } from "../normalize.js";
import { hasHebrew, hebrewRatio, normPlace } from "../lib/text.js";
import { geocode } from "../lib/geocode.js";

test("postIdFromUrl pulls the numeric id from permalink/posts URLs", () => {
  assert.equal(postIdFromUrl("https://www.facebook.com/groups/608/permalink/36811611815151206/"), "36811611815151206");
  assert.equal(postIdFromUrl("https://www.facebook.com/groups/608/posts/12345"), "12345");
  assert.equal(postIdFromUrl("https://www.facebook.com/groups/608/"), null);
  assert.equal(postIdFromUrl(null), null);
  assert.equal(postIdFromUrl(undefined), null);
});

test("numericPostId prefers the permalink, then decodes the base64 feedback id", () => {
  // permalink wins over everything else
  assert.equal(numericPostId({ url: "https://x/groups/1/permalink/999/", id: "anything" }), "999");
  // base64 "feedback" id embeds the numeric post id as the trailing number
  const b64 = Buffer.from("S:_I100004357066991:VK:36811611815151206").toString("base64");
  assert.equal(numericPostId({ id: b64 }), "36811611815151206");
  // plain numeric postId fallback
  assert.equal(numericPostId({ postId: 555 }), "555");
  // nothing usable
  assert.equal(numericPostId({}), null);
});

test("clampNum coerces strings, rejects NaN/Infinity, rounds ints, and clamps range", () => {
  assert.equal(clampNum(12), 12);
  assert.equal(clampNum("12"), 12);
  assert.equal(clampNum("12 חודשים"), 12); // leading number parsed out
  assert.equal(clampNum("not a number"), null);
  assert.equal(clampNum(NaN), null);
  assert.equal(clampNum(Infinity), null);
  assert.equal(clampNum(null), null);
  assert.equal(clampNum(2.7, { int: true }), 3); // rounds
  assert.equal(clampNum(-5, { min: 0 }), 0); // clamps to min
  assert.equal(clampNum(2, { max: 1 }), 1); // clamps to max
  assert.equal(clampNum(0.4, { min: 0, max: 1 }), 0.4); // confidence in range
});

test("clampEnum keeps allowed values and falls back otherwise", () => {
  const allowed = ["apartment", "house", null];
  assert.equal(clampEnum("house", allowed, null), "house");
  assert.equal(clampEnum("loft", allowed, null), null); // invented value -> fallback
  assert.equal(clampEnum(null, allowed, null), null); // null is allowed here
  assert.equal(clampEnum("ILS", ["ILS", "USD"], "ILS"), "ILS");
  assert.equal(clampEnum("BTC", ["ILS", "USD"], "ILS"), "ILS");
});

test("hasHebrew / hebrewRatio detect Hebrew letters", () => {
  assert.equal(hasHebrew("דירה להשכרה"), true);
  assert.equal(hasHebrew("apartment for rent"), false);
  assert.equal(hasHebrew(""), false);
  assert.equal(hasHebrew(null), false);
  assert.equal(hebrewRatio("apartment for rent"), 0);
  assert.ok(hebrewRatio("דירה apartment") > 0 && hebrewRatio("דירה apartment") < 1);
});

test("normPlace strips niqqud, quotes, and dashes for forgiving matching", () => {
  assert.equal(normPlace("תל-אביב"), "תל אביב"); // dash -> space
  assert.equal(normPlace('ת"א'), "תא"); // gershayim stripped
  assert.equal(normPlace("  רמת   גן  "), "רמת גן"); // whitespace collapsed
  assert.equal(normPlace(null), "");
});

test("geocode resolves cities, neighborhoods (with parent city), and misses", () => {
  const jeru = geocode("ירושלים", null);
  assert.equal(jeru.source, "city");
  assert.ok(Math.abs(jeru.lat - 31.769) < 0.01);

  // neighborhood given in the neighborhood field -> most specific match + parent city
  const flo = geocode(null, "פלורנטין");
  assert.equal(flo.source, "neighborhood");
  assert.equal(flo.city, "תל אביב");

  const miss = geocode("עיר שלא קיימת בכלל", null);
  assert.deepEqual(miss, { lat: null, lng: null, source: "none", city: null });
});
