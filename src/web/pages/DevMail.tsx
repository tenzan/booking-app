import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, isApiError, queryKeys, useMe, type DevMessage } from "../api";
import { Button, buttonClass } from "../components/Button";
import { Card, Notice } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { PageHeading, SkipLink, usePageTitle, useRouteChange } from "../components/Layout";
import { Skeleton } from "../components/Spinner";
import { fmtStamp } from "../format";
import { fmtDateTime, LOCALE, t } from "../i18n";

/** Links in the preview replace the app tab instead of navigating inside the sandboxed frame. */
function withTopTarget(html: string): string {
  const base = '<base target="_top">';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
}

/** The first http(s) link in the message (HTML first, then the plain text). */
function firstLink(m: DevMessage): string | null {
  const doc = new DOMParser().parseFromString(m.html, "text/html");
  const href = Array.from(doc.querySelectorAll("a[href]"))
    .map((a) => a.getAttribute("href") ?? "")
    .find((h) => /^https?:\/\//i.test(h));
  return href ?? m.text.match(/https?:\/\/\S+/)?.[0] ?? null;
}

/** `/dev/mail`: what the app would have emailed, when MAIL_MODE=dev. Polls so new messages appear on their own. */
export default function DevMail() {
  usePageTitle(t("web.devMail.heading"));
  useRouteChange();
  const tz = useMe().data?.timezone ?? "UTC";
  const q = useQuery({
    queryKey: queryKeys.devMail,
    queryFn: () => apiFetch<{ messages: DevMessage[] }>("/api/dev/mail").then((r) => r.messages),
    refetchInterval: (query) => (isApiError(query.state.error, 404) ? false : 2000),
    retry: false,
  });
  // null = nothing picked yet: phones show the list, wide screens preview the newest message.
  const [pickedId, setPickedId] = useState<number | null>(null);
  const messages = q.data ?? [];
  const picked = messages.find((m) => m.id === pickedId) ?? null;
  const shown = picked ?? messages[0] ?? null;

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <header className="border-b border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-100">
        <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center gap-2 px-4 py-2 text-sm font-medium sm:px-6">
          <svg className="size-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 9v4m0 4h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t("web.devMail.banner")}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 pt-6 pb-16 outline-none sm:px-6">
        <PageHeading>{t("web.devMail.heading")}</PageHeading>
        {q.isPending ? (
          <div className="grid gap-6 lg:grid-cols-[20rem_1fr]" aria-busy="true">
            <span className="sr-only">{t("web.common.loading")}</span>
            <Skeleton className="h-96" />
            <Skeleton className="hidden h-96 lg:block" />
          </div>
        ) : isApiError(q.error, 404) ? (
          <Notice tone="info">{t("web.devMail.unavailable")}</Notice>
        ) : q.isError && messages.length === 0 ? (
          <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
            {t("web.errors.generic")}
            <Button variant="secondary" onClick={() => void q.refetch()}>
              {t("web.common.retry")}
            </Button>
          </Notice>
        ) : messages.length === 0 ? (
          <EmptyState title={t("web.devMail.empty")} body={t("web.devMail.emptyBody")} />
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
            <Card flush className={`lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto ${picked ? "hidden lg:block" : ""}`}>
              <ul aria-label={t("web.devMail.listLabel")} className="divide-y divide-slate-200 dark:divide-slate-800">
                {messages.map((m) => {
                  const current = shown?.id === m.id;
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        aria-current={current || undefined}
                        onClick={() => setPickedId(m.id)}
                        className={`block w-full px-4 py-3 text-left first:rounded-t-2xl hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
                          current ? "lg:bg-blue-50 lg:shadow-[inset_3px_0_0] lg:shadow-blue-700 dark:lg:bg-blue-400/10 dark:lg:shadow-blue-400" : ""
                        }`}
                      >
                        <span className="block truncate text-sm text-slate-600 dark:text-slate-400">{m.to}</span>
                        <span className="line-clamp-2 font-medium break-words">{m.subject}</span>
                        <span className="block text-xs text-slate-500 tabular-nums dark:text-slate-400">{fmtDateTime(m.createdAt, tz, LOCALE)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
            {shown && (
              <div className={picked ? "" : "hidden lg:block"}>
                <MessageView key={shown.id} m={shown} tz={tz} onBack={() => setPickedId(null)} />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function MessageView({ m, tz, onBack }: { m: DevMessage; tz: string; onBack: () => void }) {
  const link = useMemo(() => firstLink(m), [m]);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="space-y-4">
      <Button variant="ghost" onClick={onBack} className="-ml-3 lg:hidden">
        <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M19 12H5m5 5-5-5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t("web.devMail.backToList")}
      </Button>
      <Card className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold break-words">{m.subject}</h2>
          <p className="text-sm break-words text-slate-600 dark:text-slate-400">{t("web.devMail.to", { to: m.to })}</p>
          <p className="text-sm text-slate-600 dark:text-slate-400">{fmtStamp(m.createdAt, tz)}</p>
        </div>
        <div className="space-y-2 rounded-xl bg-slate-100 p-3 dark:bg-slate-800/60">
          <p className="text-sm font-medium text-slate-600 dark:text-slate-300">{t("web.devMail.firstLink")}</p>
          {link ? (
            <>
              <p className="font-mono text-xs break-all text-slate-700 dark:text-slate-300">{link}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void copy()}>
                  {copied ? t("web.devMail.copied") : t("web.devMail.copyLink")}
                </Button>
                <a href={link} className={buttonClass("primary")}>
                  {t("web.devMail.openLink")}
                </a>
              </div>
              <span className="sr-only" aria-live="polite">
                {copied ? t("web.devMail.copied") : ""}
              </span>
            </>
          ) : (
            <p className="text-sm">{t("web.devMail.noLinks")}</p>
          )}
        </div>
      </Card>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t("web.devMail.preview")}</h3>
        <iframe
          title={t("web.devMail.previewTitle", { subject: m.subject })}
          srcDoc={withTopTarget(m.html)}
          sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
          className="h-[36rem] w-full rounded-2xl border border-slate-200 bg-white dark:border-slate-800"
        />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t("web.devMail.plainText")}</h3>
        <pre className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-4 text-sm whitespace-pre-wrap [overflow-wrap:anywhere] dark:border-slate-800 dark:bg-slate-900">
          {m.text}
        </pre>
      </section>
    </article>
  );
}
