import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { audit } from "../lib/db";

export async function activeStaffByEmail(db: D1Database, email: string): Promise<StaffPrincipal | null> {
  return db
    .prepare("SELECT id, email, name, role FROM staff WHERE email = ? AND active = 1")
    .bind(email)
    .first<StaffPrincipal>();
}

function isBootstrapEmail(env: Env, email: string): boolean {
  const wanted = email.trim().toLowerCase();
  return (env.BOOTSTRAP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .some((e) => e !== "" && e === wanted);
}

/**
 * First-run admin: when `email` is listed in BOOTSTRAP_ADMIN_EMAILS and no ACTIVE admin exists,
 * make it an active admin (a deactivated or non-admin row for that address is promoted/reactivated
 * so a lost admin can always be recovered from deployment config). Single guarded statement: safe under races.
 */
export async function ensureBootstrapAdmin(db: D1Database, env: Env, email: string): Promise<void> {
  if (!isBootstrapEmail(env, email)) return;
  const addr = email.trim().toLowerCase();
  const now = clock.now();
  const res = await db
    .prepare(
      `INSERT INTO staff(email, name, role, bookable, notify, active, created_at, updated_at)
       SELECT ?1, ?2, 'admin', 1, 1, 1, ?3, ?3
       WHERE NOT EXISTS (SELECT 1 FROM staff WHERE role = 'admin' AND active = 1)
       ON CONFLICT(email) DO UPDATE SET role = 'admin', active = 1, updated_at = excluded.updated_at`,
    )
    .bind(addr, addr.split("@")[0], now)
    .run();
  if (res.meta.changes === 1) {
    await audit(db, { actorKind: "system", actor: null, action: "staff.bootstrap_admin", details: { email: addr } }).run();
  }
}

/** Active staff who receive new-request notifications. */
export async function notifyStaff(db: D1Database): Promise<Array<{ id: number; email: string; name: string }>> {
  const { results } = await db
    .prepare("SELECT id, email, name FROM staff WHERE active = 1 AND notify = 1 ORDER BY id")
    .all<{ id: number; email: string; name: string }>();
  return results;
}
