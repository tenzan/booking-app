import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { Dialog } from "../../../components/Dialog";
import { Skeleton } from "../../../components/Spinner";
import { t } from "../../../i18n";

type FeedUrls = { mine: string; team: string };
const k = (key: string) => t(`web.staff.calendar.subscribe.${key}`);
const KEY = ["staff", "calendar-feed"] as const;

const webcal = (url: string) => url.replace(/^https?:/, "webcal:");
const google = (url: string) => `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal(url))}`;

/**
 * "Subscribe" on the Calendar page header: a dialog with the two live calendars (mine, and the rest of the team's).
 * The links are fetched, and made on first use, only when the dialog opens; nothing takes room from the grid.
 */
export function SubscribeButton() {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <svg className="size-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.75" />
          <path d="M3.5 9.5h17M8 3v4M16 3v4M9 15l2 2 4-4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {k("button")}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} closable labelledBy={titleId} initialFocus={titleRef}>
        <header className="flex items-start gap-3 border-b border-slate-200 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 dark:border-slate-800">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 ref={titleRef} id={titleId} tabIndex={-1} className="text-xl font-bold tracking-tight outline-none">
              {k("heading")}
            </h2>
            <p className="text-slate-600 dark:text-slate-400">{k("lead")}</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="-mt-1 -mr-2 grid size-11 shrink-0 place-items-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label={k("close")}
          >
            <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">{open && <Feeds />}</div>
      </Dialog>
    </>
  );
}

function Feeds() {
  const q = useQuery({ queryKey: KEY, queryFn: () => apiFetch<FeedUrls>("/api/staff/calendar-feed", { method: "POST", body: {} }), staleTime: Infinity });
  if (q.isPending) {
    return (
      <div aria-busy="true" className="space-y-3">
        <span className="sr-only">{k("loading")}</span>
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
        {t("web.errors.generic")}
        <Button variant="secondary" onClick={() => void q.refetch()}>
          {t("web.common.retry")}
        </Button>
      </Notice>
    );
  }
  return (
    <>
      {/* Keyed by link: after a reset the rows start afresh, so no "copied" message outlives the link it was about. */}
      <FeedRow key={q.data.mine} label={k("mine")} url={q.data.mine} />
      <FeedRow key={q.data.team} label={k("team")} url={q.data.team} />
      <p className="text-sm text-slate-600 dark:text-slate-400">{k("note")}</p>
      <p className="text-sm font-medium">{k("privacy")}</p>
      <ResetLinks />
    </>
  );
}

function FeedRow({ label, url }: { label: string; url: string }) {
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const headingId = useId();
  const inputId = useId();
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopy("done");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <section aria-labelledby={headingId} className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <h3 id={headingId} className="font-semibold">
        {label}
      </h3>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <a
          href={google(url)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-blue-700 px-4 text-center font-semibold text-white hover:bg-blue-800 dark:bg-blue-600"
        >
          {k("google")}
        </a>
        <a
          href={webcal(url)}
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-center font-semibold hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-800"
        >
          {k("webcal")}
        </a>
        <Button variant="secondary" onClick={() => void doCopy()}>
          {k("copy")}
        </Button>
      </div>
      <div aria-live="polite">
        {copy === "done" && <p className="text-sm text-green-800 dark:text-green-300">{k("copied")}</p>}
        {copy === "failed" && (
          <div className="space-y-1">
            <label htmlFor={inputId} className="text-sm">
              {k("copyFailed")}
            </label>
            <input
              id={inputId}
              readOnly
              value={url}
              onFocus={(e) => e.target.select()}
              className="block w-full rounded-lg border border-slate-300 px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-900"
            />
          </div>
        )}
      </div>
    </section>
  );
}

/** Reset asks first, inline (no dialog on top of the dialog). */
function ResetLinks() {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const reset = useMutation({
    mutationFn: () => apiFetch<FeedUrls>("/api/staff/calendar-feed/reset", { method: "POST", body: {} }),
    onSuccess: (urls) => {
      qc.setQueryData(KEY, urls);
      setAsking(false);
    },
  });
  return (
    <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div aria-live="polite">{reset.isSuccess && !asking && <Notice tone="success">{k("resetDone")}</Notice>}</div>
      {asking ? (
        <div className="space-y-3">
          <p>{k("resetBody")}</p>
          {reset.isError && <Notice tone="error">{t("web.errors.generic")}</Notice>}
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <Button variant="secondary" onClick={() => setAsking(false)} disabled={reset.isPending}>
              {k("cancel")}
            </Button>
            <Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate()}>
              {k("resetConfirm")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          className="-ml-3"
          onClick={() => {
            reset.reset();
            setAsking(true);
          }}
        >
          {k("reset")}
        </Button>
      )}
    </div>
  );
}
