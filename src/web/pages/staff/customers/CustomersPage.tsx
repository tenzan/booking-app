import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router";
import { CUSTOMER_SEARCH_MAX } from "../../../../shared/schemas";
import type { CustomerListDTO, CustomerListItemDTO } from "../../../../shared/types";
import { apiFetch, queryKeys, useMe } from "../../../api";
import { Button, ButtonLink } from "../../../components/Button";
import { Card, Notice } from "../../../components/Card";
import { inputClass } from "../../../components/Field";
import { PageHeading, usePageTitle } from "../../../components/Layout";
import { Skeleton, Spinner } from "../../../components/Spinner";
import { t } from "../../../i18n";
import { contactsSummary, cu, StatusChip, type CustomersBackState } from "./shared";

type Status = "active" | "inactive" | "all";
const STATUSES: Status[] = ["active", "inactive", "all"];
const DEFAULT_STATUS: Status = "active";
const DEBOUNCE_MS = 300;

const readStatus = (raw: string | null): Status => (STATUSES.includes(raw as Status) ? (raw as Status) : DEFAULT_STATUS);

function listUrl(query: string, status: Status, cursor?: string): string {
  const p = new URLSearchParams({ query, status });
  if (cursor) p.set("cursor", cursor);
  return `/api/staff/customers?${p}`;
}

/** Customer pages, 50 at a time; "Load more" appends the next page and keeps the ones already loaded. */
function useCustomerList(query: string, status: Status) {
  return useInfiniteQuery({
    queryKey: queryKeys.customerList(query, status),
    queryFn: ({ pageParam }) => apiFetch<CustomerListDTO>(listUrl(query, status, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // While a new search loads, keep showing the previous results (dimmed) instead of a skeleton.
    placeholderData: keepPreviousData,
  });
}

/** `/staff/customers` — search and browse customers. Administrators also create and import them. */
export default function CustomersPage() {
  usePageTitle(cu("heading"));
  const me = useMe();
  const isAdmin = me.data?.staff?.role === "admin";
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const urlQuery = (params.get("q") ?? "").trim();
  const status = readStatus(params.get("status"));
  const [text, setText] = useState(urlQuery);
  const searchId = useId();
  /**
   * The search this page last wrote to the URL. Router navigations are transitions, so the URL can commit an older
   * search while the person is still typing: only a URL search that this page didn't write (back/forward, a link)
   * replaces what is in the box.
   */
  const written = useRef(urlQuery);

  useEffect(() => {
    if (urlQuery === written.current) return;
    written.current = urlQuery;
    setText(urlQuery);
  }, [urlQuery]);

  const writeUrl = (next: { q?: string; status?: Status }) => {
    const q = (next.q ?? text).trim();
    written.current = q;
    const s = next.status ?? status;
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (s !== DEFAULT_STATUS) p.set("status", s);
    setParams(p, { replace: true, preventScrollReset: true });
  };

  // Typing searches 300 ms after the last keystroke; Enter searches at once.
  useEffect(() => {
    if (text.trim() === written.current) return;
    const id = window.setTimeout(() => writeUrl({ q: text }), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
    // writeUrl reads the current URL; re-arming on every render isn't wanted.
  }, [text, urlQuery]);

  const list = useCustomerList(urlQuery, status);
  const customers = list.data?.pages.flatMap((p) => p.customers) ?? [];
  // A new search (or filter) is loading; the list on screen still shows the previous one.
  const searching = list.isFetching && list.isPlaceholderData;
  const pending = text.trim() !== urlQuery;

  // Empty with no search: is the whole register empty, or just this filter?
  const anyAtAll = useQuery({
    // Its own key: the "All" list is an infinite query, with differently shaped data.
    queryKey: [...queryKeys.customers, "any"],
    queryFn: () => apiFetch<CustomerListDTO>(listUrl("", "all")),
    enabled: urlQuery === "" && status !== "all" && list.isSuccess && !list.isPlaceholderData && customers.length === 0,
    retry: 1,
    select: (d) => d.customers.length > 0,
  });

  // "Load more": focus the first newly loaded row so keyboard and screen-reader users carry on from there.
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    if (focusFrom.current === null || list.isFetchingNextPage) return;
    const next = customers[focusFrom.current];
    focusFrom.current = null;
    if (next) document.getElementById(`customer-row-${next.id}`)?.focus();
  }, [customers.length, list.isFetchingNextPage]);

  const backState: CustomersBackState = { listSearch: location.search };

  const showEmpty = list.isSuccess && !list.isPlaceholderData && customers.length === 0;
  /** What an empty list means, for the status line and the empty state: undefined while that is still being worked out. */
  const emptyKind: EmptyKind | undefined = !showEmpty
    ? undefined
    : urlQuery
      ? "noMatches"
      : status === "all" || anyAtAll.data === false
        ? "none"
        : anyAtAll.data === true
          ? "filter"
          : undefined;

  let resultText = "";
  if (list.isSuccess && !searching && !pending) {
    const n = customers.length;
    if (n === 0) {
      resultText =
        emptyKind === "noMatches"
          ? cu("noMatches", { query: urlQuery })
          : emptyKind === "none"
            ? cu("emptyTitle")
            : emptyKind === "filter"
              ? cu(`emptyIn.${status}`)
              : "";
    } else if (urlQuery) {
      resultText = list.hasNextPage
        ? cu("resultsMatchMore", { n, query: urlQuery })
        : n === 1
          ? cu("resultsMatchOne", { query: urlQuery })
          : cu("resultsMatch", { n, query: urlQuery });
    } else {
      resultText = list.hasNextPage ? cu("resultsMore", { n }) : n === 1 ? cu("resultsOne") : cu("results", { n });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <PageHeading>{cu("heading")}</PageHeading>
          <p className="text-slate-600 dark:text-slate-400">{cu("lead")}</p>
          {me.data?.staff && !isAdmin && <p className="pt-1 text-slate-600 dark:text-slate-400">{cu("techNote")}</p>}
        </div>
        {isAdmin && (
          <div className="grid w-full gap-3 min-[26rem]:grid-cols-2 sm:flex sm:w-auto">
            <ButtonLink to="/staff/customers/import" variant="secondary" className="whitespace-nowrap">
              <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {cu("importLink")}
            </ButtonLink>
            <ButtonLink to="/staff/customers/new" state={backState} className="whitespace-nowrap">
              <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {cu("new")}
            </ButtonLink>
          </div>
        )}
      </div>

      <form
        role="search"
        aria-label={cu("searchLabel")}
        onSubmit={(e) => {
          e.preventDefault();
          writeUrl({ q: text });
        }}
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      >
        <div>
          <label htmlFor={`${searchId}-q`} className="mb-1.5 block font-medium">
            {cu("searchLabel")}
          </label>
          <div className="relative">
            <svg className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
              <path d="m16 16 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              id={`${searchId}-q`}
              type="search"
              value={text}
              maxLength={CUSTOMER_SEARCH_MAX}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              placeholder={cu("searchPlaceholder")}
              aria-describedby={`${searchId}-hint`}
              onChange={(e) => setText(e.target.value)}
              className={`${inputClass} min-h-11 py-2.5 pl-11`}
            />
          </div>
          <p id={`${searchId}-hint`} className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
            {cu("searchHint")}
          </p>
        </div>
        <fieldset className="sm:mb-7">
          <legend className="sr-only">{cu("statusFilter")}</legend>
          <div className="grid grid-cols-3 rounded-xl border border-slate-300 bg-white p-1 dark:border-slate-600 dark:bg-slate-900">
            {STATUSES.map((s) => (
              <label
                key={s}
                className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg px-3 lg:min-h-9 text-sm font-medium text-slate-700 has-checked:bg-blue-700 has-checked:text-white has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 hover:bg-slate-100 has-checked:hover:bg-blue-700 dark:text-slate-300 dark:has-checked:bg-blue-600 dark:hover:bg-slate-800"
              >
                <input type="radio" name={`${searchId}-status`} value={s} checked={status === s} onChange={() => writeUrl({ q: text, status: s })} className="sr-only" />
                {cu(`status.${s}`)}
              </label>
            ))}
          </div>
        </fieldset>
      </form>

      <div className="flex min-h-6 items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        {(searching || pending) && <Spinner className="size-4" />}
        <p role="status" aria-live="polite">
          {searching || pending ? cu("searching") : resultText}
        </p>
      </div>

      {list.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <span className="sr-only">{t("web.common.loading")}</span>
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : list.isError && customers.length === 0 ? (
        <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
          {cu("loadFailed")}
          <Button variant="secondary" onClick={() => void list.refetch()}>
            {t("web.common.retry")}
          </Button>
        </Notice>
      ) : customers.length === 0 && !showEmpty ? (
        // The previous search found nothing and the next one is still loading.
        <div aria-busy="true">
          <Skeleton className="h-48" />
        </div>
      ) : customers.length === 0 ? (
        <Empty
          kind={emptyKind}
          query={urlQuery}
          status={status}
          isAdmin={isAdmin}
          probeFailed={anyAtAll.isError}
          onRetryProbe={() => void anyAtAll.refetch()}
          onAll={() => writeUrl({ q: text, status: "all" })}
          onClear={() => {
            setText("");
            writeUrl({ q: "" });
            document.getElementById(`${searchId}-q`)?.focus();
          }}
        />
      ) : (
        <div className={`space-y-4 transition-opacity ${searching ? "opacity-60" : ""}`} aria-busy={searching || undefined}>
          <Card flush>
            <div
              className="hidden grid-cols-[8.5rem_minmax(0,1fr)_10rem_6.5rem_1.25rem] gap-4 border-b border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-600 md:grid dark:border-slate-800 dark:text-slate-400"
              aria-hidden="true"
            >
              <span>{cu("colNumber")}</span>
              <span>{cu("colName")}</span>
              <span>{cu("colContacts")}</span>
              <span>{cu("colStatus")}</span>
            </div>
            <ul className="divide-y divide-slate-200 dark:divide-slate-800" aria-label={cu("listLabel")}>
              {customers.map((c) => (
                <li key={c.id}>
                  <Row c={c} state={backState} />
                </li>
              ))}
            </ul>
          </Card>
          {list.isFetchNextPageError && <Notice tone="error">{cu("loadMoreFailed")}</Notice>}
          {list.hasNextPage && !searching && !pending && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                loading={list.isFetchingNextPage}
                onClick={() => {
                  focusFrom.current = customers.length;
                  void list.fetchNextPage();
                }}
                className="w-full sm:w-auto"
              >
                {list.isFetchingNextPage ? cu("loadingMore") : cu("loadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ c, state }: { c: CustomerListItemDTO; state: CustomersBackState }) {
  const contacts = contactsSummary(c.activeContactsCount, c.contactsCount);
  const noActive = c.activeContactsCount === 0;
  return (
    <Link
      id={`customer-row-${c.id}`}
      to={`/staff/customers/${c.id}`}
      state={state}
      className={`group grid grid-cols-[minmax(0,1fr)_auto_1.25rem] items-center gap-x-3 gap-y-1 px-4 py-3.5 first:rounded-t-2xl last:rounded-b-2xl hover:bg-slate-50 sm:px-5 md:grid-cols-[8.5rem_minmax(0,1fr)_10rem_6.5rem_1.25rem] md:gap-x-4 dark:hover:bg-slate-800/50 ${c.active ? "" : "text-slate-600 dark:text-slate-400"}`}
    >
      <span className="col-start-1 row-start-1 font-semibold break-words md:col-start-2 dark:text-slate-100">{c.name}</span>
      <span className="col-start-1 row-start-2 font-mono text-sm text-slate-600 md:col-start-1 md:row-start-1 md:text-base dark:text-slate-400">
        <span className="sr-only">, {cu("colNumber")} </span>
        {c.customerNumber}
      </span>
      <span className={`col-start-1 row-start-3 text-sm md:col-start-3 md:row-start-1 ${noActive ? "text-amber-800 dark:text-amber-300" : "text-slate-600 dark:text-slate-400"}`}>
        <span className="sr-only">, </span>
        {contacts}
      </span>
      <span className="col-start-2 row-span-3 row-start-1 self-start md:col-start-4 md:row-span-1 md:self-center">
        <span className="sr-only">, </span>
        <StatusChip active={c.active} />
      </span>
      <svg
        className="col-start-3 row-span-3 row-start-1 size-5 self-center shrink-0 text-slate-400 group-hover:text-blue-700 md:col-start-5 md:row-span-1 dark:group-hover:text-blue-300"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

type EmptyKind = "noMatches" | "none" | "filter";

function Empty({
  kind,
  query,
  status,
  isAdmin,
  probeFailed,
  onRetryProbe,
  onAll,
  onClear,
}: {
  /** Undefined while it isn't known yet whether any customer exists at all. */
  kind: EmptyKind | undefined;
  query: string;
  status: Status;
  isAdmin: boolean;
  probeFailed: boolean;
  onRetryProbe: () => void;
  onAll: () => void;
  onClear: () => void;
}) {
  const frame = "rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700";
  const icon = (
    <svg className="mx-auto mb-3 size-10 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM21 19v-1a4 4 0 0 0-3-3.87M15 4.13a3 3 0 0 1 0 5.74" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );

  if (kind === "noMatches") {
    return (
      <div className={frame}>
        {icon}
        <h2 className="text-lg font-semibold break-words">{cu("noMatches", { query })}</h2>
        <p className="mt-1 text-slate-600 dark:text-slate-400">{status === "all" ? cu("noMatchesBody") : cu(`noMatchesIn.${status}`)}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          {status !== "all" && <Button onClick={onAll}>{cu("searchAll")}</Button>}
          <Button variant="secondary" onClick={onClear}>
            {cu("clearSearch")}
          </Button>
        </div>
      </div>
    );
  }

  // No search: either nothing in this filter, or no customers at all yet.
  if (kind === undefined) {
    return probeFailed ? (
      <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
        {cu("loadFailed")}
        <Button variant="secondary" onClick={onRetryProbe}>
          {t("web.common.retry")}
        </Button>
      </Notice>
    ) : (
      <div aria-busy="true">
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (kind === "none") {
    return (
      <div className={frame}>
        {icon}
        <h2 className="text-lg font-semibold">{cu("emptyTitle")}</h2>
        <p className="mt-1 text-slate-600 dark:text-slate-400">{isAdmin ? cu("emptyBodyAdmin") : cu("emptyBody")}</p>
        {isAdmin && (
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <ButtonLink to="/staff/customers/import">{cu("importLink")}</ButtonLink>
            <ButtonLink to="/staff/customers/new" variant="secondary">
              {cu("new")}
            </ButtonLink>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={frame}>
      {icon}
      <h2 className="text-lg font-semibold">{cu(`emptyIn.${status}`)}</h2>
      <div className="mt-5 flex justify-center">
        <Button variant="secondary" onClick={onAll}>
          {cu("showAll")}
        </Button>
      </div>
    </div>
  );
}
