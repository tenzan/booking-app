import type { Env } from "../env";

const DAY = 86_400_000;

/** Rows each table loses per run; a backlog drains over successive hours. */
export const CLEANUP_BATCH = 1000;

/**
 * Housekeeping, run once an hour: expired login/access tokens and ended or revoked sessions after a week, rate-limit
 * counters a day after their (at most hour-long) window, delivered/skipped/cancelled mail jobs after 90 days (failed ones
 * stay for the operator), dev mailbox copies after a week. Each table loses at most `cap` rows per run. Returns the number
 * of rows removed.
 */
export async function cleanup(env: Env, now: number, cap = CLEANUP_BATCH): Promise<number> {
  const db = env.DB;
  const week = now - 7 * DAY;
  const del = (table: string, where: string, ...binds: unknown[]) =>
    db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`).bind(...binds, cap);
  const results = await db.batch([
    del("auth_tokens", "expires_at < ?", week),
    del("access_tokens", "expires_at < ?", week),
    del("sessions", "expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)", week, week),
    del("rate_limits", "window_start < ?", now - DAY),
    del("email_jobs", "status IN ('sent','skipped','cancelled') AND created_at < ?", now - 90 * DAY),
    del("dev_mailbox", "created_at < ?", week),
  ]);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}
