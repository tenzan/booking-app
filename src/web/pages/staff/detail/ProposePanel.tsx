import { useEffect, useId, useRef, useState } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { MAX_PROPOSAL_OPTIONS as MAX_OPTIONS, PROPOSAL_MESSAGE_MAX as MESSAGE_MAX } from "../../../../shared/schemas";
import type { ProposalCandidatesDTO, ReservationDTO } from "../../../../shared/types";
import { apiFetch, isApiError, queryKeys } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { Field, inputClass } from "../../../components/Field";
import { Spinner } from "../../../components/Spinner";
import { TimezoneNote } from "../../../components/TimezoneNote";
import { addDays, dateIn, dayParts, fmtLongDate, fmtShortDate, fmtStamp, fmtTimeRange, fmtWhen, todayIn } from "../../../format";
import { t } from "../../../i18n";
import { WithdrawProposal } from "./ProposalCard";
import { actionErrorText, type PanelProps } from "./shared";

const k = (key: string, params?: Record<string, string | number>) => t(`web.staff.lifecycle.propose.${key}`, params);

/** Dates per candidates request (the API allows up to 14). */
const PAGE_DAYS = 14;

type Day = ProposalCandidatesDTO["days"][number];
type CandidateSlot = Day["slots"][number];
interface Pick {
  startAt: number;
  endAt: number;
  staffId: number;
}

/** Errors that name one option (`details.index`); the list of times is reloaded after them. */
const OPTION_ERRORS = [
  "option_not_a_slot",
  "option_too_soon",
  "option_beyond_horizon",
  "option_tech_unavailable",
  "option_overlaps_current",
  "options_conflict",
  "option_duplicate_time",
  "option_same_as_current",
] as const;

interface Props extends PanelProps {
  tz: string;
  /** Withdrawing the open proposal from here: confirmation, or "it had already closed" (reload). */
  onWithdrawn: (text: string) => void;
  onChanged: (text: string) => void;
}

/**
 * Up to three other times for a pending request or confirmed appointment: dates and times from the candidates API
 * (only times that could be held now), each with a technician (the current one preselected when free), an optional
 * message, and a preview of what the customer will see (times only). An open proposal is shown with Withdraw; sending
 * replaces it.
 */
export function ProposePanel({ r, tz, onDone, onStale, onWithdrawn, onChanged }: Props) {
  const ids = useId();
  const today = todayIn(tz);
  const currentTech = r.status === "confirmed" ? (r.assignedStaff?.id ?? null) : r.provisionalStaffId;
  const [date, setDate] = useState<string | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState<{ tone: "warning" | "error"; text: string } | null>(null);
  const selectionRef = useRef<HTMLHeadingElement>(null);

  const candidates = useInfiniteQuery({
    // Under the reservation queries: any change to a reservation reloads the times too.
    queryKey: [...queryKeys.staffReservations, "candidates", r.id, today],
    queryFn: ({ pageParam }) =>
      apiFetch<ProposalCandidatesDTO>(
        `/api/staff/reservations/${encodeURIComponent(r.id)}/proposal-candidates?from=${pageParam}&to=${addDays(pageParam, PAGE_DAYS - 1)}`,
      ),
    initialPageParam: today,
    // Up to the booking window's last date: no empty page after it.
    getNextPageParam: (last, _all, lastParam) => {
      const next = addDays(lastParam, PAGE_DAYS);
      return next > last.lastDate ? undefined : next;
    },
    refetchOnWindowFocus: "always",
    retry: (n, e) => !isApiError(e, 409) && !isApiError(e, 404) && n < 2,
  });
  const days: Day[] = candidates.data?.pages.flatMap((p) => p.days) ?? [];
  const slotAt = new Map(days.flatMap((d) => d.slots.map((s) => [s.startAt, s] as const)));
  const shownDate = date !== null && days.some((d) => d.date === date) ? date : (days.find((d) => d.slots.length > 0)?.date ?? days[0]?.date ?? null);
  const shownDay = days.find((d) => d.date === shownDate) ?? null;

  const defaultTech = (slot: CandidateSlot) => (slot.staff.some((s) => s.id === currentTech) ? currentTech! : slot.staff[0]!.id);

  // Reloaded times can take a chosen time or technician away: drop the time, or move it to a technician still free,
  // and say so (in the panel's live region, after any message already there).
  useEffect(() => {
    if (!candidates.data) return;
    const notes: string[] = [];
    const next = picks.flatMap((p) => {
      const when = fmtStamp(p.startAt, tz);
      const slot = slotAt.get(p.startAt);
      if (!slot) {
        notes.push(k("pickDropped", { when }));
        return [];
      }
      if (slot.staff.some((s) => s.id === p.staffId)) return [p];
      const staffId = defaultTech(slot);
      notes.push(k("pickTechChanged", { when, name: slot.staff.find((s) => s.id === staffId)?.name ?? "" }));
      return [{ ...p, staffId }];
    });
    if (notes.length === 0) return;
    setPicks(next);
    setProblem((old) => ({ tone: old?.tone ?? "warning", text: [...(old ? [old.text] : []), ...notes].join(" ") }));
  }, [candidates.data]);

  const toggle = (slot: CandidateSlot) => {
    setProblem(null);
    setPicks((old) =>
      old.some((p) => p.startAt === slot.startAt)
        ? old.filter((p) => p.startAt !== slot.startAt)
        : old.length >= MAX_OPTIONS
          ? old
          : [...old, { startAt: slot.startAt, endAt: slot.endAt, staffId: defaultTech(slot) }].sort((a, b) => a.startAt - b.startAt),
    );
  };

  const send = useMutation({
    mutationFn: (body: { options: Array<{ startAt: number; staffId: number }>; message?: string; version: number }) =>
      apiFetch<{ reservation: ReservationDTO }>(`/api/staff/reservations/${encodeURIComponent(r.id)}/propose`, { method: "POST", body }),
    onMutate: () => setProblem(null),
    onSuccess: ({ reservation }) => {
      const n = reservation.proposal?.options.length ?? picks.length;
      onDone(n === 1 ? k("doneOne") : k("done", { n }));
    },
    onError: (e, body) => {
      if (isApiError(e, 409, "stale")) return onStale((e.details as { current?: ReservationDTO } | undefined)?.current);
      if (isApiError(e, 409, "too_late")) return setProblem({ tone: "error", text: k("tooLate") });
      const code = OPTION_ERRORS.find((c) => isApiError(e, 409, c) || isApiError(e, 400, c));
      if (code) {
        const index = (e as { details?: { index?: unknown } }).details?.index;
        const option = typeof index === "number" ? body.options[index] : undefined;
        const when = option ? fmtWhen(option.startAt, slotAt.get(option.startAt)?.endAt ?? option.startAt, tz) : "";
        const key = code === "option_overlaps_current" && !option ? "option_overlaps_current_any" : code;
        setProblem({ tone: "warning", text: k(`errors.${key}`, { when }) });
        void candidates.refetch();
        return;
      }
      if (!isApiError(e, 401)) setProblem({ tone: isApiError(e, 503) ? "warning" : "error", text: actionErrorText(e) });
    },
  });

  function submit() {
    if (picks.length === 0) {
      setProblem({ tone: "error", text: k("chooseFirst") });
      return;
    }
    const text = message.trim();
    send.mutate({ options: picks.map((p) => ({ startAt: p.startAt, staffId: p.staffId })), ...(text ? { message: text } : {}), version: r.version });
  }

  const open = r.proposal?.status === "open" ? r.proposal : null;
  const tooLate = isApiError(candidates.error, 409, "too_late");
  const full = picks.length >= MAX_OPTIONS;

  return (
    <div className="space-y-5">
      {open && (
        <div className="space-y-3 rounded-xl border border-violet-300 bg-violet-50/60 p-4 dark:border-violet-400/40 dark:bg-violet-400/5">
          <p className="font-medium">{k("openNotice", { when: fmtStamp(open.createdAt, tz), expires: fmtStamp(open.expiresAt, tz) })}</p>
          <WithdrawProposal r={r} proposal={open} onDone={onWithdrawn} onChanged={onChanged} />
        </div>
      )}

      {tooLate ? (
        <Notice tone="warning">{k("tooLate")}</Notice>
      ) : (
        <>
          <p className="text-slate-600 dark:text-slate-400">{r.status === "confirmed" ? k("leadConfirmed") : k("leadPending")}</p>
          <TimezoneNote tz={tz} atMs={r.startAt} />

          {candidates.isPending ? (
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400" aria-busy="true">
              <Spinner />
              {t("web.common.loading")}
            </div>
          ) : candidates.isError && days.length === 0 ? (
            <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
              {k("loadFailed")}
              <Button variant="secondary" onClick={() => void candidates.refetch()}>
                {t("web.common.retry")}
              </Button>
            </Notice>
          ) : (
            <>
              <ul aria-label={k("datesLabel")} className="-mx-1 flex snap-x gap-2 overflow-x-auto scroll-px-1 px-1 pt-1 pb-3">
                {days.map((d) => {
                  const p = dayParts(d.date);
                  const n = d.slots.length;
                  const selected = d.date === shownDate;
                  const chosen = picks.filter((x) => dateIn(x.startAt, tz) === d.date).length;
                  const count = n === 0 ? k("dayNoTimes") : n === 1 ? k("dayOneTime") : k("dayTimes", { n });
                  return (
                    <li key={d.date} className="w-16 shrink-0 snap-start">
                      <button
                        type="button"
                        disabled={n === 0}
                        aria-pressed={selected}
                        aria-label={`${fmtLongDate(d.date)}, ${count}${chosen > 0 ? `, ${k("chosen")} ${chosen}` : ""}`}
                        onClick={() => setDate(d.date)}
                        className={`relative flex h-20 w-full flex-col items-center justify-center rounded-xl border text-center ${
                          selected
                            ? "border-violet-700 bg-violet-700 text-white shadow-md dark:border-violet-400 dark:bg-violet-600"
                            : n === 0
                              ? "cursor-not-allowed border-transparent bg-slate-100 text-slate-500 dark:bg-slate-900/60 dark:text-slate-500"
                              : "border-slate-300 bg-white hover:border-violet-600 hover:bg-violet-50 dark:border-slate-600 dark:bg-slate-900 dark:hover:border-violet-400 dark:hover:bg-slate-800"
                        }`}
                      >
                        <span className={`text-xs font-medium uppercase ${selected ? "text-violet-100" : ""}`}>{p.weekday}</span>
                        <span className="text-xl leading-tight font-bold tabular-nums">{p.day}</span>
                        <span className={`text-xs ${selected ? "text-violet-100" : n === 0 ? "" : "text-slate-500 dark:text-slate-400"}`}>{p.month}</span>
                        {chosen > 0 && (
                          <span
                            className={`absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full text-xs font-bold ${
                              selected ? "bg-white text-violet-800" : "bg-violet-700 text-white dark:bg-violet-500"
                            }`}
                            aria-hidden="true"
                          >
                            {chosen}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
                {candidates.hasNextPage && (
                  <li className="w-24 shrink-0 snap-start">
                    <button
                      type="button"
                      onClick={() => void candidates.fetchNextPage()}
                      disabled={candidates.isFetchingNextPage}
                      aria-busy={candidates.isFetchingNextPage || undefined}
                      className="flex h-20 w-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 px-2 text-center text-sm font-medium text-blue-700 hover:bg-blue-50 dark:border-slate-600 dark:text-blue-300 dark:hover:bg-slate-800"
                    >
                      {candidates.isFetchingNextPage ? (
                        <>
                          <Spinner />
                          <span className="sr-only">{k("loadingLater")}</span>
                        </>
                      ) : (
                        k("later")
                      )}
                    </button>
                  </li>
                )}
              </ul>

              {days.every((d) => d.slots.length === 0) ? (
                <p className="text-slate-600 dark:text-slate-400">{k("noTimesAtAll")}</p>
              ) : shownDay ? (
                <section aria-labelledby={`${ids}-times`} className="space-y-2">
                  <h3 id={`${ids}-times`} className="font-medium">
                    {k("timesHeading", { date: fmtShortDate(shownDay.date) })}
                  </h3>
                  {shownDay.slots.length === 0 ? (
                    <p className="text-slate-600 dark:text-slate-400">{k("noTimesDay")}</p>
                  ) : (
                    <ul className="grid grid-cols-2 gap-2">
                      {shownDay.slots.map((s) => {
                        const chosen = picks.some((p) => p.startAt === s.startAt);
                        return (
                          <li key={s.startAt}>
                            <button
                              type="button"
                              aria-pressed={chosen}
                              disabled={!chosen && full}
                              onClick={() => toggle(s)}
                              className={`flex min-h-14 w-full flex-col items-start justify-center rounded-xl border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
                                chosen
                                  ? "border-violet-700 bg-violet-50 ring-1 ring-violet-700 dark:border-violet-400 dark:bg-violet-400/10 dark:ring-violet-400"
                                  : "border-slate-300 bg-white hover:border-violet-600 dark:border-slate-600 dark:bg-slate-900 dark:hover:border-violet-400"
                              }`}
                            >
                              <span className="font-semibold tabular-nums">{fmtTimeRange(s.startAt, s.endAt, tz)}</span>
                              <span className="text-sm text-slate-600 dark:text-slate-400">
                                {chosen ? k("chosen") : s.staff.length === 1 ? k("techFree") : k("techsFree", { n: s.staff.length })}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {full && <p className="text-sm text-slate-600 dark:text-slate-400">{k("maxReached")}</p>}
                </section>
              ) : null}
            </>
          )}

          <section aria-labelledby={`${ids}-selection`} className="space-y-2">
            <h3 id={`${ids}-selection`} ref={selectionRef} tabIndex={-1} className="font-medium outline-none">
              {k("selectionHeading", { n: picks.length, max: MAX_OPTIONS })}
            </h3>
            {picks.length === 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-400">{k("selectionEmpty")}</p>
            ) : (
              <ol className="space-y-2">
                {picks.map((p) => {
                  const slot = slotAt.get(p.startAt);
                  const when = fmtWhen(p.startAt, p.endAt, tz);
                  const selectId = `${ids}-tech-${p.startAt}`;
                  return (
                    <li key={p.startAt} className="space-y-2 rounded-xl border border-violet-300 p-3 dark:border-violet-400/40">
                      <div className="flex items-start justify-between gap-2">
                        <p className="pt-2 font-medium tabular-nums">{when}</p>
                        <Button
                          variant="ghost"
                          aria-label={k("removeLabel", { when })}
                          onClick={() => {
                            setPicks((old) => old.filter((x) => x.startAt !== p.startAt));
                            selectionRef.current?.focus();
                          }}
                          className="-mr-2 shrink-0 px-3"
                        >
                          {k("remove")}
                        </Button>
                      </div>
                      <div>
                        <label htmlFor={selectId} className="mb-1 block text-sm font-medium">
                          {k("techFor", { when: fmtTimeRange(p.startAt, p.endAt, tz) })}
                        </label>
                        <select
                          id={selectId}
                          value={p.staffId}
                          onChange={(e) => {
                            const staffId = Number(e.target.value);
                            setProblem(null);
                            setPicks((old) => old.map((x) => (x.startAt === p.startAt ? { ...x, staffId } : x)));
                          }}
                          className="block min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                        >
                          {(slot?.staff ?? []).map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.id === currentTech ? k("currentTech", { name: s.name }) : s.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <Field
            id={`${ids}-message`}
            label={k("messageLabel")}
            hint={k("messageHint")}
            aside={t("web.book.details.counter", { n: message.length, max: MESSAGE_MAX })}
          >
            {(aria) => (
              <textarea
                {...aria}
                rows={3}
                maxLength={MESSAGE_MAX}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className={`${inputClass} min-h-24 resize-y`}
              />
            )}
          </Field>

          <CustomerPreview r={r} picks={picks} message={message.trim()} tz={tz} />

          <div>
            {/* Always rendered so problems are announced; it takes no space while empty. */}
            <div aria-live="polite">{problem && <Notice tone={problem.tone} className="mb-4">{problem.text}</Notice>}</div>
            <Button size="lg" block loading={send.isPending} onClick={submit}>
              {send.isPending ? k("sending") : open ? k("sendReplace") : k("send")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** The proposal email's gist as the customer gets it: times only, never a technician. */
function CustomerPreview({ r, picks, message, tz }: { r: ReservationDTO; picks: Pick[]; message: string; tz: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="font-medium">
        {k("previewHeading")}
      </h3>
      <div className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm dark:border-slate-600 dark:bg-slate-950/40">
        {picks.length === 0 ? (
          <p className="text-slate-600 dark:text-slate-400">{k("previewEmpty")}</p>
        ) : (
          <>
            <p>{r.status === "confirmed" ? t("email.proposal.introConfirmed") : t("email.proposal.introPending")}</p>
            {message && <p className="break-words whitespace-pre-wrap">{t("email.proposal.message", { message })}</p>}
            <p>{t("email.proposal.choose")}</p>
            <ul className="space-y-1.5">
              {picks.map((p) => (
                <li key={p.startAt} className="rounded-lg border border-blue-300 bg-white px-3 py-2 font-semibold text-blue-800 tabular-nums dark:border-blue-400/40 dark:bg-slate-900 dark:text-blue-200">
                  {t("email.proposal.option", { when: fmtStamp(p.startAt, tz) })}
                </li>
              ))}
            </ul>
            <p className="text-slate-600 dark:text-slate-400">{r.status === "confirmed" ? k("previewKeepConfirmed") : k("previewOtherPending")}</p>
          </>
        )}
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-400">{k("previewNote")}</p>
    </section>
  );
}
