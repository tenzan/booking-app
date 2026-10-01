import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router";
import { EMAIL_STATUSES } from "../../../shared/schemas";
import type { EmailJobDTO, EmailListDTO, EmailSummaryDTO } from "../../../shared/types";
import { apiFetch, isApiError, queryKeys, safePath, useMe } from "../../api";
import { Button } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton, Spinner } from "../../components/Spinner";
import { Toast, useToast } from "../../components/Toast";
import { TimezoneNote } from "../../components/TimezoneNote";
import { fmtDateTime, LOCALE, t } from "../../i18n";
import { actionErrorText } from "./detail/shared";
import { templateLabel } from "./emailLabels";

const k = (key: string, params?: Record<string, string | number>) => t(`web.staff.emails.${key}`, params);

type Status = (typeof EMAIL_STATUSES)[number];
const readStatus = (s: string | null): Status => (EMAIL_STATUSES.includes(s as Status) ? (s as Status) : "failed");

/** Where the back link goes: the page that linked here when it said so in history state, else the dashboard. */
function readBack(state: unknown): { to: string; label: string; state?: object } {
  const back = (state as { back?: { to?: unknown; label?: unknown; state?: unknown } } | null)?.back;
  const to = typeof back?.to === "string" ? safePath(back.to) : null;
  if (!to || typeof back?.label !== "string" || back.label === "") return { to: "/staff", label: t("web.staff.nav.dashboard") };
  const returnState = typeof back.state === "object" && back.state !== null && !Array.isArray(back.state) ? back.state : undefined;
  return { to, label: back.label, state: returnState };
}

/** `/staff/emails[?status=failed|queued|sent|skipped|cancelled]` — email delivery. Everyone looks; admins retry failures. */
export default function EmailsPage() {
  usePageTitle(k("heading"));
  const me = useMe();
  const tz = me.data?.timezone ?? "UTC";
  const isAdmin = me.data?.staff?.role === "admin";
  const [params, setParams] = useSearchParams();
  const status = readStatus(params.get("status"));
  const { toast, show, dismiss } = useToast();
  // Read once: switching tabs rewrites the URL (and drops the history state).
  const backTo = useRef(readBack(useLocation().state)).current;

  const summary = useQuery({
    queryKey: queryKeys.emailSummary,
    queryFn: () => apiFetch<EmailSummaryDTO>("/api/staff/emails/summary"),
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
  });
  const list = useInfiniteQuery({
    queryKey: queryKeys.emailList(status),
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ status });
      if (pageParam) p.set("cursor", pageParam);
      return apiFetch<EmailListDTO>(`/api/staff/emails?${p}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: "always",
    // The queue drains within a minute or so: keep the queued and failed views current.
    refetchInterval: status === "queued" || status === "failed" ? 30_000 : false,
  });
  const emails = list.data?.pages.flatMap((p) => p.emails) ?? [];
  const switching = list.isFetching && list.isPlaceholderData;

  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    if (focusFrom.current === null || list.isFetchingNextPage) return;
    const next = emails[focusFrom.current];
    focusFrom.current = null;
    if (next) document.getElementById(`email-${next.id}`)?.focus();
  }, [emails.length, list.isFetchingNextPage]);

  const counts: Partial<Record<Status, number>> = summary.data ? { failed: summary.data.failed, queued: summary.data.queued } : {};
  const select = (s: Status) => setParams(s === "failed" ? {} : { status: s }, { replace: true, preventScrollReset: true });

  const resultText =
    list.isSuccess && !switching
      ? emails.length === 0
        ? k(`empty.${status}`)
        : list.hasNextPage
          ? k("resultsMore", { n: emails.length })
          : emails.length === 1
            ? k("resultsOne")
            : k("results", { n: emails.length })
      : "";

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          to={backTo.to}
          state={backTo.state}
          className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-slate-800"
        >
          <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M19 12H5m5 5-5-5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {backTo.label}
        </Link>
        <PageHeading>{k("heading")}</PageHeading>
        <p className="text-slate-600 dark:text-slate-400">{k("lead")}</p>
        <TimezoneNote tz={tz} />
        {me.data?.staff && !isAdmin && <p className="pt-1 text-slate-600 dark:text-slate-400">{k("techNote")}</p>}
      </div>

      <StatusTabs status={status} counts={counts} onSelect={select}>
        {(panel) => (
          <div {...panel} className="space-y-4 outline-none">
            <div className="flex min-h-6 items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              {switching && <Spinner className="size-4" />}
              <p role="status" aria-live="polite">
                {switching ? t("web.common.loading") : resultText}
              </p>
            </div>
            {list.isPending ? (
              <div className="space-y-2" aria-busy="true">
                <span className="sr-only">{t("web.common.loading")}</span>
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            ) : list.isError && emails.length === 0 ? (
              <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
                {k("loadFailed")}
                <Button variant="secondary" onClick={() => void list.refetch()}>
                  {t("web.common.retry")}
                </Button>
              </Notice>
            ) : emails.length === 0 ? (
              <EmptyState title={k(`empty.${status}`)} body={k(`emptyBody.${status}`)} />
            ) : (
              <div className={`space-y-4 transition-opacity ${switching ? "opacity-60" : ""}`} aria-busy={switching || undefined}>
                <Card flush>
                  <ul className="divide-y divide-slate-200 dark:divide-slate-800" aria-label={k(`tabs.${status}`)}>
                    {emails.map((j) => (
                      <li key={j.id} id={`email-${j.id}`} tabIndex={-1} className="outline-none focus-visible:outline-2 focus-visible:-outline-offset-2">
                        <EmailRow j={j} tz={tz} canRetry={isAdmin && j.status === "failed"} onOutcome={show} />
                      </li>
                    ))}
                  </ul>
                </Card>
                {/* Always rendered so a failed "Load more" is announced. */}
                <div aria-live="polite">{list.isFetchNextPageError && <Notice tone="error">{k("loadMoreFailed")}</Notice>}</div>
                {list.hasNextPage && !switching && (
                  <div className="flex justify-center">
                    <Button
                      variant="secondary"
                      loading={list.isFetchingNextPage}
                      className="w-full sm:w-auto"
                      onClick={() => {
                        focusFrom.current = emails.length;
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
        )}
      </StatusTabs>
      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}

/** ARIA tabs over the delivery statuses; arrows move (and select), Home/End jump. Phones scroll the row sideways. */
function StatusTabs({
  status,
  counts,
  onSelect,
  children,
}: {
  status: Status;
  counts: Partial<Record<Status, number>>;
  onSelect: (s: Status) => void;
  children: (panel: { id: string; role: "tabpanel"; "aria-labelledby": string; tabIndex: number }) => ReactNode;
}) {
  const base = useId();
  const refs = useRef(new Map<Status, HTMLButtonElement>());
  const tabId = (s: Status) => `${base}-tab-${s}`;
  const all = EMAIL_STATUSES;

  function onKeyDown(e: KeyboardEvent) {
    const i = all.indexOf(status);
    const next =
      e.key === "ArrowRight" ? all[(i + 1) % all.length] : e.key === "ArrowLeft" ? all[(i - 1 + all.length) % all.length] : e.key === "Home" ? all[0] : e.key === "End" ? all[all.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    onSelect(next);
    refs.current.get(next)?.focus();
  }

  return (
    <div className="space-y-4">
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div role="tablist" aria-label={k("tabsLabel")} onKeyDown={onKeyDown} className="inline-flex gap-1 rounded-xl bg-slate-200/70 p-1 dark:bg-slate-800">
          {all.map((s) => {
            const active = s === status;
            const n = counts[s];
            return (
              <button
                key={s}
                ref={(el) => void (el ? refs.current.set(s, el) : refs.current.delete(s))}
                id={tabId(s)}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`${base}-panel`}
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(s)}
                className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-semibold whitespace-nowrap transition-colors sm:px-4 ${
                  active
                    ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white"
                    : "text-slate-600 hover:bg-white/60 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700/60 dark:hover:text-white"
                }`}
              >
                {k(`tabs.${s}`)}
                {n !== undefined && n > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-xs font-bold tabular-nums ${
                      s === "failed" ? "bg-red-700 text-white dark:bg-red-500" : "bg-slate-300 text-slate-800 dark:bg-slate-600 dark:text-slate-100"
                    }`}
                  >
                    <span className="sr-only">(</span>
                    {n}
                    <span className="sr-only">)</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {children({ id: `${base}-panel`, role: "tabpanel", "aria-labelledby": tabId(status), tabIndex: 0 })}
    </div>
  );
}

/**
 * One email. Outcomes that remove the row from this list (retried, or no longer failed) go to the page's toast with
 * focus on the page, since the row and anything in it disappear on the refresh.
 */
function EmailRow({ j, tz, canRetry, onOutcome }: { j: EmailJobDTO; tz: string; canRetry: boolean; onOutcome: (text: string) => void }) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const askId = useId();
  const retryRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const when = (ms: number) => fmtDateTime(ms, tz, LOCALE);

  useEffect(() => {
    if (asking) cancelRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      retryRef.current?.focus();
    }
  }, [asking]);

  const leaveRow = (text: string) => {
    onOutcome(text);
    document.getElementById("main")?.focus({ preventScroll: true });
    void qc.invalidateQueries({ queryKey: queryKeys.emails });
  };

  const retry = useMutation({
    mutationFn: () => apiFetch<{ ok: true }>(`/api/staff/emails/${encodeURIComponent(j.id)}/retry`, { method: "POST" }),
    onMutate: () => setProblem(null),
    onSuccess: () => {
      leaveRow(k("retried", { template: templateLabel(j.template) }));
    },
    onError: (e) => {
      if (isApiError(e, 401)) return;
      if (isApiError(e, 409, "not_failed") || isApiError(e, 404)) {
        leaveRow(k("notFailed"));
        return;
      }
      returnFocus.current = true;
      setAsking(false);
      if (isApiError(e, 403)) setProblem(k("adminOnly"));
      else setProblem(actionErrorText(e));
    },
  });

  const cancel = () => {
    returnFocus.current = true;
    setAsking(false);
  };

  return (
    <div className="space-y-2 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <p className="font-semibold break-words">
            {templateLabel(j.template)}
            {j.ref && j.reservationId && (
              <>
                {" · "}
                <Link
                  to={`/staff/r/${encodeURIComponent(j.reservationId)}`}
                  className="font-mono font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300"
                >
                  {j.ref}
                </Link>
              </>
            )}
          </p>
          <p className="text-sm break-all text-slate-700 dark:text-slate-300">{k("to", { to: j.to })}</p>
        </div>
        {canRetry && !asking && (
          <Button ref={retryRef} variant="secondary" onClick={() => setAsking(true)} aria-label={k("retryLabel", { template: templateLabel(j.template), to: j.to })}>
            <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {k("retry")}
          </Button>
        )}
      </div>

      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
        <div className="flex gap-1.5">
          <dt>{k("created")}</dt>
          <dd className="tabular-nums">{when(j.createdAt)}</dd>
        </div>
        {j.sentAt !== null && (
          <div className="flex gap-1.5">
            <dt>{k("sent")}</dt>
            <dd className="tabular-nums">{when(j.sentAt)}</dd>
          </div>
        )}
        {j.status === "queued" && (
          <div className="flex gap-1.5">
            <dt>{k("nextAttempt")}</dt>
            <dd className="tabular-nums">{when(j.sendAfter)}</dd>
          </div>
        )}
        {(j.attempts > 0 || j.status === "failed") && (
          <div className="flex gap-1.5">
            <dt>{k("attempts")}</dt>
            <dd className="tabular-nums">{j.attempts}</dd>
          </div>
        )}
      </dl>

      {j.lastError && (
        <details className="group text-sm">
          <summary
            className={`inline-flex min-h-8 cursor-pointer items-center gap-1 font-medium select-none ${
              j.status === "failed" ? "text-red-800 dark:text-red-300" : "text-slate-600 dark:text-slate-400"
            }`}
          >
            <svg className="size-4 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {k("lastError")}
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-slate-100 p-3 font-mono text-xs break-all whitespace-pre-wrap text-slate-800 dark:bg-slate-800 dark:text-slate-200">
            {j.lastError}
          </pre>
        </details>
      )}

      {canRetry && asking && (
        <div
          role="group"
          aria-labelledby={askId}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !retry.isPending) cancel();
          }}
          className="space-y-3 rounded-xl border border-slate-300 bg-slate-50 p-4 dark:border-slate-600 dark:bg-slate-800/50"
        >
          <p id={askId} className="font-medium">
            {k("retryAsk", { to: j.to })}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button loading={retry.isPending} onClick={() => retry.mutate()}>
              {retry.isPending ? k("retrying") : k("retryConfirm")}
            </Button>
            <Button ref={cancelRef} variant="secondary" disabled={retry.isPending} onClick={cancel}>
              {k("keep")}
            </Button>
          </div>
        </div>
      )}

      {/* Always rendered so a failed retry is announced; it takes no space while empty. */}
      <div aria-live="polite">{problem && <Notice tone="error">{problem}</Notice>}</div>
    </div>
  );
}
