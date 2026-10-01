import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { randomToken, sha256Hex } from "../lib/crypto";
import { HttpError } from "../lib/http";

export type SessionKind = "customer" | "staff";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const SESSION_COOKIE: Record<SessionKind, string> = { customer: "__Host-cust", staff: "__Host-staff" };
const TTL_MS: Record<SessionKind, number> = { customer: 24 * HOUR, staff: 14 * DAY };
const STAFF_REFRESH_BELOW_MS = 7 * DAY;

const COOKIE_ATTRS = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" } as const;

function writeCookie(c: Context<AppEnv>, kind: SessionKind, rawToken: string): void {
  setCookie(c, SESSION_COOKIE[kind], rawToken, { ...COOKIE_ATTRS, maxAge: TTL_MS[kind] / 1000 });
}

export function clearSessionCookie(c: Context<AppEnv>, kind: SessionKind): void {
  deleteCookie(c, SESSION_COOKIE[kind], COOKIE_ATTRS);
}

/** Revoke the session behind this request's cookie of `kind` (no-op when absent or already revoked). */
export async function revokeSession(c: Context<AppEnv>, kind: SessionKind): Promise<void> {
  const raw = getCookie(c, SESSION_COOKIE[kind]);
  if (!raw) return;
  await c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND kind = ? AND revoked_at IS NULL")
    .bind(clock.now(), await sha256Hex(raw), kind)
    .run();
}

/** Start a session: store sha256 of a fresh random token, set the cookie. Any session already presented for this kind is revoked. */
export async function createSession(c: Context<AppEnv>, kind: SessionKind, email: string, staffId: number | null): Promise<void> {
  await revokeSession(c, kind);
  const raw = randomToken();
  const now = clock.now();
  await c.env.DB.prepare(
    "INSERT INTO sessions(id_hash, kind, email, staff_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(raw), kind, email, staffId, now, now + TTL_MS[kind], now)
    .run();
  writeCookie(c, kind, raw);
}

/** Reads the session cookies on every /api request; sets c.var.customerEmail / c.var.staff for valid sessions only. */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = c.env.DB;
  const now = clock.now();

  const custRaw = getCookie(c, SESSION_COOKIE.customer);
  if (custRaw) {
    const hash = await sha256Hex(custRaw);
    const row = await db
      .prepare("SELECT email FROM sessions WHERE id_hash = ? AND kind = 'customer' AND revoked_at IS NULL AND expires_at > ?")
      .bind(hash, now)
      .first<{ email: string }>();
    if (row) {
      c.set("customerEmail", row.email);
      c.set("sessionHash", hash);
    }
  }

  const staffRaw = getCookie(c, SESSION_COOKIE.staff);
  if (staffRaw) {
    const hash = await sha256Hex(staffRaw);
    // Joined on an ACTIVE staff row: deactivation takes effect on the next request.
    const row = await db
      .prepare(
        `SELECT st.id AS id, st.email AS email, st.name AS name, st.role AS role, s.expires_at AS expiresAt
         FROM sessions s JOIN staff st ON st.id = s.staff_id
         WHERE s.id_hash = ? AND s.kind = 'staff' AND s.revoked_at IS NULL AND s.expires_at > ? AND st.active = 1`,
      )
      .bind(hash, now)
      .first<StaffPrincipal & { expiresAt: number }>();
    if (row) {
      const { expiresAt, ...principal } = row;
      c.set("staff", principal);
      if (expiresAt - now < STAFF_REFRESH_BELOW_MS) {
        await db.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id_hash = ?").bind(now + TTL_MS.staff, now, hash).run();
        writeCookie(c, "staff", staffRaw);
      }
    }
  }
  await next();
};

export function requireCustomer(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.var.customerEmail) throw new HttpError(401, "auth_required");
    await next();
  };
}

export function requireStaff(role?: "admin"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const staff = c.var.staff;
    if (!staff) throw new HttpError(401, "auth_required");
    if (role && staff.role !== role) throw new HttpError(403, "forbidden");
    await next();
  };
}
