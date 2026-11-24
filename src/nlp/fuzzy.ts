// ============================================
// Typo-tolerant matching
//
// Edit distance that counts a swap of two neighbouring letters as one mistake ("nvdia" is one away
// from "nvida"), and a helper to find the closest word in a vocabulary. Used to understand a
// misspelled company name without any model.
// ============================================

/** Optimal string alignment distance: insert, delete, substitute or swap two neighbours, each costing 1. */
export function editDistance(a: string, b: string, limit = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** How many mistakes a word of this length may have and still count as the same word. Short words get none. */
export const allowedMistakes = (length: number): number => (length < 4 ? 0 : length <= 5 ? 1 : 2);

export interface Closest {
  word: string;
  distance: number;
}

/** The vocabulary words within the allowed number of mistakes of `word`, closest first. */
export function closeWords(word: string, vocabulary: Iterable<string>): Closest[] {
  const w = word.toLowerCase();
  const allowed = allowedMistakes(w.length);
  const out: Closest[] = [];
  for (const v of vocabulary) {
    if (v.length < 4 && v !== w) continue;
    const dist = editDistance(w, v, allowed);
    // Different first letters are rarely a typo of the same name, so they must be an exact-ish match.
    if (dist <= allowed && (w[0] === v[0] || dist <= Math.max(0, allowed - 1))) out.push({ word: v, distance: dist });
  }
  return out.sort((a, b) => a.distance - b.distance || a.word.localeCompare(b.word));
}
