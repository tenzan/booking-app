import { component, solve } from "../../domain/matching";
import { freeStaffAt, rangeBlocks } from "../../domain/slots";
import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit, capacityBatch, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { activeStaffByIds, noticeRecipients, notifyStaff } from "../repos/staff";
import { loadScheduleCtx } from "../scheduling/context";
import { blockInsert, movedPending, movePendingStatements } from "./holds";
import { closeProposalStatements } from "./propose";
import { releasedHolds } from "./replacement";
import { getReservation, techOptions, type ReservationDTO } from "./queries";

/**
 * Give a confirmed appointment another technician at the same time. The target must be free on the appointment's
 * window and stored range, and everything else must stay assignable with it fixed there (pending requests may move).
 * Same batch discipline as approve: of two racing reassignments exactly one commits, the other is stale on retry.
 * An open proposal on the appointment is withdrawn in the same batch (staff decided), its options released first, and
 * the customer is told the proposed times were withdrawn (the time itself is unchanged, so nothing else tells them).
 */
export async function reassignReservation(env: Env, actor: StaffPrincipal, id: string, staffId: number, version: number): Promise<ReservationDTO> {
  return withRetry(() => attempt(env, actor, id, staffId, version));
}

async function attempt(env: Env, actor: StaffPrincipal, id: string, staffId: number, version: number): Promise<ReservationDTO> {
  const db = env.DB;
  const current = await getReservation(db, id);
  if (!current) throw new HttpError(404, "not_found");
  if (current.status !== "confirmed" || current.version !== version || !current.assignedStaff) throw new HttpError(409, "stale", { current });
  const from = current.assignedStaff.id;
  if (from === staffId) throw new HttpError(409, "same_tech");
  if (current.endAt <= clock.now()) throw new HttpError(409, "too_late");

  const ctx = await loadScheduleCtx(env, current.startAt, current.endAt);
  const target = ctx.holds.find((h) => h.id === id);
  if (!target) throw new HttpError(409, "stale", { current: (await getReservation(db, id)) ?? current });

  const released = releasedHolds(ctx, current, null);
  const free = freeStaffAt(ctx.slotInput, current.startAt, target.start, target.end);
  const fixedHolds = ctx.holds.filter((h) => !released.has(h.id)).map((h) => (h.id === id ? { ...h, fixed: staffId, eligible: [staffId] } : h));
  const assignment = free.includes(staffId) ? solve(component(fixedHolds, target.start, target.end)) : null;
  if (!assignment) throw new HttpError(409, "tech_unavailable", { options: await techOptions(env, current) });

  const now = clock.now();
  const newVersion = version + 1;
  const moved = movedPending(ctx, assignment, id);
  const staff = await notifyStaff(db);
  const involved = await activeStaffByIds(db, [from, staffId]);
  const openProposal = current.proposal?.status === "open" ? current.proposal : null;

  await capacityBatch(db, ctx.version, [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = 'confirmed' AND version = ? AND assigned_staff_id = ?", id, version, from),
    ...(openProposal
      ? [
          ...closeProposalStatements(db, id, openProposal.id, "withdrawn", now),
          enqueueEmail(db, {
            template: "proposal_outcome",
            to: current.contactEmail,
            dedupeKey: `proposal-outcome:${openProposal.id}`,
            reservationId: id,
            payload: { audience: "customer", proposalId: openProposal.id, outcome: "withdrawn" },
          }),
        ]
      : []),
    // The appointment's blocks go first so a moved request may take its old technician.
    db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(id),
    ...movePendingStatements(db, moved, now),
    db
      .prepare(
        `UPDATE reservations SET assigned_staff_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'confirmed' AND version = ?`,
      )
      .bind(staffId, now, id, version),
    blockInsert(db, staffId, rangeBlocks(target.start, target.end), id),
    ...reassignedEmails(db, { id, newVersion, from, to: staffId, actorId: actor.id, staff, involved, contactEmail: current.contactEmail, notifyCustomer: ctx.settings.notifyCustomerOnReassign }),
    audit(db, {
      actorKind: "staff",
      actor: String(actor.id),
      action: "reservation.reassigned",
      reservationId: id,
      customerId: current.customer.id,
      details: { from, to: staffId },
    }),
  ]);
  return (await getReservation(db, id))!;
}

/**
 * The `reassigned` notices for a confirmed appointment now at `newVersion`: every notified team member and the two
 * technicians involved (whatever their notify setting), once each and except the actor, plus the customer when the
 * setting asks for it. Shared by the direct reassign and schedule resolutions.
 */
export function reassignedEmails(
  db: D1Database,
  o: {
    id: string;
    newVersion: number;
    from: number;
    to: number;
    actorId: number;
    staff: Array<{ id: number; email: string }>;
    /** The technicians this appointment moved from and to (active ones only). */
    involved: Array<{ id: number; email: string }>;
    contactEmail: string;
    notifyCustomer: boolean;
  },
): D1PreparedStatement[] {
  return [
    ...noticeRecipients(o.staff, o.involved, o.actorId).map((s) =>
        enqueueEmail(db, {
          template: "reassigned",
          to: s.email,
          dedupeKey: `reassigned:${o.id}:v${o.newVersion}:${s.id}`,
          reservationId: o.id,
          payload: { audience: "team", from: o.from, to: o.to, by: o.actorId },
        }),
      ),
    ...(o.notifyCustomer
      ? [
          enqueueEmail(db, {
            template: "reassigned",
            to: o.contactEmail,
            dedupeKey: `reassigned-customer:${o.id}:v${o.newVersion}`,
            reservationId: o.id,
            payload: { audience: "customer", to: o.to },
          }),
        ]
      : []),
  ];
}
