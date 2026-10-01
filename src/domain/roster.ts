// Roster impact engine: given the holds that exist and the PROPOSED schedule, decides which pending requests
// move to another technician, which holds become conflicts, and who could take over each conflict.
// Eligibility of an existing hold is judged from the hold's own data (its slot start and stored occupied range),
// so changing duration/buffers/step never invalidates an existing appointment.

import { component, solveDetailed, type Hold } from "./matching";
import { freeStaffAt, windowExistsAt, type SlotInput } from "./slots";

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
  /** Optional creation time (epoch ms): breaks ties between same-start pendings (older first). */
  createdAt?: number;
}
export interface RosterInput {
  holds: RosterHold[];
  /** Slot input under the PROPOSED roster/schedule. */
  slotInput: SlotInput;
}
export type ConflictReason = "tech_removed" | "slot_removed" | "no_capacity" | "too_complex";
/** A technician a conflicting hold could take, and the accepted pendings that would be left without a place. */
export interface RosterAlternative {
  staffId: number;
  displaces: string[];
}
export interface RosterConflict {
  id: string;
  kind: RosterHold["kind"];
  status: RosterHold["status"];
  ref: string;
  slotStart: number;
  staffId: number | null;
  reason: ConflictReason;
  /**
   * Only for confirmed/option conflicts: each is an independent option for THIS conflict (confirmed holds take
   * priority over pendings, so only valid fixed holds are considered), not a joint plan across conflicts.
   * `displaces` lists the pendings that would become conflicts if this option were chosen. The UI re-previews
   * after each resolution. Always empty for pending conflicts.
   */
  alternatives: RosterAlternative[];
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
 *
 * Priority: confirmed/option holds that are still valid are fixed; pendings are then added one at a time and
 * rejected when they no longer fit (the result is maximal, not necessarily maximum: an earlier pending is never
 * displaced by a later one).
 */
export function rosterImpact(input: RosterInput, budget?: number): RosterImpact {
  const { slotInput } = input;
  const holds = [...input.holds].sort(byStartThenId);

  const position = new Map(holds.map((h, i) => [h.id, i]));
  const cmpId = (a: string, b: string) => position.get(a)! - position.get(b)!;
  type Verdict = { hold: RosterHold; reason: ConflictReason };
  const free = new Map<string, number[]>();
  for (const h of holds) free.set(h.id, freeStaffAt(slotInput, h.slotStart, h.occStart, h.occEnd));
  const toHold = (h: RosterHold, o: Partial<Hold>): Hold => ({
    id: h.id, start: h.occStart, end: h.occEnd, fixed: null, eligible: [], preferred: null, ...o,
  });

  const conflicts: Verdict[] = [];
  const validFixed: Hold[] = [];
  const fixedConflicts: RosterHold[] = [];
  const pendings: RosterHold[] = [];

  for (const h of holds) {
    if (h.status === "pending") {
      pendings.push(h);
      continue;
    }
    if (!windowExistsAt(slotInput, h.slotStart)) conflicts.push({ hold: h, reason: "slot_removed" });
    else if (h.staffId === null || !free.get(h.id)!.includes(h.staffId)) conflicts.push({ hold: h, reason: "tech_removed" });
    else {
      validFixed.push(toHold(h, { fixed: h.staffId }));
      continue;
    }
    fixedConflicts.push(h);
  }

  // Same start: pendings whose provisional technician is still a candidate go first (an untouched pending is not
  // flagged while another is moved onto its technician), then older, then id.
  const keeps = (h: RosterHold) => (h.staffId !== null && free.get(h.id)!.includes(h.staffId) ? 0 : 1);
  const ordered = [...pendings].sort(
    (a, b) => a.slotStart - b.slotStart || keeps(a) - keeps(b) || (a.createdAt ?? 0) - (b.createdAt ?? 0) || cmp(a.id, b.id),
  );

  /** Adds pendings in priority order on top of `base`; returns the accepted ones and the rejected with reasons. */
  const acceptPendings = (base: Hold[]) => {
    const solid = [...base];
    const accepted: RosterHold[] = [];
    const rejected: Verdict[] = [];
    for (const h of ordered) {
      const candidates = free.get(h.id)!;
      if (candidates.length === 0) {
        rejected.push({ hold: h, reason: windowExistsAt(slotInput, h.slotStart) ? "no_capacity" : "slot_removed" });
        continue;
      }
      const added = toHold(h, { eligible: candidates, preferred: h.staffId });
      const trial = solveDetailed(component([...solid, added], h.occStart, h.occEnd), budget);
      if (!trial.ok) {
        rejected.push({ hold: h, reason: trial.reason === "budget_exhausted" ? "too_complex" : "no_capacity" });
        continue;
      }
      solid.push(added);
      accepted.push(h);
    }
    return { solid, accepted, rejected };
  };

  const main = acceptPendings(validFixed);
  conflicts.push(...main.rejected);

  // Final staff: solve each time-connected group of holds on its own.
  const assignment = new Map<string, number>();
  const remaining = new Set(main.solid);
  for (const seed of main.solid) {
    if (!remaining.has(seed)) continue;
    const group = component(main.solid, seed.start, seed.end);
    for (const g of group) remaining.delete(g);
    const result = solveDetailed(group, budget);
    if (result.ok) {
      for (const [id, staff] of result.assignment) assignment.set(id, staff);
    } else {
      // Only reachable when the stored fixed holds already clash with each other; keep them where they are.
      for (const g of group) if (g.fixed !== null) assignment.set(g.id, g.fixed);
    }
  }

  const moved = main.accepted
    .filter((h) => assignment.get(h.id) !== h.staffId)
    .map((h) => ({ id: h.id, ref: h.ref, from: h.staffId, to: assignment.get(h.id)! }))
    .sort((a, b) => cmpId(a.id, b.id));

  const mainAccepted = new Set(main.accepted.map((h) => h.id));
  const alternativesFor = (h: RosterHold): RosterAlternative[] => {
    const out: RosterAlternative[] = [];
    for (const staffId of free.get(h.id)!) {
      const fixedTo = toHold(h, { fixed: staffId });
      if (!solveDetailed(component([...validFixed, fixedTo], h.occStart, h.occEnd), budget).ok) continue;
      const variant = acceptPendings([...validFixed, fixedTo]);
      const kept = new Set(variant.accepted.map((p) => p.id));
      out.push({ staffId, displaces: [...mainAccepted].filter((id) => !kept.has(id)).sort(cmpId) });
    }
    return out;
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
