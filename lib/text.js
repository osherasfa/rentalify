/**
 * Small text helpers shared by the pipeline.
 */

// Hebrew block + Hebrew presentation forms.
const HEBREW_RE = /[֐-׿יִ-ﭏ]/g;

/** True if the string contains at least one Hebrew letter. */
export function hasHebrew(s) {
  if (!s) return false;
  return HEBREW_RE.test(s);
}

/**
 * Fraction of letters that are Hebrew (0..1). Punctuation/digits/emoji ignored.
 * Use this if "has any Hebrew" is too loose and English posts slip through.
 */
export function hebrewRatio(s) {
  if (!s) return 0;
  const letters = (s.match(/[A-Za-z֐-׿יִ-ﭏ]/g) || []).length;
  if (!letters) return 0;
  const heb = (s.match(/[֐-׿יִ-ﭏ]/g) || []).length;
  return heb / letters;
}

/** Normalize a place name for gazetteer lookup (used on both keys and queries). */
export function normPlace(s) {
  if (!s) return "";
  return s
    .replace(/[֑-ׇ]/g, "")   // strip niqqud / cantillation marks
    .replace(/["'`׳״]/g, "")            // strip quotes / geresh / gershayim
    .replace(/[־\-–—_]/g, " ")     // maqaf + hyphens/dashes -> space
    .replace(/\s+/g, " ")
    .trim();
}
