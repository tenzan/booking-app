import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, ORIGIN } from "../helpers";
import { loginCustomer, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import worker from "../../src/worker/index";
import { setNow } from "../../src/worker/lib/clock";
import { wallToUtc } from "../../src/domain/time";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let pat: { id: number; cookie: string };

beforeEach(async () => {
  setNow(at(THU, 8));
  const team = await seedTeam();
  await seedWeekly(5, 600, 720, [team.admin, team.a]);
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
});

/** A pending request that expires at 12:00 on Thursday. */
async function pendingDueAtNoon(): Promise<string> {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: pat.cookie,
    body: { customerId: pat.id, startAt: at(FRI, 10), contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  const id = res.json.reservation.id as string;
  await env.DB.prepare("UPDATE reservations SET expires_at = ? WHERE id = ?").bind(at(THU, 12), id).run();
  return id;
}
const status = async (id: string) => (await env.DB.prepare("SELECT status FROM reservations WHERE id = ?").bind(id).first<{ status: string }>())!.status;

const call = (e: Record<string, unknown>, base: string, init: { body?: string } = {}) =>
  worker.fetch!(
    new Request(`${base}/api/dev/cron`, {
      method: "POST",
      headers: { origin: base, "x-requested-with": "fetch", "content-type": "application/json" },
      body: init.body,
    }) as any,
    { ...env, ...e } as any,
    { waitUntil() {}, passThroughOnException() {} } as any,
  );

describe("dev cron route", () => {
  it("runs the sweeps as of `now`, then the outbox, and returns a summary", async () => {
    const id = await pendingDueAtNoon();
    const res = await api("POST", "/api/dev/cron", { body: { now: at(THU, 12) } });
    expect(res.status).toBe(200);
    expect(res.json.counts).toMatchObject({ expiry: 1 });
    expect(res.json.failed).toEqual([]);
    expect(res.json.outbox.sent).toBeGreaterThan(0);
    expect(await status(id)).toBe("expired");
    const mail = await env.DB.prepare("SELECT 1 FROM dev_mailbox WHERE to_email = 'pat@example.test' AND subject LIKE '%in time%'").first();
    expect(mail).not.toBeNull();
  });

  it("respects `now`: nothing is due earlier, and without a body it uses the clock", async () => {
    const id = await pendingDueAtNoon();
    const early = await api("POST", "/api/dev/cron", { body: { now: at(THU, 11) } });
    expect(early.json.counts.expiry).toBe(0);
    expect(await status(id)).toBe("pending");

    const clockNow = await api("POST", "/api/dev/cron");
    expect(clockNow.status).toBe(200);
    expect(clockNow.json.counts.expiry).toBe(0);

    setNow(at(THU, 13));
    const later = await api("POST", "/api/dev/cron");
    expect(later.json.counts.expiry).toBe(1);
    expect(await status(id)).toBe("expired");
  });

  it("rejects a malformed body", async () => {
    expect((await api("POST", "/api/dev/cron", { body: { now: "soon" } })).status).toBe(400);
    expect((await call({}, ORIGIN, { body: "{nope" })).status).toBe(400);
  });

  it("still requires the same-origin headers", async () => {
    expect((await api("POST", "/api/dev/cron", { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await api("POST", "/api/dev/cron", { xrw: false })).status).toBe(403);
  });

  it("404s when mail is not in dev mode", async () => {
    const id = await pendingDueAtNoon();
    const res = await call({ MAIL_MODE: "cloudflare" }, ORIGIN, { body: JSON.stringify({ now: at(THU, 12) }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(await status(id)).toBe("pending");
  });

  it.each(["https://booking.example.com", "http://192.0.2.10:5173", "http://localhost.example.com"])(
    "404s in dev mode when the app is not served from localhost (%s)",
    async (base) => {
      const id = await pendingDueAtNoon();
      const res = await call({ MAIL_MODE: "dev", APP_BASE_URL: base }, base, { body: JSON.stringify({ now: at(THU, 12) }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(await status(id)).toBe("pending");
    },
  );

  it("works on 127.0.0.1 too", async () => {
    const base = "http://127.0.0.1:5173";
    const res = await call({ APP_BASE_URL: base }, base, { body: JSON.stringify({}) });
    expect(res.status).toBe(200);
  });
});
