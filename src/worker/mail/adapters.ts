import type { Env } from "../env";
import { clock } from "../lib/clock";
import { devMailEnabled } from "../lib/local";

export interface Mailer {
  send(m: { to: string; subject: string; html: string; text: string; replyTo?: string; headers?: Record<string, string> }): Promise<void>;
}

export function mailerFor(env: Env): Mailer {
  if (env.MAIL_MODE === "dev") {
    if (!devMailEnabled(env)) {
      throw new Error(
        "Configuration error: MAIL_MODE=dev is only allowed when APP_BASE_URL is on localhost or 127.0.0.1; deployments must use MAIL_MODE=cloudflare",
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
      try {
        await env.EMAIL.send({ ...msg, headers: m.headers });
      } catch (e) {
        console.warn("mail headers refused, sending without them:", e instanceof Error ? e.message.slice(0, 200) : "error");
        await env.EMAIL.send(msg);
      }
    },
  };
}
