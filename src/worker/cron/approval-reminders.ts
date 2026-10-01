import type { Env } from "../env";
import { enqueueEmail, safeError, type TemplateName } from "../mail/outbox";
import { activeAdmins, notifyStaff } from "../repos/staff";
import { SWEEP_LIMIT } from "./expiry";

type Recipients = (db: D1Database) => Promise<Array<{ id: number; email: string }>>;

/**
 * Enqueue `template` to `recipients` for pending requests whose `column` time has come and that have not yet reached their
 * deadline. No state is kept: the dedupe key makes a repeat (or a second overlapping run) a no-op, and a request that
 * already has a job of this template is not selected again, so rows already handled never crowd out new ones.
 */
async function remind(
  env: Env,
  now: number,
  column: "approval_reminder_at" | "escalation_at",
  template: Extract<TemplateName, "approval_reminder" | "approval_escalation">,
  keyPrefix: string,
  recipients: Recipients,
): Promise<number> {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT r.id FROM reservations r
       WHERE r.status = 'pending' AND r.${column} <= ?1 AND (r.expires_at IS NULL OR r.expires_at > ?1)
         AND NOT EXISTS (SELECT 1 FROM email_jobs j WHERE j.reservation_id = r.id AND j.template = ?2)
       ORDER BY r.${column}, r.id LIMIT ?3`,
    )
    .bind(now, template, SWEEP_LIMIT)
    .all<{ id: string }>();
  if (results.length === 0) return 0;
  const to = await recipients(db);
  if (to.length === 0) return 0;
  let done = 0;
  for (const { id } of results) {
    try {
      await db.batch(to.map((s) => enqueueEmail(db, { template, to: s.email, dedupeKey: `${keyPrefix}:${id}:${s.id}`, reservationId: id })));
      done++;
    } catch (e) {
      console.error(template, id, safeError(e));
    }
  }
  return done;
}

/** Reminder to everyone who follows requests. */
export const sendApprovalReminders = (env: Env, now: number): Promise<number> =>
  remind(env, now, "approval_reminder_at", "approval_reminder", "approval-reminder", notifyStaff);

/** Escalation to the active administrators. */
export const sendEscalations = (env: Env, now: number): Promise<number> =>
  remind(env, now, "escalation_at", "approval_escalation", "approval-escalation", activeAdmins);
