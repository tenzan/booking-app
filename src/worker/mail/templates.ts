import type { Env } from "../env";
import { clock } from "../lib/clock";
import { randomToken, sha256Hex } from "../lib/crypto";
import { safeRedirect } from "../lib/redirect";
import { getSettings } from "../repos/settings";
import { fmtDateTime, t, tzLabel } from "../../shared/i18n/i18n";
import type { Settings } from "../../domain/settings";
import { MIN } from "../../domain/time";
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
  /** The reservation a replacement request asks to change: its reference and current status. */
  replaces_ref: string | null;
  replaces_status: string | null;
  expires_at: number | null;
  /** The reservation's open proposal, if any. */
  open_proposal_id: string | null;
}

/** Selects a reservation's open proposal id as `open_proposal_id` (reservation aliased `r`). */
const OPEN_PROPOSAL_SQL = "(SELECT p.id FROM proposals p WHERE p.reservation_id = r.id AND p.status = 'open') AS open_proposal_id";

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
  // A reminder is for the confirmed appointment at the start it was queued for.
  appointment_reminder: ["confirmed"],
  // About the original time, which still stands (proposals are open on pending and confirmed reservations only).
  proposal: ["pending", "confirmed"],
  proposal_outcome: ["pending", "confirmed"],
  // About the confirmed appointment at the start it was moved to.
  rescheduled: ["confirmed"],
};

/** Is a job's message still true of the reservation as it is now? `to` is the technician a reassignment notice names. */
function stillTrue(
  template: string,
  state: { status: string; assigned_staff_id: number | null; start_at: number; open_proposal_id: string | null },
  payload: Record<string, unknown>,
): boolean {
  const valid = VALID_STATUS[template];
  if (!valid || !valid.includes(state.status)) return false;
  // Proposed times are only on offer while that very proposal is open (not superseded, withdrawn or answered).
  if (template === "proposal") return state.open_proposal_id === payload.proposalId;
  // An outcome is out of date once another proposal is open: that one's own mail is what the customer needs.
  if (template === "proposal_outcome") return state.open_proposal_id === null;
  // A reminder or reschedule notice for a start the appointment no longer has (it was moved) would name the wrong time.
  if (template === "appointment_reminder" || template === "rescheduled") return state.start_at === payload.startAt;
  // A reassignment notice is only true while the appointment is still with the technician it names.
  return template !== "reassigned" || state.assigned_staff_id === payload.to;
}

/**
 * Re-checks, right before sending, that the reservation still permits the job (it may have been cancelled between
 * the render and now). Jobs that are not about a reservation (logins) always pass. Narrows the race; it cannot close
 * it, since a state change can still land between this read and the send.
 */
export async function jobStillValid(env: Env, job: EmailJobRow): Promise<boolean> {
  if (!VALID_STATUS[job.template]) return true;
  if (!job.reservation_id) return false;
  const r = await env.DB.prepare(`SELECT r.status, r.assigned_staff_id, r.start_at, ${OPEN_PROPOSAL_SQL} FROM reservations r WHERE r.id = ?`)
    .bind(job.reservation_id)
    .first<{ status: string; assigned_staff_id: number | null; start_at: number; open_proposal_id: string | null }>();
  return r !== null && stillTrue(job.template, r, parsePayload(job));
}

function loadReservation(env: Env, id: string): Promise<ReservationData | null> {
  return env.DB.prepare(
    `SELECT r.id, r.ref, r.contact_email, r.contact_name, r.phone, r.issue, r.start_at, r.end_at, r.status, r.close_reason,
            c.name AS account_name, c.customer_number,
            approver.name AS approver_name, tech.name AS tech_name, r.assigned_staff_id, r.closed_by_kind,
            COALESCE(closer.name, r.closed_by) AS closer_name, r.replaces_id, orig.ref AS replaces_ref, orig.status AS replaces_status,
            r.expires_at, ${OPEN_PROPOSAL_SQL}
     FROM reservations r
     JOIN customers c ON c.id = r.customer_id
     LEFT JOIN reservations orig ON orig.id = r.replaces_id
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

interface ProposalData {
  message: string | null;
  expires_at: number;
  created_by_name: string | null;
  options: Array<{ id: string; start_at: number; staff_name: string }>;
}

async function loadProposal(env: Env, id: unknown): Promise<ProposalData | null> {
  if (typeof id !== "string") return null;
  const p = await env.DB.prepare(
    "SELECT p.message, p.expires_at, s.name AS created_by_name FROM proposals p LEFT JOIN staff s ON s.id = p.created_by WHERE p.id = ?",
  )
    .bind(id)
    .first<Omit<ProposalData, "options">>();
  if (!p) return null;
  const { results } = await env.DB.prepare(
    "SELECT o.id, o.start_at, s.name AS staff_name FROM proposal_options o JOIN staff s ON s.id = o.staff_id WHERE o.proposal_id = ? ORDER BY o.start_at, o.rowid",
  )
    .bind(id)
    .all<ProposalData["options"][number]>();
  return { ...p, options: results };
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
  if (!r || !stillTrue(job.template, r, payload)) return "skip";

  const locale = env.APP_LOCALE || "en-US";
  const fmt = (ms: number) => `${fmtDateTime(ms, env.APP_TIMEZONE, locale)} ${tzLabel(env.APP_TIMEZONE, ms, locale)}`;
  const when = fmt(r.start_at);
  const common: Array<[string, string]> = [
    [t("common.account"), r.account_name],
    [t("common.when"), when],
    [t("common.reference"), r.ref],
  ];
  const base = { orgName: s.orgName };
  const staffUrl = `${env.APP_BASE_URL}/staff/r/${encodeURIComponent(r.id)}`;
  const staffFooter = t("email.footer.staff", { org: s.orgName });
  const customerFooter = t("email.footer.customer", { org: s.orgName });
  // A replacement request whose original is still pending or confirmed: that original stays until this one is approved.
  const originalActive = r.replaces_ref !== null && (r.replaces_status === "pending" || r.replaces_status === "confirmed");
  const originalStays = originalActive
    ? [t(r.replaces_status === "confirmed" ? "email.replacement.appointmentStays" : "email.replacement.requestStays")]
    : [];

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
        const supersedes = typeof payload.supersedesRef === "string" ? payload.supersedesRef : null;
        const replacement = originalActive
          ? [
              supersedes
                ? t("email.requestReceived.supersedes", { previous: supersedes, ref: r.replaces_ref! })
                : t("email.requestReceived.replacement", { ref: r.replaces_ref! }),
            ]
          : [];
        return {
          subject: t("email.requestReceived.subject", { ref: r.ref }),
          ...renderEmail({
            ...base,
            banner: { text: t("status.pending"), tone: "amber" },
            paragraphs: [t("email.requestReceived.intro"), ...replacement],
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
    case "appointment_reminder": {
      const viewUrl = `${env.APP_BASE_URL}/r#t=${await mintAccessToken(env, r)}`;
      // The same rule the cancel endpoint applies, judged at send time: the customer may no longer be able to cancel online.
      const canCancel = r.start_at - s.cancelCutoffMin * MIN > clock.now();
      return {
        subject: t("email.reminder.subject", { when, ref: r.ref }),
        ...renderEmail({
          ...base,
          banner: { text: t("status.confirmed"), tone: "green" },
          paragraphs: [
            t("email.reminder.intro"),
            t("email.confirmed.call", { phone: r.phone, tool: s.remoteToolName }),
            ...(s.customerInstructions ? [s.customerInstructions] : []),
            ...(canCancel ? [] : [t(s.supportPhone ? "email.reminder.noCancelPhone" : "email.reminder.noCancel", { phone: s.supportPhone })]),
          ],
          facts: common,
          actions: [
            { label: t("common.viewReservation"), url: viewUrl, primary: true },
            ...(canCancel ? [{ label: t("common.cancelReservation"), url: `${viewUrl}&action=cancel` }] : []),
            { label: t("email.reminder.addToCalendar"), url: `${viewUrl}&action=ics` },
          ],
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
          paragraphs: [
            t("email.declined.intro"),
            ...(r.close_reason ? [t("email.declined.reason", { reason: r.close_reason })] : []),
            ...originalStays,
          ],
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
            paragraphs: [t("email.expiredTeam.intro"), ...(originalActive ? [t("email.expiredTeam.replacement", { ref: r.replaces_ref! })] : [])],
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
          // A request to change an existing reservation: that reservation itself is untouched.
          paragraphs: [t("email.expired.intro"), ...originalStays],
          facts: common,
          actions: [{ label: t("email.expired.rebook"), url: env.APP_BASE_URL, primary: true }],
          footer: customerFooter,
        }),
      };
    }
    case "approval_reminder":
    case "approval_escalation": {
      const key = job.template === "approval_reminder" ? "email.approvalReminder" : "email.approvalEscalation";
      const deadline = r.expires_at === null ? t("common.notSet") : `${fmtDateTime(r.expires_at, env.APP_TIMEZONE, locale)} ${tzLabel(env.APP_TIMEZONE, r.expires_at, locale)}`;
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
    case "proposal": {
      const p = await loadProposal(env, payload.proposalId);
      if (!p) return "skip";
      const confirmed = r.status === "confirmed";
      if (payload.audience === "team") {
        const currentLabel = t(confirmed ? "email.proposalTeam.current" : "email.proposalTeam.requested");
        return {
          subject: t("email.proposalTeam.subject", { ref: r.ref, when }),
          ...renderEmail({
            ...base,
            banner: { text: t("email.proposalTeam.banner"), tone: "amber" },
            paragraphs: [t("email.proposalTeam.intro", { by: p.created_by_name ?? "—" })],
            facts: [
              [t("common.account"), r.account_name],
              [t("common.customerNumber"), r.customer_number],
              [t("common.contact"), `${r.contact_name} <${r.contact_email}>`],
              [currentLabel, when],
              [t("common.reference"), r.ref],
              ...p.options.map((o, i): [string, string] => [
                t("email.proposalTeam.option", { n: i + 1 }),
                t("email.proposalTeam.optionValue", { when: fmt(o.start_at), tech: o.staff_name }),
              ]),
              ...(p.message ? [[t("email.proposalTeam.message"), p.message] as [string, string]] : []),
              [t("email.proposal.answerBy"), fmt(p.expires_at)],
            ],
            actions: [{ label: t("email.newRequest.details"), url: staffUrl, primary: true }],
            footer: staffFooter,
          }),
        };
      }
      const currentLabel = t(confirmed ? "email.proposal.current" : "email.proposal.requested");
      const viewUrl = `${env.APP_BASE_URL}/r#t=${await mintAccessToken(env, r)}`;
      const respond = `${viewUrl}&action=proposal`;
      return {
        subject: t("email.proposal.subject", { ref: r.ref }),
        ...renderEmail({
          ...base,
          banner: { text: t("email.proposal.banner"), tone: "amber" },
          paragraphs: [
            t(confirmed ? "email.proposal.introConfirmed" : "email.proposal.introPending"),
            ...(p.message ? [t("email.proposal.message", { message: p.message })] : []),
            t("email.proposal.choose"),
          ],
          facts: [
            [t("common.account"), r.account_name],
            [currentLabel, when],
            [t("common.reference"), r.ref],
            [t("email.proposal.answerBy"), fmt(p.expires_at)],
          ],
          actions: [
            ...p.options.map((o) => ({
              label: t("email.proposal.option", { when: fmt(o.start_at) }),
              url: `${respond}&option=${encodeURIComponent(o.id)}`,
              primary: true,
            })),
            ...(confirmed ? [{ label: t("email.proposal.keep"), url: `${respond}&choice=keep` }] : []),
            { label: t("email.proposal.other"), url: `${respond}&choice=other` },
          ],
          after: [t(confirmed ? "email.proposal.expiryConfirmed" : "email.proposal.expiryPending", { expires: fmt(p.expires_at) })],
          footer: customerFooter,
        }),
      };
    }
    case "proposal_outcome": {
      const outcome = payload.outcome;
      const confirmed = r.status === "confirmed";
      if (payload.audience === "team") {
        // The team hears of answers and expiry (a withdrawal is their own doing).
        if (outcome !== "accepted" && outcome !== "rejected" && outcome !== "expired") return "skip";
        // Rejected by a replacement request: the customer asked for another time rather than keeping this one.
        const k = `email.proposalOutcomeTeam.${outcome === "rejected" && payload.via === "replacement" ? "replaced" : outcome}`;
        const previous = typeof payload.fromStartAt === "number" ? fmt(payload.fromStartAt) : null;
        return {
          subject: t(`${k}.subject`, { ref: r.ref, when }),
          ...renderEmail({
            ...base,
            banner: confirmed ? { text: t("status.confirmed"), tone: "green" } : { text: t("status.pending"), tone: "amber" },
            paragraphs: [
              t(`${k}.intro`),
              ...(typeof payload.replacesRef === "string" ? [t("email.assigned.replaces", { ref: payload.replacesRef })] : []),
            ],
            facts: [
              [t("common.account"), r.account_name],
              [t("common.customerNumber"), r.customer_number],
              [t("common.contact"), `${r.contact_name} <${r.contact_email}>`],
              [t(outcome === "accepted" ? "email.rescheduled.newTime" : confirmed ? "email.proposalTeam.current" : "email.proposalTeam.requested"), when],
              ...(outcome === "accepted" && previous ? [[t("email.rescheduled.previousTime"), previous] as [string, string]] : []),
              [t("common.reference"), r.ref],
              ...(r.tech_name ? [[t("common.technician"), r.tech_name] as [string, string]] : []),
            ],
            actions: [{ label: t("email.newRequest.details"), url: staffUrl, primary: true }],
            footer: staffFooter,
          }),
        };
      }
      // Customer: the original time stands, never who takes it. An accepted option is told by `rescheduled` instead.
      if (outcome !== "rejected" && outcome !== "expired" && outcome !== "withdrawn") return "skip";
      const k = `email.proposalOutcome.${outcome}`;
      const viewUrl = `${env.APP_BASE_URL}/r#t=${await mintAccessToken(env, r)}`;
      return {
        subject: t(`${k}.subject`, { ref: r.ref }),
        ...renderEmail({
          ...base,
          banner: confirmed ? { text: t("status.confirmed"), tone: "green" } : { text: t("status.pending"), tone: "amber" },
          paragraphs: [t(`${k}.${confirmed ? "confirmed" : "pending"}`)],
          facts: common,
          actions: [{ label: t("common.viewReservation"), url: viewUrl, primary: true }],
          footer: customerFooter,
        }),
      };
    }
    case "rescheduled": {
      // The customer's one message about a move: an accepted proposal, or an approved replacement that cancelled the
      // reservation it replaces. Never names technicians.
      const viewUrl = `${env.APP_BASE_URL}/r#t=${await mintAccessToken(env, r)}`;
      const canCancel = r.start_at - s.cancelCutoffMin * MIN > clock.now();
      const previous = typeof payload.fromStartAt === "number" ? fmt(payload.fromStartAt) : null;
      const intro =
        payload.via === "replacement"
          ? t("email.rescheduled.introReplacement", { previous: typeof payload.replacesRef === "string" ? payload.replacesRef : "—" })
          : t(payload.fromStatus === "pending" ? "email.rescheduled.introConfirmed" : "email.rescheduled.introMoved");
      return {
        subject: t("email.rescheduled.subject", { when, ref: r.ref }),
        ...renderEmail({
          ...base,
          banner: { text: t("status.confirmed"), tone: "green" },
          paragraphs: [
            intro,
            t("email.confirmed.call", { phone: r.phone, tool: s.remoteToolName }),
            ...(s.customerInstructions ? [s.customerInstructions] : []),
          ],
          facts: [
            [t("common.account"), r.account_name],
            [t("email.rescheduled.newTime"), when],
            ...(previous ? [[t("email.rescheduled.previousTime"), previous] as [string, string]] : []),
            [t("common.reference"), r.ref],
          ],
          actions: [
            { label: t("common.viewReservation"), url: viewUrl, primary: true },
            ...(canCancel ? [{ label: t("common.cancelReservation"), url: `${viewUrl}&action=cancel` }] : []),
            { label: t("email.reminder.addToCalendar"), url: `${viewUrl}&action=ics` },
          ],
          footer: customerFooter,
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
            ...(r.replaces_ref ? [[t("email.newRequest.replaces"), r.replaces_ref] as [string, string]] : []),
            ...(typeof payload.supersedesRef === "string" ? [[t("email.newRequest.supersedes"), payload.supersedesRef] as [string, string]] : []),
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
      // A replacement: whether this approval cancelled the reservation it replaces (decided in the approving batch).
      const replaces = r.replaces_ref
        ? [t(payload.originalCancelled === true ? "email.assigned.replaces" : "email.assigned.replacesInactive", { ref: r.replaces_ref })]
        : [];
      return {
        subject: t("email.assigned.subject", { ref: r.ref, tech: names.tech }),
        ...renderEmail({
          ...base,
          banner: { text: t("status.confirmed"), tone: "green" },
          paragraphs: [t("email.assigned.intro", names), ...replaces],
          facts: [...common, [t("common.technician"), names.tech]],
          actions: [{ label: t("email.newRequest.details"), url: staffUrl, primary: true }],
          footer: staffFooter,
        }),
      };
    }
  }
}
