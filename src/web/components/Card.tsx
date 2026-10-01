import type { HTMLAttributes } from "react";

/** The standard surface: rounded, bordered, padded. */
export function Card({ className = "", flush = false, ...rest }: HTMLAttributes<HTMLDivElement> & { flush?: boolean }) {
  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:shadow-none ${flush ? "" : "p-5 sm:p-6"} ${className}`}
      {...rest}
    />
  );
}

type Tone = "info" | "warning" | "error" | "success";
const tones: Record<Tone, string> = {
  info: "border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-400/30 dark:bg-blue-400/10 dark:text-blue-100",
  warning: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-100",
  error: "border-red-300 bg-red-50 text-red-950 dark:border-red-400/40 dark:bg-red-400/10 dark:text-red-100",
  success: "border-green-300 bg-green-50 text-green-950 dark:border-green-400/40 dark:bg-green-400/10 dark:text-green-100",
};

/** Inline message banner. Render it inside an always-present `aria-live` region to have it announced. */
export function Notice({ tone = "info", className = "", ...rest }: HTMLAttributes<HTMLDivElement> & { tone?: Tone }) {
  return <div className={`rounded-xl border px-4 py-3 ${tones[tone]} ${className}`} {...rest} />;
}
