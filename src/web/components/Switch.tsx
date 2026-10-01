import { useId, type ReactNode, type Ref } from "react";
import { Spinner } from "./Spinner";

/**
 * An on/off switch: a button with role="switch", its visible label inside, so the whole row (at least 44px tall) is
 * the target. `busy` shows a spinner and blocks input while the change is being saved.
 */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  busy = false,
  className = "",
  id,
  ref,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  id?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <button
      ref={ref}
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy || undefined}
      aria-labelledby={labelId}
      aria-describedby={hint ? hintId : undefined}
      // Busy keeps focus on the switch (a disabled button would drop it); clicks are ignored meanwhile.
      aria-disabled={busy || undefined}
      disabled={disabled}
      onClick={() => {
        if (!busy) onChange(!checked);
      }}
      className={`group flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent dark:hover:bg-slate-800 ${className}`}
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-blue-700 dark:bg-blue-500" : "bg-slate-300 dark:bg-slate-600"
        }`}
      >
        <span
          className={`grid size-5 place-items-center rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${checked ? "translate-x-5.5" : "translate-x-0.5"}`}
        >
          {busy && <Spinner className="size-3.5 text-blue-700" />}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span id={labelId} className="block font-medium">
          {label}
        </span>
        {hint && (
          <span id={hintId} className="block text-sm text-slate-600 dark:text-slate-400">
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}
