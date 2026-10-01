import { useId } from "react";
import type { AuditRow } from "../../../../shared/types";
import { Card } from "../../../components/Card";
import { TimezoneNote } from "../../../components/TimezoneNote";
import { fmtDateTime, LOCALE, t } from "../../../i18n";

/** Catalog keys can't contain dots, so "reservation.approved" is looked up as "reservation_approved"; unknown actions show as-is. */
const actionLabel = (action: string): string => {
  const key = `web.staff.detail.auditActions.${action.replaceAll(".", "_")}`;
  const label = t(key);
  return label === key ? action : label;
};

/** The reservation's audit trail, oldest first. */
export function History({ audit, tz }: { audit: AuditRow[]; tz: string }) {
  const id = useId();
  if (audit.length === 0) return null;
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="text-lg font-semibold">
          {t("web.staff.detail.historyHeading")}
        </h2>
        <TimezoneNote tz={tz} />
      </div>
      <Card>
        <ol className="space-y-4">
          {audit.map((a, i) => {
            const reason = typeof a.details === "object" && a.details !== null ? (a.details as { reason?: unknown }).reason : undefined;
            return (
              <li key={i} className="flex gap-3">
                <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-slate-400 dark:bg-slate-500" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-medium">{actionLabel(a.action)}</p>
                  <p className="text-sm break-words text-slate-600 dark:text-slate-400">
                    {a.actor ?? t("web.staff.detail.system")} · {fmtDateTime(a.at, tz, LOCALE)}
                  </p>
                  {typeof reason === "string" && <p className="mt-1 text-sm break-words whitespace-pre-wrap">{reason}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>
    </section>
  );
}
