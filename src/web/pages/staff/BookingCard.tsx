import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, isApiError, queryKeys, type Me } from "../../api";
import { Button } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { t } from "../../i18n";

/**
 * Online-booking switch. Administrators get a toggle with an inline confirmation (no window.confirm);
 * technicians see the state read-only. The outcome is announced through an always-present live region.
 */
export function BookingCard({ enabled, isAdmin }: { enabled: boolean; isAdmin: boolean }) {
  const qc = useQueryClient();
  const headingId = useId();
  const askId = useId();
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  // Focus follows the inline confirmation: into it when it opens (on the safe choice), back to the toggle when it closes.
  useEffect(() => {
    if (asking) cancelRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      toggleRef.current?.focus();
    }
  }, [asking]);

  const change = useMutation({
    mutationFn: (next: boolean) => apiFetch<{ bookingEnabled: boolean }>("/api/staff/settings/booking", { method: "POST", body: { enabled: next } }),
    onMutate: () => setResult(null),
    onSuccess: async ({ bookingEnabled }) => {
      qc.setQueryData<Me>(queryKeys.me, (old) => (old ? { ...old, bookingEnabled } : old));
      setResult({ tone: "success", text: t(bookingEnabled ? "web.staff.dashboard.booking.doneResumed" : "web.staff.dashboard.booking.donePaused") });
      returnFocus.current = true;
      setAsking(false);
      await qc.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (e) => {
      if (isApiError(e, 401)) return;
      setResult({ tone: "error", text: t("web.staff.dashboard.booking.failed") });
      returnFocus.current = true;
      setAsking(false);
    },
  });

  const k = (key: string) => t(`web.staff.dashboard.booking.${key}`);
  const badge = enabled
    ? "bg-green-100 text-green-900 ring-green-300 dark:bg-green-400/15 dark:text-green-200 dark:ring-green-400/40"
    : "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-400/15 dark:text-amber-200 dark:ring-amber-400/40";

  function cancel() {
    returnFocus.current = true;
    setAsking(false);
  }

  return (
    <Card className="space-y-4" role="region" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 space-y-1">
          <h2 id={headingId} className="flex items-center gap-2 text-lg font-semibold">
            {k("heading")}
            <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ring-1 ring-inset ${badge}`}>{enabled ? k("on") : k("off")}</span>
          </h2>
          <p className="text-slate-600 dark:text-slate-400">{enabled ? k("explainOn") : k("explainOff")}</p>
          {!isAdmin && <p className="text-sm text-slate-500 dark:text-slate-400">{k("adminOnly")}</p>}
        </div>
        {isAdmin && !asking && (
          <Button ref={toggleRef} variant={enabled ? "secondary" : "primary"} onClick={() => setAsking(true)}>
            {enabled ? k("pause") : k("resume")}
          </Button>
        )}
      </div>

      {isAdmin && asking && (
        <div
          role="group"
          aria-labelledby={askId}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !change.isPending) cancel();
          }}
          className="space-y-3 rounded-xl border border-slate-300 bg-slate-50 p-4 dark:border-slate-600 dark:bg-slate-800/50"
        >
          <p id={askId} className="font-medium">
            {enabled ? k("pauseAsk") : k("resumeAsk")}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant={enabled ? "danger" : "primary"} loading={change.isPending} onClick={() => change.mutate(!enabled)}>
              {change.isPending ? k("working") : enabled ? k("pauseConfirm") : k("resumeConfirm")}
            </Button>
            <Button ref={cancelRef} variant="secondary" disabled={change.isPending} onClick={cancel}>
              {k("cancel")}
            </Button>
          </div>
        </div>
      )}

      {/* Always rendered so the outcome is announced; it takes no space while empty. */}
      <div aria-live="polite" className="empty:hidden">
        {result && <Notice tone={result.tone}>{result.text}</Notice>}
      </div>
    </Card>
  );
}
