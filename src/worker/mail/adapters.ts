import type { Env } from "../env";
import { clock } from "../lib/clock";
import { devMailEnabled } from "../lib/local";

export interface Mailer {
  send(m: { to: string; subject: string; html: string; text: string; replyTo?: string; headers?: Record<string, string> }): Promise<void>;
}

const HEADER_CODE = /\bE_HEADERS?_[A-Z_]+\b/;
const HEADER_WORD = /\bheaders?\b/i;
const REFUSAL = /\b(not allowed|disallowed|not permitted|not supported|unsupported|invalid|forbidden|refused|rejected)\b/i;

/**
 * True when the send binding refused the message because of its custom headers (an `E_HEADER_*` code, or a message that
 * names a header and a refusal) — the only failure that is safe to answer with an immediate second send.
 */
export function isHeaderRejection(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && HEADER_CODE.test(code)) return true;
  return HEADER_CODE.test(e.message) || (HEADER_WORD.test(e.message) && REFUSAL.test(e.message));
}

export function mailerFor(env: Env): Mailer {
  if (env.MAIL_MODE === "dev") {
    if (!devMailEnabled(env)) {
      throw new Error(
        "Configuration error: MAIL_MODE=dev is only allowed when APP_BASE_URL is on localhost, 127.0.0.1 or [::1]; deployments must use MAIL_MODE=cloudflare",
      );
    }
    return {
      async send(m) {
        await env.DB.prepare("INSERT INTO dev_mailbox(to_email, subject, html, text, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(m.to, m.subject, m.html, m.text, m.replyTo ?? null, clock.now())
          .run();
      },
    };
  }
  return {
    async send(m) {
      if (!env.EMAIL) throw new Error("EMAIL binding is not configured");
      const msg = {
        from: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME },
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      };
      if (!m.headers) {
        await env.EMAIL.send(msg);
        return;
      }
      // Custom headers are a nicety (they keep auto-responders quiet); if the binding refuses them, send without.
      // Any other failure is thrown: the message may have gone out, and the outbox's backoff decides what happens next.
      try {
        await env.EMAIL.send({ ...msg, headers: m.headers });
      } catch (e) {
        if (!isHeaderRejection(e)) throw e;
        console.warn("mail headers refused, sending without them:", e instanceof Error ? e.message.slice(0, 200) : "error");
        await env.EMAIL.send(msg);
      }
    },
  };
}
