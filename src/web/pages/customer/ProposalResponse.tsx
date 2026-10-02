import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CustomerReservationDTO } from "../../../shared/types";
import { isApiError } from "../../api";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Card";
import { focusWhenReady } from "../../components/Dialog";
import { TimezoneNote } from "../../components/TimezoneNote";
import { dateIn, fmtShortDate, fmtStamp, fmtTimeRange, fmtTz, fmtWhenTz } from "../../format";
import { t } from "../../i18n";
import { ErrorText, PhoneLink, type ReservationTransport } from "./ReservationActions";

/** What an email link asked for: `option=<id>` preselects a time, `choice=keep|other` opens that step. */
export interface ProposalIntent {
  option?: string;
  choice?: string;
}

type Stage = { kind: "choose" } | { kind: "option"; optionId: string } | { kind: "keep" } | { kind: "other" };
type Message = { tone: "success" | "info" | "warning" | "error"; body: ReactNode };

interface Props {
  r: CustomerReservationDTO;
  tz: string;
  transport: ReservationTransport;
  supportPhone: string | null;
  intent?: ProposalIntent;
  /** Show the outcome of a proposal that is already closed (the page was opened to answer it). */
  showClosed?: boolean;
  onChanged: (r: CustomerReservationDTO) => void;
  /** The "choose another time" step's way forward: straight to booking, or signing in first. */
  other: ReactNode;
  /** The email link's request has been answered or set aside. */
  onIntentDone?: () => void;
}

const isOpen = (r: CustomerReservationDTO) =>
  r.proposal?.status === "open" && r.proposal.expiresAt > Date.now() && (r.status === "pending" || r.status === "confirmed");

/**
 * The reservation's rescheduling proposal: while it is open, the offered times as large buttons, "keep my original
 * time" (confirmed appointments) and "choose another time". Nothing is sent until the customer confirms the step. Once
 * answered (here, or before: `showClosed`), what happened, in words.
 */
export function ProposalSection({ r, tz, transport, supportPhone, intent = {}, showClosed = false, onChanged, other, onIntentDone }: Props) {
  /** Answered on this page: true, or what to say when a newer proposal took its place. */
  const [answered, setAnswered] = useState<Message | true | null>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  const announce = (m: Message | true) => {
    setAnswered(m);
    focusWhenReady(() => liveRef.current);
  };

  const open = isOpen(r);
  // A proposal past its expiry that the sweep hasn't closed yet is as good as expired: always say so.
  const closedOutcome = !open && r.proposal && (answered !== null || showClosed || r.proposal.status === "open") ? outcomeOf(r, tz) : null;

  return (
    <>
      {/* Always rendered so outcomes are announced; focus lands here after an answer. */}
      <div aria-live="polite" ref={liveRef} tabIndex={-1} className="space-y-3 outline-none">
        {typeof answered === "object" && answered !== null && open && <Notice tone={answered.tone}>{answered.body}</Notice>}
        {closedOutcome && (
          <section aria-label={t("web.customer.proposal.outcomeHeading")}>
            <Notice tone={closedOutcome.tone}>{closedOutcome.body}</Notice>
          </section>
        )}
      </div>
      {open && (
        <Respond
          // A newer proposal starts from a clean slate.
          key={r.proposal!.id}
          r={r}
          tz={tz}
          transport={transport}
          supportPhone={supportPhone}
          intent={answered ? {} : intent}
          onChanged={onChanged}
          other={other}
          onIntentDone={onIntentDone}
          onAnswered={announce}
        />
      )}
    </>
  );
}

/** The closed proposal's outcome as the customer reads it. */
function outcomeOf(r: CustomerReservationDTO, tz: string): Message {
  const p = r.proposal!;
  const active = r.status === "pending" || r.status === "confirmed";
  const variant = r.status === "confirmed" ? "confirmed" : "pending";
  if (p.status === "accepted" && r.status === "confirmed") return { tone: "success", body: t("web.customer.proposal.outcome.accepted", { when: fmtWhenTz(r.startAt, r.endAt, tz) }) };
  if (!active) return { tone: "info", body: t("web.customer.proposal.outcome.closed") };
  if (p.status === "rejected") {
    if (r.replacedByRef) return { tone: "info", body: t("web.customer.proposal.outcome.replaced", { ref: r.replacedByRef }) };
    return { tone: "success", body: t(r.status === "confirmed" ? "web.customer.proposal.outcome.keptConfirmed" : "web.customer.proposal.outcome.keptPending") };
  }
  if (p.status === "withdrawn") return { tone: "info", body: t(`email.proposalOutcome.withdrawn.${variant}`) };
  if (p.status === "expired" || p.status === "open") return { tone: "warning", body: t(`email.proposalOutcome.expired.${variant}`) };
  return { tone: "info", body: t("web.customer.proposal.outcome.closed") };
}

interface RespondProps extends Omit<Props, "showClosed"> {
  onAnswered: (m: Message | true) => void;
}

function Respond({ r, tz, transport, supportPhone, intent = {}, onChanged, other, onIntentDone, onAnswered }: RespondProps) {
  const p = r.proposal!;
  const confirmed = r.status === "confirmed";
  const headingId = useId();
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  const [problem, setProblem] = useState<Message | null>(null);
  const [stage, setStage] = useState<Stage>(() => {
    if (intent.option && p.options.some((o) => o.id === intent.option)) return { kind: "option", optionId: intent.option };
    if (intent.choice === "keep" && confirmed) return { kind: "keep" };
    if (intent.choice === "other") return { kind: "other" };
    return { kind: "choose" };
  });
  // The email offered a time this proposal no longer has (a newer proposal replaced the one the email was about).
  const [staleOption] = useState(() => Boolean(intent.option) && !p.options.some((o) => o.id === intent.option));

  // Opened from an email button: land on the step it asked for (still only a question until confirmed).
  useEffect(() => {
    if (stage.kind !== "choose") focusWhenReady(() => stepHeading.current);
  }, []);

  const go = (s: Stage, focusStep = true) => {
    setStage(s);
    setProblem(null);
    if (s.kind === "choose") onIntentDone?.();
    else if (focusStep) focusWhenReady(() => stepHeading.current);
  };

  /** A failed answer: the proposal closed meanwhile (the page then shows what happened), or something to retry. */
  const failed = (e: unknown) => {
    if (isApiError(e, 409, "proposal_closed")) {
      const current = (e.details as { current?: CustomerReservationDTO } | undefined)?.current;
      onIntentDone?.();
      if (current) {
        onChanged(current);
        const newer = current.proposal?.status === "open" && current.proposal.id !== p.id;
        onAnswered(newer ? { tone: "info", body: t("web.customer.proposal.outcome.superseded") } : true);
      }
      return;
    }
    if (isApiError(e, 403, "not_eligible")) {
      setProblem({
        tone: "warning",
        body: supportPhone ? (
          <span className="flex flex-wrap items-center gap-x-2">
            {t("web.customer.proposal.notEligible")} <PhoneLink phone={supportPhone} />
          </span>
        ) : (
          t("web.customer.proposal.notEligibleNoPhone")
        ),
      });
      return;
    }
    setProblem({ tone: "error", body: <ErrorText e={e} /> });
  };

  const accept = useMutation({
    mutationFn: (optionId: string) => transport.accept({ proposalId: p.id, optionId }),
    onSuccess: (next) => {
      onIntentDone?.();
      onChanged(next);
      onAnswered(true);
    },
    onError: failed,
  });
  const keep = useMutation({
    mutationFn: () => transport.reject({ proposalId: p.id }),
    onSuccess: (next) => {
      onIntentDone?.();
      onChanged(next);
      onAnswered(true);
    },
    onError: failed,
  });
  const busy = accept.isPending || keep.isPending;

  const chosen = stage.kind === "option" ? p.options.find((o) => o.id === stage.optionId) : undefined;
  const when = (start: number, end: number) => fmtWhenTz(start, end, tz);

  // One radio group: each offered time, "keep my original time" (confirmed only) and "choose another time".
  const choices: Stage[] = [
    ...p.options.map((o): Stage => ({ kind: "option", optionId: o.id })),
    ...(confirmed ? [{ kind: "keep" } as Stage] : []),
    { kind: "other" },
  ];
  const isChecked = (c: Stage) => c.kind === stage.kind && (c.kind !== "option" || (stage.kind === "option" && c.optionId === stage.optionId));
  const checkedIndex = choices.findIndex(isChecked);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const n = (i + step + choices.length) % choices.length;
    go(choices[n]!, false);
    radios.current[n]?.focus();
  };
  const radio = (c: Stage, i: number, className: string, content: ReactNode) => {
    const checked = isChecked(c);
    return (
      <button
        ref={(el) => {
          radios.current[i] = el;
        }}
        key={i}
        type="button"
        role="radio"
        aria-checked={checked}
        tabIndex={checked || (checkedIndex === -1 && i === 0) ? 0 : -1}
        disabled={busy}
        onClick={() => go(c)}
        onKeyDown={(e) => onKeyDown(e, i)}
        className={`${className} rounded-xl border-2 transition-colors disabled:opacity-60 ${
          checked
            ? "border-blue-700 bg-blue-700 text-white dark:border-blue-400 dark:bg-blue-600"
            : "border-slate-300 bg-white text-slate-900 hover:border-blue-600 hover:bg-blue-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-blue-400 dark:hover:bg-slate-800"
        }`}
      >
        {content}
      </button>
    );
  };
  const chain = r.status === "pending" && r.replacesRef !== null;

  return (
    <section aria-labelledby={headingId} className="space-y-5 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950 sm:p-6 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-50">
      <div className="space-y-2">
        <span className="inline-flex items-center rounded-full bg-amber-200 px-2.5 py-1 text-sm font-semibold text-amber-950 dark:bg-amber-400/25 dark:text-amber-100">
          {t("web.customer.proposal.badge")}
        </span>
        <h2 id={headingId} className="text-xl font-semibold">
          {t("web.customer.proposal.heading")}
        </h2>
        <p>{t(confirmed ? "email.proposal.introConfirmed" : "email.proposal.introPending")}</p>
      </div>

      {p.message && (
        <div className="rounded-xl border border-amber-300/70 bg-white/70 px-4 py-3 dark:border-amber-400/30 dark:bg-slate-900/40">
          <p className="text-sm font-medium opacity-80">{t("web.customer.proposal.messageLabel")}</p>
          <p className="break-words whitespace-pre-wrap">{p.message}</p>
        </div>
      )}

      <div>
        <p className="text-sm font-medium opacity-80">{t(confirmed ? "email.proposal.current" : "email.proposal.requested")}</p>
        <p className="font-semibold">{when(r.startAt, r.endAt)}</p>
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="font-semibold">{t("web.customer.proposal.optionsLabel")}</h3>
          <p>{t("email.proposal.choose")}</p>
          <TimezoneNote tz={tz} atMs={p.options[0]?.startAt} inheritColor className="mt-1 opacity-90" />
        </div>
        {staleOption && <Notice tone="info">{t("web.customer.proposal.staleOption")}</Notice>}
        <div role="radiogroup" aria-label={t("web.customer.proposal.choicesLabel")} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {p.options.map((o, i) =>
              radio(
                choices[i]!,
                i,
                "flex min-h-16 w-full flex-col items-start justify-center px-4 py-3 text-left",
                <>
                  <span className="text-lg font-semibold">{fmtShortDate(dateIn(o.startAt, tz))}</span>
                  <span className="tabular-nums">
                    {fmtTimeRange(o.startAt, o.endAt, tz)}
                    <span className="sr-only"> {fmtTz(tz, o.startAt)}</span>
                  </span>
                </>,
              ),
            )}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            {choices.slice(p.options.length).map((c, j) =>
              radio(
                c,
                p.options.length + j,
                "inline-flex min-h-13 items-center justify-center px-6 text-lg font-semibold sm:flex-1",
                t(c.kind === "keep" ? "email.proposal.keep" : "email.proposal.other"),
              ),
            )}
          </div>
        </div>
      </div>

      {stage.kind !== "choose" && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 text-slate-900 sm:p-5 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
          <h3 ref={stepHeading} tabIndex={-1} className="text-lg font-semibold outline-none">
            {stage.kind === "option"
              ? t("web.customer.proposal.confirmOptionHeading")
              : stage.kind === "keep"
                ? t("web.customer.proposal.confirmKeepHeading")
                : t("web.customer.proposal.otherHeading")}
          </h3>
          {stage.kind === "option" && chosen && <p>{t("web.customer.proposal.confirmOptionBody", { when: when(chosen.startAt, chosen.endAt) })}</p>}
          {stage.kind === "keep" && <p>{t("web.customer.proposal.confirmKeepBody", { when: when(r.startAt, r.endAt) })}</p>}
          {stage.kind === "other" && (
            <p>
              {chain
                ? t("web.customer.proposal.otherBodyChain", { pending: r.ref, ref: r.replacesRef! })
                : t(confirmed ? "web.customer.proposal.otherBodyConfirmed" : "web.customer.proposal.otherBodyPending")}
            </p>
          )}
          <div aria-live="polite">{problem && <Notice tone={problem.tone}>{problem.body}</Notice>}</div>
          {stage.kind === "other" && other}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="ghost" disabled={busy} onClick={() => go({ kind: "choose" })}>
              {t("web.customer.proposal.back")}
            </Button>
            {stage.kind === "option" && chosen && (
              <Button size="lg" loading={accept.isPending} onClick={() => accept.mutate(chosen.id)}>
                {accept.isPending ? t("web.customer.proposal.confirming") : t("web.customer.proposal.confirmOption")}
              </Button>
            )}
            {stage.kind === "keep" && (
              <Button size="lg" loading={keep.isPending} onClick={() => keep.mutate()}>
                {keep.isPending ? t("web.customer.proposal.keeping") : t("web.customer.proposal.confirmKeep")}
              </Button>
            )}
          </div>
        </div>
      )}

      <p className="text-sm">{t(confirmed ? "email.proposal.expiryConfirmed" : "email.proposal.expiryPending", { expires: fmtStamp(p.expiresAt, tz) })}</p>
    </section>
  );
}
