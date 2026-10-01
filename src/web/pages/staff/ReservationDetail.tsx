import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import type { ReservationDTO, TechOption } from "../../../shared/types";
import { apiFetch, isApiError, queryKeys, safePath, useMe, type StaffReservationView } from "../../api";
import { Button, ButtonLink } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { StatusBadge, statusTone } from "../../components/StatusBadge";
import { TimezoneNote } from "../../components/TimezoneNote";
import { fmtStamp, fmtWhen } from "../../format";
import { t } from "../../i18n";
import { Countdown, useNow } from "./Countdown";
import { ApprovePanel } from "./detail/ApprovePanel";
import { DeclinePanel } from "./detail/DeclinePanel";
import { History } from "./detail/History";

type Action = "approve" | "decline" | "propose";
const ACTIONS: Action[] = ["approve", "decline", "propose"];
const asAction = (s: string | null): Action | null => (ACTIONS as Array<string | null>).includes(s) ? (s as Action) : null;

type PageNotice = { tone: "success" | "warning"; text: string };

/** Who closed or confirmed it, and when; null when the record doesn't say. */
function handledBy(r: ReservationDTO): { name: string; at: number } | null {
  if (r.status === "confirmed" && r.confirmedBy && r.confirmedAt !== null) return { name: r.confirmedBy.name, at: r.confirmedAt };
  if (r.closedAt !== null) return { name: r.closedBy ?? t("web.staff.detail.system"), at: r.closedAt };
  return null;
}

/** Where the back link goes: the page that linked here when it said so in history state (e.g. a customer), else the dashboard. */
function readBack(state: unknown): { to: string; label: string } | null {
  const back = (state as { back?: { to?: unknown; label?: unknown } } | null)?.back;
  const to = typeof back?.to === "string" ? safePath(back.to) : null;
  return to && typeof back?.label === "string" && back.label !== "" ? { to, label: back.label } : null;
}

/** `/staff/r/:id[?action=approve|decline|propose[&assign=me]]` — the links in staff notification emails land here. */
export default function ReservationDetail() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  // Read once: opening an action panel rewrites the URL (and drops the history state).
  const backTo = useRef(readBack(useLocation().state)).current;
  const qc = useQueryClient();
  const me = useMe();
  const tz = me.data?.timezone ?? "UTC";
  const action = asAction(params.get("action"));
  const assignMe = params.get("assign") === "me";
  const [notice, setNotice] = useState<PageNotice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  const key = queryKeys.staffReservation(id);
  const q = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<StaffReservationView>(`/api/staff/reservations/${encodeURIComponent(id)}`),
    refetchOnWindowFocus: "always",
  });
  usePageTitle(q.data ? t("web.staff.detail.heading", { ref: q.data.reservation.ref }) : t("web.common.loading"));

  // The panel that had focus is gone after approve/decline/stale: move focus to the result instead of <body>.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  const openPanel = (a: Action | null) => setParams(a ? { action: a } : {}, { replace: true });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.staffReservations });
  };

  const onDone = (text: string) => {
    setNotice({ tone: "success", text });
    openPanel(null);
    refresh();
  };

  const onStale = (current: ReservationDTO | undefined) => {
    const who = current && current.status !== "pending" ? handledBy(current) : null;
    setNotice({
      tone: "warning",
      text: who
        ? t("web.staff.detail.stale", { status: t(`web.statusShort.${current!.status}`), name: who.name, time: fmtStamp(who.at, tz) })
        : t("web.staff.detail.changed"),
    });
    if (current && current.status !== "pending") openPanel(null);
    refresh();
  };

  const onOptions = (options: TechOption[]) => {
    qc.setQueryData<StaffReservationView>(key, (old) => (old ? { ...old, techOptions: options } : old));
    refresh();
  };

  const back = (
    <Link
      to={backTo?.to ?? "/staff"}
      className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-slate-800"
    >
      <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M19 12H5m5 5-5-5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="break-words">{backTo?.label ?? t("web.staff.detail.back")}</span>
    </Link>
  );

  if (isApiError(q.error, 404)) {
    return (
      <div className="space-y-6">
        {back}
        <EmptyState
          title={t("web.staff.detail.notFoundHeading")}
          body={t("web.staff.detail.notFoundBody")}
          action={<ButtonLink to="/staff">{t("web.staff.nav.dashboard")}</ButtonLink>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {back}
      {q.isPending ? (
        <div className="space-y-4" aria-busy="true">
          <span className="sr-only">{t("web.staff.detail.loading")}</span>
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-24" />
          <Skeleton className="h-80" />
        </div>
      ) : q.isError ? (
        <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
          {t("web.staff.detail.loadFailed")}
          <Button variant="secondary" onClick={() => void q.refetch()}>
            {t("web.common.retry")}
          </Button>
        </Notice>
      ) : (
        <>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <PageHeading>{t("web.staff.detail.heading", { ref: q.data.reservation.ref })}</PageHeading>
              <StatusBadge status={q.data.reservation.status} />
            </div>
            {/* Always rendered so the result is announced; it takes no space while empty. */}
            <div aria-live="polite">
              {notice && (
                <Notice ref={noticeRef} tabIndex={-1} tone={notice.tone} className="mt-6 flex items-start justify-between gap-3">
                  <span className="pt-0.5">{notice.text}</span>
                  <button
                    type="button"
                    onClick={() => setNotice(null)}
                    className="-my-2 -mr-2 grid size-11 shrink-0 place-items-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
                    aria-label={t("web.common.dismiss")}
                  >
                    <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </Notice>
              )}
            </div>
          </div>
          <div className="grid items-start gap-6 lg:grid-cols-5">
            <div className="min-w-0 space-y-6 lg:col-span-3">
              <StatusBanner r={q.data.reservation} tz={tz} />
              <Facts r={q.data.reservation} tz={tz} />
            </div>
            <div className="min-w-0 space-y-6 lg:sticky lg:top-32 lg:col-span-2">
              {q.data.reservation.status === "pending" && (
                <ActionsCard action={action} onOpen={openPanel}>
                  {action === "approve" && (
                    <ApprovePanel
                      key={q.data.reservation.version}
                      r={q.data.reservation}
                      options={q.data.techOptions}
                      myId={me.data?.staff?.id ?? null}
                      assignMe={assignMe}
                      onOptions={onOptions}
                      onDone={onDone}
                      onStale={onStale}
                    />
                  )}
                  {action === "decline" && <DeclinePanel r={q.data.reservation} onDone={onDone} onStale={onStale} />}
                  {action === "propose" && <ProposeNote />}
                </ActionsCard>
              )}
              <History audit={q.data.audit} tz={tz} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatusBanner({ r, tz }: { r: ReservationDTO; tz: string }) {
  const now = useNow();
  const who = handledBy(r);
  const line =
    r.status === "pending"
      ? t("web.staff.detail.banner.pending")
      : r.status === "confirmed"
        ? t("web.staff.detail.banner.confirmed", {
            name: who?.name ?? "—",
            when: who ? fmtStamp(who.at, tz) : "—",
            tech: r.assignedStaff?.name ?? t("web.staff.dashboard.unassigned"),
          })
        : r.status === "completed"
          ? t("web.staff.detail.banner.completed")
          : t(`web.staff.detail.banner.${r.status}`, { name: who?.name ?? "—", when: who ? fmtStamp(who.at, tz) : "—" });
  return (
    <section className={`space-y-2 rounded-2xl border p-5 sm:p-6 ${statusTone[r.status].panel}`}>
      <p className="flex items-center gap-2 text-lg font-semibold">
        <span className={`size-3 shrink-0 rounded-full ${statusTone[r.status].dot}`} aria-hidden="true" />
        {t(`status.${r.status}`)}
      </p>
      <p className="break-words">{line}</p>
      {r.status === "declined" && r.closeReason && <p className="break-words whitespace-pre-wrap opacity-90">“{r.closeReason}”</p>}
      {r.status === "pending" && r.expiresAt !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-sm">
          <Countdown expiresAt={r.expiresAt} now={now} />
          <span>
            {t("web.staff.detail.deadline")}: {fmtStamp(r.expiresAt, tz)}
          </span>
        </div>
      )}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="-mt-2 min-w-0 break-words sm:mt-0">{children}</dd>
    </div>
  );
}

const linkClass = "font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300";

function Facts({ r, tz }: { r: ReservationDTO; tz: string }) {
  return (
    <Card className="space-y-5">
      <div>
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{t("common.when")}</p>
        <p className="text-lg font-semibold sm:text-xl">{fmtWhen(r.startAt, r.endAt, tz)}</p>
        <TimezoneNote tz={tz} atMs={r.startAt} className="mt-1" />
      </div>
      <dl className="grid gap-x-6 gap-y-3 border-t border-slate-200 pt-5 sm:grid-cols-[minmax(8rem,auto)_1fr] dark:border-slate-800">
        <Fact label={t("common.account")}>
          <span className="font-medium">{r.customer.name}</span>
          <span className="block text-sm text-slate-600 dark:text-slate-400">
            {t("web.book.account.number", { number: r.customer.number })}
            {!r.customer.active && (
              <span className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-semibold text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100">
                {t("web.staff.detail.inactiveAccount")}
              </span>
            )}
          </span>
        </Fact>
        <Fact label={t("common.contact")}>
          {r.contactName}
          <a href={`mailto:${r.contactEmail}`} className={`block text-sm ${linkClass}`}>
            {r.contactEmail}
          </a>
        </Fact>
        <Fact label={t("common.callbackPhone")}>
          <a href={`tel:${r.phone.replace(/[^0-9+]/g, "")}`} className={`inline-flex min-h-11 items-center gap-2 text-lg tabular-nums sm:min-h-0 ${linkClass}`}>
            <svg className="size-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinejoin="round"
              />
            </svg>
            {r.phone}
          </a>
        </Fact>
        <Fact label={t("common.issue")}>
          <p className="whitespace-pre-wrap">{r.issue}</p>
        </Fact>
        <Fact label={t("common.reference")}>
          <span className="font-mono">{r.ref}</span>
        </Fact>
        <Fact label={t("web.staff.detail.requested")}>{fmtStamp(r.createdAt, tz)}</Fact>
      </dl>
    </Card>
  );
}

function ActionsCard({ action, onOpen, children }: { action: Action | null; onOpen: (a: Action | null) => void; children: ReactNode }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const opened = useRef(false);
  // Focus the panel heading when the user opens a panel (not when the page loads with ?action=).
  useEffect(() => {
    if (opened.current && action) headingRef.current?.focus();
  }, [action]);

  const tab = (a: Action) => {
    const active = action === a;
    const tone =
      a === "approve"
        ? active
          ? "border-blue-700 bg-blue-700 text-white dark:border-blue-500 dark:bg-blue-600"
          : "border-slate-300 bg-white text-slate-900 hover:border-blue-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        : a === "decline"
          ? active
            ? "border-red-700 bg-red-700 text-white dark:border-red-500 dark:bg-red-600"
            : "border-slate-300 bg-white text-slate-900 hover:border-red-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          : active
            ? "border-slate-700 bg-slate-700 text-white dark:border-slate-400 dark:bg-slate-600"
            : "border-slate-300 bg-white text-slate-900 hover:border-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100";
    return (
      <button
        key={a}
        type="button"
        aria-expanded={active}
        aria-controls={active ? "action-panel" : undefined}
        onClick={() => {
          opened.current = true;
          onOpen(active ? null : a);
        }}
        className={`min-h-11 rounded-xl border px-3 text-sm font-semibold transition-colors ${a === "propose" ? "col-span-2 sm:col-span-1 lg:col-span-2" : ""} ${tone}`}
      >
        {t(`web.staff.detail.actions.${a}`)}
      </button>
    );
  };

  const headings: Record<Action, string> = {
    approve: t("web.staff.detail.approve.heading"),
    decline: t("web.staff.detail.decline.heading"),
    propose: t("web.staff.detail.propose.heading"),
  };

  return (
    <Card className="space-y-4">
      <div role="group" aria-label={t("web.staff.detail.actions.label")} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
        {ACTIONS.map(tab)}
      </div>
      {action && (
        <div id="action-panel" className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
            {headings[action]}
          </h2>
          {children}
        </div>
      )}
    </Card>
  );
}

function ProposeNote() {
  return (
    <div className="space-y-2">
      <span className="inline-flex rounded-full bg-violet-100 px-2.5 py-1 text-sm font-semibold text-violet-900 dark:bg-violet-400/15 dark:text-violet-200">
        {t("web.staff.detail.propose.comingSoon")}
      </span>
      <p className="text-slate-600 dark:text-slate-400">{t("web.staff.detail.propose.body")}</p>
    </div>
  );
}
