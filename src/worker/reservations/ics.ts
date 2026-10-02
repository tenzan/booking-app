import type { Context } from "hono";
import { buildIcs } from "../../domain/ics";
import { t } from "../../shared/i18n/i18n";
import type { AppEnv, Env } from "../env";
import { clock } from "../lib/clock";
import { HttpError } from "../lib/http";
import { getSettings } from "../repos/settings";

interface IcsRow {
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

async function loadRow(db: D1Database, id: string): Promise<IcsRow> {
  const row = await db
    .prepare(
      `SELECT r.id, r.ref, r.status, r.version, r.start_at, r.end_at, r.confirmed_at, r.phone, r.issue,
              r.contact_name, r.contact_email, c.name AS customer_name, asg.name AS assigned_name
       FROM reservations r
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN staff asg ON asg.id = r.assigned_staff_id
       WHERE r.id = ?`,
    )
    .bind(id)
    .first<IcsRow>();
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
export async function customerIcs(env: Env, reservationId: string): Promise<IcsFile> {
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
  const body = buildIcs({
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
  });
  return { ref: r.ref, body };
}

/** The staff event: names the customer, the contact and the assigned technician. Read-only. */
export async function staffIcs(env: Env, reservationId: string): Promise<IcsFile> {
  const r = await loadRow(env.DB, reservationId);
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
  const body = buildIcs({
    uid: uidFor(env, r.ref),
    sequence: r.version,
    method: "PUBLISH",
    status,
    startAt: r.start_at,
    endAt: r.end_at,
    stamp: clock.now(),
    summary: t("ics.staffSummary", { customer: r.customer_name, ref: r.ref }),
    description,
    url,
  });
  return { ref: r.ref, body };
}

/** A calendar attachment. The API-wide security headers (CSP, no-store, nosniff) are already set by the middleware. */
export const icsResponse = (c: Context<AppEnv>, file: IcsFile): Response =>
  c.body(file.body, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": `attachment; filename="${file.ref}.ics"`,
    "Cache-Control": "no-store",
  });
