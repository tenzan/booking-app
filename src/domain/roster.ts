// Roster impact engine: given the holds that exist and the PROPOSED schedule, decides which pending requests
// move to another technician, which holds become conflicts, and who could take over each conflict.
// Eligibility of an existing hold is judged from the hold's own data (its slot start and stored occupied range),
// so changing duration/buffers/step never invalidates an existing appointment.

import { component, solveDetailed, type Hold } from "./matching";
import { windowStaffAt, type SlotInput } from "./slots";

export interface RosterHold {
  id: string;
  kind: "reservation" | "option";
  status: "pending" | "confirmed" | "option";
  ref: string;
  slotStart: number;
  /** Stored occupied range (buffers included), half-open [occStart, occEnd). */
  occStart: number;
  occEnd: number;
  /** Current technician: fixed for confirmed/option, provisional for pending (may be null). */
  staffId: number | null;
}
export interface RosterInput {
  holds: RosterHold[];
  /** Slot input under the PROPOSED roster/schedule. */
  slotInput: SlotInput;
}
export type ConflictReason = "tech_removed" | "slot_removed" | "no_capacity" | "too_complex";
export interface RosterConflict {
  id: string;
  kind: RosterHold["kind"];
  status: RosterHold["status"];
  ref: string;
  slotStart: number;
  staffId: number | null;
  reason: ConflictReason;
  alternatives: number[];
}
export interface RosterImpact {
  moved: Array<{ id: string; ref: string; from: number | null; to: number }>;
  conflicts: RosterConflict[];
  /** Final technician for every non-conflicting hold. */
  assignment: Map<string, number>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byStartThenId = (a: RosterHold, b: RosterHold) => a.slotStart - b.slotStart || cmp(a.id, b.id);

/**
 * `budget` is the matching search budget per solve (defaults to the matching module's); tests lower it to
 * exercise `too_complex`.
 */
export function rosterImpact(input: RosterInput, budget?: number): RosterImpact {
  const { slotInput } = input;
  const holds = [...input.holds].sort(byStartThenId);

  /** window staff at the hold's slot start, and those of them free of time off over the hold's own range. */
  const eligibility = (h: RosterHold): { windowStaff: number[]; candidates: number[] } => {
    const windowStaff = windowStaffAt(slotInput, h.slotStart);
    const candidates = windowStaff.filter(
      (id) => !slotInput.unavailability.some((u) => u.staffId === id && u.startAt < h.occEnd && h.occStart < u.endAt),
    );
    return { windowStaff, candidates };
  };
  const toHold = (h: RosterHold, o: Partial<Hold>): Hold => ({
    id: h.id, start: h.occStart, end: h.occEnd, fixed: null, eligible: [], preferred: null, ...o,
  });

  const conflicts: Array<{ hold: RosterHold; reason: ConflictReason }> = [];
  const solid: Hold[] = []; // valid fixed holds, then accepted pendings
  const fixedConflicts: RosterHold[] = [];
  const pendings: RosterHold[] = [];

  for (const h of holds) {
    if (h.status === "pending") {
      pendings.push(h);
      continue;
    }
    const { windowStaff, candidates } = eligibility(h);
    if (windowStaff.length === 0) conflicts.push({ hold: h, reason: "slot_removed" });
    else if (h.staffId === null || !candidates.includes(h.staffId)) conflicts.push({ hold: h, reason: "tech_removed" });
    else {
      solid.push(toHold(h, { fixed: h.staffId }));
      continue;
    }
    fixedConflicts.push(h);
  }

  const accepted: RosterHold[] = [];
  for (const h of pendings) {
    const { windowStaff, candidates } = eligibility(h);
    if (candidates.length === 0) {
      conflicts.push({ hold: h, reason: windowStaff.length === 0 ? "slot_removed" : "no_capacity" });
      continue;
    }
    const added = toHold(h, { eligible: candidates, preferred: h.staffId });
    const trial = solveDetailed(component([...solid, added], h.occStart, h.occEnd), budget);
    if (!trial.ok) {
      conflicts.push({ hold: h, reason: trial.reason === "budget_exhausted" ? "too_complex" : "no_capacity" });
      continue;
    }
    solid.push(added);
    accepted.push(h);
  }

  // Final staff: solve each time-connected group of holds on its own.
  const assignment = new Map<string, number>();
  const remaining = new Set(solid);
  for (const seed of solid) {
    if (!remaining.has(seed)) continue;
    const group = component(solid, seed.start, seed.end);
    for (const g of group) remaining.delete(g);
    const result = solveDetailed(group, budget);
    if (result.ok) {
      for (const [id, staff] of result.assignment) assignment.set(id, staff);
    } else {
      // Only reachable when the stored fixed holds already clash with each other; keep them where they are.
      for (const g of group) if (g.fixed !== null) assignment.set(g.id, g.fixed);
    }
  }

  const moved = accepted
    .filter((h) => assignment.get(h.id) !== h.staffId)
    .map((h) => ({ id: h.id, ref: h.ref, from: h.staffId, to: assignment.get(h.id)! }));

  const alternativesFor = (h: RosterHold): number[] => {
    const { candidates } = eligibility(h);
    return candidates.filter((staff) => {
      const trial = solveDetailed(component([...solid, toHold(h, { fixed: staff })], h.occStart, h.occEnd), budget);
      return trial.ok;
    });
  };
  const fixedSet = new Set(fixedConflicts);

  return {
    moved,
    conflicts: conflicts
      .sort((a, b) => byStartThenId(a.hold, b.hold))
      .map(({ hold: h, reason }) => ({
        id: h.id,
        kind: h.kind,
        status: h.status,
        ref: h.ref,
        slotStart: h.slotStart,
        staffId: h.staffId,
        reason,
        alternatives: fixedSet.has(h) ? alternativesFor(h) : [],
      })),
    assignment,
  };
}
