import { env } from "cloudflare:test";
import { afterEach, it, expect } from "vitest";
import { api } from "../helpers";
import { getSettings, getHolidays, bhCtx } from "../../src/worker/repos/settings";
import { rateLimit } from "../../src/worker/lib/rate-limit";
import { audit, isRetryableBatchError, withRetry } from "../../src/worker/lib/db";
import { setNow, clock } from "../../src/worker/lib/clock";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";

afterEach(() => setNow(null));

it("rejected requests still carry security headers and unknown routes are JSON 404", async () => {
  const r = await api("POST", "/api/nope", { origin: null });
  expect(r.status).toBe(403);
  expect(r.json).toEqual({ error: "csrf" });
  expect(r.headers.get("cache-control")).toBe("no-store");
  const nf = await api("GET", "/api/nope");
  expect(nf.status).toBe(404);
  expect(nf.json).toEqual({ error: "not_found" });
  expect(nf.headers.get("x-content-type-options")).toBe("nosniff");
});

it("getSettings overlays env then DB rows, ignores junk, and never shares defaults", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings VALUES ('durationMin','45')"),
    env.DB.prepare("INSERT INTO settings VALUES ('supportPhone','not json')"),
    env.DB.prepare("INSERT INTO settings VALUES ('bogus','1')"),
  ]);
  const s = await getSettings(env.DB, { ...env, ORG_NAME: "Acme Test" });
  expect(s.orgName).toBe("Acme Test");
  expect(s.durationMin).toBe(45);
  expect(s.supportPhone).toBe("");
  expect("bogus" in s).toBe(false);
  s.customerReminderOffsetsMin.push(1);
  s.businessHours[1] = null;
  expect(DEFAULT_SETTINGS.customerReminderOffsetsMin).toEqual([1440, 60]);
  expect(DEFAULT_SETTINGS.businessHours[1]).not.toBeNull();
});

it("bhCtx combines timezone, hours and holidays", async () => {
  await env.DB.prepare("INSERT INTO holidays VALUES ('2026-12-25','Xmas')").run();
  expect([...(await getHolidays(env.DB))]).toEqual(["2026-12-25"]);
  const ctx = await bhCtx(env.DB, env);
  expect(ctx.tz).toBe(env.APP_TIMEZONE);
  expect(ctx.hours).toEqual(DEFAULT_SETTINGS.businessHours);
  expect(ctx.holidays.has("2026-12-25")).toBe(true);
});

it("rateLimit allows up to the limit then blocks, and resets after the window", async () => {
  setNow(1_000_000);
  expect(await rateLimit(env.DB, "k", 2, 60_000)).toBe(true);
  expect(await rateLimit(env.DB, "k", 2, 60_000)).toBe(true);
  expect(await rateLimit(env.DB, "k", 2, 60_000)).toBe(false);
  expect(await rateLimit(env.DB, "other", 2, 60_000)).toBe(true);
  setNow(1_000_000 + 60_001);
  expect(await rateLimit(env.DB, "k", 2, 60_000)).toBe(true);
});

it("audit uses the overridable clock and JSON details", async () => {
  setNow(1234);
  expect(clock.now()).toBe(1234);
  await audit(env.DB, { actorKind: "system", actor: null, action: "x", details: { a: 1 } }).run();
  const row = await env.DB.prepare("SELECT at, details, reservation_id FROM audit_log").first<any>();
  expect(row).toEqual({ at: 1234, details: '{"a":1}', reservation_id: null });
});

it("withRetry retries retryable errors only", async () => {
  let n = 0;
  expect(await withRetry(async () => { if (++n < 3) throw new Error("NOT NULL constraint failed: guard.ok"); return "ok"; })).toBe("ok");
  expect(n).toBe(3);
  await expect(withRetry(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
});

it("withRetry gives up on a persistent conflict with 503 busy_try_again", async () => {
  let n = 0;
  await expect(withRetry(async () => { n++; throw new Error("UNIQUE constraint failed: tech_blocks.staff_id, tech_blocks.block_start"); }, 3)).rejects.toMatchObject({
    status: 503,
    code: "busy_try_again",
  });
  expect(n).toBe(3);
});

it("a reference collision is retryable", () => {
  expect(isRetryableBatchError(new Error("D1_ERROR: UNIQUE constraint failed: reservations.ref: SQLITE_CONSTRAINT"))).toBe(true);
  expect(isRetryableBatchError(new Error("UNIQUE constraint failed: reservations.idempotency_key"))).toBe(false);
});
