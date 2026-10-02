import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CustomerReservationDTO } from "../../../shared/types";
import { ApiError, apiFetch, isApiError } from "../../api";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Card";
import { Dialog, focusWhenReady } from "../../components/Dialog";
import { Field, inputClass } from "../../components/Field";
import { fmtWhen, fmtTz } from "../../format";
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
  ics: () => Promise<Blob>;
}

type Answer = { reservation: CustomerReservationDTO };
const post = (path: string, body: unknown) => apiFetch<Answer>(path, { method: "POST", body }).then((r) => r.reservation);

export const tokenTransport = (token: string): ReservationTransport => ({
  cancel: (b) => post("/api/access/reservation/cancel", { ...b, token }),
  accept: (b) => post("/api/access/proposal/accept", { ...b, token }),
  reject: (b) => post("/api/access/proposal/reject", { ...b, token }),
  ics: () => postBlob("/api/access/reservation/ics", { token }),
});

export const sessionTransport = (id: string): ReservationTransport => {
  const base = `/api/customer/reservations/${encodeURIComponent(id)}`;
  return {
    cancel: (b) => post(`${base}/cancel`, b),
    accept: (b) => post(`${base}/proposal/accept`, b),
    reject: (b) => post(`${base}/proposal/reject`, b),
    ics: () => postBlob(`${base}/ics`, {}),
  };
};

/** A POST answered with a file (never a GET: the token, when there is one, stays out of URLs). */
async function postBlob(path: string, body: unknown): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-Requested-With": "fetch", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    throw new ApiError(res.status, typeof data?.error === "string" ? data.error : "http_error", data?.details, data ?? undefined);
  }
  return res.blob();
}

/** Save `blob` as `name` through a temporary link. */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

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

  const cancel = useMutation({
    mutationFn: () => transport.cancel({ reason: reason.trim() || undefined, version: r.version }),
    onSuccess: (next) => {
      setOpen(false);
      onChanged(next);
      cancelled(t("web.customer.cancel.done"));
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
      } else if (isApiError(e, 409, "past_cutoff")) {
        const d = e.details as { cutoffMin?: number; supportPhone?: string } | undefined;
        setOpen(false);
        setPastCutoff({ minutes: d?.cutoffMin ?? cutoffMin ?? 0, phone: d?.supportPhone || supportPhone });
        focusWhenReady(() => resultRef.current);
      } else if (isApiError(e, 409, "too_late")) {
        setOpen(false);
        show({ tone: "warning", body: t("web.customer.cancel.tooLate") });
      }
      // Anything else stays in the dialog (see dialogError) so the customer can try again.
    },
  });

  const dialogError = cancel.error && !isApiError(cancel.error, 409) ? errorText(cancel.error) : null;
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
      <Dialog open={open} onClose={close} closable={!cancel.isPending} labelledBy={titleId} describedBy={descId} initialFocus={titleRef} returnFocus={buttonRef.current}>
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

/**
 * "Add to calendar" for a confirmed appointment: the file is fetched with a POST and saved from a Blob as `<ref>.ics`.
 * `prompt` (the `#…&action=ics` email link) adds a line saying what the button is for; nothing downloads by itself.
 */
export function CalendarButton({ r, transport, prompt = false }: { r: CustomerReservationDTO; transport: ReservationTransport; prompt?: boolean }) {
  const [done, setDone] = useState(false);
  const noteId = useId();
  const ics = useMutation({
    mutationFn: () => transport.ics(),
    onMutate: () => setDone(false),
    onSuccess: (blob) => {
      saveBlob(blob, `${r.ref}.ics`);
      setDone(true);
    },
  });
  if (r.status !== "confirmed") return null;
  const error = ics.error ? (isApiError(ics.error, 409, "not_confirmed") ? t("web.customer.calendar.notConfirmed") : errorText(ics.error)) : null;
  return (
    <div className="space-y-2">
      {prompt && <p className="font-medium">{t("web.customer.calendar.prompt")}</p>}
      <Button variant="secondary" block loading={ics.isPending} aria-describedby={noteId} onClick={() => ics.mutate()}>
        <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.75" />
          <path d="M3.5 9.5h17M8 3v4M16 3v4M12 12.5v5M9.5 15h5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
        {ics.isPending ? t("web.customer.calendar.preparing") : t("web.customer.calendar.button")}
      </Button>
      <p id={noteId} className="text-sm text-slate-600 dark:text-slate-400">
        {t("web.customer.calendar.note")}
      </p>
      <div aria-live="polite">
        {error ? <Notice tone="error">{error}</Notice> : done ? <Notice tone="success">{t("web.customer.calendar.downloaded")}</Notice> : null}
      </div>
    </div>
  );
}

/** How this reservation relates to a change request: what it would replace, or what replaces it. */
export function ReplacementNote({ r }: { r: CustomerReservationDTO }) {
  const active = r.status === "pending" || r.status === "confirmed";
  let text: string | null = null;
  if (r.replacedByRef && active) text = t("web.customer.link.replacedByPending", { ref: r.replacedByRef });
  else if (r.replacedByRef && r.status === "cancelled") text = t("web.customer.link.replacedBy", { ref: r.replacedByRef });
  else if (r.replacesRef && r.status === "pending") text = t("web.customer.link.replacesPending", { ref: r.replacesRef });
  else if (r.replacesRef && r.status !== "declined" && r.status !== "expired" && r.status !== "cancelled") text = t("web.customer.link.replaces", { ref: r.replacesRef });
  return text ? <Notice tone="info">{text}</Notice> : null;
}

/** A close reason as the customer reads it: system codes in words, anything typed by a person as written. */
export function closeReasonText(reason: string): string {
  const key = `web.customer.closeReason.${reason}`;
  const text = t(key);
  return text === key ? reason : text;
}

/** "Fri, Oct 2, 2026, 11:00 – 11:30 Asia/Tokyo (GMT+9)": a time range with its time-zone label, for standalone mentions. */
export const fmtWhenTz = (startAt: number, endAt: number, tz: string): string => `${fmtWhen(startAt, endAt, tz)} ${fmtTz(tz, startAt)}`;
