import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ReservationDTO, TechOption } from "../../../../shared/types";
import { apiFetch, isApiError } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { t } from "../../../i18n";
import { reasonText } from "./ApprovePanel";
import { actionErrorText, type PanelProps } from "./shared";

const k = (key: string, params?: Record<string, string | number>) => t(`web.staff.detail.reassign.${key}`, params);

interface Props extends PanelProps {
  options: TechOption[];
  myId: number | null;
  /** The server's fresh technician list after a 409 tech_unavailable. */
  onOptions: (options: TechOption[]) => void;
  /** Reload the reservation (409 same_tech: someone already made the same change). */
  onRefresh: () => void;
}

/** Same-time technician choice for a confirmed appointment: the current one marked, the others free or greyed with the reason. */
export function ReassignPanel({ r, options, myId, onOptions, onRefresh, onDone, onStale }: Props) {
  const currentId = r.assignedStaff?.id ?? null;
  const isCurrent = (o: TechOption) => o.current === true || o.id === currentId;
  const choosable = (o: TechOption) => o.assignable && !isCurrent(o);
  const [selected, setSelected] = useState<number | null>(null);
  const [problem, setProblem] = useState<{ tone: "warning" | "error"; text: string; retry?: boolean } | null>(null);

  // A refreshed list can take the chosen technician away.
  useEffect(() => {
    if (selected !== null && !options.some((o) => o.id === selected && choosable(o))) setSelected(null);
  }, [options, selected]);

  const reassign = useMutation({
    mutationFn: (staffId: number) =>
      apiFetch<{ reservation: ReservationDTO }>(`/api/staff/reservations/${encodeURIComponent(r.id)}/reassign`, {
        method: "POST",
        body: { staffId, version: r.version },
      }),
    onMutate: () => setProblem(null),
    onSuccess: ({ reservation }) => onDone(k("done", { tech: reservation.assignedStaff?.name ?? "" })),
    onError: (e) => {
      if (isApiError(e, 409, "stale")) onStale((e.details as { current?: ReservationDTO } | undefined)?.current);
      else if (isApiError(e, 409, "tech_unavailable")) {
        const fresh = (e.details as { options?: TechOption[] } | undefined)?.options;
        if (fresh) onOptions(fresh);
        setProblem({ tone: "warning", text: k("techUnavailable") });
      } else if (isApiError(e, 409, "same_tech")) {
        setProblem({ tone: "warning", text: k("sameTech") });
        onRefresh();
      } else if (isApiError(e, 409, "too_late")) setProblem({ tone: "error", text: k("tooLate") });
      else if (!isApiError(e, 401)) setProblem({ tone: isApiError(e, 503) ? "warning" : "error", text: actionErrorText(e), retry: true });
    },
  });

  const anyFree = options.some(choosable);

  function confirm() {
    if (selected === null) {
      setProblem({ tone: "error", text: k("chooseFirst") });
      return;
    }
    reassign.mutate(selected);
  }

  return (
    <div className="space-y-4">
      <p className="text-slate-600 dark:text-slate-400">{k("lead")}</p>
      <fieldset>
        <legend className="mb-2 font-medium">{t("web.staff.detail.approve.techLabel")}</legend>
        <div className="space-y-2">
          {options.map((o) => {
            const current = isCurrent(o);
            const enabled = choosable(o);
            return (
              <label
                key={o.id}
                className={`flex min-h-16 items-center gap-3 rounded-xl border px-4 py-3 ${
                  enabled
                    ? "cursor-pointer border-slate-300 bg-white hover:border-blue-600 has-checked:border-blue-700 has-checked:bg-blue-50 has-checked:ring-1 has-checked:ring-blue-700 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 dark:border-slate-600 dark:bg-slate-900 dark:hover:border-blue-400 dark:has-checked:border-blue-400 dark:has-checked:bg-blue-400/10 dark:has-checked:ring-blue-400"
                    : current
                      ? "cursor-not-allowed border-green-300 bg-green-50 text-green-950 dark:border-green-400/40 dark:bg-green-400/10 dark:text-green-100"
                      : "cursor-not-allowed border-dashed border-slate-300 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-400"
                }`}
              >
                <input
                  type="radio"
                  name="reassign-technician"
                  value={o.id}
                  checked={selected === o.id}
                  disabled={!enabled}
                  onChange={() => {
                    setSelected(o.id);
                    setProblem(null);
                  }}
                  className="size-5 shrink-0 accent-blue-700 focus-visible:outline-none disabled:opacity-50"
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium break-words">
                    {o.name}
                    {o.id === myId && <span className="font-normal opacity-75"> ({t("web.staff.detail.approve.you")})</span>}
                  </span>
                  <span className={`flex items-center gap-1.5 text-sm ${enabled ? "text-green-800 dark:text-green-300" : ""}`}>
                    <span className={`size-2 shrink-0 rounded-full ${current ? "bg-green-600" : enabled ? "bg-green-600" : "bg-slate-400"}`} aria-hidden="true" />
                    {current ? k("current") : reasonText(o)}
                  </span>
                </span>
                {current && (
                  <span className="shrink-0 rounded-full bg-green-600 px-2 py-0.5 text-xs font-semibold text-white dark:bg-green-500 dark:text-green-950">
                    {k("currentBadge")}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>
      {!anyFree && <Notice tone="warning">{k("noneFree")}</Notice>}
      <div>
        {/* Always rendered so problems are announced; it takes no space while empty. */}
        <div aria-live="polite">
          {problem && (
            <Notice tone={problem.tone} className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <span>{problem.text}</span>
              {problem.retry && selected !== null && (
                <Button variant="secondary" onClick={confirm} loading={reassign.isPending}>
                  {t("web.common.retry")}
                </Button>
              )}
            </Notice>
          )}
        </div>
        <Button size="lg" block loading={reassign.isPending} disabled={!anyFree} onClick={confirm}>
          {reassign.isPending ? k("confirming") : k("confirm")}
        </Button>
      </div>
    </div>
  );
}
