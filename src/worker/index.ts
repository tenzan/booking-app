import { app } from "./app";
import { runSweeps } from "./cron";
import type { Env } from "./env";
import { handleInbound } from "./mail/inbound";
import { processOutbox, safeError } from "./mail/outbox";

/** The sweeps, then the outbox (so what they enqueued goes out now); a failure in one never stops the other. */
async function tick(env: Env, now: number): Promise<void> {
  await runSweeps(env, now).catch((e) => console.error("sweeps", safeError(e)));
  await processOutbox(env, 50).catch((e) => console.error("outbox", safeError(e)));
}

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  async scheduled(controller, env, ctx) {
    // The cron's own scheduled time: the minute-0 check for cleanup does not depend on how late the invocation starts.
    ctx.waitUntil(tick(env, controller.scheduledTime));
  },
  // Deliberate refusals use message.setReject inside the handler; anything thrown is a fault on our side, logged once and
  // swallowed rather than surfaced to Email Routing as an exception (which would bounce or retry the sender's mail).
  async email(message, env, ctx) {
    try {
      await handleInbound(message, env, ctx);
    } catch (e) {
      console.error("inbound mail failed", safeError(e));
    }
  },
} satisfies ExportedHandler<Env>;
