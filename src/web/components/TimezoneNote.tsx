import { fmtTz } from "../format";
import { t } from "../i18n";

/** "All times in Asia/Tokyo (GMT+9)" — required wherever times are shown. */
export function TimezoneNote({ tz, atMs, className = "", inheritColor = false }: { tz: string; atMs?: number; className?: string; inheritColor?: boolean }) {
  return (
    <p className={`flex items-center gap-1.5 text-sm ${inheritColor ? "" : "text-slate-600 dark:text-slate-400"} ${className}`}>
      <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
        <path d="M3 12h18M12 3c2.5 2.6 3.75 5.6 3.75 9S14.5 18.4 12 21c-2.5-2.6-3.75-5.6-3.75-9S9.5 5.6 12 3Z" stroke="currentColor" strokeWidth="1.75" />
      </svg>
      {t("web.common.allTimesIn", { tz: fmtTz(tz, atMs) })}
    </p>
  );
}
