/**
 * Seed the extraction gold set from the bundled raw-post sample.
 *
 * Joins verbatim `text` from `apify example input.json` (by index) with the
 * hand-written expected labels below, and writes a self-contained `gold.jsonl`
 * (one {id, note, raw_text, expected} per line). Run once to (re)generate the
 * seed; after that, `gold.jsonl` is the source of truth — edit it directly or
 * append new examples. Re-running OVERWRITES it, so only re-run to reset.
 *
 *   node eval/seed-gold.mjs
 *
 * Labels are PARTIAL: only fields we're confident about are asserted. The
 * scorer ignores any field absent from `expected`, so genuinely ambiguous
 * fields (e.g. a room count that must be inferred) are simply left out rather
 * than baked in as a shaky "correct" answer.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(__dirname, "..", "apify example input.json");

// Each label supplies its post text either by `idx` (into the bundled corpus) or
// inline via `raw_text` (for real production posts that aren't in the sample).
const LABELS = [
  {
    idx: 0,
    note: "LOOKING FOR a room (מחפש להיכנס לדירת שותפים) — must be dropped",
    expected: { is_rental_offer: false },
  },
  {
    idx: 2,
    note: "LOOKING FOR a room to rent (מחפש להשכרה) — must be dropped",
    expected: { is_rental_offer: false },
  },
  {
    idx: 1,
    note: "Room in Givat Shmuel: floor 1/2, no elevator, explicit amenities + negatives",
    expected: {
      is_rental_offer: true,
      listing_kind: "room_in_shared",
      location: { city: "גבעת שמואל" },
      property: { floor: 1, total_floors: 2 },
      price: { amount: 2550, includes_arnona: true },
      amenities: { elevator: false, balcony: true, parking: true, safe_room_mamad: true, furnished: true, pets_allowed: false },
      contact: { phone: "0525622256", contact_name: "דביר" },
    },
  },
  {
    idx: 4,
    note: "Tel Aviv / Old North room, private balcony (near-dup of idx 9). Neighborhood left unlabelled: post names both 'צפון הישן' and 'איזור בזל', both valid.",
    expected: {
      is_rental_offer: true,
      listing_kind: "room_in_shared",
      location: { city: "תל אביב" },
      price: { amount: 2900 },
      amenities: { balcony: true },
    },
  },
  {
    idx: 8,
    note: "Florentin room — city must be INFERRED as Tel Aviv; explicit AC/renovated + no-pets negative",
    expected: {
      is_rental_offer: true,
      listing_kind: "room_in_shared",
      location: { city: "תל אביב", neighborhood: "פלורנטין" },
      price: { amount: 2950 },
      amenities: { air_conditioning: true, renovated: true, pets_allowed: false },
    },
  },
  {
    idx: 5,
    note: "Bat Yam 4-room, floor 29 WITH elevator, furnished, incl arnona+vaad",
    expected: {
      is_rental_offer: true,
      listing_kind: "room_in_shared",
      location: { city: "בת ים" },
      property: { rooms: 4, floor: 29 },
      price: { amount: 3300, includes_arnona: true, includes_vaad_bait: true },
      amenities: { elevator: true, balcony: true, furnished: true },
    },
  },
  {
    idx: 6,
    note: "Tel Aviv / Ibn Gabirol room, floor 1 no elevator, vaad billed SEPARATELY",
    expected: {
      is_rental_offer: true,
      listing_kind: "room_in_shared",
      location: { city: "תל אביב" },
      property: { floor: 1 },
      price: { amount: 3750, includes_vaad_bait: false },
      amenities: { elevator: false, furnished: true },
    },
  },
  {
    idx: 10,
    note: "Herzliya / Galil Yam, 4-room, private parking + sun balcony",
    expected: {
      is_rental_offer: true,
      listing_kind: "room_in_shared",
      location: { city: "הרצליה", neighborhood: "גליל ים" },
      property: { rooms: 4 },
      price: { amount: 3850 },
      amenities: { parking: true, balcony: true },
    },
  },
  {
    idx: 11,
    note: "Sderot 4-room, floor 5 w/ elevator, mamad+AC — NO price stated (amount must be null)",
    expected: {
      is_rental_offer: true,
      listing_kind: "room_in_shared",
      location: { city: "שדרות" },
      property: { rooms: 4, floor: 5 },
      price: { amount: null },
      amenities: { elevator: true, safe_room_mamad: true, air_conditioning: true, balcony: true },
      contact: { phone: "0523595980", contact_name: "אבי" },
    },
  },
  {
    idx: 3,
    note: "Bat Yam room, floor 2 no elevator, all-inclusive price, bilingual HE/RU post",
    expected: {
      is_rental_offer: true,
      listing_kind: "room_in_shared",
      location: { city: "בת ים" },
      price: { includes_arnona: true, includes_vaad_bait: true },
      amenities: { elevator: false, air_conditioning: true, balcony: true },
    },
  },
  {
    // Real production post. Haiku extracted this twice with different results —
    // once catching "ממד בדירה", once missing it — and put "מרכז" in neighborhood,
    // which geocoded to Eilat (~280km off). Locks both: mamad present, and city =
    // הוד השרון with neighborhood null (no real neighborhood named).
    raw_text: "חדר בדירת 2 שותפים במרכז הוד השרון.\n📍מרחק הליכה מהרכבת\n📍קרוב לסופרים בתי קפה וברי יין\n\n✅ממד בדירה\n✅סלון גדול ומרווח מאוד\n✅מרפסת חמודה\n✅מרפסת שירות למכונה ומייבש כביסה\n✅חנייה בשפע מול הבניין\n\n✳️ בדירה יש בעלי חיים🦋\n💵2900₪ ללא חשמל ומים",
    note: "Hod Hasharon room: mamad present but sometimes missed; 'מרכז' must NOT become a neighborhood. (pets_allowed left unlabelled — 'there are pets' implies but doesn't state the policy.)",
    expected: {
      is_rental_offer: true,
      listing_kind: "room_in_shared",
      location: { city: "הוד השרון", neighborhood: null },
      price: { amount: 2900 },
      amenities: { safe_room_mamad: true, balcony: true, parking: true },
    },
  },
  {
    // Real production post kept as an offer (false positive) — a seeker naming
    // three alternative cities, not an offer for one place.
    raw_text: "שלום לכולם\n\nמחפש להשכיר חדר בדירת שותפים בתל אביב, גבעתיים או רמת גן - קרוב למרכז תל אביב.",
    note: "Seeker naming several alternative cities — must be dropped (was a false-positive offer)",
    expected: { is_rental_offer: false },
  },
];

const corpus = JSON.parse(readFileSync(CORPUS, "utf8"));
const lines = LABELS.map(({ idx, raw_text, note, expected }, i) => {
  const text = (raw_text ?? corpus[idx]?.text ?? "").trim();
  if (!text) throw new Error(`label ${i} (idx=${idx}) has no text`);
  return JSON.stringify({ id: `ex${String(i + 1).padStart(2, "0")}`, note, raw_text: text, expected });
});

writeFileSync(join(__dirname, "gold.jsonl"), lines.join("\n") + "\n");
console.log(`wrote ${lines.length} gold examples -> eval/gold.jsonl`);
