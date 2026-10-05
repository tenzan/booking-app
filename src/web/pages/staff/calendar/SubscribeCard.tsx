import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../../api";
import { Button } from "../../../components/Button";
import { Card, Notice } from "../../../components/Card";
import { Dialog } from "../../../components/Dialog";
import { Skeleton } from "../../../components/Spinner";
import { t } from "../../../i18n";

type FeedUrls = { mine: string; team: string };
const k = (key: string) => t(`web.staff.calendar.subscribe.${key}`);
const KEY = ["staff", "calendar-feed"] as const;
const SEEN = "calendar-subscribe-seen";

const webcal = (url: string) => url.replace(/^https?:/, "webcal:");
const google = (url: string) => `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal(url))}`;

function seenBefore(): boolean {
  try {
    return localStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
}

/** Open on the first visit, collapsed afterwards; the links are fetched (and created) only once it is opened. */
export function SubscribeCard() {
  const [open, setOpen] = useState(() => !seenBefore());
  const remember = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(SEEN, "1");
    } catch {
      // Private mode: the card simply opens again next time.
    }
  };
  const q = useQuery({ queryKey: KEY, queryFn: () => apiFetch<FeedUrls>("/api/staff/calendar-feed", { method: "POST", body: {} }), enabled: open, staleTime: Infinity });
  return (
    <Card className="space-y-4">
      {/* The reset dialog inside fires its own toggle events: only the card's own open/close counts. */}
      <details open={open} onToggle={(e) => e.target === e.currentTarget && remember(e.currentTarget.open)}>
        <summary className="flex min-h-11 cursor-pointer items-center text-lg font-semibold">{k("heading")}</summary>
        <div className="mt-3 space-y-4">
          <p className="text-slate-600 dark:text-slate-400">{k("lead")}</p>
          {q.isPending ? (
            <div aria-busy="true" className="space-y-3">
              <span className="sr-only">{k("loading")}</span>
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : q.isError ? (
            <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
              {t("web.errors.generic")}
              <Button variant="secondary" onClick={() => void q.refetch()}>
                {t("web.common.retry")}
              </Button>
            </Notice>
          ) : (
            <>
              <FeedRow label={k("mine")} url={q.data.mine} />
              <FeedRow label={k("team")} url={q.data.team} />
              <p className="text-sm text-slate-600 dark:text-slate-400">{k("note")}</p>
              <p className="text-sm font-medium">{k("privacy")}</p>
              <ResetLinks />
            </>
          )}
        </div>
      </details>
    </Card>
  );
}

function FeedRow({ label, url }: { label: string; url: string }) {
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
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
    <section className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <h3 className="font-semibold">{label}</h3>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <a href={google(url)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center rounded-xl text-center bg-blue-700 px-4 font-semibold text-white hover:bg-blue-800 dark:bg-blue-600">
          {k("google")}
        </a>
        <a href={webcal(url)} className="inline-flex min-h-11 items-center justify-center rounded-xl text-center border border-slate-300 bg-white px-4 font-semibold hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-800">
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
            <label htmlFor={inputId} className="text-sm">{k("copyFailed")}</label>
            <input id={inputId} readOnly value={url} onFocus={(e) => e.target.select()} className="block w-full rounded-lg border border-slate-300 px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-900" />
          </div>
        )}
      </div>
    </section>
  );
}

function ResetLinks() {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reset = useMutation({
    mutationFn: () => apiFetch<FeedUrls>("/api/staff/calendar-feed/reset", { method: "POST", body: {} }),
    onSuccess: (urls) => {
      qc.setQueryData(KEY, urls);
      setAsking(false);
    },
  });
  return (
    <div className="space-y-2">
      <Button variant="ghost" className="-ml-3" onClick={() => setAsking(true)}>
        {k("reset")}
      </Button>
      <div aria-live="polite">{reset.isSuccess && <Notice tone="success">{k("resetDone")}</Notice>}</div>
      <Dialog open={asking} onClose={() => setAsking(false)} closable={!reset.isPending} labelledBy={titleId} describedBy={bodyId} initialFocus={cancelRef}>
        <div className="space-y-4">
          <h2 id={titleId} className="text-lg font-semibold">{k("resetTitle")}</h2>
          <p id={bodyId}>{k("resetBody")}</p>
          {reset.isError && <Notice tone="error">{t("web.errors.generic")}</Notice>}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button ref={cancelRef} variant="secondary" onClick={() => setAsking(false)} disabled={reset.isPending}>
              {k("cancel")}
            </Button>
            <Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate()}>
              {k("resetConfirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
