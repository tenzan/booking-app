import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { lastMailTo, loginCustomer, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { clock, setNow } from "../../src/worker/lib/clock";
import { sha256Hex } from "../../src/worker/lib/crypto";
import { wallToUtc } from "../../src/domain/time";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  await seedWeekly(5, 600, 720, [team.a, team.b]);
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
});

const submit = async (who: { id: number; cookie: string }, startAt: number, issue = "Printer is offline") => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue, idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation.id as string;
};
/** Cancel directly in the DB, releasing the technician blocks like the real flow does. */
const cancel = async (id: string) => {
  await env.DB.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM tech_blocks WHERE owner_id = ?").bind(id).run();
};
const access = (token: unknown, headers: Record<string, string> = {}) =>
  api("POST", "/api/access/reservation", { body: { token }, headers });
const mintToken = async (reservationId: string, expiresAt: number) => {
  const token = `tok-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO access_tokens(token_hash, reservation_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), reservationId, clock.now(), expiresAt)
    .run();
  return token;
};

describe("GET /api/customer/reservations", () => {
  it("requires a customer session", async () => {
    expect((await api("GET", "/api/customer/reservations")).status).toBe(401);
  });

  it("lists only the caller's accounts' reservations, newest first, without staff data", async () => {
    const r1 = await submit(pat, at(FRI, 10));
    await cancel(r1);
    const r2 = await submit(pat, at(FRI, 11));
    await submit(sam, at(FRI, 10, 30));

    const res = await api("GET", "/api/customer/reservations", { cookie: pat.cookie });
    expect(res.status).toBe(200);
    expect(res.json.reservations.map((r: any) => r.id)).toEqual([r2, r1]);
    expect(res.json.reservations[0]).toEqual({
      id: r2,
      ref: expect.stringMatching(/^R-[A-Z0-9]{4}-[A-Z0-9]{4}$/),
      status: "pending",
      startAt: at(FRI, 11),
      endAt: at(FRI, 11, 30),
      accountName: "Pat Co",
      customerNumber: expect.any(String),
      contactName: "Pat Example",
      phone: "+81 3-1234-5678",
      issue: "Printer is offline",
      createdAt: at(THU, 8),
      closeReason: null,
      version: 1,
    });
  });

  it("orders equal start times by newest creation first", async () => {
    const r1 = await submit(pat, at(FRI, 10));
    await cancel(r1);
    setNow(at(THU, 9));
    const r2 = await submit(pat, at(FRI, 10));
    const res = await api("GET", "/api/customer/reservations", { cookie: pat.cookie });
    expect(res.json.reservations.map((r: any) => r.id)).toEqual([r2, r1]);
  });

  it("includes reservations of a deactivated account while the contact is active", async () => {
    const id = await submit(pat, at(FRI, 10));
    await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(pat.id).run();
    const res = await api("GET", "/api/customer/reservations", { cookie: pat.cookie });
    expect(res.json.reservations.map((r: any) => r.id)).toEqual([id]);
  });

  it("drops an account's reservations once the contact is deactivated", async () => {
    await submit(pat, at(FRI, 10));
    await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(pat.id).run();
    await env.DB.prepare("UPDATE customer_contacts SET active = 0 WHERE customer_id = ?").bind(pat.id).run();
    const res = await api("GET", "/api/customer/reservations", { cookie: pat.cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ reservations: [] });
  });

  it("returns an empty list for a contact with no reservations", async () => {
    await submit(pat, at(FRI, 10));
    const res = await api("GET", "/api/customer/reservations", { cookie: sam.cookie });
    expect(res.json).toEqual({ reservations: [] });
  });
});

describe("GET /api/customer/reservations/:id", () => {
  it("returns an owned reservation", async () => {
    const id = await submit(pat, at(FRI, 10));
    const res = await api("GET", `/api/customer/reservations/${id}`, { cookie: pat.cookie });
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({ id, accountName: "Pat Co", status: "pending" });
  });

  it("is 404 for another account's reservation, identical to a missing one", async () => {
    const id = await submit(pat, at(FRI, 10));
    const other = await api("GET", `/api/customer/reservations/${id}`, { cookie: sam.cookie });
    const missing = await api("GET", `/api/customer/reservations/${crypto.randomUUID()}`, { cookie: sam.cookie });
    expect(other.status).toBe(404);
    expect(other.json).toEqual({ error: "not_found" });
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual(other.json);
  });

  it("lets a second contact of the same account see it", async () => {
    const id = await submit(pat, at(FRI, 10));
    await env.DB.prepare("INSERT INTO customer_contacts(customer_id, email, active) VALUES (?, 'kim@example.test', 1)").bind(pat.id).run();
    const kim = await loginCustomer("kim@example.test");
    const res = await api("GET", `/api/customer/reservations/${id}`, { cookie: kim });
    expect(res.status).toBe(200);
    expect(res.json.reservation.id).toBe(id);
    const list = await api("GET", "/api/customer/reservations", { cookie: kim });
    expect(list.json.reservations.map((r: any) => r.id)).toEqual([id]);
  });

  it("hides the reservation from a deactivated contact's session, but the emailed access link still opens it", async () => {
    const id = await submit(pat, at(FRI, 10));
    const token = await lastMailTo("pat@example.test");
    await env.DB.prepare("UPDATE customer_contacts SET active = 0 WHERE customer_id = ?").bind(pat.id).run();
    const viaSession = await api("GET", `/api/customer/reservations/${id}`, { cookie: pat.cookie });
    expect([viaSession.status, viaSession.json]).toEqual([404, { error: "not_found" }]);
    const viaLink = await access(token);
    expect(viaLink.status).toBe(200);
    expect(viaLink.json.reservation.id).toBe(id);
  });

  it("does not leak staff names, staff ids or other contacts' emails", async () => {
    const id = await submit(pat, at(FRI, 10));
    await env.DB.prepare("INSERT INTO customer_contacts(customer_id, email, active) VALUES (?, 'kim@example.test', 1)").bind(pat.id).run();
    const res = await api("GET", `/api/customer/reservations/${id}`, { cookie: pat.cookie });
    const text = JSON.stringify(res.json);
    expect(text).not.toContain("Test Person");
    expect(text).not.toContain("example.test");
    expect(Object.keys(res.json.reservation).sort()).toEqual(
      ["accountName", "closeReason", "contactName", "createdAt", "customerNumber", "endAt", "id", "issue", "phone", "ref", "startAt", "status", "version"],
    );
  });
});

describe("POST /api/access/reservation", () => {
  it("resolves the token from the request_received email", async () => {
    const id = await submit(pat, at(FRI, 10));
    const token = await lastMailTo("pat@example.test");
    // the login mail was newest before submit; after submit the newest mail to pat is request_received
    expect(token).not.toBeNull();
    const res = await access(token);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      reservation: { id, status: "pending", accountName: "Pat Co", startAt: at(FRI, 10) },
      timezone: env.APP_TIMEZONE,
      supportPhone: "",
      cancelCutoffMin: 60,
    });
    expect(JSON.stringify(res.json)).not.toContain(token!);
  });

  it("reports configured support phone and cancel cutoff", async () => {
    const id = await submit(pat, at(FRI, 10));
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('supportPhone', '\"+81 3-0000-0000\"'), ('cancelCutoffMin', '120')").run();
    const res = await access(await mintToken(id, at(FRI, 12)));
    expect(res.json).toMatchObject({ supportPhone: "+81 3-0000-0000", cancelCutoffMin: 120 });
  });

  it("returns an identical 404 for tampered, unknown and expired tokens", async () => {
    const id = await submit(pat, at(FRI, 10));
    const token = (await lastMailTo("pat@example.test"))!;
    const tampered = await access(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"));
    const unknown = await access("x".repeat(43));
    const expiredToken = await mintToken(id, clock.now() - 1);
    const expired = await access(expiredToken);
    const atExpiry = await access(await mintToken(id, clock.now()));
    for (const r of [tampered, unknown, expired, atExpiry]) {
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: "invalid_link" });
    }
  });

  it("stops working once the token expires", async () => {
    const id = await submit(pat, at(FRI, 10));
    const token = await mintToken(id, at(FRI, 12));
    expect((await access(token)).status).toBe(200);
    setNow(at(FRI, 12));
    expect((await access(token)).status).toBe(404);
  });

  it("scopes a token to its own reservation", async () => {
    const a = await submit(pat, at(FRI, 10));
    const b = await submit(sam, at(FRI, 11), "Sam's secret issue");
    const res = await access(await mintToken(a, at(FRI, 12)));
    expect(res.json.reservation.id).toBe(a);
    expect(JSON.stringify(res.json)).not.toContain(b);
    expect(JSON.stringify(res.json)).not.toContain("Sam");
  });

  it("does not reveal staff names or contact emails", async () => {
    const id = await submit(pat, at(FRI, 10));
    const res = await access(await mintToken(id, at(FRI, 12)));
    const text = JSON.stringify(res.json);
    expect(text).not.toContain("Test Person");
    expect(text).not.toContain("example.test");
  });

  it("validates the token shape", async () => {
    expect((await access("short")).status).toBe(400);
    expect((await access("x".repeat(201))).status).toBe(400);
    expect((await access(123)).status).toBe(400);
    expect((await api("POST", "/api/access/reservation", { body: {} })).status).toBe(400);
  });

  it("needs no session but still enforces the origin check", async () => {
    const id = await submit(pat, at(FRI, 10));
    const token = await mintToken(id, at(FRI, 12));
    expect((await api("POST", "/api/access/reservation", { body: { token }, origin: "http://evil.example.com" })).status).toBe(403);
  });

  it("rate limits per IP at 60 per 15 minutes", async () => {
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    await env.DB.prepare("INSERT INTO rate_limits(key, window_start, count) VALUES ('access:ip:203.0.113.9', ?, 60)").bind(clock.now()).run();
    const res = await access("x".repeat(43), ip);
    expect(res.status).toBe(429);
    expect(res.json.error).toBe("rate_limited");
    // another IP and a request without an IP header are unaffected
    expect((await access("x".repeat(43), { "cf-connecting-ip": "203.0.113.10" })).status).toBe(404);
    expect((await access("x".repeat(43))).status).toBe(404);
  });
});
