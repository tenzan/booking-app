import type { ReactNode } from "react";

export const inputClass =
  "block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 placeholder:text-slate-400 " +
  "focus:border-blue-600 " +
  "aria-[invalid=true]:border-red-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 " +
  "dark:focus:border-blue-400 dark:aria-[invalid=true]:border-red-400";
// Focus ring: the global :focus-visible outline in index.css (text inputs match it on every focus).

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  /** Right-aligned text under the input, e.g. a character counter. */
  aside?: ReactNode;
  children: (control: { id: string; "aria-describedby"?: string; "aria-invalid": boolean }) => ReactNode;
}

/** Label + control + hint/error wired together with ids so screen readers announce all of them. */
export function Field({ id, label, hint, error, aside, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-medium">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": Boolean(error) })}
      <div className="mt-1.5 flex items-start justify-between gap-4 text-sm">
        <div>
          {error && (
            <p id={errorId} className="font-medium text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
          {hint && (
            <p id={hintId} className="text-slate-600 dark:text-slate-400">
              {hint}
            </p>
          )}
        </div>
        {aside && <div className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{aside}</div>}
      </div>
    </div>
  );
}
