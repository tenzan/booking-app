import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  open: boolean;
  /** Esc or a close button asked to close; ignored while `closable` is false. */
  onClose: () => void;
  /** False while something is in flight: Esc does nothing then. */
  closable: boolean;
  /** Id of the visible title (the dialog's accessible name). */
  labelledBy: string;
  describedBy?: string;
  /** Receives focus when the dialog opens (e.g. the title, with tabIndex -1); the first control otherwise. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Where focus goes back to on close; by default whatever had focus when it opened. */
  returnFocus?: HTMLElement | null;
  children: ReactNode;
}

/**
 * Modal dialog on the native <dialog> (the page behind is inert). Focus is kept inside, Esc closes unless
 * `closable` is false, and focus goes back to whatever had it before the dialog opened. Full screen on phones,
 * a centred panel from `sm` up; children lay out the header, scrolling body and footer.
 */
export function Dialog({ open, onClose, closable, labelledBy, describedBy, initialFocus, returnFocus, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const closableRef = useRef(closable);
  closableRef.current = closable;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      d.showModal();
      document.documentElement.style.overflow = "hidden";
      (initialFocus?.current ?? d.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    } else if (!open && d.open) {
      d.close();
    }
    if (!open) {
      document.documentElement.style.overflow = "";
      const target = returnTo.current;
      returnTo.current = null;
      if (target?.isConnected) target.focus();
    }
    // Focus targets are read when it opens or closes; changing them in between means nothing.
  }, [open]);

  // Never leave the page scroll-locked if the dialog unmounts while open.
  useEffect(() => () => void (document.documentElement.style.overflow = ""), []);

  function onKeyDown(e: KeyboardEvent<HTMLDialogElement>) {
    if (e.key === "Escape") {
      // Handled here rather than by the browser so an Esc mid-flight can't close it.
      e.preventDefault();
      if (closableRef.current) onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    // Focus on something that isn't a tab stop (the title, a notice): wrap when nothing lies beyond it.
    if (active && ref.current?.contains(active) && !items.includes(active as HTMLElement)) {
      const before = items.filter((el) => el.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).length;
      if (e.shiftKey && before === 0) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && before === items.length) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.shiftKey && (active === first || !ref.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !ref.current?.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onKeyDown={onKeyDown}
      // The browser's own close request (e.g. a second Esc) — honour it only when closing is allowed.
      onCancel={(e) => {
        e.preventDefault();
        if (closableRef.current) onClose();
      }}
      // Closed by the browser anyway (a close request that couldn't be cancelled): follow it when allowed, else reopen.
      onClose={() => {
        if (!openRef.current) return;
        if (closableRef.current) onClose();
        else ref.current?.showModal();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 text-slate-900 backdrop:bg-slate-950/60 sm:m-auto sm:h-fit sm:max-h-[min(52rem,calc(100dvh-4rem))] sm:w-[calc(100%-3rem)] sm:max-w-2xl dark:text-slate-100"
    >
      {open && (
        <div className="flex h-full flex-col bg-white sm:max-h-[min(52rem,calc(100dvh-4rem))] sm:rounded-2xl sm:border sm:border-slate-200 sm:shadow-xl dark:bg-slate-900 dark:sm:border-slate-700">
          {children}
        </div>
      )}
    </dialog>
  );
}
