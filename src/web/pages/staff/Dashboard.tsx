import { useId, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { wallToUtc } from "../../../domain/time";
import type { ReservationDTO } from "../../../shared/types";
import { apiFetch, queryKeys, useMe } from "../../api";
import { Button } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { TimezoneNote } from "../../components/TimezoneNote";
import { addDays, dateIn, fmtLongDate, fmtShortDate, fmtTime, fmtTimeRange, todayIn } from "../../format";
import { t } from "../../i18n";
import { BookingCard } from "./BookingCard";
import { Countdown, useNow } from "./Countdown";

/** Every page of a reservation query (pages are capped server-side), so the dashboard never silently drops rows. */
async function fetchAllReservations(query: string): Promise<ReservationDTO[]> {
  const all: ReservationDTO[] = [];
  let cursor: string | null = null;
  do {
    const page: { reservations: ReservationDTO[]; nextCursor: string | null } = await apiFetch(
      `/api/staff/reservations?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    all.push(...page.reservations);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/** Staff reservation list; refetched on window focus and every minute so a dashboard left open stays current. */
function useReservations(query: string) {
  return useQuery({
    queryKey: queryKeys.staffReservationList(query),
    queryFn: () => fetchAllReservations(query),
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
  });
}

const byDeadline = (a: ReservationDTO, b: ReservationDTO) =>
  (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.startAt - b.startAt;

export default function Dashboard() {
  usePageTitle(t("web.staff.dashboard.heading"));
  const me = useMe();
  const tz = me.data?.timezone ?? "UTC";
  const staffId = me.data?.staff?.id ?? null;
  const now = useNow();
  const today = todayIn(tz, now);

  const pending = useReservations("status=pending&limit=200");
  const confirmed = useReservations(
    `status=confirmed&limit=200&from=${wallToUtc(today, 0, tz)}&to=${wallToUtc(addDays(today, 1), 0, tz)}`,
  );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <PageHeading>{t("web.staff.dashboard.heading")}</PageHeading>
        <p className="text-slate-600 dark:text-slate-400">{fmtLongDate(today)}</p>
        <TimezoneNote tz={tz} atMs={now} />
      </div>

      {me.data?.staff && <BookingCard enabled={me.data.bookingEnabled} isAdmin={me.data.staff.role === "admin"} />}

      <div className="grid items-start gap-8 lg:grid-cols-5">
        <Section title={t("web.staff.dashboard.pendingHeading")} count={pending.data?.length} className="lg:col-span-3">
          <ListBody
            q={pending}
            empty={<EmptyState title={t("web.staff.dashboard.pendingEmpty")} body={t("web.staff.dashboard.pendingEmptyBody")} />}
          >
            {(items) =>
              [...items].sort(byDeadline).map((r) => (
                <li key={r.id}>
                  <PendingRow r={r} tz={tz} now={now} />
                </li>
              ))
            }
          </ListBody>
        </Section>

        <Section title={t("web.staff.dashboard.todayHeading")} count={confirmed.data?.length} className="lg:col-span-2">
          <ListBody q={confirmed} empty={<EmptyState title={t("web.staff.dashboard.todayEmpty")} />}>
            {(items) =>
              items.map((r) => (
                <li key={r.id}>
                  <TodayRow r={r} tz={tz} mine={r.assignedStaff?.id === staffId} />
                </li>
              ))
            }
          </ListBody>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, count, className = "", children }: { title: string; count?: number; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`min-w-0 space-y-3 ${className}`}>
      <h2 id={id} className="flex items-center gap-2 text-lg font-semibold">
        {title}
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            {count}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

function ListBody({
  q,
  empty,
  children,
}: {
  q: ReturnType<typeof useReservations>;
  empty: ReactNode;
  children: (items: ReservationDTO[]) => ReactNode;
}) {
  if (q.isPending) {
    return (
      <div className="space-y-3" aria-busy="true">
        <span className="sr-only">{t("web.common.loading")}</span>
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
        {t("web.staff.dashboard.loadFailed")}
        <Button variant="secondary" onClick={() => void q.refetch()}>
          {t("web.common.retry")}
        </Button>
      </Notice>
    );
  }
  if (q.data.length === 0) return empty;
  return (
    <Card flush>
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">{children(q.data)}</ul>
    </Card>
  );
}

const rowLink =
  "group flex items-start gap-3 px-4 py-4 hover:bg-slate-50 first:rounded-t-2xl last:rounded-b-2xl sm:px-5 dark:hover:bg-slate-800/50";

const Chevron = () => (
  <svg className="mt-1 size-5 shrink-0 text-slate-400 group-hover:text-blue-700 dark:group-hover:text-blue-300" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function PendingRow({ r, tz, now }: { r: ReservationDTO; tz: string; now: number }) {
  return (
    <Link to={`/staff/r/${encodeURIComponent(r.id)}`} className={rowLink}>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {r.expiresAt !== null && <Countdown expiresAt={r.expiresAt} now={now} />}
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">{r.ref}</span>
        </div>
        <p className="font-semibold">
          {fmtShortDate(dateIn(r.startAt, tz))} · <span className="tabular-nums">{fmtTimeRange(r.startAt, r.endAt, tz)}</span>
        </p>
        <p className="break-words">
          {r.customer.name} <span className="text-sm text-slate-500 dark:text-slate-400">· {r.customer.number}</span>
        </p>
        <p className="line-clamp-1 text-sm text-slate-600 dark:text-slate-400">
          {r.contactName} — {r.issue}
        </p>
      </div>
      <Chevron />
    </Link>
  );
}

function TodayRow({ r, tz, mine }: { r: ReservationDTO; tz: string; mine: boolean }) {
  return (
    <Link to={`/staff/r/${encodeURIComponent(r.id)}`} className={rowLink}>
      <p className="w-14 shrink-0 pt-0.5 tabular-nums">
        <span className="block font-semibold">{fmtTime(r.startAt, tz)}</span>
        <span className="block text-sm text-slate-500 dark:text-slate-400">{fmtTime(r.endAt, tz)}</span>
      </p>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="break-words font-medium">{r.customer.name}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span className="sr-only">{t("common.technician")}:</span>
          <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 21a8 8 0 1 0-16 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
          {r.assignedStaff?.name ?? t("web.staff.dashboard.unassigned")}
          {mine && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-400/20 dark:text-blue-200">
              {t("web.staff.dashboard.you")}
            </span>
          )}
        </p>
      </div>
      <Chevron />
    </Link>
  );
}
