import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ReservationDTO, TechOption } from "../../../../shared/types";
import { apiFetch, isApiError } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { t } from "../../../i18n";
import { actionErrorText, type PanelProps } from "./shared";

export function reasonText(o: TechOption): string {
  if (o.reason === "busy") return o.conflictRef ? t("web.staff.detail.reasons.busy", { ref: o.conflictRef }) : t("web.staff.detail.reasons.busyNoRef");
  return o.reason ? t(`web.staff.detail.reasons.${o.reason}`) : t("web.staff.detail.approve.free");
}

interface Props extends PanelProps {
  options: TechOption[];
  myId: number | null;
  /** `?assign=me` from the email: preselect the signed-in technician, but only if they can take it. */
  assignMe: boolean;
  /** The server's fresh technician list after a 409 tech_unavailable. */
  onOptions: (options: TechOption[]) => void;
}

/** Technician radio cards (free ones first, others greyed with the reason) and the confirm button. */
export function ApprovePanel({ r, options, myId, assignMe, onOptions, onDone, onStale }: Props) {
  const [selected, setSelected] = useState<number | null>(() =>
    assignMe && options.some((o) => o.id === myId && o.assignable) ? myId : null,
  );
  const [problem, setProblem] = useState<{ tone: "warning" | "error"; text: string; retry?: boolean } | null>(null);

  // A refreshed list can take the chosen technician away.
  useEffect(() => {
    if (selected !== null && !options.some((o) => o.id === selected && o.assignable)) setSelected(null);
  }, [options, selected]);

  const approve = useMutation({
    mutationFn: (staffId: number) =>
      apiFetch<{ reservation: ReservationDTO }>(`/api/staff/reservations/${encodeURIComponent(r.id)}/approve`, {
        method: "POST",
        body: { staffId, version: r.version },
      }),
    onMutate: () => setProblem(null),
    onSuccess: ({ reservation }) =>
      onDone(t("web.staff.detail.approve.done", { tech: reservation.assignedStaff?.name ?? "" })),
    onError: (e) => {
      if (isApiError(e, 409, "stale")) onStale((e.details as { current?: ReservationDTO } | undefined)?.current);
      else if (isApiError(e, 409, "tech_unavailable")) {
        const fresh = (e.details as { options?: TechOption[] } | undefined)?.options;
        if (fresh) onOptions(fresh);
        setProblem({ tone: "warning", text: t("web.staff.detail.approve.techUnavailable") });
      } else if (isApiError(e, 409, "customer_ineligible")) setProblem({ tone: "error", text: t("web.staff.detail.approve.customerIneligible") });
      else if (!isApiError(e, 401)) setProblem({ tone: isApiError(e, 503) ? "warning" : "error", text: actionErrorText(e), retry: true });
    },
  });

  const anyFree = options.some((o) => o.assignable);

  function confirm() {
    if (selected === null) {
      setProblem({ tone: "error", text: t("web.staff.detail.approve.chooseFirst") });
      return;
    }
    approve.mutate(selected);
  }

  return (
    <div className="space-y-4">
      <p className="text-slate-600 dark:text-slate-400">{t("web.staff.detail.approve.lead")}</p>
      {!r.customer.active && <Notice tone="warning">{t("web.staff.detail.approve.customerIneligible")}</Notice>}
      <fieldset>
        <legend className="mb-2 font-medium">{t("web.staff.detail.approve.techLabel")}</legend>
        <div className="space-y-2">
          {options.map((o) => (
            <label
              key={o.id}
              className={`flex min-h-16 items-center gap-3 rounded-xl border px-4 py-3 ${
                o.assignable
                  ? "cursor-pointer border-slate-300 bg-white hover:border-blue-600 has-checked:border-blue-700 has-checked:bg-blue-50 has-checked:ring-1 has-checked:ring-blue-700 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 dark:border-slate-600 dark:bg-slate-900 dark:hover:border-blue-400 dark:has-checked:border-blue-400 dark:has-checked:bg-blue-400/10 dark:has-checked:ring-blue-400"
                  : "cursor-not-allowed border-dashed border-slate-300 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-400"
              }`}
            >
              <input
                type="radio"
                name="technician"
                value={o.id}
                checked={selected === o.id}
                disabled={!o.assignable}
                onChange={() => {
                  setSelected(o.id);
                  setProblem(null);
                }}
                className="size-5 shrink-0 accent-blue-700 focus-visible:outline-none disabled:opacity-50"
              />
              <span className="min-w-0 flex-1">
                <span className="block break-words font-medium">
                  {o.name}
                  {o.id === myId && <span className="font-normal text-slate-500 dark:text-slate-400"> ({t("web.staff.detail.approve.you")})</span>}
                </span>
                <span className={`flex items-center gap-1.5 text-sm ${o.assignable ? "text-green-800 dark:text-green-300" : ""}`}>
                  <span className={`size-2 shrink-0 rounded-full ${o.assignable ? "bg-green-600" : "bg-slate-400"}`} aria-hidden="true" />
                  {reasonText(o)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {!anyFree && <Notice tone="warning">{t("web.staff.detail.approve.noneFree")}</Notice>}
      <div aria-live="polite" className="empty:hidden">
        {problem && (
          <Notice tone={problem.tone} className="flex flex-wrap items-center justify-between gap-3">
            <span>{problem.text}</span>
            {problem.retry && selected !== null && (
              <Button variant="secondary" onClick={confirm} loading={approve.isPending}>
                {t("web.common.retry")}
              </Button>
            )}
          </Notice>
        )}
      </div>
      <Button size="lg" block loading={approve.isPending} disabled={!anyFree} onClick={confirm}>
        {approve.isPending ? t("web.staff.detail.approve.confirming") : t("web.staff.detail.approve.confirm")}
      </Button>
    </div>
  );
}
