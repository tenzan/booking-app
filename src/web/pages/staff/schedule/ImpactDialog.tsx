import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { ConflictDTO, ImpactDTO, ReservationDTO, Resolution, ScheduleChange } from "../../../../shared/types";
import { apiFetch, handleSignedOut, isApiError, queryKeys, type Previewed, type StaffReservationView } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { Dialog } from "../../../components/Dialog";
import { inputClass } from "../../../components/Field";
import { TimezoneNote } from "../../../components/TimezoneNote";
import { fmtDateTime, LOCALE, t } from "../../../i18n";
import { actionErrorText } from "../detail/shared";
import { k, scheduleErrorText } from "./shared";

/** One capacity change on its way through preview → (review) → apply. */
export interface ChangeRequest {
  /** What is being changed, in a line (shown in the review dialog). */
  summary: string;
  /** Confirmation once it is applied. */
  done: string;
  /** `resolutions`: conflicts answered together with the change (staged reassignments); sent only when there are some. */
  preview: (resolutions?: Resolution[]) => Promise<Previewed>;
  apply: (version: number, resolutions?: Resolution[]) => Promise<unknown>;
  /** Runs once the change is applied (e.g. close the edit form). */
  onApplied?: () => void;
  /** Text for errors this kind of change has its own words for (null: the generic schedule message). */
  errorText?: (e: unknown) => string | null;
}

/**
 * "applied": saved at once; "review": the impact dialog is open; otherwise the error to show next to the form
 * (`error` is the raw failure, e.g. to point at the invalid fields).
 */
export type SubmitResult = { status: "applied" } | { status: "review" } | { status: "failed"; message: string; error: unknown };

const errorTextFor = (req: ChangeRequest, e: unknown) => req.errorText?.(e) ?? scheduleErrorText(e);

export type Submit = (req: ChangeRequest) => Promise<SubmitResult>;

/** `body` plus the staged resolutions, when there are any (the field is optional on every preview/apply endpoint). */
export const withResolutions = <T extends object>(body: T, resolutions?: Resolution[]) => (resolutions && resolutions.length > 0 ? { ...body, resolutions } : body);

/** Preview and apply through the schedule endpoints. */
export function scheduleRequest(change: ScheduleChange, texts: { summary: string; done: string }, onApplied?: () => void): ChangeRequest {
  return {
    ...texts,
    onApplied,
    preview: (resolutions) => apiFetch<Previewed>("/api/staff/schedule/preview", { method: "POST", body: withResolutions({ change }, resolutions) }),
    apply: (version, resolutions) => apiFetch("/api/staff/schedule/apply", { method: "POST", body: withResolutions({ change, version }, resolutions) }),
  };
}

const isClear = (i: ImpactDTO) => i.moved.length === 0 && i.conflicts.length === 0;
/**
 * Everything the person was shown and may have decided on: who moves from whom to whom (by staff id), which holds
 * conflict, and which already needed attention (warnings don't block, but a new one is news).
 */
const signature = (i: ImpactDTO) =>
  JSON.stringify([
    i.moved.map((m) => `${m.id}:${m.fromId ?? "-"}>${m.toId}`).sort(),
    i.conflicts.map((c) => `${c.id}:${c.reason}`).sort(),
    i.warnings.map((w) => `${w.id}:${w.reason}`).sort(),
  ]);
const isRace = (e: unknown) => isApiError(e, 409, "stale_preview") || isApiError(e, 409, "conflicts");

type ApplyOutcome = { kind: "applied" } | { kind: "review"; previewed: Previewed };

/**
 * Apply at `version` with the staged `resolutions`. If the schedule moved on meanwhile (409 stale_preview), preview
 * again without a word: when the impact is still what was shown (and every staged resolution still holds), apply
 * once more; otherwise hand back the new impact for review.
 */
async function applyChecked(req: ChangeRequest, version: number, shown: ImpactDTO, resolutions: Resolution[] = []): Promise<ApplyOutcome> {
  try {
    await req.apply(version, resolutions);
    return { kind: "applied" };
  } catch (e) {
    if (!isRace(e)) throw e;
    const fresh = await req.preview(resolutions);
    const unchanged = fresh.impact.conflicts.length === 0 && !fresh.impact.invalidResolutions && signature(fresh.impact) === signature(shown);
    if (isApiError(e, 409, "stale_preview") && unchanged) {
      try {
        await req.apply(fresh.version, resolutions);
        return { kind: "applied" };
      } catch (e2) {
        if (!isRace(e2)) throw e2;
        return { kind: "review", previewed: await req.preview(resolutions) };
      }
    }
    return { kind: "review", previewed: fresh };
  }
}

/** A conflict answered by reassigning it to `staffId`; it is saved together with the change. */
interface Staged {
  /** The conflict as it was shown when the reassignment was chosen. */
  conflict: ConflictDTO;
  staffId: number;
  name: string;
}
const toResolutions = (staged: Staged[]): Resolution[] => staged.map((s) => ({ reservationId: s.conflict.reservationId, staffId: s.staffId }));

/** Splits `staged` by the preview's verdict: the ones that still hold, and why each of the others was dropped. */
function reconcile(staged: Staged[], impact: ImpactDTO): { keep: Staged[]; dropped: string[] } {
  const bad = new Map((impact.invalidResolutions ?? []).map((i) => [i.reservationId, i.reason]));
  return {
    keep: staged.filter((s) => !bad.has(s.conflict.reservationId)),
    dropped: staged
      .filter((s) => bad.has(s.conflict.reservationId))
      .map((s) =>
        k("impact.resolve.dropped", { ref: s.conflict.ref, name: s.name, why: k(`impact.resolve.why.${bad.get(s.conflict.reservationId)!}`, { name: s.name }) }),
      ),
  };
}

type Tone = "success" | "warning" | "error";
interface Review extends Previewed {
  req: ChangeRequest;
  /** Reassignments chosen in the dialog; `impact` was previewed with them. */
  staged: Staged[];
  notice: { tone: Tone; text: string } | null;
  /** The control that asked for the change; it is usually disabled (busy) by the time the dialog opens. */
  returnTo: HTMLElement | null;
}

/**
 * Every capacity change goes through here: preview first; with nothing moved and no conflicts it is applied at once
 * (and `onDone` gets the confirmation), otherwise the impact dialog opens. Render `dialog` once on the page.
 * The schedule and reservations are refetched after every change; `refresh` names further queries the page shows.
 */
export function useImpactFlow({ tz, onDone, refresh }: { tz: string; onDone: (text: string) => void; refresh?: readonly QueryKey[] }) {
  const qc = useQueryClient();
  const [review, setReview] = useState<Review | null>(null);

  /**
   * These calls bypass React Query, so its global 401 handler never sees them: on 401 re-ask "who am I" and the
   * route guard sends the person to sign in. True when `e` was a 401.
   */
  const signedOut = useCallback(
    (e: unknown) => {
      if (!handleSignedOut(qc, e)) return false;
      setReview(null);
      return true;
    },
    [qc],
  );

  // Joined so a fresh array literal from the caller doesn't change the callback on every render.
  const extra = JSON.stringify(refresh ?? []);
  const refreshLists = useCallback(
    () =>
      Promise.all(
        [queryKeys.schedule, queryKeys.staffReservations, ...(JSON.parse(extra) as QueryKey[])].map((queryKey) => qc.invalidateQueries({ queryKey })),
      ).then(() => undefined),
    [qc, extra],
  );

  const finish = useCallback(
    (req: ChangeRequest) => {
      setReview(null);
      req.onApplied?.();
      onDone(req.done);
      void refreshLists();
    },
    [onDone, refreshLists],
  );

  const submit = useCallback<Submit>(
    async (req) => {
      // Read before the first await: the form re-renders its button as busy (disabled) right after this call.
      const returnTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      try {
        const first = await req.preview();
        if (!isClear(first.impact)) {
          setReview({ req, ...first, staged: [], notice: null, returnTo });
          return { status: "review" };
        }
        const out = await applyChecked(req, first.version, first.impact);
        if (out.kind === "applied") {
          finish(req);
          return { status: "applied" };
        }
        setReview({ req, ...out.previewed, staged: [], notice: { tone: "warning", text: k("impact.changedJustNow") }, returnTo });
        return { status: "review" };
      } catch (e) {
        signedOut(e);
        if (isApiError(e, 404) || isApiError(e, 400, "invalid_staff")) void refreshLists();
        return { status: "failed", message: errorTextFor(req, e), error: e };
      }
    },
    [finish, refreshLists, signedOut],
  );

  const dialog = (
    <ImpactDialog
      review={review}
      tz={tz}
      setReview={setReview}
      onClose={() => setReview(null)}
      onApplied={(req) => finish(req)}
      refreshLists={refreshLists}
      signedOut={signedOut}
    />
  );
  return { submit, dialog };
}

function ImpactDialog({
  review,
  tz,
  setReview,
  onClose,
  onApplied,
  refreshLists,
  signedOut,
}: {
  review: Review | null;
  tz: string;
  setReview: (fn: (r: Review | null) => Review | null) => void;
  onClose: () => void;
  onApplied: (req: ChangeRequest) => void;
  refreshLists: () => Promise<void>;
  signedOut: (e: unknown) => boolean;
}) {
  const titleId = useId();
  const descId = useId();
  const hintId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  /** What is running: "save", the id of the conflict being resolved, or "undo:" + the id of a staged one. */
  const [busy, setBusy] = useState<string | null>(null);
  const focusNotice = useRef(false);

  useEffect(() => {
    if (focusNotice.current && review?.notice) {
      focusNotice.current = false;
      noticeRef.current?.focus();
    }
  }, [review?.notice]);

  // Kept mounted while closed so the dialog can hand focus back when it closes.
  if (!review) {
    return (
      <Dialog open={false} onClose={onClose} closable labelledBy={titleId}>
        {null}
      </Dialog>
    );
  }
  const { impact, req } = review;
  const blocked = impact.conflicts.length > 0;

  const say = (tone: Tone, text: string) => {
    focusNotice.current = true;
    setReview((r) => (r ? { ...r, notice: { tone, text } } : r));
  };

  /**
   * Preview again with `staged` (after a resolution, an undo or a race) and show `message` with the new impact.
   * Staged reassignments that no longer hold are dropped, and the notice says why instead of `message` when `message`
   * was about one of them (`about`).
   */
  async function rePreview(staged: Staged[], tone: Tone, message: string, about?: string) {
    try {
      const fresh = await review!.req.preview(toResolutions(staged));
      const { keep, dropped } = reconcile(staged, fresh.impact);
      const aboutDropped = about !== undefined && !keep.some((s) => s.conflict.reservationId === about);
      const notice =
        dropped.length === 0 ? { tone, text: message } : { tone: "warning" as const, text: [...(aboutDropped ? [] : [message]), ...dropped].join(" ") };
      focusNotice.current = true;
      setReview((r) => (r ? { ...r, ...fresh, staged: keep, notice } : r));
    } catch (e) {
      if (!signedOut(e)) say("error", errorTextFor(review!.req, e));
    }
  }

  async function save() {
    setBusy("save");
    try {
      const out = await applyChecked(req, review!.version, impact, toResolutions(review!.staged));
      if (out.kind === "applied") onApplied(req);
      else {
        const { keep, dropped } = reconcile(review!.staged, out.previewed.impact);
        focusNotice.current = true;
        setReview((r) => (r ? { ...r, ...out.previewed, staged: keep, notice: { tone: "warning", text: [k("impact.changedMeanwhile"), ...dropped].join(" ") } } : r));
        void refreshLists();
      }
    } catch (e) {
      if (!signedOut(e)) say("error", errorTextFor(req, e));
    } finally {
      setBusy(null);
    }
  }

  /** Stages "reassign `c` to `staffId`": nothing is written until the change is saved, together with it. */
  async function stage(c: ConflictDTO, staffId: number, name: string) {
    setBusy(c.id);
    try {
      const next = [...review!.staged.filter((s) => s.conflict.reservationId !== c.reservationId), { conflict: c, staffId, name }];
      await rePreview(next, "success", k("impact.resolve.staged", { ref: c.ref, name }), c.reservationId);
    } finally {
      setBusy(null);
    }
  }

  async function unstage(s: Staged) {
    setBusy(`undo:${s.conflict.reservationId}`);
    try {
      const next = review!.staged.filter((x) => x !== s);
      await rePreview(next, "success", k("impact.resolve.unstaged", { ref: s.conflict.ref, name: s.name }));
    } finally {
      setBusy(null);
    }
  }

  /** Runs an immediate resolution (cancel/decline) for conflict `c`; `action` returns the confirmation. Always re-previews afterwards. */
  async function resolve(c: ConflictDTO, action: () => Promise<string>) {
    setBusy(c.id);
    const staged = review!.staged;
    try {
      await rePreview(staged, "success", await action());
    } catch (e) {
      if (signedOut(e)) return;
      if (isApiError(e, 409, "stale")) await rePreview(staged, "warning", k("impact.resolve.stale", { ref: c.ref }));
      else if (isApiError(e, 409, "too_late")) say("error", k("impact.resolve.tooLate", { ref: c.ref }));
      else say("error", actionErrorText(e));
    } finally {
      setBusy(null);
      void refreshLists();
    }
  }

  const counts = [
    impact.conflicts.length > 0 && k("impact.countConflicts", { n: impact.conflicts.length }),
    review.staged.length > 0 && k("impact.countStaged", { n: review.staged.length }),
    impact.moved.length > 0 && k("impact.countMoved", { n: impact.moved.length }),
  ].filter(Boolean);

  return (
    <Dialog open onClose={onClose} closable={busy === null} labelledBy={titleId} describedBy={descId} initialFocus={review.notice ? noticeRef : titleRef} returnFocus={review.returnTo}>
      <header className="flex items-start gap-3 border-b border-slate-200 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 dark:border-slate-800">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 ref={titleRef} id={titleId} tabIndex={-1} className="text-xl font-bold tracking-tight outline-none">
            {k("impact.title")}
          </h2>
          <p id={descId} className="text-slate-600 dark:text-slate-400">
            <span className="font-medium text-slate-900 dark:text-slate-100">{req.summary}</span>
            {counts.length > 0 && <> · {counts.join(" · ")}</>}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={busy !== null}
          className="-mt-1 -mr-2 grid size-11 shrink-0 place-items-center rounded-lg hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800"
          aria-label={k("impact.close")}
        >
          <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
        <TimezoneNote tz={tz} />
        {/* Always rendered so outcomes are announced; it takes no space while empty. */}
        <div aria-live="polite" className="empty:mb-0">
          {review.notice && (
            <Notice ref={noticeRef} tabIndex={-1} tone={review.notice.tone} className="outline-none focus-visible:outline-2">
              {review.notice.text}
            </Notice>
          )}
        </div>

        {isClear(impact) && impact.warnings.length === 0 && (
          <p className="text-slate-700 dark:text-slate-300">{review.staged.length > 0 ? k("impact.nothingLeftStaged") : k("impact.nothingLeft")}</p>
        )}

        {impact.conflicts.length > 0 && (
          <Section tone="conflict" title={k("impact.conflictsHeading", { n: impact.conflicts.length })} lead={k("impact.conflictsLead")}>
            {impact.conflicts.map((c) => (
              <li key={c.id}>
                <ConflictCard c={c} tz={tz} busy={busy} onStage={(staffId, name) => void stage(c, staffId, name)} onResolve={(action) => void resolve(c, action)} />
              </li>
            ))}
          </Section>
        )}

        {review.staged.length > 0 && (
          <Section tone="staged" title={k("impact.stagedHeading", { n: review.staged.length })} lead={k("impact.stagedLead")}>
            {review.staged.map((st) => (
              <li key={st.conflict.reservationId}>
                <StagedCard s={st} tz={tz} busy={busy} onUndo={() => void unstage(st)} />
              </li>
            ))}
          </Section>
        )}

        {impact.moved.length > 0 && (
          <Section tone="moved" title={k("impact.movedHeading", { n: impact.moved.length })} lead={k("impact.movedLead")}>
            {impact.moved.map((m) => {
              const from = m.from ?? k("impact.unassigned");
              return (
                <li key={m.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5">
                  <span className="font-mono font-semibold">{m.ref}</span>
                  <span className="text-sm text-slate-600 tabular-nums dark:text-slate-400">{fmtDateTime(m.startAt, tz, LOCALE)}</span>
                  <span className="basis-full sm:basis-auto">
                    <span aria-hidden="true">
                      {from} <span className="text-slate-400">→</span> <span className="font-semibold">{m.to}</span>
                    </span>
                    <span className="sr-only">{k("impact.movesFromTo", { from, to: m.to })}</span>
                  </span>
                </li>
              );
            })}
          </Section>
        )}

        {impact.warnings.length > 0 && (
          <Section tone="muted" title={k("impact.warningsHeading", { n: impact.warnings.length })} lead={k("impact.warningsLead")}>
            {impact.warnings.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
                <span className="min-w-0">
                  <span className="font-mono font-semibold">{w.ref}</span> · <span className="tabular-nums">{fmtDateTime(w.startAt, tz, LOCALE)}</span>
                  <span className="block text-sm">{reasonText(w)}</span>
                </span>
                <OpenRequest c={w} />
              </li>
            ))}
          </Section>
        )}
      </div>

      <footer className="space-y-2 border-t border-slate-200 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex sm:items-center sm:gap-3 sm:space-y-0 sm:px-6 sm:py-4 dark:border-slate-800">
        {blocked && (
          <p id={hintId} className="min-w-0 flex-1 text-sm text-slate-600 dark:text-slate-400">
            {k("impact.resolveFirst")}
          </p>
        )}
        <div className="grid shrink-0 grid-cols-2 gap-3 sm:ml-auto sm:flex">
          <Button variant="secondary" onClick={onClose} disabled={busy !== null} className="shrink-0 px-3">
            {k("impact.keepEditing")}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={blocked || (busy !== null && busy !== "save")}
            loading={busy === "save"}
            aria-describedby={blocked ? hintId : undefined}
            className="shrink-0 px-3"
          >
            {busy === "save" ? k("saving") : k("impact.save")}
          </Button>
        </div>
      </footer>
    </Dialog>
  );
}

function Section({ tone, title, lead, children }: { tone: "conflict" | "staged" | "moved" | "muted"; title: string; lead: string; children: ReactNode }) {
  const id = useId();
  const dot = tone === "conflict" ? "bg-red-600" : tone === "staged" ? "bg-green-600" : tone === "moved" ? "bg-blue-600" : "bg-slate-400";
  return (
    <section aria-labelledby={id} className={tone === "muted" ? "text-slate-600 dark:text-slate-400" : ""}>
      <h3 id={id} className="flex items-center gap-2 font-semibold">
        <span className={`size-2.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        {title}
      </h3>
      <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{lead}</p>
      <ul
        className={
          tone === "conflict" || tone === "staged"
            ? "mt-3 space-y-3"
            : `mt-2 divide-y rounded-xl border px-4 ${
                tone === "moved" ? "divide-slate-200 border-slate-200 dark:divide-slate-800 dark:border-slate-800" : "divide-slate-200 border-dashed border-slate-300 dark:divide-slate-800 dark:border-slate-700"
              }`
        }
      >
        {children}
      </ul>
    </section>
  );
}

function reasonText(c: ConflictDTO): string {
  if (c.reason === "tech_removed") return c.staffName ? k("impact.reasons.tech_removed", { tech: c.staffName }) : k("impact.reasons.tech_removed_unknown");
  return k(`impact.reasons.${c.reason}`);
}

function OpenRequest({ c }: { c: ConflictDTO }) {
  return (
    <a
      href={`/staff/r/${encodeURIComponent(c.reservationId)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
    >
      {k("impact.openRequest")}
      <span className="sr-only"> {c.ref} ({k("impact.newTab")})</span>
      <svg className="size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}

/** The reservation as it is now (its version is needed for every reservation action). */
async function current(c: ConflictDTO): Promise<ReservationDTO> {
  const v = await apiFetch<StaffReservationView>(`/api/staff/reservations/${encodeURIComponent(c.reservationId)}`);
  return v.reservation;
}

async function post(c: ConflictDTO, action: "cancel" | "decline", body: Record<string, unknown>) {
  await apiFetch(`/api/staff/reservations/${encodeURIComponent(c.reservationId)}/${action}`, { method: "POST", body });
}

const REASON_MAX = 500;
type Asking = { kind: "reassign"; staffId: number } | { kind: "cancel" } | { kind: "decline" } | null;

/** A staged reassignment: saved with the change, or undone. */
function StagedCard({ s, tz, busy, onUndo }: { s: Staged; tz: string; busy: string | null; onUndo: () => void }) {
  const headingId = useId();
  const c = s.conflict;
  const mine = busy === `undo:${c.reservationId}`;
  return (
    <article aria-labelledby={headingId} aria-busy={mine || undefined} className="space-y-3 rounded-xl border border-green-300 bg-green-50/50 p-4 dark:border-green-400/40 dark:bg-green-400/5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h4 id={headingId} className="flex flex-wrap items-center gap-2">
          <span className="font-mono font-semibold">{c.ref}</span>
          <StatusPill c={c} />
        </h4>
        <OpenRequest c={c} />
      </div>
      <div className="-mt-2 space-y-0.5">
        <p className="font-medium tabular-nums">{fmtDateTime(c.startAt, tz, LOCALE)}</p>
        <p className="break-words text-slate-700 dark:text-slate-300">
          {c.customerName}
          {c.staffName && (
            <span className="text-slate-500 dark:text-slate-400">
              {" "}
              · {t("common.technician")}: {c.staffName}
            </span>
          )}
        </p>
        <p className="flex items-start gap-1.5 pt-1 text-sm font-medium text-green-800 dark:text-green-300">
          <svg className="mt-0.5 size-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m5 12 5 5L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {k("impact.stagedWill", { name: s.name })}
        </p>
      </div>
      <Button variant="secondary" disabled={busy !== null} loading={mine} onClick={onUndo} aria-label={k("impact.undoLabel", { ref: c.ref, name: s.name })}>
        {k("impact.undo")}
      </Button>
    </article>
  );
}

function StatusPill({ c }: { c: ConflictDTO }) {
  const label = c.kind === "option" ? k("impact.option") : t(`web.statusShort.${c.status}`);
  const cls =
    c.status === "confirmed"
      ? "bg-green-100 text-green-900 ring-green-300 dark:bg-green-400/15 dark:text-green-200 dark:ring-green-400/40"
      : c.status === "pending"
        ? "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-400/15 dark:text-amber-200 dark:ring-amber-400/40"
        : "bg-violet-100 text-violet-900 ring-violet-300 dark:bg-violet-400/15 dark:text-violet-200 dark:ring-violet-400/40";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}`}>{label}</span>;
}

/**
 * One conflict and what can be done about it. "Reassign to …" stages the reassignment (saved with the change);
 * cancelling or declining happens at once. Either way the change is previewed again afterwards.
 */
function ConflictCard({
  c,
  tz,
  busy,
  onStage,
  onResolve,
}: {
  c: ConflictDTO;
  tz: string;
  busy: string | null;
  onStage: (staffId: number, name: string) => void;
  onResolve: (action: () => Promise<string>) => void;
}) {
  const [asking, setAsking] = useState<Asking>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const headingId = useId();
  const askId = useId();
  const reasonId = useId();
  const firstRef = useRef<HTMLElement | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  /** `data-action` of the button that opened the confirmation, to focus it again when it closes. */
  const trigger = useRef<string | null>(null);
  const busyAlt = useRef<number | null>(null);
  const mine = busy === c.id;
  const disabled = busy !== null;

  // A fresh preview hands over a new conflict object: any open confirmation refers to the old one.
  useEffect(() => setAsking(null), [c]);

  useEffect(() => {
    if (asking) firstRef.current?.focus();
  }, [asking]);

  const open = (a: Asking, action: string) => {
    trigger.current = action;
    setReason("");
    setReasonError(null);
    setAsking(a);
  };
  const close = () => {
    setAsking(null);
    requestAnimationFrame(() => articleRef.current?.querySelector<HTMLElement>(`[data-action="${trigger.current}"]`)?.focus());
  };

  const reassign = (staffId: number, name: string) => onStage(staffId, name);

  function submitReason(kind: "cancel" | "decline") {
    const text = reason.trim();
    const err = text === "" ? k("impact.resolve.reasonRequired") : text.length > REASON_MAX ? t("web.staff.detail.decline.tooLong", { max: REASON_MAX }) : null;
    setReasonError(err);
    if (err) {
      (firstRef.current as HTMLTextAreaElement | null)?.focus();
      return;
    }
    onResolve(async () => {
      const r = await current(c);
      await post(c, kind, { reason: text, version: r.version });
      return k(kind === "cancel" ? "impact.resolve.cancelled" : "impact.resolve.declined", { ref: c.ref });
    });
  }

  const askAlt = asking?.kind === "reassign" ? c.alternatives.find((a) => a.id === asking.staffId) : undefined;
  const escape = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // Keep Esc from closing the whole dialog: it only closes this confirmation (and nothing mid-flight).
      e.preventDefault();
      e.stopPropagation();
      if (!mine) close();
    }
  };

  return (
    <article ref={articleRef} aria-labelledby={headingId} aria-busy={mine || undefined} className="space-y-3 rounded-xl border border-red-300 bg-red-50/50 p-4 dark:border-red-400/40 dark:bg-red-400/5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h4 id={headingId} className="flex flex-wrap items-center gap-2">
          <span className="font-mono font-semibold">{c.ref}</span>
          <StatusPill c={c} />
        </h4>
        <OpenRequest c={c} />
      </div>
      <div className="-mt-2 space-y-0.5">
        <p className="font-medium tabular-nums">{fmtDateTime(c.startAt, tz, LOCALE)}</p>
        <p className="break-words text-slate-700 dark:text-slate-300">
          {c.customerName}
          {c.staffName && (
            <span className="text-slate-500 dark:text-slate-400">
              {" "}
              · {t("common.technician")}: {c.staffName}
            </span>
          )}
        </p>
        <p className="flex items-start gap-1.5 pt-1 text-sm font-medium text-red-800 dark:text-red-300">
          <svg className="mt-0.5 size-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {reasonText(c)}
        </p>
      </div>

      {asking === null ? (
        <div className="space-y-2">
          {c.status === "confirmed" && c.kind === "reservation" && (
            <>
              {c.alternatives.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">{k("impact.noAlternatives")}</p>}
              <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {c.alternatives.map((a) => (
                  <li key={a.id} className="flex flex-col">
                    <Button
                      variant="secondary"
                      disabled={disabled}
                      loading={mine && busyAlt.current === a.id}
                      data-action={`reassign-${a.id}`}
                      onClick={() => {
                        if (a.displaces.length > 0) open({ kind: "reassign", staffId: a.id }, `reassign-${a.id}`);
                        else {
                          busyAlt.current = a.id;
                          reassign(a.id, a.name);
                        }
                      }}
                      className="justify-start sm:justify-center"
                    >
                      {k("impact.reassignTo", { name: a.name })}
                    </Button>
                    {a.displaces.length > 0 && (
                      <span className="mt-1 px-1 text-xs text-amber-800 dark:text-amber-300">
                        {k("impact.wouldBump", { refs: a.displaces.map((d) => d.ref).join(", ") })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {c.kind === "reservation" && (
            <div>
              <Button
                variant="ghost"
                disabled={disabled}
                data-action="close"
                onClick={() => open({ kind: c.status === "confirmed" ? "cancel" : "decline" }, "close")}
                className="-ml-2 text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-400/10"
              >
                {c.status === "confirmed" ? k("impact.cancelAppointment") : k("impact.decline")}
              </Button>
            </div>
          )}
          {c.kind === "option" && <p className="text-sm text-slate-600 dark:text-slate-400">{k("impact.optionHint")}</p>}
        </div>
      ) : asking.kind === "reassign" ? (
        <div role="group" aria-labelledby={askId} onKeyDown={escape} className="space-y-3 rounded-lg border border-amber-300 bg-white p-3 dark:border-amber-400/40 dark:bg-slate-900">
          <p id={askId} className="text-sm font-medium">
            {k("impact.bumpAsk", { ref: c.ref, name: askAlt?.name ?? "", refs: askAlt?.displaces.map((d) => d.ref).join(", ") ?? "" })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button loading={mine} onClick={() => askAlt && reassign(askAlt.id, askAlt.name)} disabled={disabled && !mine}>
              {mine ? k("impact.resolve.working") : k("impact.bumpConfirm", { name: askAlt?.name ?? "" })}
            </Button>
            <Button ref={(el) => void (firstRef.current = el)} variant="secondary" disabled={mine} onClick={close}>
              {k("impact.keep")}
            </Button>
          </div>
        </div>
      ) : (
        <form
          aria-labelledby={askId}
          noValidate
          onKeyDown={escape}
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled) submitReason(asking.kind as "cancel" | "decline");
          }}
          className="space-y-3 rounded-lg border border-red-300 bg-white p-3 dark:border-red-400/40 dark:bg-slate-900"
        >
          <p id={askId} className="text-sm font-medium">
            {asking.kind === "cancel" ? k("impact.cancelAsk", { ref: c.ref }) : k("impact.declineAsk", { ref: c.ref })}
          </p>
          <div>
            <label htmlFor={reasonId} className="mb-1.5 block text-sm font-medium">
              {t("common.reason")}
            </label>
            <textarea
              id={reasonId}
              ref={(el) => void (firstRef.current = el)}
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              aria-invalid={Boolean(reasonError)}
              aria-describedby={`${reasonId}-hint${reasonError ? ` ${reasonId}-error` : ""}`}
              onChange={(e) => {
                setReason(e.target.value);
                if (reasonError && e.target.value.trim() !== "") setReasonError(null);
              }}
              className={`${inputClass} min-h-20 resize-y`}
            />
            {reasonError && (
              <p id={`${reasonId}-error`} className="mt-1.5 text-sm font-medium text-red-700 dark:text-red-400">
                {reasonError}
              </p>
            )}
            <p id={`${reasonId}-hint`} className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
              {t("web.staff.detail.decline.reasonHint")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" loading={mine} disabled={disabled && !mine}>
              {mine ? k("impact.resolve.working") : asking.kind === "cancel" ? k("impact.cancelConfirm") : k("impact.declineConfirm")}
            </Button>
            <Button variant="secondary" disabled={mine} onClick={close}>
              {asking.kind === "cancel" ? k("impact.keepAppointment") : k("impact.keepRequest")}
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}
