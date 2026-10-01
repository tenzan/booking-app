import { t } from "../../../i18n";

export type Step = 1 | 2 | 3;
const KEYS = ["time", "details", "review"] as const;
export const stepName = (s: Step) => KEYS[s - 1]!;
export const stepFromName = (name: string | null): Step => ((KEYS as readonly string[]).indexOf(name ?? "") + 1 || 1) as Step;

/** "1 Time · 2 Details · 3 Review". Earlier steps are links back; later ones are inert. */
export function Steps({ current, onGo }: { current: Step; onGo: (s: Step) => void }) {
  return (
    <nav aria-label={t("web.book.stepsLabel")}>
      <ol className="flex items-center gap-1 sm:gap-2">
        {([1, 2, 3] as const).map((s) => {
          const done = s < current;
          const active = s === current;
          const label = t(`web.book.steps.${stepName(s)}`);
          const dot = (
            <span
              className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${
                active
                  ? "bg-blue-700 text-white dark:bg-blue-600"
                  : done
                    ? "bg-blue-100 text-blue-800 dark:bg-blue-400/20 dark:text-blue-200"
                    : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
              }`}
              aria-hidden="true"
            >
              {done ? (
                <svg className="size-4" viewBox="0 0 24 24" fill="none">
                  <path d="m5 12 5 5 9-10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                s
              )}
            </span>
          );
          const text = (
            <span className={`text-sm font-medium ${active ? "" : "text-slate-600 dark:text-slate-400"}`}>
              <span className="sr-only">{t("web.book.stepOf", { n: s, total: 3 })}: </span>
              {label}
            </span>
          );
          return (
            <li key={s} className="flex flex-1 items-center gap-1 sm:gap-2" aria-current={active ? "step" : undefined}>
              {done ? (
                <button type="button" onClick={() => onGo(s)} className="flex min-h-11 items-center gap-2 rounded-lg pr-2 hover:underline">
                  {dot}
                  {text}
                </button>
              ) : (
                <span className="flex min-h-11 items-center gap-2 pr-2">
                  {dot}
                  {text}
                </span>
              )}
              {s < 3 && <span className="h-px flex-1 bg-slate-300 dark:bg-slate-700" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
