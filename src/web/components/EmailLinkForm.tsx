import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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
            onToken={(tok) => setCaptcha(tok)}
            onError={() => {
              setCaptcha(null);
              setCaptchaFailed(true);
            }}
          />
        )}
        <div aria-live="polite" className="empty:mb-0">
          {captchaFailed ? (
            <Notice tone="error">{t("web.start.turnstileFailed")}</Notice>
          ) : error ? (
            <Notice tone="error">{error}</Notice>
          ) : null}
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
