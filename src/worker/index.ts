import { app } from "./app";
import { runSweeps } from "./cron";
import type { Env } from "./env";
import { clock } from "./lib/clock";
import { processOutbox, safeError } from "./mail/outbox";

/** The sweeps, then the outbox (so what they enqueued goes out now); a failure in one never stops the other. */
async function tick(env: Env): Promise<void> {
  await runSweeps(env, clock.now()).catch((e) => console.error("sweeps", safeError(e)));
  await processOutbox(env, 50).catch((e) => console.error("outbox", safeError(e)));
}

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  async scheduled(_c, env, ctx) {
    ctx.waitUntil(tick(env));
  },
} satisfies ExportedHandler<Env>;
