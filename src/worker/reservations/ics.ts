import type { Context } from "hono";
import { calendarWebLinks } from "../../domain/calendar-links";
import { buildIcs, type IcsEvent } from "../../domain/ics";
import { t } from "../../shared/i18n/i18n";
import type { CalendarLinks } from "../../shared/types";
import type { AppEnv, Env } from "../env";
import { clock } from "../lib/clock";
import { randomToken, sha256Hex } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { getSettings } from "../repos/settings";

/** Whose version of the event: the customer's (no technician) or the staff one (customer, contact, technician). */
export type CalendarAudience = "customer" | "staff";

export interface IcsRow {
  id: string;
  ref: string;
  status: string;
  version: number;
  start_at: number;
  end_at: number;
  confirmed_at: number | null;
  phone: string;
  issue: string;
  contact_name: string;
  contact_email: string;
  customer_name: string;
  assigned_name: string | null;
}

export interface IcsFile {
  ref: string;
  body: string;
}

/** The row every calendar event is built from; callers append their own WHERE (reservation aliased `r`). */
export const ICS_SELECT = `SELECT r.id, r.ref, r.status, r.version, r.start_at, r.end_at, r.confirmed_at, r.phone, r.issue,
        r.contact_name, r.contact_email, c.name AS customer_name, asg.name AS assigned_name
 FROM reservations r
 JOIN customers c ON c.id = r.customer_id
 LEFT JOIN staff asg ON asg.id = r.assigned_staff_id`;

async function loadRow(db: D1Database, id: string): Promise<IcsRow> {
  const row = await db.prepare(`${ICS_SELECT} WHERE r.id = ?`).bind(id).first<IcsRow>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

/** Only what has been in someone's calendar: confirmed, or cancelled after it was confirmed. Anything else has no event. */
function eventStatus(r: IcsRow): "CONFIRMED" | "CANCELLED" {
  if (r.status === "confirmed") return "CONFIRMED";
  if (r.status === "cancelled" && r.confirmed_at !== null) return "CANCELLED";
  throw new HttpError(409, "not_confirmed");
}

const baseUrl = (env: Env) => env.APP_BASE_URL.replace(/\/+$/, "");
/** `ref@host`: stable and unique per reservation, so a re-imported file updates the same event. */
const uidFor = (env: Env, ref: string) => `${ref}@${new URL(env.APP_BASE_URL).hostname}`;

/**
 * The customer's event for a reservation the caller has already proven access to. It links to the customer's
 * reservations page (reached by signing in) and never to a token link, since the file may be forwarded or stored
 * anywhere; it never names a technician.
 */
async function customerEvent(env: Env, reservationId: string): Promise<{ ref: string; event: IcsEvent }> {
  const r = await loadRow(env.DB, reservationId);
  const status = eventStatus(r);
  const s = await getSettings(env.DB, env);
  const url = `${baseUrl(env)}/my`;
  const description = [
    t("ics.reference", { ref: r.ref }),
    ...(status === "CANCELLED"
      ? [t("ics.cancelled")]
      : [t("ics.call", { phone: r.phone }), t("ics.ready", { tool: s.remoteToolName }), ...(s.customerInstructions ? [s.customerInstructions] : [])]),
    t("ics.link", { url }),
  ].join("\n");
  return {
    ref: r.ref,
    event: {
      uid: uidFor(env, r.ref),
      sequence: r.version,
      method: "PUBLISH",
      status,
      startAt: r.start_at,
      endAt: r.end_at,
      stamp: clock.now(),
      summary: t("ics.customerSummary", { org: s.orgName }),
      description,
      url,
    },
  };
}

/** The staff event for a row: customer, contact, phone, issue and technician. `summary` overrides the title (feeds). */
export function staffEventFromRow(env: Env, r: IcsRow, summary?: string): IcsEvent {
  const status = eventStatus(r);
  const url = `${baseUrl(env)}/staff/r/${encodeURIComponent(r.id)}`;
  const description = [
    t("ics.reference", { ref: r.ref }),
    t("ics.contact", { name: r.contact_name, email: r.contact_email }),
    t("ics.phone", { phone: r.phone }),
    t("ics.issue", { issue: r.issue }),
    t("ics.technician", { name: r.assigned_name ?? t("common.notSet") }),
    ...(status === "CANCELLED" ? [t("ics.cancelled")] : []),
    t("ics.link", { url }),
  ].join("\n");
  return {
    uid: uidFor(env, r.ref),
    sequence: r.version,
    method: "PUBLISH",
    status,
    startAt: r.start_at,
    endAt: r.end_at,
    stamp: clock.now(),
    summary: summary ?? t("ics.staffSummary", { customer: r.customer_name, ref: r.ref }),
    description,
    url,
  };
}

/** The staff event: names the customer, the contact and the assigned technician. Read-only. */
async function staffEvent(env: Env, reservationId: string): Promise<{ ref: string; event: IcsEvent }> {
  const r = await loadRow(env.DB, reservationId);
  return { ref: r.ref, event: staffEventFromRow(env, r) };
}

const eventFor = (env: Env, reservationId: string, audience: CalendarAudience) =>
  audience === "customer" ? customerEvent(env, reservationId) : staffEvent(env, reservationId);

/** The audience's calendar file for a reservation the caller has already proven access to. */
export async function calendarFile(env: Env, reservationId: string, audience: CalendarAudience): Promise<IcsFile> {
  const { ref, event } = await eventFor(env, reservationId, audience);
  return { ref, body: buildIcs(event) };
}

export const customerIcs = (env: Env, reservationId: string) => calendarFile(env, reservationId, "customer");
export const staffIcs = (env: Env, reservationId: string) => calendarFile(env, reservationId, "staff");

/**
 * "Add to calendar" links for a confirmed appointment: Google, Outlook.com and Microsoft 365 forms pre-filled with the
 * same text as the audience's .ics, and `ics()`, the URL that serves that file (called only once the appointment is
 * known to qualify, so nothing is minted for one that doesn't). A cancelled appointment has none (409 not_confirmed):
 * a web calendar form can only add an event, never remove one.
 */
export async function calendarLinks(
  env: Env,
  reservationId: string,
  audience: CalendarAudience,
  ics: () => string | Promise<string>,
): Promise<CalendarLinks> {
  const { event } = await eventFor(env, reservationId, audience);
  if (event.status !== "CONFIRMED") throw new HttpError(409, "not_confirmed");
  return { ics: await ics(), ...calendarWebLinks(event) };
}

/** How long a calendar link minted for a page stays valid: the page asks again when it has gone stale. */
export const WEB_CALENDAR_TOKEN_MS = 60 * 60_000;

/** The customer's links for a page (the email-link page or "My reservations"), with a fresh short-lived file link. */
export const customerWebCalendarLinks = (env: Env, reservationId: string) =>
  calendarLinks(env, reservationId, "customer", async () =>
    calendarFileUrl(env, await mintCalendarToken(env.DB, reservationId, "customer", clock.now() + WEB_CALENDAR_TOKEN_MS)),
  );

/** Read-only, so it may sit in a URL; the plain token is returned once and only its hash is stored. */
export async function mintCalendarToken(db: D1Database, reservationId: string, audience: CalendarAudience, expiresAt: number): Promise<string> {
  const token = randomToken();
  await db
    .prepare("INSERT INTO calendar_tokens(token_hash, reservation_id, audience, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), reservationId, audience, clock.now(), expiresAt)
    .run();
  return token;
}

/** The reservation and audience an unexpired calendar token reads. */
export async function calendarTokenTarget(db: D1Database, tokenHash: string, now: number): Promise<{ id: string; audience: CalendarAudience } | null> {
  const row = await db
    .prepare("SELECT reservation_id, audience FROM calendar_tokens WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, now)
    .first<{ reservation_id: string; audience: CalendarAudience }>();
  return row ? { id: row.reservation_id, audience: row.audience } : null;
}

/** Where a calendar token's file is served: one tap from an email opens it in the device's calendar. */
export const calendarFileUrl = (env: Env, token: string) => `${baseUrl(env)}/api/cal/${token}.ics`;

/** A calendar attachment. The API-wide security headers (CSP, no-store, nosniff) are already set by the middleware. */
export const icsResponse = (c: Context<AppEnv>, file: IcsFile): Response =>
  c.body(file.body, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": `attachment; filename="${file.ref}.ics"`,
    "Cache-Control": "no-store",
  });
