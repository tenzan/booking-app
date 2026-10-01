import { Hono, type Context } from "hono";
import { z } from "zod";
import { emailSchema } from "../../shared/schemas";
import type { AppEnv } from "../env";
import { audit } from "../lib/db";
import { sha256Hex, uuid } from "../lib/crypto";
import { clock } from "../lib/clock";
import { HttpError, readJson } from "../lib/http";
import { rateLimit } from "../lib/rate-limit";
import { safeRedirect } from "../lib/redirect";
import { verifyTurnstile } from "../lib/turnstile";
import { enqueueEmail, kickOutbox } from "../mail/outbox";
import { clearSessionCookie, createSession, requireStaff, revokeSession, type SessionKind } from "../middleware/session";
import { eligibleAccountsForEmail } from "../repos/customers";
import { getSettings } from "../repos/settings";
import { activeStaffByEmail, ensureBootstrapAdmin } from "../repos/staff";

const WINDOW_MS = 15 * 60_000;

export const authRoutes = new Hono<AppEnv>();

const tokenSchema = z.string().min(1).max(200);
const requestSchema = z.object({
  email: emailSchema,
  turnstileToken: z.string().max(4096).optional(),
  redirectPath: z.string().max(2048).optional(),
});

const clientIp = (c: Context<AppEnv>): string | null => c.req.header("cf-connecting-ip") ?? null;

/**
 * Shared by request and resend. Always performs the same lookups and never reveals the outcome:
 * a link is sent only when Turnstile passes (failures return before any bucket is charged), no rate limit trips and the address is eligible.
 */
async function sendLoginLink(
  c: Context<AppEnv>,
  kind: SessionKind,
  email: string,
  redirectPath: string | null,
  turnstile: { token?: string } | "skip",
): Promise<void> {
  const db = c.env.DB;
  // Booking paused: customer links are neither sent nor counted (before Turnstile and the buckets). Staff sign-in is unaffected.
  if (kind === "customer" && !(await getSettings(db, c.env)).bookingEnabled) return;
  const ip = clientIp(c);
  // A failed CAPTCHA must not charge the buckets, or anyone could lock out an address without solving one.
  if (turnstile !== "skip" && !(await verifyTurnstile(c.env, turnstile.token, ip))) return;
  const emailOk = await rateLimit(db, `login:email:${email}`, 3, WINDOW_MS);
  const ipOk = ip ? await rateLimit(db, `login:ip:${ip}`, 20, WINDOW_MS) : true;
  const allowed = emailOk && ipOk;

  let eligible: boolean;
  if (kind === "customer") {
    eligible = (await eligibleAccountsForEmail(db, email)).length > 0;
  } else {
    if (allowed) await ensureBootstrapAdmin(db, c.env, email);
    eligible = (await activeStaffByEmail(db, email)) !== null;
  }

  if (allowed && eligible) {
    await enqueueEmail(db, {
      template: kind === "customer" ? "customer_login" : "staff_login",
      to: email,
      dedupeKey: `login:${uuid()}`,
      payload: { redirectPath },
    }).run();
    kickOutbox(c);
  }
}

for (const kind of ["customer", "staff"] as const) {
  authRoutes.post(`/auth/${kind}/request`, async (c) => {
    const body = await readJson(c, requestSchema);
    await sendLoginLink(c, kind, body.email, safeRedirect(body.redirectPath), { token: body.turnstileToken });
    return c.json({ ok: true });
  });
}

authRoutes.post("/auth/resend", async (c) => {
  const { token } = await readJson(c, z.object({ token: tokenSchema }));
  const row = await c.env.DB.prepare("SELECT kind, email, redirect_path FROM auth_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ kind: SessionKind; email: string; redirect_path: string | null }>();
  if (row) {
    await sendLoginLink(c, row.kind, row.email.toLowerCase(), safeRedirect(row.redirect_path), "skip");
  } else {
    const ip = clientIp(c);
    if (ip) await rateLimit(c.env.DB, `login:ip:${ip}`, 20, WINDOW_MS);
  }
  return c.json({ ok: true });
});

authRoutes.post("/auth/redeem", async (c) => {
  const { token } = await readJson(c, z.object({ token: tokenSchema }));
  const db = c.env.DB;
  const ip = clientIp(c);
  if (ip && !(await rateLimit(db, `redeem:ip:${ip}`, 30, WINDOW_MS))) throw new HttpError(429, "rate_limited");

  const row = await db
    .prepare("SELECT id, kind, email, redirect_path, expires_at, used_at FROM auth_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ id: number; kind: SessionKind; email: string; redirect_path: string | null; expires_at: number; used_at: number | null }>();
  if (!row) throw new HttpError(400, "invalid_link");

  const now = clock.now();
  if (row.used_at !== null || row.expires_at <= now) return c.json({ error: "expired_link", kind: row.kind }, 410);
  const claim = await db
    .prepare("UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, row.id, now)
    .run();
  if (claim.meta.changes !== 1) return c.json({ error: "expired_link", kind: row.kind }, 410);

  // Eligibility is re-checked at redemption: access may have been revoked since the link was sent.
  if (row.kind === "customer") {
    if ((await eligibleAccountsForEmail(db, row.email)).length === 0) throw new HttpError(403, "not_eligible");
    await createSession(c, "customer", row.email.toLowerCase(), null);
    await audit(db, { actorKind: "customer", actor: row.email.toLowerCase(), action: "auth.customer_signin" }).run();
  } else {
    const staff = await activeStaffByEmail(db, row.email);
    if (!staff) throw new HttpError(403, "not_eligible");
    await createSession(c, "staff", staff.email, staff.id);
    await audit(db, { actorKind: "staff", actor: String(staff.id), action: "auth.staff_signin", details: { email: staff.email } }).run();
  }
  return c.json({ kind: row.kind, redirectPath: safeRedirect(row.redirect_path) });
});

authRoutes.post("/auth/logout", async (c) => {
  const { kind } = await readJson(c, z.object({ kind: z.enum(["customer", "staff"]) }));
  await revokeSession(c, kind);
  clearSessionCookie(c, kind);
  return c.json({ ok: true });
});

authRoutes.get("/auth/me", async (c) => {
  const settings = await getSettings(c.env.DB, c.env);
  return c.json({
    customer: c.var.customerEmail ? { email: c.var.customerEmail } : null,
    staff: c.var.staff ?? null,
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null,
    orgName: settings.orgName,
    timezone: c.env.APP_TIMEZONE,
    bookingEnabled: settings.bookingEnabled,
    supportPhone: settings.supportPhone,
  });
});

authRoutes.get("/staff/me", requireStaff(), (c) => c.json(c.var.staff));
