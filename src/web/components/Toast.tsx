import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";

export interface ToastMessage {
  id: number;
  text: string;
}

const SHOW_MS = 6000;

/** A short-lived confirmation; `show` replaces any toast still on screen. */
export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const next = useRef(0);
  const show = useCallback((text: string) => setToast({ id: ++next.current, text }), []);
  const dismiss = useCallback(() => setToast(null), []);
  return { toast, show, dismiss };
}

/**
 * Bottom-of-screen confirmation in an always-present live region (so it is announced). It hides itself after a few
 * seconds unless the pointer or focus is on it.
 */
export function Toast({ toast, onDismiss }: { toast: ToastMessage | null; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!toast || paused) return;
    const id = window.setTimeout(onDismiss, SHOW_MS);
    return () => window.clearTimeout(id);
  }, [toast, paused, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      {toast && (
        <div
          key={toast.id}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
          className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl bg-slate-900 py-2 pr-2 pl-4 text-white shadow-lg ring-1 ring-black/10 motion-safe:animate-[toast-in_160ms_ease-out] dark:bg-slate-100 dark:text-slate-900"
        >
          <svg className="size-5 shrink-0 text-green-400 dark:text-green-700" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="min-w-0 flex-1 py-1.5">{toast.text}</p>
          <button
            type="button"
            onClick={onDismiss}
            className="grid size-11 shrink-0 place-items-center rounded-lg hover:bg-white/10 dark:hover:bg-black/10"
            aria-label={t("web.common.dismiss")}
          >
            <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
