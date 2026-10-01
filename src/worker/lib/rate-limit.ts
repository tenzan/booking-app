import { clock } from "./clock";

/** Fixed-window counter per key. Returns true when the request is allowed. */
export async function rateLimit(db: D1Database, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = clock.now();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits(key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
       RETURNING count`,
    )
    .bind(key, now, now - windowMs)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}
