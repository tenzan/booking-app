import type { Env } from "../env";
import { clock } from "../lib/clock";
import { devMailEnabled } from "../lib/local";

export interface Mailer {
  send(m: { to: string; subject: string; html: string; text: string }): Promise<void>;
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
        await env.DB.prepare("INSERT INTO dev_mailbox(to_email, subject, html, text, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(m.to, m.subject, m.html, m.text, clock.now())
          .run();
      },
    };
  }
  return {
    async send(m) {
      if (!env.EMAIL) throw new Error("EMAIL binding is not configured");
      await env.EMAIL.send({
        from: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME },
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
      });
    },
  };
}
