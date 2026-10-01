// Roster bridge: loads every hold a schedule change could affect, runs the pure roster engine against the
// proposed schedule, and (on apply) commits the change together with the pending requests it moves.

import { rosterImpact, type RosterHold, type RosterImpact } from "../../domain/roster";
import type { SlotCfg, SlotInput, Unavail } from "../../domain/slots";
import type { Settings } from "../../domain/settings";
import { addDays, MIN, utcToWall } from "../../domain/time";
import type { ConflictDTO, ImpactDTO, ScheduleChange } from "../../shared/types";
import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { audit, capacityBatch, readScheduleVersion, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { getHolidays, getSettings } from "../repos/settings";
import { loadOverrideDates, loadWindows } from "../repos/schedule";
import { movePendingStatements, type PendingMove } from "../reservations/holds";
import { resolveChange } from "./changes";

export type { ConflictDTO, ImpactDTO, ScheduleChange, WindowInput } from "../../shared/types";

const DAY = 24 * 60 * MIN;

export interface StaffInfo {
  id: number;
  name: string;
  role: "admin" | "technician";
  active: boolean;
  bookable: boolean;
}
export interface UnavailRow extends Unavail {
  id: number;
}
interface HoldInfo {
  reservationId: string;
  customerName: string;
}

/** The current schedule and every hold that has not ended yet, read under one schedule version. */
export interface RosterState {
  version: number;
  settings: Settings;
  slotInput: SlotInput;
  /** Same rows as `slotInput.unavailability`, with ids. */
  unavailability: UnavailRow[];
  staff: Map<number, StaffInfo>;
  holds: RosterHold[];
  info: Map<string, HoldInfo>;
}

interface ReservationRow {
  id: string;
  ref: string;
  status: "pending" | "confirmed";
  startAt: number;
  occStart: number;
  occEnd: number;
  assignedStaffId: number | null;
  provisionalStaffId: number | null;
  createdAt: number;
  customerName: string;
}
interface OptionRow {
  id: string;
  reservationId: string;
  ref: string;
  startAt: number;
  occStart: number;
  occEnd: number;
  staffId: number;
  customerName: string;
}

/**
 * Holds that a change can affect: pending/confirmed reservations and open proposal options whose stored occupied
 * range has not ended (however far ahead they are), with the schedule inputs covering all of them.
 */
export async function loadRosterState(env: Env): Promise<RosterState> {
  const db = env.DB;
  // Version first (see loadScheduleCtx): a write in between leaves us with a stale version, never stale data.
  const version = await readScheduleVersion(db);
  const now = clock.now();
  const [settings, holidays, staffRows, reservations, options] = await Promise.all([
    getSettings(db, env),
    getHolidays(db),
    db.prepare("SELECT id, name, role, active, bookable FROM staff ORDER BY id").all<{ id: number; name: string; role: "admin" | "technician"; active: number; bookable: number }>(),
    db
      .prepare(
        `SELECT r.id, r.ref, r.status, r.start_at AS startAt, r.occ_start AS occStart, r.occ_end AS occEnd,
                r.assigned_staff_id AS assignedStaffId, r.provisional_staff_id AS provisionalStaffId, r.created_at AS createdAt,
                c.name AS customerName
         FROM reservations r JOIN customers c ON c.id = r.customer_id
         WHERE r.status IN ('pending','confirmed') AND r.occ_end > ?`,
      )
      .bind(now)
      .all<ReservationRow>(),
    db
      .prepare(
        `SELECT o.id, r.id AS reservationId, r.ref, o.start_at AS startAt, o.occ_start AS occStart, o.occ_end AS occEnd,
                o.staff_id AS staffId, c.name AS customerName
         FROM proposal_options o
         JOIN proposals p ON p.id = o.proposal_id
         JOIN reservations r ON r.id = p.reservation_id
         JOIN customers c ON c.id = r.customer_id
         WHERE p.status = 'open' AND o.occ_end > ?`,
      )
      .bind(now)
      .all<OptionRow>(),
  ]);

  const holds: RosterHold[] = [];
  const info = new Map<string, HoldInfo>();
  for (const r of reservations.results) {
    const pending = r.status === "pending";
    holds.push({
      id: r.id, kind: "reservation", status: r.status, ref: r.ref, slotStart: r.startAt, occStart: r.occStart, occEnd: r.occEnd,
      staffId: pending ? r.provisionalStaffId : r.assignedStaffId,
      ...(pending ? { createdAt: r.createdAt } : {}),
    });
    info.set(r.id, { reservationId: r.id, customerName: r.customerName });
  }
  for (const o of options.results) {
    holds.push({ id: o.id, kind: "option", status: "option", ref: o.ref, slotStart: o.startAt, occStart: o.occStart, occEnd: o.occEnd, staffId: o.staffId });
    info.set(o.id, { reservationId: o.reservationId, customerName: o.customerName });
  }

  // Windows and overrides for every date a hold starts on (and at least the booking horizon); time off over the
  // holds' occupied ranges, which is what eligibility is judged against.
  const tz = env.APP_TIMEZONE;
  const earliest = Math.min(now, ...holds.map((h) => h.slotStart));
  const latest = Math.max(now + settings.bookingHorizonDays * DAY, ...holds.map((h) => h.slotStart));
  const fromDate = addDays(utcToWall(earliest, tz).date, -1);
  const toDate = addDays(utcToWall(latest, tz).date, 1);
  const occFrom = Math.min(...holds.map((h) => h.occStart));
  const occTo = Math.max(...holds.map((h) => h.occEnd));
  const [windows, overrideDates, unavailability] = await Promise.all([
    loadWindows(db, fromDate, toDate),
    loadOverrideDates(db, fromDate, toDate),
    holds.length === 0
      ? Promise.resolve([] as UnavailRow[])
      : db
          .prepare("SELECT id, staff_id AS staffId, start_at AS startAt, end_at AS endAt FROM staff_unavailability WHERE start_at < ? AND end_at > ?")
          .bind(occTo, occFrom)
          .all<UnavailRow>()
          .then((r) => r.results),
  ]);

  const staff = new Map(
    staffRows.results.map((s) => [s.id, { id: s.id, name: s.name, role: s.role, active: s.active === 1, bookable: s.bookable === 1 }]),
  );
  const bookableStaff = new Set([...staff.values()].filter((s) => s.active && s.bookable).map((s) => s.id));
  const cfg: SlotCfg = {
    tz,
    durationMin: settings.durationMin,
    stepMin: settings.slotStepMin,
    bufferBeforeMin: settings.bufferBeforeMin,
    bufferAfterMin: settings.bufferAfterMin,
  };
  const slotInput: SlotInput = { fromDate, toDate, windows, overrideDates, holidays, unavailability, bookableStaff, cfg };
  return { version, settings, slotInput, unavailability, staff, holds, info };
}

function toImpactDTO(state: RosterState, impact: RosterImpact, preexisting: Set<string>): ImpactDTO {
  const holds = new Map(state.holds.map((h) => [h.id, h]));
  const name = (id: number | null) => (id === null ? null : (state.staff.get(id)?.name ?? null));
  const conflict = (c: RosterImpact["conflicts"][number]): ConflictDTO => ({
    id: c.id,
    kind: c.kind,
    status: c.status,
    reservationId: state.info.get(c.id)!.reservationId,
    ref: c.ref,
    startAt: c.slotStart,
    staffName: name(c.staffId),
    reason: c.reason,
    alternatives: c.alternatives.map((a) => ({
      id: a.staffId,
      name: name(a.staffId) ?? "",
      displaces: a.displaces.map((id) => ({ id, ref: holds.get(id)!.ref })),
    })),
    customerName: state.info.get(c.id)!.customerName,
  });
  return {
    moved: impact.moved.map((m) => ({ id: m.id, ref: m.ref, startAt: holds.get(m.id)!.slotStart, from: name(m.from), to: name(m.to) ?? "" })),
    conflicts: impact.conflicts.filter((c) => !preexisting.has(c.id)).map(conflict),
    warnings: impact.conflicts.filter((c) => preexisting.has(c.id)).map(conflict),
  };
}

/**
 * Conflicts that exist before the change (e.g. data written outside these paths) must not block unrelated edits,
 * but their holds still own their tech_blocks. So they are pinned to their current technician, in the baseline and
 * in the proposal alike, and nothing is matched onto it. Pinning can push another pending out in the baseline; that
 * one is pre-existing too, so pins grow until the baseline is stable. Returns the pinned holds and the ids of the
 * baseline's conflicts.
 */
function baseline(state: RosterState): { holds: RosterHold[]; preexisting: Set<string> } {
  const pins = new Set<string>();
  for (;;) {
    const holds = state.holds.map((h) => (pins.has(h.id) ? { ...h, pinned: true } : h));
    const base = rosterImpact({ holds, slotInput: state.slotInput });
    const fresh = base.conflicts.filter((c) => !pins.has(c.id));
    if (fresh.length === 0) return { holds, preexisting: new Set(base.conflicts.map((c) => c.id)) };
    for (const c of fresh) pins.add(c.id);
  }
}

async function evaluate(env: Env, state: RosterState, change: ScheduleChange) {
  const resolved = await resolveChange(env.DB, state, change);
  const { holds, preexisting } = baseline(state);
  const impact = rosterImpact({ holds, slotInput: resolved.slotInput });
  const dto = toImpactDTO(state, impact, preexisting);
  return { resolved, impact, dto };
}

/** What `change` would do to existing holds, under the returned schedule version. Never writes. */
export async function previewChange(env: Env, change: ScheduleChange): Promise<{ version: number; impact: ImpactDTO }> {
  const state = await loadRosterState(env);
  const { dto } = await evaluate(env, state, change);
  return { version: state.version, impact: dto };
}

/**
 * Applies `change` if the schedule is still at the previewed `version` (else 409 stale_preview) and it introduces no
 * conflict (else 409 conflicts with the recomputed impact; pre-existing ones are only warnings). The impact is always recomputed here. One batch writes
 * the change, re-blocks every moved pending request (asserting it is still pending with its old technician) and
 * audits `schedule.<type>`.
 */
export async function applyChange(env: Env, actor: StaffPrincipal, change: ScheduleChange, version: number): Promise<{ version: number; impact: ImpactDTO }> {
  return withRetry(async () => {
    const db = env.DB;
    const state = await loadRosterState(env);
    if (state.version !== version) throw new HttpError(409, "stale_preview");
    const { resolved, impact, dto } = await evaluate(env, state, change);
    if (dto.conflicts.length > 0) throw new HttpError(409, "conflicts", { impact: dto });

    const now = clock.now();
    const holds = new Map(state.holds.map((h) => [h.id, h]));
    const moves: PendingMove[] = impact.moved.map((m) => ({ id: m.id, from: m.from, to: m.to, occStart: holds.get(m.id)!.occStart, occEnd: holds.get(m.id)!.occEnd }));
    await capacityBatch(db, state.version, [
      ...resolved.statements(db, now),
      ...movePendingStatements(db, moves, now),
      audit(db, {
        actorKind: "staff",
        actor: String(actor.id),
        action: `schedule.${change.type}`,
        details: { ...resolved.details, moved: impact.moved.map((m) => ({ id: m.id, ref: m.ref, from: m.from, to: m.to })) },
      }),
    ]);
    return { version: state.version + 1, impact: dto };
  });
}
