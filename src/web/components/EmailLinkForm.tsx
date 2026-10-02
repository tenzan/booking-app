import { useEffect, useImperativeHandle, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch, isApiError } from "../api";
import { t } from "../i18n";
import { Button } from "./Button";
import { Card, Notice } from "./Card";
import { Field, inputClass } from "./Field";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The last address this device asked a sign-in link for, one per kind (a customer and a staff member may share a
 * device). Only ever written after a request succeeded, never from a token or a URL; storage may throw or be empty.
 */
const rememberKey = (kind: "customer" | "staff") => `signin-email:${kind}`;
function readRemembered(kind: "customer" | "staff"): string {
  try {
    const v = localStorage.getItem(rememberKey(kind));
    return v !== null && EMAIL_RE.test(v) ? v : "";
  } catch {
    return "";
  }
}
function writeRemembered(kind: "customer" | "staff", email: string | null) {
  try {
    if (email === null) localStorage.removeItem(rememberKey(kind));
    else localStorage.setItem(rememberKey(kind), email);
  } catch {
    // A convenience only: without storage the field just starts empty.
  }
}

interface EmailLinkFormProps {
  kind: "customer" | "staff";
  siteKey: string | null;
  /** Where to land after the link is redeemed. */
  next: string | null;
  label: string;
  hint?: string;
  submitLabel: string;
  onSent: (email: string) => void;
  /** Back from "Check your email" to use a different address: start empty and focused instead of with the last one. */
  startEmpty?: boolean;
}

/**
 * "Email me a link" form shared by customer and staff sign-in. The server answers the same whether or not the address is
 * known. The field starts with the address this device last asked a link for, with a way to use another.
 */
export function EmailLinkForm({ kind, siteKey, next, label, hint, submitLabel, onSent, startEmpty = false }: EmailLinkFormProps) {
  const [remembered, setRemembered] = useState(() => (startEmpty ? "" : readRemembered(kind)));
  const [email, setEmail] = useState(remembered);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const widget = useRef<TurnstileHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (startEmpty) inputRef.current?.focus();
  }, []);

  const request = useMutation({
    mutationFn: (addr: string) =>
      apiFetch(`/api/auth/${kind}/request`, {
        method: "POST",
        body: { email: addr, turnstileToken: captcha ?? undefined, redirectPath: next ?? undefined },
      }),
    onSuccess: (_, addr) => {
      writeRemembered(kind, addr);
      onSent(addr);
    },
    // Whatever the outcome (sent, 4xx including 429, network error), the server has seen the token and may have spent it:
    // never send it again. The button waits for the fresh one the widget issues after the reset.
    onSettled: () => {
      setCaptcha(null);
      widget.current?.reset();
    },
  });

  function forget() {
    writeRemembered(kind, null);
    setRemembered("");
    setEmail("");
    setFieldError(null);
    inputRef.current?.focus();
  }

  const waitingForCaptcha = siteKey !== null && captcha === null;

  function submit(e: FormEvent) {
    e.preventDefault();
    // Never send a request without a fresh token (or while one is in flight, which would resend the spent one).
    if (request.isPending || waitingForCaptcha) return;
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
        <Field id="email" label={label} hint={hint} error={fieldError}>
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
        {remembered !== "" && (
          <button
            type="button"
            onClick={forget}
            className="-mt-3 inline-flex min-h-11 items-center text-sm font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-200"
          >
            {t("web.start.notYou")}
          </button>
        )}
        {siteKey && (
          <Turnstile
            siteKey={siteKey}
            ref={widget}
            onToken={(tok) => {
              setCaptcha(tok);
              if (tok !== null) setCaptchaFailed(false);
            }}
            onError={() => {
              setCaptcha(null);
              setCaptchaFailed(true);
            }}
          />
        )}
        {/* Both can apply at once (a request failed, then the fresh check did too): the request's outcome first. */}
        <div aria-live="polite" className="space-y-3 empty:mb-0">
          {error && <Notice tone="error">{error}</Notice>}
          {captchaFailed && <Notice tone="error">{t("web.start.turnstileFailed")}</Notice>}
        </div>
        <Button type="submit" size="lg" block loading={request.isPending} disabled={waitingForCaptcha}>
          {request.isPending ? t("web.start.sending") : waitingForCaptcha ? t("web.start.turnstileWaiting") : submitLabel}
        </Button>
      </form>
    </Card>
  );
}

/** "Check your email" confirmation; its heading takes focus so screen readers announce it. */
export function LinkSent({ body, onReset }: { body: ReactNode; onReset: () => void }) {
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
      <p className="break-words text-slate-700 dark:text-slate-300">{body}</p>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("web.start.sentHelp")}</p>
      <Button variant="secondary" onClick={onReset}>
        {t("web.start.differentEmail")}
      </Button>
    </Card>
  );
}

/** Bold email address for the "sent" body text. */
export const EmailStrong = ({ email }: { email: string }) => <strong className="font-semibold text-slate-900 dark:text-slate-100">{email}</strong>;

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id: string): void;
      remove(id: string): void;
    };
  }
}

/** How long the script may take to load before the widget is given up on (a hang fires neither load nor error). */
const TURNSTILE_LOAD_TIMEOUT_MS = 10_000;

let turnstileScript: { promise: Promise<void>; abandon: () => void } | null = null;

/** Loads Cloudflare Turnstile once, only when the server says it is configured. */
function loadTurnstile(): { promise: Promise<void>; abandon: () => void } {
  if (turnstileScript) return turnstileScript;
  const s = document.createElement("script");
  const entry = {
    promise: new Promise<void>((resolve, reject) => {
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        entry.abandon();
        reject(new Error("turnstile_load_failed"));
      };
    }),
    // Forget a script that failed or hung so the next mount starts a fresh load instead of waiting on this one forever.
    // Removing the element does not cancel a download already in progress: a hung script that arrives late still runs,
    // and the next mount has appended a fresh copy, so after a hang api.js can end up loaded twice. Accepted: it needs a
    // hang followed by a late arrival, and the widget is rendered through whichever `window.turnstile` is there.
    abandon: () => {
      if (turnstileScript === entry) turnstileScript = null;
      s.remove();
    },
  };
  turnstileScript = entry;
  document.head.appendChild(s);
  return entry;
}

/** Lets the form ask for a new token once the current one has been sent (a token is single use). */
interface TurnstileHandle {
  reset(): void;
}

function Turnstile({
  siteKey,
  ref,
  onToken,
  onError,
}: {
  siteKey: string;
  ref: Ref<TurnstileHandle>;
  onToken: (token: string | null) => void;
  onError: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const handlers = useRef({ onToken, onError });
  handlers.current = { onToken, onError };
  useImperativeHandle(ref, () => ({
    reset() {
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
    },
  }));

  useEffect(() => {
    let cancelled = false;
    const script = loadTurnstile();
    const fail = () => {
      cancelled = true;
      handlers.current.onError();
    };
    // A script that hangs fires neither load nor error: give up after a while and drop it so a retry can load afresh.
    const timer = setTimeout(() => {
      if (cancelled) return;
      script.abandon();
      fail();
    }, TURNSTILE_LOAD_TIMEOUT_MS);
    script.promise
      .then(() => {
        clearTimeout(timer);
        if (cancelled || !el.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(el.current, {
          sitekey: siteKey,
          theme: "auto",
          size: "flexible",
          callback: (tok: string) => handlers.current.onToken(tok),
          "expired-callback": () => handlers.current.onToken(null),
          "error-callback": () => handlers.current.onError(),
        });
      })
      .catch(() => {
        clearTimeout(timer);
        if (!cancelled) fail();
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  return <div ref={el} className="min-h-[65px]" />;
}
