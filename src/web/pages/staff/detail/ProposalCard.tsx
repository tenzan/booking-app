import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ProposalDTO, ReservationDTO } from "../../../../shared/types";
import { apiFetch, isApiError } from "../../../api";
import { Button } from "../../../components/Button";
import { Card, Notice } from "../../../components/Card";
import { fmtStamp, fmtWhen } from "../../../format";
import { t } from "../../../i18n";
import { fmtDuration } from "../Countdown";
import { actionErrorText } from "./shared";

const k = (key: string, params?: Record<string, string | number>) => t(`web.staff.lifecycle.proposal.${key}`, params);

const HOUR = 60 * 60_000;
/** An open proposal this close to its expiry is highlighted (dashboard, detail page). */
export const EXPIRING_SOON_MS = 2 * HOUR;

/** "Expires in 3h 10m" pill: violet while there is time, red once it is close. */
export function ExpiryPill({ expiresAt, now }: { expiresAt: number; now: number }) {
  const left = expiresAt - now;
  const soon = left < EXPIRING_SOON_MS;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium tabular-nums ring-1 ring-inset ${
        soon
          ? "bg-red-50 text-red-800 ring-red-300 dark:bg-red-400/10 dark:text-red-200 dark:ring-red-400/40"
          : "bg-violet-50 text-violet-900 ring-violet-300 dark:bg-violet-400/10 dark:text-violet-200 dark:ring-violet-400/40"
      }`}
    >
      <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {left < 60_000 ? k("expiringNow") : k("expiresIn", { time: fmtDuration(left) })}
    </span>
  );
}

/**
 * Withdraw the reservation's open proposal behind an inline confirmation. `onDone` gets the confirmation text;
 * `onChanged` runs when the proposal had already closed (the page should reload).
 */
export function WithdrawProposal({
  r,
  proposal,
  onDone,
  onChanged,
}: {
  r: ReservationDTO;
  proposal: ProposalDTO;
  onDone: (text: string) => void;
  onChanged: (text: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const askId = useId();
  const keepRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (asking) keepRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      openRef.current?.focus();
    }
  }, [asking]);

  const withdraw = useMutation({
    mutationFn: () =>
      apiFetch<{ reservation: ReservationDTO }>(`/api/staff/reservations/${encodeURIComponent(r.id)}/proposal/withdraw`, {
        method: "POST",
        body: { proposalId: proposal.id },
      }),
    onMutate: () => setProblem(null),
    onSuccess: () => onDone(k("withdrawn")),
    onError: (e) => {
      if (isApiError(e, 409, "proposal_closed") || isApiError(e, 404)) onChanged(k("alreadyClosed"));
      else if (!isApiError(e, 401)) setProblem(actionErrorText(e));
    },
  });

  const close = () => {
    returnFocus.current = true;
    setAsking(false);
  };

  return (
    <div className="space-y-3">
      {!asking ? (
        <Button ref={openRef} variant="secondary" onClick={() => setAsking(true)}>
          {k("withdraw")}
        </Button>
      ) : (
        <div
          role="group"
          aria-labelledby={askId}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !withdraw.isPending) close();
          }}
          className="space-y-3 rounded-xl border border-red-300 bg-white p-4 dark:border-red-400/40 dark:bg-slate-900"
        >
          <p id={askId} className="font-medium">
            {k("withdrawAsk")}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="danger" loading={withdraw.isPending} onClick={() => withdraw.mutate()}>
              {withdraw.isPending ? k("withdrawing") : k("withdrawConfirm")}
            </Button>
            <Button ref={keepRef} variant="secondary" disabled={withdraw.isPending} onClick={close}>
              {k("keep")}
            </Button>
          </div>
        </div>
      )}
      {/* Always rendered so a failure is announced; it takes no space while empty. */}
      <div aria-live="polite">{problem && <Notice tone="error">{problem}</Notice>}</div>
    </div>
  );
}

/** The times offered, soonest first, each with its technician (staff only); the one the customer chose is marked. */
export function ProposalOptions({ r, proposal, tz }: { r: ReservationDTO; proposal: ProposalDTO; tz: string }) {
  return (
    <ul className="space-y-2">
      {proposal.options.map((o) => {
        const chosen = proposal.status === "accepted" && o.startAt === r.startAt;
        return (
          <li
            key={o.id}
            className={`rounded-xl border px-3 py-2 ${
              chosen ? "border-green-300 bg-green-50 dark:border-green-400/40 dark:bg-green-400/10" : "border-slate-200 dark:border-slate-700"
            }`}
          >
            <p className="font-medium tabular-nums">{fmtWhen(o.startAt, o.endAt, tz)}</p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              <span>
                <span className="sr-only">{t("common.technician")}: </span>
                {o.staffName}
              </span>
              {chosen && (
                <span className="rounded-full bg-green-700 px-2 py-0.5 text-xs font-semibold text-white dark:bg-green-400 dark:text-green-950">
                  {t("web.staff.lifecycle.propose.chosen")}
                </span>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The reservation's proposal (open, or closed within the last week): status, when it was sent and expires or closed,
 * the times offered with their technicians, the message, and — while open, when `withdraw` is given — Withdraw.
 */
export function ProposalCard({
  r,
  proposal,
  tz,
  now,
  withdraw,
}: {
  r: ReservationDTO;
  proposal: ProposalDTO;
  tz: string;
  now: number;
  withdraw?: { onDone: (text: string) => void; onChanged: (text: string) => void };
}) {
  const headingId = useId();
  const open = proposal.status === "open";
  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      className={`space-y-4 ${open ? "border-violet-300 dark:border-violet-400/40" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 space-y-1">
          <h2 id={headingId} className="text-lg font-semibold">
            {k("heading")}
          </h2>
          <p className="flex items-center gap-2 font-medium">
            <span className={`size-2.5 shrink-0 rounded-full ${open ? "bg-violet-600 dark:bg-violet-400" : "bg-slate-400"}`} aria-hidden="true" />
            {k(`status.${proposal.status}`)}
            {!open && proposal.resolvedAt !== null && (
              <span className="font-normal text-slate-600 dark:text-slate-400">· {fmtStamp(proposal.resolvedAt, tz)}</span>
            )}
          </p>
        </div>
        {open && <ExpiryPill expiresAt={proposal.expiresAt} now={now} />}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="font-medium text-slate-500 dark:text-slate-400">{k("sentLabel")}</dt>
        <dd className="break-words">{fmtStamp(proposal.createdAt, tz)}</dd>
        {open && (
          <>
            <dt className="font-medium text-slate-500 dark:text-slate-400">{k("expiresLabel")}</dt>
            <dd className="break-words">{fmtStamp(proposal.expiresAt, tz)}</dd>
          </>
        )}
      </dl>
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-slate-500 dark:text-slate-400">{k("optionsLabel")}</h3>
        <ProposalOptions r={r} proposal={proposal} tz={tz} />
      </div>
      {proposal.message && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-slate-500 dark:text-slate-400">{k("message")}</h3>
          <p className="break-words whitespace-pre-wrap">“{proposal.message}”</p>
        </div>
      )}
      {open && withdraw && <WithdrawProposal r={r} proposal={proposal} onDone={withdraw.onDone} onChanged={withdraw.onChanged} />}
    </Card>
  );
}
