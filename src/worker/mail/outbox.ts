import type { Env } from "../env";
import { clock } from "../lib/clock";
import { uuid } from "../lib/crypto";
import { assertSql, audit } from "../lib/db";
import { HttpError } from "../lib/http";
import { mailerFor, type Mailer } from "./adapters";
import { jobStillValid, renderJob } from "./templates";

export type TemplateName =
  | "customer_login"
  | "staff_login"
  | "request_received"
  | "new_request"
  | "confirmed"
  | "assigned"
  | "declined"
  | "cancelled"
  | "reassigned"
  | "expired"
  | "approval_reminder"
  | "approval_escalation"
  | "appointment_reminder"
  | "proposal"
  | "proposal_outcome"
  | "rescheduled"
  | "reply_relay";

export interface EmailJobRow {
  id: string;
  dedupe_key: string;
  template: string;
  to_email: string;
  reservation_id: string | null;
  payload: string;
  status: string;
  attempts: number;
  send_after: number;
  locked_until: number | null;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

const LOCK_MS = 60_000;
const BACKOFF_MIN = [1, 5, 15, 60, 240];
const MAX_ATTEMPTS = 6;

/** INSERT OR IGNORE keyed on dedupe_key; add it to the same db.batch() as the state change. */
export function enqueueEmail(
  db: D1Database,
  j: {
    template: TemplateName;
    to: string;
    dedupeKey: string;
    reservationId?: string | null;
    payload?: Record<string, unknown>;
    sendAfter?: number;
  },
): D1PreparedStatement {
  const now = clock.now();
  return db
    .prepare(
      `INSERT OR IGNORE INTO email_jobs(id, dedupe_key, template, to_email, reservation_id, payload, status, attempts, send_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    )
    .bind(uuid(), j.dedupeKey, j.template, j.to, j.reservationId ?? null, JSON.stringify(j.payload ?? {}), j.sendAfter ?? now, now);
}

/** Error text safe to persist: no magic-link fragments, no URLs, at most 500 chars. */
export function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/#t=[^\s"']+/g, "")
    .replace(/https?:\/\/[^\s"']+/g, "[url]")
    .slice(0, 500);
}

export async function processOutbox(
  env: Env,
  limit = 20,
  mailer: Mailer = mailerFor(env),
): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  const now = clock.now();
  const { results } = await env.DB.prepare(
    `SELECT * FROM email_jobs
     WHERE (status = 'queued' AND send_after <= ?1) OR (status = 'sending' AND locked_until < ?1)
     ORDER BY send_after LIMIT ?2`,
  )
    .bind(now, limit)
    .all<EmailJobRow>();

  for (const j of results) {
    const claim = await env.DB.prepare(
      `UPDATE email_jobs SET status = 'sending', locked_until = ?1
       WHERE id = ?2 AND ((status = 'queued' AND send_after <= ?3) OR (status = 'sending' AND locked_until < ?3))`,
    )
      .bind(now + LOCK_MS, j.id, now)
      .run();
    if (claim.meta.changes !== 1) continue;

    try {
      const rendered = await renderJob(env, j);
      if (rendered === "skip") {
        await env.DB.prepare("UPDATE email_jobs SET status = 'skipped', locked_until = NULL WHERE id = ?").bind(j.id).run();
        out.skipped++;
        continue;
      }
      // The reservation may have changed since the render read it (cancelled, say): the last look before the send.
      if (!(await jobStillValid(env, j))) {
        await env.DB.prepare("UPDATE email_jobs SET status = 'skipped', locked_until = NULL WHERE id = ?").bind(j.id).run();
        out.skipped++;
        continue;
      }
      await mailer.send({ to: j.to_email, ...rendered });
      await env.DB.prepare("UPDATE email_jobs SET status = 'sent', sent_at = ?, locked_until = NULL WHERE id = ?")
        .bind(clock.now(), j.id)
        .run();
      out.sent++;
    } catch (e) {
      const attempts = j.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      const delayMin = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1]!;
      await env.DB.prepare(
        "UPDATE email_jobs SET status = ?, attempts = ?, last_error = ?, send_after = ?, locked_until = NULL WHERE id = ?",
      )
        .bind(giveUp ? "failed" : "queued", attempts, safeError(e), giveUp ? j.send_after : clock.now() + delayMin * 60_000, j.id)
        .run();
      out.failed++;
    }
  }
  return out;
}

/**
 * Puts a failed job back in the queue for another full round of attempts, due now. The last error stays visible until the
 * next attempt overwrites it. Only `failed` jobs: 404 for an unknown id, 409 not_failed otherwise (also when the job
 * changed state between the read and the write).
 */
export async function retryFailedEmail(db: D1Database, id: string, staffId: number): Promise<{ id: string; template: string }> {
  const job = await db
    .prepare("SELECT template, status, reservation_id FROM email_jobs WHERE id = ?")
    .bind(id)
    .first<{ template: string; status: string; reservation_id: string | null }>();
  if (!job) throw new HttpError(404, "not_found");
  if (job.status !== "failed") throw new HttpError(409, "not_failed");
  try {
    await db.batch([
      assertSql(db, "SELECT 1 FROM email_jobs WHERE id = ? AND status = 'failed'", id),
      db
        .prepare("UPDATE email_jobs SET status = 'queued', attempts = 0, send_after = ?, locked_until = NULL WHERE id = ? AND status = 'failed'")
        .bind(clock.now(), id),
      audit(db, {
        actorKind: "staff",
        actor: String(staffId),
        action: "email.retry",
        reservationId: job.reservation_id,
        details: { id, template: job.template },
      }),
    ]);
  } catch (e) {
    if (String(e instanceof Error ? e.message : e).includes("guard.ok")) throw new HttpError(409, "not_failed");
    throw e;
  }
  return { id, template: job.template };
}

/** Fire-and-forget delivery after a request has committed. */
export function kickOutbox(c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }): void {
  c.executionCtx.waitUntil(
    processOutbox(c.env, 20).then(
      () => undefined,
      (e) => console.error("outbox error:", safeError(e)),
    ),
  );
}
