import { useEffect, useId, useRef, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router";
import type { AuditEntryDTO, AuditListDTO, EmailSummaryDTO } from "../../../shared/types";
import { apiFetch, queryKeys, useMe, type TeamList } from "../../api";
import { Button } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton, Spinner } from "../../components/Spinner";
import { TimezoneNote } from "../../components/TimezoneNote";
import { dateIn, fmtDateWithYear, fmtMinuteRange, fmtTime, fmtWeekday, todayIn, addDays } from "../../format";
import { fmtDateTime, LOCALE, t, tNodes } from "../../i18n";
import { auditReasonText } from "./detail/History";
import { templateLabel } from "./emailLabels";

const k = (key: string, params?: Record<string, string | number>) => t(`web.staff.activity.${key}`, params);

/** Filter chips → the audit API's comma-separated action terms (`prefix.` or exact). Sign-ins only show under All. */
const CATEGORIES = {
  all: "",
  reservations: "reservation.",
  schedule: "schedule.window.,schedule.override.,schedule.unavailability.,schedule.holiday.",
  settings: "settings.,schedule.settings.",
  staff: "staff.,schedule.staff.",
  customers: "customer.,customers.",
  email: "email.",
} as const;
type Category = keyof typeof CATEGORIES;
const CATEGORY_KEYS = Object.keys(CATEGORIES) as Category[];
const readCategory = (s: string | null): Category => (CATEGORY_KEYS.includes(s as Category) ? (s as Category) : "all");

function useAudit(category: Category, actor: string) {
  const action = CATEGORIES[category];
  return useInfiniteQuery({
    queryKey: queryKeys.audit(action, actor),
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (action) p.set("action", action);
      if (actor) p.set("actor", actor);
      if (pageParam) p.set("cursor", pageParam);
      return apiFetch<AuditListDTO>(`/api/staff/audit?${p}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: "always",
  });
}

/** `/staff/activity[?type=…&actor=<staff id>]` — who did what, newest first. */
export default function ActivityPage() {
  usePageTitle(k("heading"));
  const me = useMe();
  const tz = me.data?.timezone ?? "UTC";
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const category = readCategory(params.get("type"));
  const actor = /^\d+$/.test(params.get("actor") ?? "") ? params.get("actor")! : "";
  const ids = useId();

  const team = useQuery({ queryKey: queryKeys.team, queryFn: () => apiFetch<TeamList>("/api/staff/team") });
  const names = new Map((team.data?.staff ?? []).map((s) => [s.id, s.name]));
  const byEmail = new Map((team.data?.staff ?? []).map((s) => [s.email.toLowerCase(), s.name]));
  const members = [...(team.data?.staff ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const summary = useQuery({
    queryKey: queryKeys.emailSummary,
    queryFn: () => apiFetch<EmailSummaryDTO>("/api/staff/emails/summary"),
    refetchInterval: 60_000,
  });

  const list = useAudit(category, actor);
  const entries = list.data?.pages.flatMap((p) => p.entries) ?? [];
  const switching = list.isFetching && list.isPlaceholderData;

  const update = (next: { type?: Category; actor?: string }) => {
    // From the live URL: router navigations are transitions, so `params` can lag a filter changed a moment ago.
    const p = new URLSearchParams(window.location.search);
    if (next.type !== undefined) (next.type === "all" ? p.delete("type") : p.set("type", next.type));
    if (next.actor !== undefined) (next.actor === "" ? p.delete("actor") : p.set("actor", next.actor));
    setParams(p, { replace: true, preventScrollReset: true });
  };

  // "Load more": focus the first newly loaded entry so keyboard and screen-reader users carry on from there.
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    if (focusFrom.current === null || list.isFetchingNextPage) return;
    const next = entries[focusFrom.current];
    focusFrom.current = null;
    if (next) document.getElementById(`activity-${next.id}`)?.focus();
  }, [entries.length, list.isFetchingNextPage]);

  // Group by the day each entry happened on (entries arrive newest first).
  const today = todayIn(tz);
  const groups: Array<{ date: string; items: AuditEntryDTO[] }> = [];
  for (const e of entries) {
    const date = dateIn(e.at, tz);
    const last = groups.at(-1);
    if (last?.date === date) last.items.push(e);
    else groups.push({ date, items: [e] });
  }
  const dayHeading = (date: string) =>
    date === today ? k("today") : date === addDays(today, -1) ? k("yesterday") : fmtDateWithYear(date);

  const filtered = category !== "all" || actor !== "";
  const resultText =
    list.isSuccess && !switching
      ? entries.length === 0
        ? filtered
          ? k("noMatches")
          : k("empty")
        : list.hasNextPage
          ? k("resultsMore", { n: entries.length })
          : entries.length === 1
            ? k("resultsOne")
            : k("results", { n: entries.length })
      : "";
  const failed = summary.data?.failed ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <PageHeading>{k("heading")}</PageHeading>
          <p className="text-slate-600 dark:text-slate-400">{k("lead")}</p>
          <TimezoneNote tz={tz} />
        </div>
        <Link
          to="/staff/emails"
          state={{ back: { to: `/staff/activity${location.search}`, label: t("web.staff.nav.activity") } }}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 font-semibold text-slate-900 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
        >
          <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.75" />
            <path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {k("emailsLink")}
          {failed > 0 && (
            <span className="rounded-full bg-red-700 px-2 py-0.5 text-xs font-bold text-white tabular-nums dark:bg-red-500">
              {failed === 1 ? k("failedBadgeOne") : k("failedBadge", { n: failed })}
            </span>
          )}
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-end">
        <fieldset className="min-w-0">
          <legend className="mb-1.5 block text-sm font-medium">{k("typeLabel")}</legend>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
            {CATEGORY_KEYS.map((c) => (
              <label
                key={c}
                className="inline-flex min-h-11 shrink-0 cursor-pointer items-center rounded-full border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 has-checked:border-blue-700 has-checked:bg-blue-700 has-checked:text-white has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 lg:min-h-9 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:has-checked:border-blue-500 dark:has-checked:bg-blue-600"
              >
                <input type="radio" name={`${ids}-type`} value={c} checked={category === c} onChange={() => update({ type: c })} className="sr-only" />
                {k(`types.${c}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor={`${ids}-actor`} className="mb-1.5 block text-sm font-medium">
            {k("actorLabel")}
          </label>
          <select
            id={`${ids}-actor`}
            value={actor}
            onChange={(e) => update({ actor: e.target.value })}
            className="block min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">{k("anyone")}</option>
            {actor !== "" && !members.some((s) => String(s.id) === actor) && <option value={actor}>{k("unknownActor")}</option>}
            {members.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.active ? s.name : k("inactiveMember", { name: s.name })}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex min-h-6 items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        {switching && <Spinner className="size-4" />}
        <p role="status" aria-live="polite">
          {switching ? t("web.common.loading") : resultText}
        </p>
      </div>

      {list.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <span className="sr-only">{t("web.common.loading")}</span>
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : list.isError && entries.length === 0 ? (
        <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
          {k("loadFailed")}
          <Button variant="secondary" onClick={() => void list.refetch()}>
            {t("web.common.retry")}
          </Button>
        </Notice>
      ) : entries.length === 0 ? (
        <EmptyState
          title={filtered ? k("noMatches") : k("empty")}
          body={filtered ? k("noMatchesBody") : undefined}
          action={
            filtered ? (
              <Button variant="secondary" onClick={() => update({ type: "all", actor: "" })}>
                {k("clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={`space-y-6 transition-opacity ${switching ? "opacity-60" : ""}`} aria-busy={switching || undefined}>
          {groups.map((g) => (
            <section key={g.date} aria-labelledby={`${ids}-${g.date}`} className="space-y-2">
              <h2 id={`${ids}-${g.date}`} className="text-sm font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400">
                {dayHeading(g.date)}
              </h2>
              <Card flush>
                <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                  {g.items.map((e) => (
                    <li key={e.id} id={`activity-${e.id}`} tabIndex={-1} className="outline-none focus-visible:outline-2 focus-visible:-outline-offset-2">
                      <Entry e={e} tz={tz} names={names} byEmail={byEmail} />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
          {/* Always rendered so a failed "Load more" is announced. */}
          <div aria-live="polite">{list.isFetchNextPageError && <Notice tone="error">{k("loadMoreFailed")}</Notice>}</div>
          {list.hasNextPage && !switching && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                loading={list.isFetchingNextPage}
                className="w-full sm:w-auto"
                onClick={() => {
                  focusFrom.current = entries.length;
                  void list.fetchNextPage();
                }}
              >
                {list.isFetchingNextPage ? k("loadingMore") : k("loadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- One entry -------------------------------------------------------------------------------------------------------

type Details = Record<string, unknown>;
const asObj = (v: unknown): Details => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Details) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const refLink = (e: AuditEntryDTO): ReactNode =>
  e.reservationId ? (
    <Link to={`/staff/r/${encodeURIComponent(e.reservationId)}`} className="font-mono font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300">
      {e.reservationRef ?? k("aRequest")}
    </Link>
  ) : (
    k("aRequest")
  );

/** The catalog sentence for an entry: `{ key, params }` under web.staff.activity.events, or null for the generic fallback. */
function describe(e: AuditEntryDTO, tz: string, names: Map<number, string>): { key: string; params: Record<string, ReactNode> } | null {
  const d = asObj(e.details);
  const staffName = (id: unknown) => (num(id) !== null ? (names.get(num(id)!) ?? k("someone")) : k("someone"));
  const p: Record<string, ReactNode> = {};
  const hoursText = (w: unknown) => {
    const o = asObj(w);
    const s = num(o.startMin);
    const en = num(o.endMin);
    const range = s !== null && en !== null ? fmtMinuteRange(s, en) : "";
    return num(o.weekday) !== null ? `${fmtWeekday(num(o.weekday)!)} ${range}` : range;
  };
  switch (e.action) {
    case "reservation.requested": {
      const start = num(d.startAt);
      if (start === null) return { key: "reservation_requestedNoTime", params: { ref: refLink(e) } };
      const when = fmtDateTime(start, tz, LOCALE);
      return { key: str(d.replacesId) ? "reservation_requestedReplacement" : "reservation_requested", params: { ref: refLink(e), when } };
    }
    case "reservation.approved":
      return { key: "reservation_approved", params: { ref: refLink(e), tech: staffName(d.assignedStaffId) } };
    case "reservation.declined":
      return { key: "reservation_declined", params: { ref: refLink(e) } };
    case "reservation.cancelled":
      // Closed because another reservation took over (the customer's change request).
      if (str(d.replacedBy) && d.reason === "rescheduled") return { key: "reservation_cancelledRescheduled", params: { ref: refLink(e) } };
      if (str(d.replacedBy) && d.reason === "superseded") return { key: "reservation_cancelledSuperseded", params: { ref: refLink(e) } };
      return { key: "reservation_cancelled", params: { ref: refLink(e) } };
    case "reservation.expired":
      // `silent`: the news was stale when the sweep got to it (the time had passed, or a day late), so nobody was emailed.
      return { key: d.silent === true ? "reservation_expiredSilent" : "reservation_expired", params: { ref: refLink(e) } };
    case "reservation.completed":
      return { key: "reservation_completed", params: { ref: refLink(e) } };
    case "reservation.proposed": {
      const n = Array.isArray(d.options) ? d.options.length : 0;
      return { key: n === 1 ? "reservation_proposedOne" : n > 1 ? "reservation_proposedN" : "reservation_proposed", params: { ref: refLink(e), n } };
    }
    case "reservation.proposal_withdrawn":
      return { key: "reservation_proposal_withdrawn", params: { ref: refLink(e) } };
    case "reservation.proposal_rejected":
      return { key: d.via === "replacement" ? "reservation_proposal_rejectedReplacement" : "reservation_proposal_rejected", params: { ref: refLink(e) } };
    case "reservation.proposal_expired":
      return { key: d.silent === true ? "reservation_proposal_expiredSilent" : "reservation_proposal_expired", params: { ref: refLink(e) } };
    case "reservation.rescheduled": {
      const start = num(asObj(d.to).startAt);
      return start === null
        ? { key: "reservation_rescheduledNoTime", params: { ref: refLink(e) } }
        : { key: "reservation_rescheduled", params: { ref: refLink(e), when: fmtDateTime(start, tz, LOCALE) } };
    }
    case "reservation.reassigned":
      return { key: "reservation_reassigned", params: { ref: refLink(e), from: staffName(d.from), to: staffName(d.to) } };
    case "email.retry": {
      const template = templateLabel(str(d.template) ?? "");
      return e.reservationId ? { key: "email_retryFor", params: { template, ref: refLink(e) } } : { key: "email_retry", params: { template } };
    }
    case "email.inbound_relayed": {
      const from = str(d.from) ?? "—";
      return e.reservationId || str(d.ref)
        ? { key: "email_inbound_relayed", params: { from, ref: e.reservationId ? refLink(e) : str(d.ref)! } }
        : { key: "email_inbound_relayedNoRef", params: { from } };
    }
    case "auth.staff_signin":
      return { key: "auth_staff_signin", params: p };
    case "auth.customer_signin":
      return { key: "auth_customer_signin", params: p };
    case "customer.create":
      return { key: "customer_create", params: { name: str(d.name) ?? "—", number: str(d.customerNumber) ?? "—" } };
    case "customer.update":
      return { key: "customer_update", params: p };
    case "customer.activate":
    case "customer.deactivate":
      return { key: e.action.replace(".", "_"), params: { number: str(d.customerNumber) ?? "—" } };
    case "customer.contact.add":
    case "customer.contact.update":
    case "customer.contact.remove":
      return { key: e.action.replaceAll(".", "_"), params: { email: str(d.email) ?? "—" } };
    case "customers.import":
      return { key: "customers_import", params: { created: num(d.created) ?? 0, updated: num(d.updated) ?? 0 } };
    case "customers.import_partial":
      return { key: "customers_import_partial", params: { done: num(d.committedChunks) ?? 0, total: num(d.totalChunks) ?? 0 } };
    case "staff.create":
      return { key: "staff_create", params: { name: str(d.name) ?? "—" } };
    case "staff.update":
      return { key: "staff_update", params: { name: staffName(d.id) } };
    case "staff.bootstrap_admin":
      return { key: "staff_bootstrap_admin", params: { email: str(d.email) ?? "—" } };
    case "settings.booking":
      return { key: d.enabled === false ? "settings_booking_off" : "settings_booking_on", params: p };
    case "schedule.window.create":
    case "schedule.window.update":
      return { key: e.action.replaceAll(".", "_"), params: { window: hoursText(d.window) } };
    case "schedule.window.delete":
      return { key: "schedule_window_delete", params: p };
    case "schedule.override.set": {
      const date = str(d.date);
      const closed = Array.isArray(d.windows) && d.windows.length === 0;
      return { key: closed ? "schedule_override_closed" : "schedule_override_set", params: { date: date ? fmtDateWithYear(date) : "—" } };
    }
    case "schedule.override.clear":
    case "schedule.holiday.delete": {
      const date = str(d.date);
      return { key: e.action.replaceAll(".", "_"), params: { date: date ? fmtDateWithYear(date) : "—" } };
    }
    case "schedule.holiday.set": {
      const date = str(d.date);
      return { key: "schedule_holiday_set", params: { name: str(d.name) ?? "—", date: date ? fmtDateWithYear(date) : "—" } };
    }
    case "schedule.holiday.bulk":
      return { key: "schedule_holiday_bulk", params: { n: Array.isArray(d.set) ? d.set.length : 0 } };
    case "schedule.unavailability.create": {
      const s = num(d.startAt);
      const en = num(d.endAt);
      const range = s !== null && en !== null ? `${fmtDateTime(s, tz, LOCALE)} – ${fmtDateTime(en, tz, LOCALE)}` : "—";
      return { key: "schedule_unavailability_create", params: { staff: staffName(d.staffId), range } };
    }
    case "schedule.unavailability.delete":
      return { key: "schedule_unavailability_delete", params: { staff: staffName(d.staffId) } };
    case "schedule.staff.update":
      return { key: "schedule_staff_update", params: { staff: staffName(d.id) } };
    case "schedule.settings.update":
      return { key: "schedule_settings_update", params: p };
    default:
      return null;
  }
}

function Entry({ e, tz, names, byEmail }: { e: AuditEntryDTO; tz: string; names: Map<number, string>; byEmail: Map<string, string> }) {
  // Staff sign-ins record the address rather than the id: show the team member's name when we know it.
  const shown = e.actor === null ? t("web.staff.detail.system") : e.actorKind === "staff" ? (byEmail.get(e.actor.toLowerCase()) ?? e.actor) : e.actor;
  const actor = <strong className="font-semibold break-all sm:break-words">{shown}</strong>;
  const described = describe(e, tz, names);
  const sentence = described
    ? tNodes(`web.staff.activity.events.${described.key}`, { actor, ...described.params })
    : tNodes("web.staff.activity.events.fallback", { actor, action: <code className="font-mono text-sm">{e.action}</code> });
  const d = asObj(e.details);
  // A reason the system set (a replaced reservation) is already in the sentence: only typed reasons are quoted.
  const typed = str(d.reason);
  const reason = typed !== null && auditReasonText(e.action, d, typed) === typed ? typed : null;
  const moved = Array.isArray(d.moved) ? d.moved.length : 0;
  const hasDetails = Object.keys(d).length > 0;

  return (
    <div className="flex gap-3 px-4 py-3.5 sm:gap-4 sm:px-5">
      <time dateTime={new Date(e.at).toISOString()} className="w-12 shrink-0 pt-0.5 text-sm text-slate-500 tabular-nums dark:text-slate-400">
        {fmtTime(e.at, tz)}
      </time>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="break-words">{sentence}</p>
        {reason && <p className="text-sm break-words whitespace-pre-wrap text-slate-700 dark:text-slate-300">“{reason}”</p>}
        {moved > 0 && <p className="text-sm text-slate-600 dark:text-slate-400">{moved === 1 ? k("movedOne") : k("moved", { n: moved })}</p>}
        {(e.customerId !== null || hasDetails) && (
          <div className="flex flex-wrap items-start gap-x-4 gap-y-1 text-sm">
            {e.customerId !== null && (
              <Link to={`/staff/customers/${e.customerId}`} className="inline-flex min-h-8 items-center font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300">
                {k("viewCustomer")}
              </Link>
            )}
            {hasDetails && (
              <details className="group min-w-0 open:basis-full">
                <summary className="inline-flex min-h-8 cursor-pointer items-center gap-1 font-medium text-slate-600 select-none hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
                  <svg className="size-4 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {k("details")}
                </summary>
                {/* Text only: React escapes it, so stored values can never become markup. */}
                <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-slate-100 p-3 font-mono text-xs break-all whitespace-pre-wrap text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                  {JSON.stringify(d, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
