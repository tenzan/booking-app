import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router";
import type { CalendarLinks, CustomerReservationDTO } from "../../../shared/types";
import { apiFetch, isApiError } from "../../api";
import { AddToCalendar } from "../../components/AddToCalendar";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Card";
import { Dialog, focusWhenReady } from "../../components/Dialog";
import { Field, inputClass } from "../../components/Field";
import { fmtWhenTz } from "../../format";
import { t } from "../../i18n";

/** Matches the server's limit on a customer's cancellation reason. */
const REASON_MAX = 500;
const MIN = 60_000;

/**
 * How the customer reaches one reservation: the emailed link's token (`/r`) or their session (`/my`). The same
 * endpoints sit behind both; each action answers with the customer's view of the reservation.
 */
export interface ReservationTransport {
  cancel: (body: { reason?: string; version: number }) => Promise<CustomerReservationDTO>;
  accept: (body: { proposalId: string; optionId: string }) => Promise<CustomerReservationDTO>;
  reject: (body: { proposalId: string }) => Promise<CustomerReservationDTO>;
  /** "Add to calendar" links, with a short-lived link to the .ics file. */
  calendar: () => Promise<CalendarLinks>;
}

type Answer = { reservation: CustomerReservationDTO };
const post = (path: string, body: unknown) => apiFetch<Answer>(path, { method: "POST", body }).then((r) => r.reservation);

export const tokenTransport = (token: string): ReservationTransport => ({
  cancel: (b) => post("/api/access/reservation/cancel", { ...b, token }),
  accept: (b) => post("/api/access/proposal/accept", { ...b, token }),
  reject: (b) => post("/api/access/proposal/reject", { ...b, token }),
  // A POST, so the access token stays out of URLs; the file link it returns carries a read-only calendar token.
  calendar: () => apiFetch<{ links: CalendarLinks }>("/api/access/reservation/calendar", { method: "POST", body: { token } }).then((r) => r.links),
});

export const sessionTransport = (id: string): ReservationTransport => {
  const base = `/api/customer/reservations/${encodeURIComponent(id)}`;
  return {
    cancel: (b) => post(`${base}/cancel`, b),
    accept: (b) => post(`${base}/proposal/accept`, b),
    reject: (b) => post(`${base}/proposal/reject`, b),
    calendar: () => apiFetch<{ links: CalendarLinks }>(`${base}/calendar`, { method: "POST", body: {} }).then((r) => r.links),
  };
};

const isActive = (r: CustomerReservationDTO, now: number) => (r.status === "pending" || r.status === "confirmed") && r.startAt > now;

/** "+81 3-1234-5678" as a tap-to-call link (44px tall). */
export function PhoneLink({ phone }: { phone: string }) {
  return (
    <a href={`tel:${phone.replace(/[^0-9+]/g, "")}`} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
      {phone}
    </a>
  );
}

/** The "too late to cancel online" message: the cutoff and, when there is one, the support phone to call. */
export function PastCutoff({ minutes, supportPhone }: { minutes: number; supportPhone: string | null }) {
  return (
    <Notice tone="warning" className="space-y-1">
      <p className="font-semibold">{t("web.customer.cancel.pastCutoffHeading")}</p>
      <p>{t("web.customer.cancel.pastCutoff", { minutes })}</p>
      <p className="flex flex-wrap items-center gap-x-2">
        {supportPhone ? (
          <>
            {t("web.customer.cancel.pastCutoffCall")} <PhoneLink phone={supportPhone} />
          </>
        ) : (
          t("web.customer.cancel.pastCutoffNoPhone")
        )}
      </p>
    </Notice>
  );
}

type Result = { tone: "success" | "warning" | "error" | "info"; body: ReactNode };

interface CancelProps {
  r: CustomerReservationDTO;
  tz: string;
  transport: ReservationTransport;
  supportPhone: string | null;
  /** Known on the link page: past it, the button gives way to the "call us" message without a round trip. */
  cutoffMin?: number;
  /** Open the confirm dialog straight away (the `#…&action=cancel` email link); nothing is sent until confirmed. */
  autoOpen?: boolean;
  onChanged: (r: CustomerReservationDTO) => void;
  /** The dialog closed without cancelling, or the cancel went through. */
  onSettled?: () => void;
  /**
   * Say "cancelled" somewhere that outlives this control (a list moves the card to another group, remounting it);
   * by default it is said here.
   */
  announceCancelled?: (text: string) => void;
}

/**
 * Cancel with a confirm dialog and an optional reason. Outcomes are announced in an always-present live region:
 * cancelled (also when it already was), past the cutoff (the support phone), already started, or changed meanwhile
 * (the page then shows the current state).
 */
export function CancelControl({ r, tz, transport, supportPhone, cutoffMin, autoOpen = false, onChanged, onSettled, announceCancelled }: CancelProps) {
  const now = Date.now();
  const knownPastCutoff = r.status === "confirmed" && cutoffMin !== undefined && r.startAt - cutoffMin * MIN <= now && r.startAt > now;
  // From an email link: ask straight away, unless it is already too late (then the "call us" message takes focus).
  const [open, setOpen] = useState(autoOpen && isActive(r, now) && !knownPastCutoff);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [pastCutoff, setPastCutoff] = useState<{ minutes: number; phone: string | null } | null>(null);
  const titleId = useId();
  const descId = useId();
  const resultRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (autoOpen && knownPastCutoff) focusWhenReady(() => resultRef.current);
  }, []);

  const show = (res: Result) => {
    setResult(res);
    focusWhenReady(() => resultRef.current);
  };
  const cancelled = (text: string) => (announceCancelled ? announceCancelled(text) : show({ tone: "success", body: text }));

  // A change request still waiting on this reservation is cancelled with it (the server does both in one step).
  const pendingChange = isActive(r, now) ? r.replacedByRef : null;

  const cancel = useMutation({
    mutationFn: () => transport.cancel({ reason: reason.trim() || undefined, version: r.version }),
    onSuccess: (next) => {
      setOpen(false);
      onChanged(next);
      cancelled(pendingChange ? t("web.customer.cancel.doneWithReplacement", { ref: pendingChange }) : t("web.customer.cancel.done"));
      onSettled?.();
    },
    onError: (e) => {
      if (isApiError(e, 409, "stale")) {
        const current = (e.details as { current?: CustomerReservationDTO } | undefined)?.current;
        setOpen(false);
        if (current) onChanged(current);
        // Someone (or an earlier tap) already cancelled it: that is what was asked for.
        if (current?.status === "cancelled") cancelled(t("web.customer.cancel.already"));
        else show({ tone: "warning", body: t("web.customer.cancel.changed") });
        onSettled?.();
      } else if (isApiError(e, 409, "past_cutoff")) {
        const d = e.details as { cutoffMin?: number; supportPhone?: string } | undefined;
        setOpen(false);
        setPastCutoff({ minutes: d?.cutoffMin ?? cutoffMin ?? 0, phone: d?.supportPhone || supportPhone });
        focusWhenReady(() => resultRef.current);
        onSettled?.();
      } else if (isApiError(e, 409, "too_late")) {
        setOpen(false);
        show({ tone: "warning", body: t("web.customer.cancel.tooLate") });
        onSettled?.();
      }
      // Anything else stays in the dialog (see dialogError) so the customer can try again.
    },
  });

  const dialogError = cancel.error && !isApiError(cancel.error, 409) ? <ErrorText e={cancel.error} /> : null;
  const tooLong = reason.length > REASON_MAX;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (tooLong) return;
    cancel.mutate();
  }

  function close() {
    setOpen(false);
    cancel.reset();
    onSettled?.();
    // Back to the button: the dialog may have opened by itself (an email link), with nothing focused before it.
    focusWhenReady(() => buttonRef.current ?? resultRef.current);
  }

  const activeNow = isActive(r, now);
  const cutoffShown = pastCutoff ?? (knownPastCutoff && activeNow ? { minutes: cutoffMin!, phone: supportPhone } : null);

  return (
    <div className="space-y-3">
      {/* Always rendered so outcomes are announced; it takes no space while empty. */}
      <div aria-live="polite" ref={resultRef} tabIndex={-1} className="outline-none">
        {cutoffShown ? <PastCutoff minutes={cutoffShown.minutes} supportPhone={cutoffShown.phone} /> : result ? <Notice tone={result.tone}>{result.body}</Notice> : null}
      </div>
      {activeNow && !cutoffShown && (
        <Button ref={buttonRef} variant="secondary" block onClick={() => setOpen(true)}>
          {t("web.customer.cancel.button")}
        </Button>
      )}
      <Dialog open={open} onClose={close} closable={!cancel.isPending} labelledBy={titleId} describedBy={descId} initialFocus={titleRef}>
        <form onSubmit={submit} noValidate className="flex h-full flex-col">
          <header className="border-b border-slate-200 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 dark:border-slate-800">
            <h2 ref={titleRef} id={titleId} tabIndex={-1} className="text-xl font-bold tracking-tight outline-none">
              {t("web.customer.cancel.heading")}
            </h2>
          </header>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
            <div id={descId} className="space-y-1">
              <p>
                {t(r.status === "confirmed" ? "web.customer.cancel.bodyConfirmed" : "web.customer.cancel.bodyPending", { when: fmtWhenTz(r.startAt, r.endAt, tz) })}
              </p>
              <p className="font-mono text-sm text-slate-600 dark:text-slate-400">{r.ref}</p>
              {pendingChange && <p className="pt-2 font-medium">{t("web.customer.cancel.alsoReplacement", { ref: pendingChange })}</p>}
            </div>
            <Field
              id={`${titleId}-reason`}
              label={t("web.customer.cancel.reasonLabel")}
              hint={t("web.customer.cancel.reasonHint")}
              error={tooLong ? t("web.customer.cancel.tooLong", { max: REASON_MAX }) : null}
              aside={t("web.book.details.counter", { n: reason.length, max: REASON_MAX })}
            >
              {(aria) => <textarea {...aria} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />}
            </Field>
            <div aria-live="polite">
              {dialogError && <Notice tone="error">{dialogError}</Notice>}
            </div>
          </div>
          <footer className="flex flex-col-reverse gap-3 border-t border-slate-200 px-4 py-4 sm:flex-row sm:justify-end sm:px-6 dark:border-slate-800">
            <Button variant="secondary" onClick={close} disabled={cancel.isPending}>
              {t("web.customer.cancel.keep")}
            </Button>
            <Button type="submit" variant="danger" loading={cancel.isPending}>
              {cancel.isPending ? t("web.customer.cancel.cancelling") : t("web.customer.cancel.confirm")}
            </Button>
          </footer>
        </form>
      </Dialog>
    </div>
  );
}

/** Network, rate-limit and generic failures in catalog wording. */
export function errorText(e: unknown): string {
  if (isApiError(e, 429)) return t("web.errors.rateLimited");
  if (isApiError(e, 503)) return t("web.errors.busy");
  if (isApiError(e, 0)) return t("web.errors.network");
  return t("web.errors.generic");
}

/** errorText, except that an emailed link that has expired meanwhile says so and offers signing in. */
export function ErrorText({ e }: { e: unknown }) {
  if (!isApiError(e, 404, "invalid_link")) return <>{errorText(e)}</>;
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {t("web.customer.linkExpired")}
      <Link to="/" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
        {t("web.customer.linkExpiredSignIn")}
      </Link>
    </span>
  );
}

/**
 * "Add to calendar" for a confirmed appointment (see AddToCalendar). `prompt` (the `#…&action=ics` link of earlier
 * emails) opens the choices with a line saying what they are for; nothing is added by itself.
 */
export function CalendarButton({
  r,
  transport,
  prompt = false,
  onDone,
}: {
  r: CustomerReservationDTO;
  transport: ReservationTransport;
  prompt?: boolean;
  /** A calendar was chosen (the email link's request is answered). */
  onDone?: () => void;
}) {
  if (r.status !== "confirmed") return null;
  return (
    <AddToCalendar
      // Any change to the reservation (a new version) asks for the links afresh.
      queryKey={["customer", "calendar", r.id, r.version]}
      load={transport.calendar}
      note={t("web.customer.calendar.note")}
      prompt={prompt ? t("web.customer.calendar.prompt") : undefined}
      initiallyOpen={prompt}
      onPicked={onDone}
      errorContent={(e) => <ErrorText e={e} />}
    />
  );
}

/** How this reservation relates to a change request: what it would replace, or what replaces it. */
export function ReplacementNote({ r }: { r: CustomerReservationDTO }) {
  const active = r.status === "pending" || r.status === "confirmed";
  let text: string | null = null;
  if (r.replacedByRef && active) text = t("web.customer.link.replacedByPending", { ref: r.replacedByRef });
  // Moved only when the replacement's approval closed it; closed any other way, the request is a separate one.
  else if (r.replacedByRef && r.status === "cancelled" && r.closeReason === "rescheduled") text = t("web.customer.link.replacedBy", { ref: r.replacedByRef });
  else if (r.replacedByRef) text = t("web.customer.link.replacedByOther", { ref: r.replacedByRef });
  // A pending change request: its original stays only while that is still active; otherwise it is a request of its own.
  else if (r.replacesRef && r.status === "pending")
    text = t(r.replacesActive ? "web.customer.link.replacesPending" : "web.customer.link.replacesInactive", { ref: r.replacesRef });
  else if (r.replacesRef && r.status !== "declined" && r.status !== "expired" && r.status !== "cancelled") text = t("web.customer.link.replaces", { ref: r.replacesRef });
  return text ? <Notice tone="info">{text}</Notice> : null;
}

/** A close reason as the customer reads it: system codes in words, anything typed by a person as written. */
export function closeReasonText(reason: string): string {
  const key = `web.customer.closeReason.${reason}`;
  const text = t(key);
  return text === key ? reason : text;
}
