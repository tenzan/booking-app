import type { ReactNode } from "react";

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700">
      <svg className="mx-auto mb-3 size-10 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <h2 className="text-lg font-semibold">{title}</h2>
      {body && <p className="mt-1 text-slate-600 dark:text-slate-400">{body}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
