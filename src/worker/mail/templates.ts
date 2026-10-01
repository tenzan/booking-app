import type { Env } from "../env";
import { clock } from "../lib/clock";
import { randomToken, sha256Hex } from "../lib/crypto";
import { safeRedirect } from "../lib/redirect";
import { getSettings } from "../repos/settings";
import { fmtDateTime, t, tzLabel } from "../../shared/i18n/i18n";
import type { Settings } from "../../domain/settings";
import { renderEmail } from "./layout";
import type { EmailJobRow } from "./outbox";

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

interface ReservationData {
  id: string;
  ref: string;
  contact_email: string;
  contact_name: string;
  phone: string;
  issue: string;
  start_at: number;
  end_at: number;
  status: string;
  close_reason: string | null;
  account_name: string;
  customer_number: string;
  approver_name: string | null;
  tech_name: string | null;
  assigned_staff_id: number | null;
  closed_by_kind: string | null;
  /** Staff closer's name, or the raw closer (customer email). */
  closer_name: string | null;
  replaces_id: string | null;
  expires_at: number | null;
}

const LOGIN_TOKEN_MS = 15 * 60_000;
const ACCESS_GRACE_MS = 14 * 86_400_000;

/** Reservation statuses each template is valid for; anything else is skipped at send time. */
const VALID_STATUS: Record<string, string[]> = {
  request_received: ["pending", "confirmed"],
  new_request: ["pending"],
  confirmed: ["confirmed"],
  assigned: ["confirmed"],
  declined: ["declined"],
  cancelled: ["cancelled"],
  reassigned: ["confirmed"],
  expired: ["expired"],
  // Reminders are about a decision still open.
  approval_reminder: ["pending"],
  approval_escalation: ["pending"],
};

/** Is a job's message still true of the reservation as it is now? `to` is the technician a reassignment notice names. */
function stillTrue(template: string, status: string, assignedStaffId: number | null, payload: Record<string, unknown>): boolean {
  const valid = VALID_STATUS[template];
  if (!valid || !valid.includes(status)) return false;
  // A reassignment notice is only true while the appointment is still with the technician it names.
  return template !== "reassigned" || assignedStaffId === payload.to;
}

/**
 * Re-checks, right before sending, that the reservation still permits the job (it may have been cancelled between
 * the render and now). Jobs that are not about a reservation (logins) always pass. Narrows the race; it cannot close
 * it, since a state change can still land between this read and the send.
 */
export async function jobStillValid(env: Env, job: EmailJobRow): Promise<boolean> {
  if (!VALID_STATUS[job.template]) return true;
  if (!job.reservation_id) return false;
  const r = await env.DB.prepare("SELECT status, assigned_staff_id FROM reservations WHERE id = ?")
    .bind(job.reservation_id)
    .first<{ status: string; assigned_staff_id: number | null }>();
  return r !== null && stillTrue(job.template, r.status, r.assigned_staff_id, parsePayload(job));
}

function loadReservation(env: Env, id: string): Promise<ReservationData | null> {
  return env.DB.prepare(
    `SELECT r.id, r.ref, r.contact_email, r.contact_name, r.phone, r.issue, r.start_at, r.end_at, r.status, r.close_reason,
            c.name AS account_name, c.customer_number,
            approver.name AS approver_name, tech.name AS tech_name, r.assigned_staff_id, r.closed_by_kind,
            COALESCE(closer.name, r.closed_by) AS closer_name, r.replaces_id, r.expires_at
     FROM reservations r
     JOIN customers c ON c.id = r.customer_id
     LEFT JOIN staff approver ON approver.id = r.confirmed_by
     LEFT JOIN staff tech ON tech.id = r.assigned_staff_id
     LEFT JOIN staff closer ON r.closed_by_kind = 'staff' AND CAST(closer.id AS TEXT) = r.closed_by
     WHERE r.id = ?`,
  )
    .bind(id)
    .first<ReservationData>();
}

/** Mint a single-use login token; only its sha256 is stored. */
async function mintLoginToken(env: Env, kind: "customer" | "staff", email: string, redirectPath: string | null): Promise<string> {
  const token = randomToken();
  const now = clock.now();
  await env.DB.prepare(
    "INSERT INTO auth_tokens(token_hash, kind, email, redirect_path, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), kind, email, redirectPath, now, now + LOGIN_TOKEN_MS)
    .run();
  return token;
}

async function mintAccessToken(env: Env, r: ReservationData): Promise<string> {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO access_tokens(token_hash, reservation_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), r.id, clock.now(), r.end_at + ACCESS_GRACE_MS)
    .run();
  return token;
}

async function staffNames(env: Env, ids: unknown[]): Promise<Map<number, string>> {
  const wanted = ids.filter((id): id is number => typeof id === "number");
  if (wanted.length === 0) return new Map();
  const { results } = await env.DB.prepare(`SELECT id, name FROM staff WHERE id IN (${wanted.map(() => "?").join(",")})`)
    .bind(...wanted)
    .all<{ id: number; name: string }>();
  return new Map(results.map((s) => [s.id, s.name]));
}

function parsePayload(job: EmailJobRow): Record<string, unknown> {
  try {
    const p: unknown = JSON.parse(job.payload);
    return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function renderLogin(env: Env, job: EmailJobRow, s: Settings, kind: "customer" | "staff"): Promise<Rendered> {
  const token = await mintLoginToken(env, kind, job.to_email, safeRedirect(parsePayload(job).redirectPath));
  const path = kind === "customer" ? "/auth/verify" : "/staff/auth/verify";
  const url = `${env.APP_BASE_URL}${path}#t=${token}`;
  const k = kind === "customer" ? "email.customerLogin" : "email.staffLogin";
  const subject = t(`${k}.subject`, { org: s.orgName });
  const mail = renderEmail({
    orgName: s.orgName,
    paragraphs: [t(`${k}.body`)],
    actions: [{ label: t(`${k}.button`), url, primary: true }],
    after: kind === "customer" ? [t("email.customerLogin.ignore")] : [],
    footer: t("email.footer.login", { org: s.orgName }),
  });
  return { subject, ...mail };
}

export async function renderJob(env: Env, job: EmailJobRow): Promise<Rendered | "skip"> {
  const s = await getSettings(env.DB, env);
  if (job.template === "customer_login") return renderLogin(env, job, s, "customer");
  if (job.template === "staff_login") return renderLogin(env, job, s, "staff");

  if (!VALID_STATUS[job.template]) throw new Error(`unknown email template: ${job.template}`);
  const r = job.reservation_id ? await loadReservation(env, job.reservation_id) : null;
  const payload = parsePayload(job);
  if (!r || !stillTrue(job.template, r.status, r.assigned_staff_id, payload)) return "skip";

  const locale = env.APP_LOCALE || "en-US";
  const when = `${fmtDateTime(r.start_at, env.APP_TIMEZONE, locale)} ${tzLabel(env.APP_TIMEZONE, r.start_at, locale)}`;
  const common: Array<[string, string]> = [
    [t("common.account"), r.account_name],
    [t("common.when"), when],
    [t("common.reference"), r.ref],
  ];
  const base = { orgName: s.orgName };
  const staffUrl = `${env.APP_BASE_URL}/staff/r/${encodeURIComponent(r.id)}`;
  const staffFooter = t("email.footer.staff", { org: s.orgName });
  const customerFooter = t("email.footer.customer", { org: s.orgName });

  switch (job.template) {
    case "request_received":
    case "confirmed": {
      const accessToken = await mintAccessToken(env, r);
      const viewUrl = `${env.APP_BASE_URL}/r#t=${accessToken}`;
      // Valid only while pending or confirmed (see VALID_STATUS), exactly when the customer can still cancel.
      const actions = [
        { label: t("common.viewReservation"), url: viewUrl, primary: true },
        { label: t("common.cancelReservation"), url: `${viewUrl}&action=cancel` },
      ];
      if (job.template === "request_received") {
        return {
          subject: t("email.requestReceived.subject", { ref: r.ref }),
          ...renderEmail({
            ...base,
            banner: { text: t("status.pending"), tone: "amber" },
            paragraphs: [t("email.requestReceived.intro")],
            facts: common,
            actions,
            footer: customerFooter,
          }),
        };
      }
      return {
        subject: t("email.confirmed.subject", { when, ref: r.ref }),
        ...renderEmail({
          ...base,
          banner: { text: t("status.confirmed"), tone: "green" },
          paragraphs: [
            t("email.confirmed.intro"),
            t("email.confirmed.call", { phone: r.phone, tool: s.remoteToolName }),
            ...(s.customerInstructions ? [s.customerInstructions] : []),
          ],
          facts: common,
          actions,
          footer: customerFooter,
        }),
      };
    }
    case "declined": {
      return {
        subject: t("email.declined.subject", { ref: r.ref }),
        ...renderEmail({
          ...base,
          banner: { text: t("status.declined"), tone: "red" },
          paragraphs: [t("email.declined.intro"), ...(r.close_reason ? [t("email.declined.reason", { reason: r.close_reason })] : [])],
          facts: common,
          actions: [{ label: t("email.declined.rebook"), url: env.APP_BASE_URL, primary: true }],
          footer: customerFooter,
        }),
      };
    }
    case "cancelled": {
      if (payload.audience === "team") {
        const by =
          r.closed_by_kind === "staff"
            ? t("email.cancelledTeam.byStaff", { name: r.closer_name ?? "—" })
            : t("email.cancelledTeam.byCustomer", { email: r.closer_name ?? "—" });
        return {
          subject: t("email.cancelledTeam.subject", { ref: r.ref, when }),
          ...renderEmail({
            ...base,
            banner: { text: t("status.cancelled"), tone: "red" },
            paragraphs: [by],
            facts: [
              [t("common.account"), r.account_name],
              [t("common.customerNumber"), r.customer_number],
              [t("common.contact"), `${r.contact_name} <${r.contact_email}>`],
              [t("common.when"), when],
              [t("common.reference"), r.ref],
              ...(r.tech_name ? [[t("common.technician"), r.tech_name] as [string, string]] : []),
              ...(r.close_reason ? [[t("common.reason"), r.close_reason] as [string, string]] : []),
            ],
            actions: [{ label: t("email.newRequest.details"), url: staffUrl, primary: true }],
            footer: staffFooter,
          }),
        };
      }
      const byTeam = r.closed_by_kind === "staff";
      return {
        subject: t("email.cancelled.subject", { when, ref: r.ref }),
        ...renderEmail({
          ...base,
          banner: { text: t("status.cancelled"), tone: "red" },
          paragraphs: [
            t(byTeam ? "email.cancelled.byTeam" : "email.cancelled.byYou"),
            ...(byTeam && r.close_reason ? [t("email.cancelled.reason", { reason: r.close_reason })] : []),
          ],
          facts: common,
          actions: [{ label: t("email.cancelled.rebook"), url: env.APP_BASE_URL, primary: true }],
          footer: customerFooter,
        }),
      };
    }
    case "expired": {
      if (payload.audience === "team") {
        return {
          subject: t("email.expiredTeam.subject", { ref: r.ref, when }),
          ...renderEmail({
            ...base,
            banner: { text: t("status.expired"), tone: "red" },
            paragraphs: [t("email.expiredTeam.intro"), ...(r.replaces_id ? [t("email.expiredTeam.replacement")] : [])],
            facts: [
              [t("common.account"), r.account_name],
              [t("common.customerNumber"), r.customer_number],
              [t("common.contact"), `${r.contact_name} <${r.contact_email}>`],
              [t("common.when"), when],
              [t("common.reference"), r.ref],
            ],
            actions: [{ label: t("email.newRequest.details"), url: staffUrl, primary: true }],
            footer: staffFooter,
          }),
        };
      }
      return {
        subject: t("email.expired.subject", { ref: r.ref }),
        ...renderEmail({
          ...base,
          banner: { text: t("status.expired"), tone: "red" },
          // A request to change an existing appointment: the appointment itself is untouched.
          paragraphs: [t("email.expired.intro"), ...(r.replaces_id ? [t("email.expired.replacement")] : [])],
          facts: common,
          actions: [{ label: t("email.expired.rebook"), url: env.APP_BASE_URL, primary: true }],
          footer: customerFooter,
        }),
      };
    }
    case "approval_reminder":
    case "approval_escalation": {
      const key = job.template === "approval_reminder" ? "email.approvalReminder" : "email.approvalEscalation";
      const deadline = r.expires_at === null ? "—" : `${fmtDateTime(r.expires_at, env.APP_TIMEZONE, locale)} ${tzLabel(env.APP_TIMEZONE, r.expires_at, locale)}`;
      return {
        subject: t(`${key}.subject`, { ref: r.ref, when }),
        ...renderEmail({
          ...base,
          banner: { text: t("status.pending"), tone: "amber" },
          paragraphs: [t(`${key}.intro`)],
          facts: [
            [t("common.account"), r.account_name],
            [t("common.customerNumber"), r.customer_number],
            [t("common.contact"), `${r.contact_name} <${r.contact_email}>`],
            [t("common.when"), when],
            [t("common.reference"), r.ref],
            [t("common.approvalDeadline"), deadline],
          ],
          actions: [{ label: t("email.newRequest.details"), url: staffUrl, primary: true }],
          footer: staffFooter,
        }),
      };
    }
    case "reassigned": {
      if (payload.audience === "customer") {
        const viewUrl = `${env.APP_BASE_URL}/r#t=${await mintAccessToken(env, r)}`;
        return {
          subject: t("email.reassignedCustomer.subject", { ref: r.ref }),
          ...renderEmail({
            ...base,
            banner: { text: t("status.confirmed"), tone: "green" },
            paragraphs: [t("email.reassignedCustomer.intro"), t("email.confirmed.call", { phone: r.phone, tool: s.remoteToolName })],
            facts: common,
            actions: [
              { label: t("common.viewReservation"), url: viewUrl, primary: true },
              { label: t("common.cancelReservation"), url: `${viewUrl}&action=cancel` },
            ],
            footer: customerFooter,
          }),
        };
      }
      const names = await staffNames(env, [payload.from, payload.to, payload.by]);
      const name = (id: unknown) => (typeof id === "number" ? names.get(id) : undefined) ?? "—";
      const params = { by: name(payload.by), from: name(payload.from), to: name(payload.to) };
      return {
        subject: t("email.reassigned.subject", { ref: r.ref, to: params.to }),
        ...renderEmail({
          ...base,
          banner: { text: t("status.confirmed"), tone: "green" },
          paragraphs: [t("email.reassigned.intro", params), t("email.reassigned.unchanged")],
          facts: [...common, [t("common.technician"), params.to]],
          actions: [{ label: t("email.newRequest.details"), url: staffUrl, primary: true }],
          footer: staffFooter,
        }),
      };
    }
    case "new_request": {
      const q = (query: string) => `${staffUrl}?${query}`;
      return {
        subject: t("email.newRequest.subject", { ref: r.ref, when }),
        ...renderEmail({
          ...base,
          paragraphs: [t("email.newRequest.intro")],
          facts: [
            [t("common.account"), r.account_name],
            [t("common.customerNumber"), r.customer_number],
            [t("common.contact"), `${r.contact_name} <${r.contact_email}>`],
            [t("common.callbackPhone"), r.phone],
            [t("common.issue"), r.issue],
            [t("common.when"), when],
            [t("common.reference"), r.ref],
            [t("common.status"), t(`status.${r.status}`)],
          ],
          actions: [
            { label: t("email.newRequest.approveMe"), url: q("action=approve&assign=me"), primary: true },
            { label: t("email.newRequest.approve"), url: q("action=approve") },
            { label: t("email.newRequest.propose"), url: q("action=propose") },
            { label: t("email.newRequest.details"), url: staffUrl },
          ],
          footer: staffFooter,
        }),
      };
    }
    default: {
      // assigned
      const names = { approver: r.approver_name ?? "—", tech: r.tech_name ?? "—" };
      return {
        subject: t("email.assigned.subject", { ref: r.ref, tech: names.tech }),
        ...renderEmail({
          ...base,
          banner: { text: t("status.confirmed"), tone: "green" },
          paragraphs: [t("email.assigned.intro", names)],
          facts: [...common, [t("common.technician"), names.tech]],
          actions: [{ label: t("email.newRequest.details"), url: staffUrl, primary: true }],
          footer: staffFooter,
        }),
      };
    }
  }
}
