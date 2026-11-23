import { describe, it, expect } from "vitest";
import { buildPlans, splitWhole, planNumbers, type PlanCandidate } from "@/services/planBuilder";

const c = (ticker: string, over: Partial<PlanCandidate> = {}): PlanCandidate => ({ ticker, volatility: "medium", currentWeightPercent: null, ...over });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("splitWhole", () => {
  it("always adds up to exactly the whole budget", () => {
    for (const [b, w] of [[5000, [1, 1, 1]], [100, [1, 1, 1]], [7, [3, 2, 2]], [1, [1, 1]], [999, [0.5, 1, 1]]] as const) {
      expect(sum(splitWhole(b, [...w]))).toBe(Math.floor(b));
    }
  });
  it("gives the extra units to the largest remainders", () => expect(splitWhole(100, [1, 1, 1])).toEqual([34, 33, 33]));
  it("follows the weights", () => expect(splitWhole(100, [3, 1])).toEqual([75, 25]));
  it("a fractional budget uses whole units only", () => expect(sum(splitWhole(100.9, [1, 1]))).toBe(100));
  it("gives zeros for no weights, zero weights or no budget", () => {
    expect(splitWhole(100, [])).toEqual([]);
    expect(splitWhole(100, [0, 0])).toEqual([0, 0]);
    expect(splitWhole(0, [1, 1])).toEqual([0, 0]);
  });
});

describe("buildPlans", () => {
  const base = { budget: 5000, minOrder: 500 };

  it("every plan adds up to exactly the budget, and every line meets the minimum", () => {
    const plans = buildPlans({ ...base, candidates: [c("A"), c("B"), c("C"), c("D")] });
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      expect(sum(p.lines.map((l) => l.amount))).toBe(5000);
      for (const l of p.lines) expect(l.amount).toBeGreaterThanOrEqual(500);
      expect(sum(p.lines.map((l) => l.percent))).toBeCloseTo(100, 0);
    }
  });

  it("an even split of three, with the remainder on the first", () => {
    const even = buildPlans({ ...base, candidates: [c("A"), c("B"), c("C")] }).find((p) => p.id === "even")!;
    expect(even.lines.map((l) => [l.ticker, l.amount])).toEqual([["A", 1667], ["B", 1667], ["C", 1666]]);
  });

  it("at most three stocks by default", () => {
    for (const p of buildPlans({ ...base, candidates: ["A", "B", "C", "D", "E"].map((t) => c(t)) })) expect(p.lines.length).toBeLessThanOrEqual(3);
  });

  it("balanced leaves out a stock that is already too big a part of the portfolio, and says so", () => {
    const p = buildPlans({ ...base, candidates: [c("TSLA", { currentWeightPercent: 67 }), c("B"), c("C")] }).find((x) => x.id === "balanced")!;
    expect(p.lines.map((l) => l.ticker)).toEqual(["B", "C"]);
    expect(p.notes.join(" ")).toContain("Leaves out TSLA, already 67%");
  });

  it("balanced puts less into the bumpiest stock", () => {
    const p = buildPlans({ ...base, candidates: [c("A"), c("B", { volatility: "high" })] }).find((x) => x.id === "balanced")!;
    expect(p.lines[0].amount).toBeGreaterThan(p.lines[1].amount);
    expect(p.notes.join(" ")).toContain("B");
  });

  it("drops stocks rather than place an order below the minimum", () => {
    const p = buildPlans({ budget: 1000, minOrder: 400, candidates: [c("A"), c("B"), c("C")] }).find((x) => x.id === "even")!;
    expect(p.lines.map((l) => l.amount)).toEqual([500, 500]);
  });

  it("gives no plan when the budget cannot meet the minimum, or is not a number", () => {
    expect(buildPlans({ budget: 300, minOrder: 500, candidates: [c("A")] })).toEqual([]);
    expect(buildPlans({ budget: NaN, minOrder: 0, candidates: [c("A")] })).toEqual([]);
    expect(buildPlans({ budget: 0, minOrder: 0, candidates: [c("A")] })).toEqual([]);
  });

  it("gives no plan with no candidates", () => expect(buildPlans({ ...base, candidates: [] })).toEqual([]));

  it("does not offer two plans that are the same", () => {
    const plans = buildPlans({ ...base, candidates: [c("A")] });
    expect(plans.map((p) => p.id)).toEqual(["even"]); // balanced and focused would be identical
  });

  it("the same ticker twice counts once", () => {
    const p = buildPlans({ ...base, candidates: [c("A"), c("a"), c("B")] }).find((x) => x.id === "even")!;
    expect(p.lines.map((l) => l.ticker)).toEqual(["A", "B"]);
  });

  it("focused picks the calmest stock that is least held", () => {
    const p = buildPlans({ ...base, candidates: [c("HOT", { volatility: "high" }), c("CALM", { volatility: "low", currentWeightPercent: 30 }), c("NEW", { volatility: "low", currentWeightPercent: 5 })] }).find((x) => x.id === "focused")!;
    expect(p.lines).toEqual([{ ticker: "NEW", amount: 5000, percent: 100 }]);
  });

  it("is deterministic", () => {
    const input = { ...base, candidates: [c("A"), c("B", { volatility: "high" }), c("C")] };
    expect(buildPlans(input)).toEqual(buildPlans(input));
  });

  it("lists every number a plan mentions", () => {
    const plans = buildPlans({ ...base, candidates: [c("A"), c("B")] });
    expect(planNumbers(plans)).toContain(2500);
    expect(planNumbers(plans)).toContain(50);
  });
});
