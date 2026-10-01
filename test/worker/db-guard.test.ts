import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import { assertSql, capacityBatch, scheduleVersionGuard, bumpScheduleVersion, readScheduleVersion, isRetryableBatchError } from "../../src/worker/lib/db";
it("stale schedule version aborts the whole batch", async () => {
  const v = await readScheduleVersion(env.DB);
  await env.DB.batch([scheduleVersionGuard(env.DB, v), bumpScheduleVersion(env.DB)]);
  const err = await env.DB.batch([scheduleVersionGuard(env.DB, v), env.DB.prepare("INSERT INTO holidays VALUES ('2026-01-01','x')"), bumpScheduleVersion(env.DB)]).catch((e) => e);
  expect(isRetryableBatchError(err)).toBe(true);
  expect(await env.DB.prepare("SELECT count(*) c FROM holidays").first("c")).toBe(0);
  expect(await readScheduleVersion(env.DB)).toBe(v + 1);
});
it("assertSql passes when condition holds", async () => {
  await env.DB.batch([assertSql(env.DB, "SELECT 1 FROM schedule_state WHERE id = ?", 1)]);
  expect(await env.DB.prepare("SELECT count(*) c FROM guard").first("c")).toBe(0);
});
it("capacityBatch runs the statements between the version guard and the version bump", async () => {
  const v = await readScheduleVersion(env.DB);
  const results = await capacityBatch(env.DB, v, [env.DB.prepare("INSERT INTO holidays VALUES ('2026-01-01','x')")]);
  expect(results).toHaveLength(3);
  expect(await env.DB.prepare("SELECT count(*) c FROM holidays").first("c")).toBe(1);
  expect(await readScheduleVersion(env.DB)).toBe(v + 1);
});
it("capacityBatch with a stale version writes nothing and is retryable", async () => {
  const v = await readScheduleVersion(env.DB);
  await env.DB.batch([bumpScheduleVersion(env.DB)]);
  const err = await capacityBatch(env.DB, v, [env.DB.prepare("INSERT INTO holidays VALUES ('2026-01-01','x')")]).catch((e) => e);
  expect(isRetryableBatchError(err)).toBe(true);
  expect(await env.DB.prepare("SELECT count(*) c FROM holidays").first("c")).toBe(0);
  expect(await readScheduleVersion(env.DB)).toBe(v + 1);
});
