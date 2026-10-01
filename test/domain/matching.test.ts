import { describe, it, expect } from "vitest";
import { solve, solveDetailed, spotsFor, assignableFor, component, type Hold } from "../../src/domain/matching";
const M = 60_000, T = 1_000_000 * M;
const slot = (startMin: number, eligible: number[]) => ({ start: T + startMin * M, end: T + (startMin + 40) * M, eligible });
const hold = (id: string, startMin: number, o: Partial<{ fixed: number | null; eligible: number[]; preferred: number | null }>) =>
  ({ id, start: T + startMin * M, end: T + (startMin + 40) * M, fixed: null, eligible: [1, 2], preferred: null, ...o });
describe("capacity examples (slot 10:00 with A=1, B=2)", () => {
  it("no requests → 2", () => expect(spotsFor([], slot(0, [1, 2]))).toBe(2));
  it("one pending → 1", () => expect(spotsFor([hold("p", 0, {})], slot(0, [1, 2]))).toBe(1));
  it("confirmed(A) + pending → 0", () => expect(spotsFor([hold("c", 0, { fixed: 1 }), hold("p", 0, {})], slot(0, [1, 2]))).toBe(0));
  it("B busy at 10:15 elsewhere + pending → 0", () => expect(spotsFor([hold("x", 15, { fixed: 2, eligible: [2] }), hold("p", 0, {})], slot(0, [1, 2]))).toBe(0));
});
it("pending provisional moves to make room", () => {
  // pending P eligible [1,2] currently on 1; new slot only has staff 1 → P must move to 2
  expect(spotsFor([hold("p", 0, { preferred: 1 })], slot(0, [1]))).toBe(1);
  const sol = solve([hold("p", 0, { preferred: 1 }), hold("n", 0, { eligible: [1] })])!;
  expect(sol.get("p")).toBe(2); expect(sol.get("n")).toBe(1);
});
it("overlap across adjacent slots via buffer", () => {
  // 10:00–10:40 occupied and 10:30 slot overlap for same tech
  expect(spotsFor([hold("c", 0, { fixed: 1, eligible: [1] })], slot(30, [1]))).toBe(0);
  expect(spotsFor([hold("c", 0, { fixed: 1, eligible: [1] })], slot(40, [1]))).toBe(1);
});
it("assignableFor excludes techs needed by other pending", () => {
  const holds = [hold("t", 0, {}), hold("q", 0, { eligible: [2] })];
  expect(assignableFor(holds, "t")).toEqual([1]);
});
it("conflicting fixed holds → null", () => expect(solve([hold("a", 0, { fixed: 1 }), hold("b", 10, { fixed: 1 })])).toBeNull());

describe("solve details", () => {
  it("returns an assignment for every hold, fixed ones mapped to their staff", () => {
    const sol = solve([hold("c", 0, { fixed: 2 }), hold("p", 0, {}), hold("far", 600, {})])!;
    expect(sol.get("c")).toBe(2);
    expect(sol.get("p")).toBe(1);
    expect(sol.size).toBe(3);
  });
  it("prefers preferred staff, then ascending ids", () => {
    const sol = solve([hold("a", 0, { eligible: [3, 1, 2], preferred: 2 }), hold("b", 0, { eligible: [3, 1, 2] })])!;
    expect(sol.get("a")).toBe(2);
    expect(sol.get("b")).toBe(1);
  });
  it("flexible hold with no eligible staff is unsolvable", () => {
    expect(solve([hold("a", 0, { eligible: [] })])).toBeNull();
  });
  it("back-to-back (touching) holds do not conflict", () => {
    expect(solve([hold("a", 0, { fixed: 1 }), hold("b", 40, { fixed: 1 })])).not.toBeNull();
  });
  it("unsatisfiable pigeonhole (12 mutually overlapping holds, 11 staff) returns null", () => {
    const staff = Array.from({ length: 11 }, (_, i) => i + 1);
    const holds = Array.from({ length: 12 }, (_, i) => hold(`h${i}`, 0, { eligible: staff }));
    expect(solve(holds)).toBeNull();
  });
});

describe("component", () => {
  it("collects holds transitively overlapping the window, ignoring staff", () => {
    const a = hold("a", 0, { fixed: 1 });   // 0-40
    const b = hold("b", 30, { fixed: 2 });  // 30-70 chains to a
    const c = hold("c", 60, {});            // 60-100 chains to b
    const d = hold("d", 200, {});           // isolated
    const ids = component([d, c, b, a], T, T + 10 * M).map((h) => h.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });
  it("is empty when nothing overlaps the window", () => {
    expect(component([hold("a", 0, {})], T + 40 * M, T + 80 * M)).toEqual([]);
  });
});

describe("component isolation", () => {
  it("unrelated broken holds elsewhere do not affect spotsFor / assignableFor", () => {
    const broken = [hold("x", 600, { fixed: 1 }), hold("y", 610, { fixed: 1 })];
    expect(spotsFor(broken, slot(0, [1, 2]))).toBe(2);
    expect(assignableFor([...broken, hold("t", 0, {})], "t")).toEqual([1, 2]);
  });
});

describe("assignableFor edge cases", () => {
  it("unknown target id → []", () => expect(assignableFor([hold("a", 0, {})], "nope")).toEqual([]));
});

describe("backtracking and symmetry", () => {
  const range = (id: string, startMin: number, endMin: number, eligible: number[]) =>
    ({ id, start: T + startMin * M, end: T + endMin * M, fixed: null, eligible, preferred: null });
  const expectValid = (holds: Hold[], sol: Map<string, number>) => {
    for (const h of holds) expect(h.eligible).toContain(sol.get(h.id));
    for (const a of holds)
      for (const b of holds)
        if (a.id < b.id && a.start < b.end && b.start < a.end) expect(sol.get(a.id)).not.toBe(sol.get(b.id));
  };

  it("backtracks when a greedy choice dead-ends", () => {
    // a (eligible 1,2) is placed first and tries 1, which starves d and e (both 1 or 3, overlapping each other).
    const holds = [range("a", 0, 100, [1, 2]), range("d", 10, 50, [1, 3]), range("e", 20, 60, [1, 3])];
    const sol = solve(holds);
    expect(sol).not.toBeNull();
    expectValid(holds, sol!);
    expect(sol!.get("a")).toBe(2);
  });

  const tenTech = (identical: number) => {
    const others = [1, 3, 4, 5, 6, 7, 8, 9, 10];
    return [hold("a", 0, { eligible: [1, 2] }), ...Array.from({ length: identical }, (_, i) => hold(`i${i}`, 0, { eligible: others }))];
  };

  it("identical holds do not exhaust the node budget (solvable schedule is solved)", () => {
    const holds = tenTech(9);
    const sol = solve(holds);
    expect(sol).not.toBeNull();
    expectValid(holds, sol!);
    expect(sol!.get("a")).toBe(2);
  });
  it("spotsFor counts the remaining spot with many identical holds", () => {
    expect(spotsFor(tenTech(8), slot(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBe(1);
  });
  it("performance guard: 13 identical holds over 12 techs is rejected quickly", () => {
    const staff = Array.from({ length: 12 }, (_, i) => i + 1);
    const twelve = Array.from({ length: 12 }, (_, i) => hold(`h${i}`, 0, { eligible: staff }));
    const started = Date.now();
    expect(solve(twelve)).not.toBeNull();
    expect(solve([...twelve, hold("extra", 0, { eligible: staff })])).toBeNull();
    expect(spotsFor(twelve, slot(0, staff))).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("solveDetailed", () => {
  it("ok with the same assignment as solve", () => {
    const holds = [hold("c", 0, { fixed: 2 }), hold("p", 0, {})];
    const r = solveDetailed(holds);
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.assignment]).toEqual([...solve(holds)!]);
  });
  it("impossible when fixed holds clash or no technician is free", () => {
    expect(solveDetailed([hold("a", 0, { fixed: 1 }), hold("b", 10, { fixed: 1 })])).toEqual({ ok: false, reason: "impossible" });
    expect(solveDetailed([hold("a", 0, { fixed: 1 }), hold("b", 0, { fixed: 2 }), hold("p", 0, {})])).toEqual({ ok: false, reason: "impossible" });
  });
  it("budget_exhausted when the node budget is forced tiny, and solve() maps it to null", () => {
    const holds = [hold("a", 0, {}), hold("b", 0, {})];
    expect(solveDetailed(holds, 1)).toEqual({ ok: false, reason: "budget_exhausted" });
    expect(solveDetailed(holds, 2).ok).toBe(true);
    expect(solveDetailed(holds)).toMatchObject({ ok: true });
  });
  it("only fixed holds need no budget", () => {
    expect(solveDetailed([hold("c", 0, { fixed: 1 })], 0).ok).toBe(true);
  });
});
