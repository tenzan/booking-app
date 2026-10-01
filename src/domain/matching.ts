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

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean =>
  a.start < b.end && b.start < a.end;

/** Assigns every hold a technician, or returns null if impossible (or the search budget runs out). */
export function solve(holds: Hold[]): Map<string, number> | null {
  const assignment = new Map<string, number>();
  const placed: { hold: Hold; staff: number }[] = [];

  for (const h of holds) {
    if (h.fixed === null) continue;
    for (const p of placed) {
      if (p.staff === h.fixed && overlaps(p.hold, h)) return null;
    }
    placed.push({ hold: h, staff: h.fixed });
    assignment.set(h.id, h.fixed);
  }

  const flexible = holds
    .filter((h) => h.fixed === null)
    .sort((a, b) => a.eligible.length - b.eligible.length || a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const candidates = flexible.map((h) => {
    const rest = [...new Set(h.eligible)].filter((s) => s !== h.preferred).sort((a, b) => a - b);
    return h.preferred !== null && h.eligible.includes(h.preferred) ? [h.preferred, ...rest] : rest;
  });

  let nodes = 0;
  const place = (i: number): boolean => {
    if (i === flexible.length) return true;
    const h = flexible[i]!;
    for (const staff of candidates[i]!) {
      if (++nodes > NODE_BUDGET) return false;
      if (placed.some((p) => p.staff === staff && overlaps(p.hold, h))) continue;
      placed.push({ hold: h, staff });
      assignment.set(h.id, staff);
      if (place(i + 1)) return true;
      placed.pop();
      assignment.delete(h.id);
      if (nodes > NODE_BUDGET) return false;
    }
    return false;
  };

  return place(0) ? assignment : null;
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
