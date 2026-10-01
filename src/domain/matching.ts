// Technician matching: decides whether holds (pending requests with a flexible
// technician, confirmed appointments / proposal options with a fixed one) can be
// assigned so that no technician has two time-overlapping holds.

export interface Hold {
  id: string;
  /** Occupied range in epoch ms (buffers included), half-open [start, end). */
  start: number;
  end: number;
  /** Confirmed / option technician; null for a pending request. */
  fixed: number | null;
  /** Candidate technicians, used when `fixed` is null. */
  eligible: number[];
  /** Tried first when assigning a flexible hold. */
  preferred: number | null;
}

const NODE_BUDGET = 200_000;

export type SolveResult =
  | { ok: true; assignment: Map<string, number> }
  | { ok: false; reason: "impossible" | "budget_exhausted" };

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean =>
  a.start < b.end && b.start < a.end;

/** Assigns every hold a technician, or returns null if impossible (or the search budget runs out). */
export function solve(holds: Hold[]): Map<string, number> | null {
  const result = solveDetailed(holds);
  return result.ok ? result.assignment : null;
}

/** Like `solve`, but says why it failed: provably `impossible`, or the search `budget` of nodes ran out. */
export function solveDetailed(holds: Hold[], budget: number = NODE_BUDGET): SolveResult {
  const assignment = new Map<string, number>();
  const placed: { hold: Hold; staff: number }[] = [];

  for (const h of holds) {
    if (h.fixed === null) continue;
    for (const p of placed) {
      if (p.staff === h.fixed && overlaps(p.hold, h)) return { ok: false, reason: "impossible" };
    }
    placed.push({ hold: h, staff: h.fixed });
    assignment.set(h.id, h.fixed);
  }

  // Interchangeable holds (same range, same eligible set, same effective preferred) share a group key
  // and a candidate order. They are sorted consecutively and may only take strictly increasing
  // candidate indices, which removes the n! permutations of identical holds without changing feasibility.
  const info = new Map<Hold, { candidates: number[]; group: string }>();
  for (const h of holds) {
    if (h.fixed !== null) continue;
    const eligible = [...new Set(h.eligible)].sort((a, b) => a - b);
    const preferred = h.preferred !== null && eligible.includes(h.preferred) ? h.preferred : null;
    const candidates = preferred === null ? eligible : [preferred, ...eligible.filter((s) => s !== preferred)];
    info.set(h, { candidates, group: `${h.start}|${h.end}|${eligible.join(",")}|${preferred}` });
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const flexible = [...info.keys()].sort(
    (a, b) =>
      a.eligible.length - b.eligible.length ||
      a.start - b.start ||
      cmp(info.get(a)!.group, info.get(b)!.group) ||
      cmp(a.id, b.id),
  );

  let nodes = 0;
  const chosen: number[] = [];
  const place = (i: number): boolean => {
    if (i === flexible.length) return true;
    const h = flexible[i]!;
    const { candidates, group } = info.get(h)!;
    const first = i > 0 && info.get(flexible[i - 1]!)!.group === group ? chosen[i - 1]! + 1 : 0;
    for (let c = first; c < candidates.length; c++) {
      const staff = candidates[c]!;
      if (++nodes > budget) return false;
      if (placed.some((p) => p.staff === staff && overlaps(p.hold, h))) continue;
      placed.push({ hold: h, staff });
      assignment.set(h.id, staff);
      chosen[i] = c;
      if (place(i + 1)) return true;
      placed.pop();
      assignment.delete(h.id);
      if (nodes > budget) return false;
    }
    return false;
  };

  if (place(0)) return { ok: true, assignment };
  return { ok: false, reason: nodes > budget ? "budget_exhausted" : "impossible" };
}

/** Holds transitively overlapping [start, end), by time only (staff ignored). */
export function component(holds: Hold[], start: number, end: number): Hold[] {
  const inSet = new Set<Hold>();
  const queue: { start: number; end: number }[] = [{ start, end }];
  while (queue.length > 0) {
    const range = queue.pop()!;
    for (const h of holds) {
      if (!inSet.has(h) && overlaps(h, range)) {
        inSet.add(h);
        queue.push(h);
      }
    }
  }
  return holds.filter((h) => inSet.has(h));
}

/** How many more bookings fit in the slot: largest k such that k flexible holds can be added. */
export function spotsFor(existing: Hold[], slot: { start: number; end: number; eligible: number[] }): number {
  let spots = 0;
  for (let k = 0; k <= slot.eligible.length; k++) {
    const synthetic: Hold[] = Array.from({ length: k }, (_, i) => ({
      id: `__new${i}`,
      start: slot.start,
      end: slot.end,
      fixed: null,
      eligible: slot.eligible,
      preferred: null,
    }));
    if (solve(component([...existing, ...synthetic], slot.start, slot.end)) === null) break;
    spots = k;
  }
  return spots;
}

/** Technicians the target hold could be fixed to while everything else stays assignable. */
export function assignableFor(existing: Hold[], targetId: string): number[] {
  const target = existing.find((h) => h.id === targetId);
  if (!target) return [];
  return [...new Set(target.eligible)]
    .sort((a, b) => a - b)
    .filter((staff) => {
      const holds = existing.map((h) => (h.id === targetId ? { ...h, fixed: staff } : h));
      return solve(component(holds, target.start, target.end)) !== null;
    });
}
