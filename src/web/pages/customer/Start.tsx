import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { apiFetch, isApiError, safePath, useMe } from "../../api";
import { Button, ButtonLink } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { Field, inputClass } from "../../components/Field";
import { PageHeading, usePageTitle, useSignOut } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { t } from "../../i18n";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Start() {
  usePageTitle(t("web.start.heading"));
  const me = useMe();
  const [params] = useSearchParams();
  const next = safePath(params.get("next"));
  const [sentTo, setSentTo] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <PageHeading>{t("web.start.heading")}</PageHeading>
        {!me.data?.customer && <p className="text-lg text-slate-600 dark:text-slate-300">{t("web.start.lead")}</p>}
      </div>
      {me.isPending ? (
        <Skeleton className="h-64" />
      ) : me.data?.customer ? (
        <SignedIn email={me.data.customer.email} next={next} />
      ) : sentTo ? (
        <Sent email={sentTo} onReset={() => setSentTo(null)} />
      ) : (
        <EmailForm siteKey={me.data?.turnstileSiteKey ?? null} next={next} onSent={setSentTo} />
      )}
      {!me.data?.customer && !sentTo && <HowItWorks />}
    </div>
  );
}

function EmailForm({ siteKey, next, onSent }: { siteKey: string | null; next: string | null; onSent: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const request = useMutation({
    mutationFn: (addr: string) =>
      apiFetch("/api/auth/customer/request", {
        method: "POST",
        body: { email: addr, turnstileToken: captcha ?? undefined, redirectPath: next ?? undefined },
      }),
    onSuccess: (_, addr) => onSent(addr),
  });

  const waitingForCaptcha = siteKey !== null && captcha === null;

  function submit(e: FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!EMAIL_RE.test(addr)) {
      setFieldError(t("web.start.emailInvalid"));
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    request.mutate(addr);
  }

  const error = request.error
    ? isApiError(request.error, 429)
      ? t("web.errors.rateLimited")
      : isApiError(request.error, 400)
        ? t("web.start.emailInvalid")
        : isApiError(request.error, 0)
          ? t("web.errors.network")
          : t("web.errors.generic")
    : null;

  return (
    <Card>
      <form onSubmit={submit} noValidate className="space-y-5">
        <Field id="email" label={t("web.start.emailLabel")} hint={t("web.start.emailHint")} error={fieldError}>
          {(aria) => (
            <input
              {...aria}
              ref={inputRef}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              placeholder={t("web.start.emailPlaceholder")}
            />
          )}
        </Field>
        {siteKey && (
          <Turnstile
            siteKey={siteKey}
            onToken={(tok) => setCaptcha(tok)}
            onError={() => {
              setCaptcha(null);
              setCaptchaFailed(true);
            }}
          />
        )}
        <div aria-live="polite" className="empty:hidden">
          {captchaFailed ? (
            <Notice tone="error">{t("web.start.turnstileFailed")}</Notice>
          ) : error ? (
            <Notice tone="error">{error}</Notice>
          ) : null}
        </div>
        <Button type="submit" size="lg" block loading={request.isPending} disabled={waitingForCaptcha}>
          {request.isPending ? t("web.start.sending") : waitingForCaptcha ? t("web.start.turnstileWaiting") : t("web.start.submit")}
        </Button>
      </form>
    </Card>
  );
}

function Sent({ email, onReset }: { email: string; onReset: () => void }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Card className="space-y-4 text-center">
      <span className="mx-auto grid size-14 place-items-center rounded-full bg-blue-50 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300" aria-hidden="true">
        <svg className="size-7" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.75" />
          <path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <h2 ref={ref} tabIndex={-1} className="text-xl font-semibold outline-none">
        {t("web.start.sentHeading")}
      </h2>
      <p className="text-slate-700 dark:text-slate-300">{t("web.start.sentBody", { email })}</p>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("web.start.sentHelp")}</p>
      <Button variant="secondary" onClick={onReset}>
        {t("web.start.differentEmail")}
      </Button>
    </Card>
  );
}

function SignedIn({ email, next }: { email: string; next: string | null }) {
  const signOut = useSignOut();
  return (
    <Card className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">{t("web.start.signedInHeading")}</h2>
        <p className="mt-1 break-words text-slate-600 dark:text-slate-400">{t("web.nav.signedInAs", { email })}</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <ButtonLink to={next ?? "/book"} size="lg" className="sm:flex-1">
          {t("web.start.bookNow")}
        </ButtonLink>
        <ButtonLink to="/my" variant="secondary" size="lg" className="sm:flex-1">
          {t("web.nav.myReservations")}
        </ButtonLink>
      </div>
      <Button variant="ghost" onClick={() => signOut.mutate()} loading={signOut.isPending}>
        {t("web.nav.signOut")}
      </Button>
    </Card>
  );
}

function HowItWorks() {
  const steps = [t("web.start.how1"), t("web.start.how2"), t("web.start.how3")];
  return (
    <section aria-labelledby="how-heading">
      <h2 id="how-heading" className="mb-3 text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {t("web.start.howHeading")}
      </h2>
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={s} className="flex items-start gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {i + 1}
            </span>
            <span className="pt-0.5 text-slate-700 dark:text-slate-300">{s}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      remove(id: string): void;
    };
  }
}

let turnstileScript: Promise<void> | null = null;

/** Loads Cloudflare Turnstile once, only when the server says it is configured. */
function loadTurnstile(): Promise<void> {
  turnstileScript ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      turnstileScript = null;
      s.remove();
      reject(new Error("turnstile_load_failed"));
    };
    document.head.appendChild(s);
  });
  return turnstileScript;
}

function Turnstile({ siteKey, onToken, onError }: { siteKey: string; onToken: (token: string | null) => void; onError: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onToken, onError });
  handlers.current = { onToken, onError };

  useEffect(() => {
    let id: string | null = null;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !el.current || !window.turnstile) return;
        id = window.turnstile.render(el.current, {
          sitekey: siteKey,
          theme: "auto",
          size: "flexible",
          callback: (tok: string) => handlers.current.onToken(tok),
          "expired-callback": () => handlers.current.onToken(null),
          "error-callback": () => handlers.current.onError(),
        });
      })
      .catch(() => !cancelled && handlers.current.onError());
    return () => {
      cancelled = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey]);

  return <div ref={el} className="min-h-[65px]" />;
}
