import { clock } from "./clock";

/**
 * Batch guard: inserts a NULL into guard.ok (NOT NULL) when `existsSql` yields no rows,
 * which aborts and rolls back the whole db.batch(). Inserts nothing when the condition holds.
 */
export function assertSql(db: D1Database, existsSql: string, ...binds: unknown[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO guard(ok) SELECT NULL WHERE NOT EXISTS (${existsSql})`).bind(...binds);
}

export function scheduleVersionGuard(db: D1Database, version: number): D1PreparedStatement {
  return assertSql(db, "SELECT 1 FROM schedule_state WHERE id = 1 AND version = ?", version);
}

export function bumpScheduleVersion(db: D1Database): D1PreparedStatement {
  return db.prepare("UPDATE schedule_state SET version = version + 1 WHERE id = 1");
}

export async function readScheduleVersion(db: D1Database): Promise<number> {
  const v = await db.prepare("SELECT version FROM schedule_state WHERE id = 1").first<number>("version");
  return v ?? 0;
}

export function isRetryableBatchError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes("NOT NULL constraint failed: guard.ok") || m.includes("UNIQUE constraint failed: tech_blocks");
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isRetryableBatchError(e)) throw e;
    }
  }
}

export function audit(
  db: D1Database,
  e: {
    actorKind: "customer" | "staff" | "system";
    actor: string | null;
    action: string;
    reservationId?: string | null;
    customerId?: number | null;
    details?: unknown;
  },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO audit_log(at, actor_kind, actor, action, reservation_id, customer_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(clock.now(), e.actorKind, e.actor, e.action, e.reservationId ?? null, e.customerId ?? null, JSON.stringify(e.details ?? {}));
}
