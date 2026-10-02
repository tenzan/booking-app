import type { Env } from "../env";
import { assertSql, audit, capacityBatch, readScheduleVersion, withRetry } from "../lib/db";
import { safeError } from "../mail/outbox";
import { closeProposalStatements } from "../reservations/propose";
import { getReservation } from "../reservations/queries";
import { outcomeEmails } from "../reservations/respond";
import { activeStaffByIds, noticeRecipients, notifyStaff } from "../repos/staff";
import { STALE_AFTER_MS, SWEEP_LIMIT } from "./expiry";

/**
 * Expire one open proposal. Returns false when it is no longer due (answered, withdrawn or superseded meanwhile). When
 * every offered time has already passed, or the proposal expired more than STALE_AFTER_MS ago, it is closed silently.
 */
async function expireOne(env: Env, proposalId: string, now: number): Promise<boolean> {
  const db = env.DB;
  // Schedule version first, then the data: a change in between fails the guard and we retry.
  const scheduleVersion = await readScheduleVersion(db);
  const p = await db
    .prepare("SELECT reservation_id, status, expires_at FROM proposals WHERE id = ?")
    .bind(proposalId)
    .first<{ reservation_id: string; status: string; expires_at: number }>();
  if (!p || p.status !== "open" || p.expires_at > now) return false;
  const current = (await getReservation(db, p.reservation_id))!;
  // The open proposal is always the reservation's latest, so the view carries its options.
  const options = current.proposal?.id === proposalId ? current.proposal.options : [];
  const silent = (options.length > 0 && options.every((o) => o.startAt <= now)) || now - p.expires_at > STALE_AFTER_MS;
  // Everyone who follows requests, the appointment's technician and the technicians whose times are released.
  const team = silent
    ? []
    : noticeRecipients(await notifyStaff(db), await activeStaffByIds(db, [...(current.assignedStaff ? [current.assignedStaff.id] : []), ...options.map((o) => o.staffId)]));
  await capacityBatch(db, scheduleVersion, [
    assertSql(db, "SELECT 1 FROM proposals WHERE id = ? AND status = 'open' AND expires_at <= ?", proposalId, now),
    ...closeProposalStatements(db, current.id, proposalId, "expired", now),
    ...(silent ? [] : outcomeEmails(db, { id: current.id, proposalId, contactEmail: current.contactEmail, outcome: "expired", team })),
    audit(db, {
      actorKind: "system",
      actor: null,
      action: "reservation.proposal_expired",
      reservationId: current.id,
      customerId: current.customer.id,
      details: { proposalId, ...(silent ? { silent: true } : {}) },
    }),
  ]);
  return true;
}

/**
 * Open proposals past their expiry become `expired`: their option holds are released, the reservation is left as it is
 * (whatever its status), and the customer and team are told (unless the news is stale: see expireOne). Bounded per run; each row commits on its own, and a row
 * that fails is logged and left for the next run. Returns how many it expired.
 */
export async function expireProposals(env: Env, now: number): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id FROM proposals WHERE status = 'open' AND expires_at <= ? ORDER BY expires_at, id LIMIT ?")
    .bind(now, SWEEP_LIMIT)
    .all<{ id: string }>();
  let done = 0;
  for (const { id } of results) {
    try {
      if (await withRetry(() => expireOne(env, id, now))) done++;
    } catch (e) {
      console.error("proposal expiry", id, safeError(e));
    }
  }
  return done;
}
