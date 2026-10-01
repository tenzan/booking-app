import type { ReactNode } from "react";

/**
 * The current selection plus the primary action. Pinned to the bottom of the screen on phones (within thumb
 * reach, clear of the home indicator); an ordinary footer row from `sm` up.
 */
export function StickyBar({ summary, action }: { summary: ReactNode; action: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-[0_-4px_16px_rgb(0_0_0/0.06)] backdrop-blur sm:static sm:mt-8 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none dark:border-slate-800 dark:bg-slate-900/95 sm:dark:bg-transparent">
      <div className="mx-auto flex w-full max-w-[40rem] items-center gap-3 px-4 sm:px-0">
        <div className="min-w-0 flex-1 text-sm">{summary}</div>
        <div className="shrink-0">{action}</div>
      </div>
    </div>
  );
}
