import { env, reset, applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
