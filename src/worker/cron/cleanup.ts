import type { Env } from "../env";

const DAY = 86_400_000;

/**
 * Housekeeping, run once an hour: expired login/access tokens and ended or revoked sessions after a week, rate-limit
 * counters a day after their (at most hour-long) window, delivered/skipped/cancelled mail jobs after 90 days (failed ones
 * stay for the operator), dev mailbox copies after a week. Returns the number of rows removed.
 */
export async function cleanup(env: Env, now: number): Promise<number> {
  const db = env.DB;
  const week = now - 7 * DAY;
  const results = await db.batch([
    db.prepare("DELETE FROM auth_tokens WHERE expires_at < ?").bind(week),
    db.prepare("DELETE FROM access_tokens WHERE expires_at < ?").bind(week),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?1 OR (revoked_at IS NOT NULL AND revoked_at < ?1)").bind(week),
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - DAY),
    db.prepare("DELETE FROM email_jobs WHERE status IN ('sent','skipped','cancelled') AND created_at < ?").bind(now - 90 * DAY),
    db.prepare("DELETE FROM dev_mailbox WHERE created_at < ?").bind(week),
  ]);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}
