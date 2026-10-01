import type { StaffDTO } from "../../shared/types";
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
 * The new or reactivated admin is bookable, so the same batch bumps the schedule version (capacity changed); the bump
 * runs first under the very condition the upsert checks, so it happens exactly when the upsert writes.
 */
export async function ensureBootstrapAdmin(db: D1Database, env: Env, email: string): Promise<void> {
  if (!isBootstrapEmail(env, email)) return;
  const addr = email.trim().toLowerCase();
  const now = clock.now();
  const [, res] = await db.batch([
    db.prepare("UPDATE schedule_state SET version = version + 1 WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM staff WHERE role = 'admin' AND active = 1)"),
    db
      .prepare(
        `INSERT INTO staff(email, name, role, bookable, notify, active, created_at, updated_at)
         SELECT ?1, ?2, 'admin', 1, 1, 1, ?3, ?3
         WHERE NOT EXISTS (SELECT 1 FROM staff WHERE role = 'admin' AND active = 1)
         ON CONFLICT(email) DO UPDATE SET role = 'admin', active = 1, updated_at = excluded.updated_at`,
      )
      .bind(addr, addr.split("@")[0], now),
  ]);
  if (res!.meta.changes === 1) {
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

/** The active staff among `ids` (people named by an appointment: they hear about it whatever their notify setting). */
export async function activeStaffByIds(db: D1Database, ids: number[]): Promise<Array<{ id: number; email: string; name: string }>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT id, email, name FROM staff WHERE active = 1 AND id IN (${wanted.map(() => "?").join(",")}) ORDER BY id`)
    .bind(...wanted)
    .all<{ id: number; email: string; name: string }>();
  return results;
}

/** Notice recipients: everyone who follows requests plus the technicians involved, once each, minus `exceptId` (the actor, who already knows). */
export function noticeRecipients<T extends { id: number }>(notify: T[], involved: T[], exceptId?: number): T[] {
  const seen = new Set<number>();
  return [...notify, ...involved].filter((s) => s.id !== exceptId && !seen.has(s.id) && seen.add(s.id));
}

/** Exists while some active admin other than `?` does: the in-batch form of the last-admin rule (use with assertSql). */
export const OTHER_ACTIVE_ADMIN_SQL = "SELECT 1 FROM staff WHERE role = 'admin' AND active = 1 AND id <> ?";

const STAFF_COLUMNS = "id, email, name, role, bookable, notify, active";
interface StaffRow {
  id: number;
  email: string;
  name: string;
  role: "admin" | "technician";
  bookable: number;
  notify: number;
  active: number;
}
const toDTO = (r: StaffRow): StaffDTO => ({ ...r, bookable: r.bookable === 1, notify: r.notify === 1, active: r.active === 1 });

export async function listStaff(db: D1Database): Promise<StaffDTO[]> {
  const { results } = await db.prepare(`SELECT ${STAFF_COLUMNS} FROM staff ORDER BY name, id`).all<StaffRow>();
  return results.map(toDTO);
}

export async function getStaff(db: D1Database, id: number): Promise<StaffDTO | null> {
  const row = await db.prepare(`SELECT ${STAFF_COLUMNS} FROM staff WHERE id = ?`).bind(id).first<StaffRow>();
  return row ? toDTO(row) : null;
}
