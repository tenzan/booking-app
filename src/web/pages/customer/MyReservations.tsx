import { useId, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { CustomerReservationDTO } from "../../../shared/types";
import { apiFetch, queryKeys, useMe } from "../../api";
import { Button, ButtonLink } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { StatusBadge } from "../../components/StatusBadge";
import { focusWhenReady } from "../../components/Dialog";
import { Toast, useToast } from "../../components/Toast";
import { TimezoneNote } from "../../components/TimezoneNote";
import { fmtWhen } from "../../format";
import { fmtDateTime, LOCALE, t } from "../../i18n";
import { ProposalSection } from "./ProposalResponse";
import { CalendarButton, CancelControl, closeReasonText, ReplacementNote, sessionTransport } from "./ReservationActions";

/** The id of a reservation card's expand/collapse button. */
const toggleId = (id: string) => `reservation-toggle-${id}`;

const isUpcoming = (r: CustomerReservationDTO, now: number) => (r.status === "pending" || r.status === "confirmed") && r.endAt > now;

export default function MyReservations() {
  usePageTitle(t("web.my.heading"));
  const me = useMe();
  const tz = me.data?.timezone ?? "UTC";
  const supportPhone = me.data?.supportPhone || null;
  const { toast, show, dismiss } = useToast();
  const announce = (text: string, id: string) => {
    show(text);
    // The card re-renders in the other group: keep the keyboard where the customer was.
    focusWhenReady(() => document.getElementById(toggleId(id)));
  };
  const q = useQuery({
    queryKey: queryKeys.reservations,
    queryFn: () => apiFetch<{ reservations: CustomerReservationDTO[] }>("/api/customer/reservations").then((r) => r.reservations),
  });

  const now = Date.now();
  const upcoming = (q.data ?? []).filter((r) => isUpcoming(r, now)).sort((a, b) => a.startAt - b.startAt);
  const past = (q.data ?? []).filter((r) => !isUpcoming(r, now)).sort((a, b) => b.startAt - a.startAt);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading>{t("web.my.heading")}</PageHeading>
        <ButtonLink to="/book">{t("web.my.bookNew")}</ButtonLink>
      </div>
      {q.isPending ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">{t("web.common.loading")}</span>
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : q.isError ? (
        <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
          {t("web.my.loadFailed")}
          <Button variant="secondary" onClick={() => void q.refetch()}>
            {t("web.common.retry")}
          </Button>
        </Notice>
      ) : q.data.length === 0 ? (
        <EmptyState
          title={t("web.my.emptyHeading")}
          body={t("web.my.emptyBody")}
          action={<ButtonLink to="/book">{t("web.my.bookNew")}</ButtonLink>}
        />
      ) : (
        <>
          <TimezoneNote tz={tz} />
          {upcoming.length > 0 && <Group title={t("web.my.upcoming")} items={upcoming} ctx={{ tz, supportPhone, announce }} />}
          {past.length > 0 && <Group title={t("web.my.past")} items={past} ctx={{ tz, supportPhone, announce }} />}
        </>
      )}
      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}

interface CardCtx {
  tz: string;
  supportPhone: string | null;
  /** Page-level announcement, then focus on the card's toggle (a cancelled card moves to the other group). */
  announce: (text: string, id: string) => void;
}

function Group({ title, items, ctx }: { title: string; items: CustomerReservationDTO[]; ctx: CardCtx }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {title}
      </h2>
      <ul className="space-y-3">
        {items.map((r) => (
          <li key={r.id}>
            <ReservationCard r={r} ctx={ctx} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const hasOpenProposal = (r: CustomerReservationDTO) =>
  r.proposal?.status === "open" && r.proposal.expiresAt > Date.now() && (r.status === "pending" || r.status === "confirmed");

function ReservationCard({ r, ctx }: { r: CustomerReservationDTO; ctx: CardCtx }) {
  const { tz, supportPhone } = ctx;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const transport = useMemo(() => sessionTransport(r.id), [r.id]);
  const actionNeeded = hasOpenProposal(r);
  // Opened when there is something to answer.
  const [open, setOpen] = useState(actionNeeded);
  const panelId = useId();

  const onChanged = (next: CustomerReservationDTO) => {
    qc.setQueryData<CustomerReservationDTO[]>(queryKeys.reservations, (list) => list?.map((x) => (x.id === next.id ? next : x)));
    qc.setQueryData(queryKeys.reservation(next.id), next);
    // An answer can change other reservations too (an approved replacement cancels its original).
    void qc.invalidateQueries({ queryKey: queryKeys.reservations });
  };
  const replaceTarget = `/book?replaces=${encodeURIComponent(r.id)}`;
  return (
    <Card flush>
      <button
        type="button"
        id={toggleId(r.id)}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 rounded-2xl p-5 text-left hover:bg-slate-50 sm:p-6 dark:hover:bg-slate-800/50"
      >
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={r.status} />
            {actionNeeded && (
              <span className="inline-flex items-center rounded-full bg-amber-200 px-2.5 py-1 text-sm font-semibold text-amber-950 dark:bg-amber-400/25 dark:text-amber-100">
                {t("web.customer.proposal.badge")}
              </span>
            )}
          </div>
          <p className="text-lg font-semibold">{fmtWhen(r.startAt, r.endAt, tz)}</p>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            <span className="font-mono">{r.ref}</span> · {r.accountName}
          </p>
        </div>
        <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-blue-700 dark:text-blue-300">
          <span className="sr-only sm:not-sr-only">{open ? t("web.my.hideDetails") : t("web.my.showDetails")}</span>
          <svg className={`size-5 transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <div id={panelId} hidden={!open} className="space-y-5 border-t border-slate-200 px-5 py-4 sm:px-6 dark:border-slate-800">
        <ReplacementNote r={r} />
        <ProposalSection
          r={r}
          tz={tz}
          transport={transport}
          supportPhone={supportPhone}
          onChanged={onChanged}
          other={
            <Button size="lg" block onClick={() => navigate(replaceTarget)}>
              {t("web.customer.proposal.otherContinue")}
            </Button>
          }
        />
        <div>
          <ReservationDetails r={r} />
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            {t("web.my.requested", { when: fmtDateTime(r.createdAt, tz, LOCALE) })}
          </p>
        </div>
        {(r.status === "pending" || r.status === "confirmed") && (
          <div className="space-y-4">
            <CalendarButton r={r} transport={transport} />
            <CancelControl r={r} tz={tz} transport={transport} supportPhone={supportPhone} onChanged={onChanged} announceCancelled={(text) => ctx.announce(text, r.id)} />
          </div>
        )}
      </div>
    </Card>
  );
}

/** Definition list of a reservation's facts; shared with the email-link page. */
export function ReservationDetails({ r }: { r: CustomerReservationDTO }) {
  const rows: Array<[string, string]> = [
    [t("common.reference"), r.ref],
    [t("common.account"), `${r.accountName}\n${t("web.book.account.number", { number: r.customerNumber })}`],
    [t("common.contact"), r.contactName],
    [t("common.callbackPhone"), r.phone],
    [t("common.issue"), r.issue],
  ];
  // "Moved to a new time" is already said by the replacement note above the details.
  if (r.closeReason && !(r.closeReason === "rescheduled" && r.replacedByRef)) rows.push([t("web.my.reason"), closeReasonText(r.closeReason)]);
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">{k}</dt>
          <dd className="-mt-2 break-words whitespace-pre-wrap sm:mt-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
