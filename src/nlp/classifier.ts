// ============================================
// A very small text classifier, written from scratch
//
// Multinomial Naive Bayes over words, word pairs and CHARACTER n-grams. The character
// n-grams are what make it forgiving: "nvdia", "wats my stuf worth" and "teslaa" still
// share most of their n-grams with the phrases it was trained on.
//
// It runs locally, trains in milliseconds from a list of example phrases, makes no
// network call and needs no dependency. It is deterministic: the same text always gets
// the same answer. It is deliberately not clever. It is for understanding everyday
// requests cheaply, so the big model is kept for real analysis.
//
// It says how sure it is (`confidence`, and `margin` over the runner-up) so the caller can
// refuse to act on a guess. The "other" label exists so that messages which are not about
// this topic are recognised as such.
// ============================================

export interface Example {
  label: string;
  text: string;
}

export interface Prediction {
  label: string;
  /** Probability of the best label, 0 to 1. */
  confidence: number;
  /** How far ahead of the second best it is, 0 to 1. */
  margin: number;
}

export interface Classifier {
  classify(text: string): Prediction | null;
  labels: string[];
}

/** Lower case, accents and punctuation removed, spaces collapsed. */
export function normalise(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%$\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words, word pairs, and 3 and 4 character pieces of each padded word. */
export function features(text: string): string[] {
  const words = normalise(text).split(" ").filter(Boolean);
  const out: string[] = [];
  words.forEach((w, i) => {
    out.push(`w:${w}`);
    if (i > 0) out.push(`b:${words[i - 1]}_${w}`);
    const padded = `^${w}$`;
    for (const n of [3, 4]) for (let j = 0; j + n <= padded.length; j++) out.push(`c:${padded.slice(j, j + n)}`);
  });
  return out;
}

export function trainClassifier(examples: Example[], options: { alpha?: number } = {}): Classifier {
  const alpha = options.alpha ?? 0.4;
  const labels = [...new Set(examples.map((e) => e.label))];
  const counts = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  const vocab = new Set<string>();
  for (const l of labels) {
    counts.set(l, new Map());
    totals.set(l, 0);
  }
  for (const e of examples) {
    const c = counts.get(e.label)!;
    for (const f of features(e.text)) {
      c.set(f, (c.get(f) ?? 0) + 1);
      totals.set(e.label, totals.get(e.label)! + 1);
      vocab.add(f);
    }
  }
  const V = vocab.size;

  return {
    labels,
    classify(text) {
      const feats = features(text);
      if (feats.length === 0 || labels.length < 2) return null;
      // Equal priors: a label is not favoured for having more examples.
      const scores = labels.map((l) => {
        const c = counts.get(l)!;
        const denom = totals.get(l)! + alpha * V;
        let s = 0;
        for (const f of feats) s += Math.log(((c.get(f) ?? 0) + alpha) / denom);
        return s;
      });
      const max = Math.max(...scores);
      const exps = scores.map((s) => Math.exp(s - max));
      const sum = exps.reduce((a, b) => a + b, 0);
      const probs = exps.map((e) => e / sum);
      const order = probs.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p);
      return { label: labels[order[0].i], confidence: order[0].p, margin: order[0].p - order[1].p };
    },
  };
}
