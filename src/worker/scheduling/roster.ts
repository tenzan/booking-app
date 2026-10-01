// Roster bridge: loads every hold a schedule change could affect, runs the pure roster engine against the
// proposed schedule, and (on apply) commits the change together with the pending requests it moves.

import { rosterImpact, type RosterHold, type RosterImpact } from "../../domain/roster";
import { freeStaffAt, rangeBlocks, type SlotCfg, type SlotInput, type Unavail } from "../../domain/slots";
import type { Settings } from "../../domain/settings";
import { addDays, MIN, utcToWall } from "../../domain/time";
import type { ConflictDTO, ImpactDTO, InvalidResolution, Resolution, ResolutionProblem, ScheduleChange } from "../../shared/types";
import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit, capacityBatch, readScheduleVersion, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { getHolidays, getSettings } from "../repos/settings";
import { loadOverrideDates, loadWindows } from "../repos/schedule";
import { activeStaffByIds, notifyStaff } from "../repos/staff";
import { blockInsert, movePendingStatements, type PendingMove } from "../reservations/holds";
import { reassignedEmails } from "../reservations/reassign";
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
/** What a resolution needs to assert and announce about a pending/confirmed reservation. */
export interface ReservationMeta {
  status: "pending" | "confirmed";
  version: number;
  /** Assigned (confirmed) or provisional (pending) technician. */
  staffId: number | null;
  customerId: number;
  contactEmail: string;
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
  reservations: Map<string, ReservationMeta>;
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
  version: number;
  customerId: number;
  contactEmail: string;
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
                r.version, r.customer_id AS customerId, r.contact_email AS contactEmail, c.name AS customerName
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
  const meta = new Map<string, ReservationMeta>();
  for (const r of reservations.results) {
    const pending = r.status === "pending";
    meta.set(r.id, {
      status: r.status, version: r.version, staffId: pending ? r.provisionalStaffId : r.assignedStaffId, customerId: r.customerId, contactEmail: r.contactEmail,
    });
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
  return { version, settings, slotInput, unavailability, staff, holds, info, reservations: meta };
}

function toImpactDTO(state: RosterState, impact: RosterImpact, preexisting: Set<string>, invalid: InvalidResolution[]): ImpactDTO {
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
    moved: impact.moved.map((m) => ({ id: m.id, ref: m.ref, startAt: holds.get(m.id)!.slotStart, from: name(m.from), fromId: m.from, to: name(m.to) ?? "", toId: m.to })),
    conflicts: impact.conflicts.filter((c) => !preexisting.has(c.id)).map(conflict),
    warnings: impact.conflicts.filter((c) => preexisting.has(c.id)).map(conflict),
    ...(invalid.length > 0 ? { invalidResolutions: invalid } : {}),
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

/** A resolution that holds under the proposed schedule: `hold` (as loaded) moves from its technician to `to`. */
interface AcceptedResolution {
  hold: RosterHold;
  to: number;
}

const overlaps = (a: RosterHold, b: RosterHold) => a.occStart < b.occEnd && b.occStart < a.occEnd;

/**
 * Pins each resolution's hold (pending or confirmed) to its chosen technician, in order. A resolution holds when that
 * technician is free at the hold's slot under the PROPOSED schedule and has no other fixed hold overlapping it (valid
 * confirmed appointments and options, pinned holds, earlier resolutions): pendings are flexible and may be displaced,
 * and then show up as conflicts of their own. The rest are reported with a reason and their holds left as they are.
 * `changed` names reservations that moved on since the apply started (see applyChange).
 */
function stageResolutions(slotInput: SlotInput, holds: RosterHold[], resolutions: Resolution[], changed: Set<string>) {
  const free = new Map<string, number[]>();
  const freeAt = (h: RosterHold) => {
    if (!free.has(h.id)) free.set(h.id, freeStaffAt(slotInput, h.slotStart, h.occStart, h.occEnd));
    return free.get(h.id)!;
  };
  /** Technician each fixed hold keeps under the proposal (what the engine places before any pending). */
  const fixedOn = new Map<string, number>();
  for (const h of holds) {
    if ((h.status === "pending" && !h.pinned) || h.staffId === null) continue;
    if (h.pinned || freeAt(h).includes(h.staffId)) fixedOn.set(h.id, h.staffId);
  }
  const byId = new Map(holds.map((h) => [h.id, h]));
  const accepted: AcceptedResolution[] = [];
  const invalid: InvalidResolution[] = [];
  for (const r of resolutions) {
    const h = byId.get(r.reservationId);
    const clash = (hold: RosterHold) => holds.some((o) => o.id !== hold.id && fixedOn.get(o.id) === r.staffId && overlaps(o, hold));
    const reason: ResolutionProblem | null =
      !h || h.kind !== "reservation"
        ? "not_found"
        : changed.has(h.id)
          ? "changed"
          : h.staffId === r.staffId
            ? "same_tech"
            : !freeAt(h).includes(r.staffId)
              ? "tech_unavailable"
              : clash(h)
                ? "clash"
                : null;
    if (reason !== null || !h) {
      invalid.push({ reservationId: r.reservationId, staffId: r.staffId, reason: reason ?? "not_found" });
      continue;
    }
    fixedOn.set(h.id, r.staffId);
    accepted.push({ hold: h, to: r.staffId });
  }
  const to = new Map(accepted.map((a) => [a.hold.id, a.to]));
  return {
    holds: holds.map((h) => (to.has(h.id) ? { ...h, staffId: to.get(h.id)!, pinned: true } : h)),
    accepted,
    invalid,
  };
}

async function evaluate(env: Env, state: RosterState, change: ScheduleChange, resolutions: Resolution[], changed = new Set<string>()) {
  const resolved = await resolveChange(env.DB, state, change);
  const base = baseline(state);
  const staged = stageResolutions(resolved.slotInput, base.holds, resolutions, changed);
  const impact = rosterImpact({ holds: staged.holds, slotInput: resolved.slotInput });
  const dto = toImpactDTO(state, impact, base.preexisting, staged.invalid);
  return { resolved, impact, dto, accepted: staged.accepted };
}

/**
 * What `change` would do to existing holds, under the returned schedule version, with the staged `resolutions`
 * applied (invalid ones are reported and otherwise ignored). Never writes.
 */
export async function previewChange(env: Env, change: ScheduleChange, resolutions: Resolution[] = []): Promise<{ version: number; impact: ImpactDTO }> {
  const state = await loadRosterState(env);
  const { dto } = await evaluate(env, state, change, resolutions);
  return { version: state.version, impact: dto };
}

const CURRENT_STAFF_SQL = {
  confirmed: "SELECT 1 FROM reservations WHERE id = ? AND status = 'confirmed' AND version = ? AND assigned_staff_id IS ?",
  pending: "SELECT 1 FROM reservations WHERE id = ? AND status = 'pending' AND version = ? AND provisional_staff_id IS ?",
};

/**
 * Applies `change` together with its staged `resolutions` if the schedule is still at the previewed `version` (else
 * 409 stale_preview), every resolution still holds and no conflict is left (else 409 conflicts with the recomputed
 * impact; pre-existing conflicts are only warnings). The impact is always recomputed here. One batch writes the
 * change, moves each resolved reservation (asserting it still has the status, version and technician it was judged
 * on), re-blocks every moved pending request (asserting it is still pending with its old technician), queues the
 * reassignment notices and audits `schedule.<type>` plus a `reservation.reassigned` per resolution.
 */
export async function applyChange(
  env: Env,
  actor: StaffPrincipal,
  change: ScheduleChange,
  version: number,
  resolutions: Resolution[] = [],
): Promise<{ version: number; impact: ImpactDTO }> {
  // Each resolved reservation as the first attempt saw it. A retry (after an in-batch assertion failed) that finds one
  // changed refuses it: the person decided on what the preview showed, not on what someone else made of it since.
  const seen = new Map<string, string>();
  return withRetry(async () => {
    const db = env.DB;
    const state = await loadRosterState(env);
    if (state.version !== version) throw new HttpError(409, "stale_preview");
    const changed = new Set<string>();
    for (const r of resolutions) {
      const m = state.reservations.get(r.reservationId);
      const key = m ? `${m.status}:${m.version}:${m.staffId}` : "gone";
      const first = seen.get(r.reservationId);
      if (first === undefined) seen.set(r.reservationId, key);
      else if (first !== key) changed.add(r.reservationId);
    }
    const { resolved, impact, dto, accepted } = await evaluate(env, state, change, resolutions, changed);
    if (dto.conflicts.length > 0 || dto.invalidResolutions) throw new HttpError(409, "conflicts", { impact: dto });

    const now = clock.now();
    const holds = new Map(state.holds.map((h) => [h.id, h]));
    const moves: PendingMove[] = impact.moved.map((m) => ({ id: m.id, from: m.from, to: m.to, occStart: holds.get(m.id)!.occStart, occEnd: holds.get(m.id)!.occEnd }));
    const confirmedMoves = accepted.filter((a) => a.hold.status === "confirmed");
    const team = confirmedMoves.length > 0 ? await notifyStaff(db) : [];
    // The technicians each moved appointment leaves and joins hear about it whatever their notify setting.
    const involvedStaff = new Map((await activeStaffByIds(db, confirmedMoves.flatMap((a) => [a.hold.staffId, a.to].filter((id): id is number => id !== null)))).map((s) => [s.id, s]));
    const res = accepted.map((a) => ({ ...a, meta: state.reservations.get(a.hold.id)!, from: a.hold.staffId }));
    await capacityBatch(db, state.version, [
      ...resolved.statements(db, now),
      // Every resolved and moved hold frees its blocks before any is re-inserted, so swaps never collide.
      ...res.map((r) => assertSql(db, CURRENT_STAFF_SQL[r.meta.status], r.hold.id, r.meta.version, r.from)),
      ...res.map((r) => db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(r.hold.id)),
      ...movePendingStatements(db, moves, now),
      ...res.flatMap((r) =>
        r.meta.status === "confirmed"
          ? [
              db
                .prepare("UPDATE reservations SET assigned_staff_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'confirmed' AND version = ?")
                .bind(r.to, now, r.hold.id, r.meta.version),
              ...reassignedEmails(db, {
                id: r.hold.id,
                newVersion: r.meta.version + 1,
                from: r.from!,
                to: r.to,
                actorId: actor.id,
                staff: team,
                involved: [r.from, r.to].flatMap((id) => (id !== null && involvedStaff.has(id) ? [involvedStaff.get(id)!] : [])),
                contactEmail: r.meta.contactEmail,
                notifyCustomer: state.settings.notifyCustomerOnReassign,
              }),
            ]
          : [db.prepare("UPDATE reservations SET provisional_staff_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(r.to, now, r.hold.id)],
      ),
      ...res.map((r) => blockInsert(db, r.to, rangeBlocks(r.hold.occStart, r.hold.occEnd), r.hold.id)),
      ...res.map((r) =>
        audit(db, {
          actorKind: "staff",
          actor: String(actor.id),
          action: "reservation.reassigned",
          reservationId: r.hold.id,
          customerId: r.meta.customerId,
          details: { from: r.from, to: r.to, via: "schedule" },
        }),
      ),
      audit(db, {
        actorKind: "staff",
        actor: String(actor.id),
        action: `schedule.${change.type}`,
        details: {
          ...resolved.details,
          moved: impact.moved.map((m) => ({ id: m.id, ref: m.ref, from: m.from, to: m.to })),
          ...(res.length > 0 ? { resolved: res.map((r) => ({ id: r.hold.id, ref: r.hold.ref, from: r.from, to: r.to })) } : {}),
        },
      }),
    ]);
    return { version: state.version + 1, impact: dto };
  });
}
