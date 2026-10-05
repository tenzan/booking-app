import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { submitReservation, type SubmitInput } from "../../src/worker/reservations/submit";
import { wallToUtc, MIN } from "../../src/domain/time";
import { bookableSlots } from "../../src/worker/scheduling/availability";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };

beforeEach(async () => {
  setNow(at(THU, 8)); // Thu 08:00 Tokyo
  team = await seedTeam();
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
});

const body = (customerId: number, startAt: number, over: Record<string, unknown> = {}) => ({
  customerId,
  startAt,
  contactName: "Pat Example",
  phone: "+81 3-1234-5678",
  issue: "Printer is offline",
  idempotencyKey: crypto.randomUUID(),
  ...over,
});
const submit = (who: { id: number; cookie: string }, startAt: number, over: Record<string, unknown> = {}) =>
  api("POST", "/api/customer/reservations", { cookie: who.cookie, body: body(who.id, startAt, over) });
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const provisional = async (id: string) =>
  (await env.DB.prepare("SELECT provisional_staff_id AS s FROM reservations WHERE id = ?").bind(id).first<{ s: number }>())!.s;
const blockCount = (staffId: number, ownerId: string) =>
  count("SELECT COUNT(*) AS n FROM tech_blocks WHERE staff_id = ? AND owner_id = ?", staffId, ownerId);

describe("POST /api/customer/reservations", () => {
  describe("with two eligible technicians", () => {
    beforeEach(async () => {
      await seedWeekly(5, 600, 660, [team.a, team.b]);
    });

    it("creates a pending request with blocks, mails and a lower availability", async () => {
      const res = await submit(pat, at(FRI, 10));
      expect(res.status).toBe(201);
      expect(res.json.reservation).toMatchObject({ status: "pending", startAt: at(FRI, 10), endAt: at(FRI, 10, 30) });
      expect(res.json.reservation.ref).toMatch(/^R-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      const id = res.json.reservation.id;

      const row = await env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<any>();
      expect(row).toMatchObject({ status: "pending", customer_id: pat.id, contact_email: "pat@example.test", contact_name: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline" });
      expect(row.expires_at).toBeGreaterThan(at(THU, 8));
      expect(row.approval_reminder_at).toBeGreaterThanOrEqual(at(THU, 8));
      expect(row.escalation_at).toBeGreaterThanOrEqual(row.approval_reminder_at);
      expect([team.a, team.b]).toContain(row.provisional_staff_id);

      // 10:00-10:30 plus the 10 minute buffer = 8 five-minute blocks, all for the provisional technician
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(8);
      expect(await blockCount(row.provisional_staff_id, id)).toBe(8);

      expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'request_received' AND to_email = 'pat@example.test' AND dedupe_key = ?", `received:${id}`)).toBe(1);
      // admin + four technicians all have notify = 1
      expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'new_request' AND reservation_id = ?", id)).toBe(5);

      const audit = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.requested'").first<any>();
      expect(audit).toMatchObject({ actor_kind: "customer", actor: "pat@example.test", reservation_id: id, customer_id: pat.id });
      expect(JSON.parse(audit.details)).toEqual({ startAt: at(FRI, 10), provisionalStaffId: row.provisional_staff_id });

      const av = await bookableSlots(env, FRI, FRI);
      expect(av.days[0]!.slots.map((s) => [s.startAt, s.spots])).toEqual([
        [at(FRI, 10), 1],
        [at(FRI, 10, 30), 1],
      ]);
    });

    it("returns the same reservation (200) for a retry with the same key", async () => {
      const first = body(pat.id, at(FRI, 10));
      const a = await api("POST", "/api/customer/reservations", { cookie: pat.cookie, body: first });
      const b = await api("POST", "/api/customer/reservations", { cookie: pat.cookie, body: first });
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      expect(b.json).toEqual(a.json);
      expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(8);
      expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'request_received'")).toBe(1);
    });

    it("rejects an idempotency key that belongs to another customer", async () => {
      const first = body(pat.id, at(FRI, 10));
      expect((await api("POST", "/api/customer/reservations", { cookie: pat.cookie, body: first })).status).toBe(201);
      const res = await api("POST", "/api/customer/reservations", { cookie: sam.cookie, body: { ...first, customerId: sam.id } });
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("idempotency_conflict");
      expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(1);
    });

    it("gives two concurrent customers different technicians", async () => {
      const [r1, r2] = await Promise.all([submit(pat, at(FRI, 10)), submit(sam, at(FRI, 10))]);
      expect([r1.status, r2.status]).toEqual([201, 201]);
      const a = await provisional(r1.json.reservation.id);
      const b = await provisional(r2.json.reservation.id);
      expect(new Set([a, b])).toEqual(new Set([team.a, team.b]));
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(16);
    });

    it("limits each account to its active requests", async () => {
      expect((await submit(pat, at(FRI, 10))).status).toBe(201);
      const res = await submit(pat, at(FRI, 10, 30));
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("limit_reached");
    });

    it("does not count a confirmed appointment that has already ended towards the limit", async () => {
      await env.DB.prepare(
        `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
           idempotency_key, created_at, updated_at)
         VALUES ('past1', 'R-PAST-0001', ?, 'pat@example.test', 'Pat', '000', 'issue', ?, ?, ?, ?, 'confirmed', 'past-key', 0, 0)`,
      )
        .bind(pat.id, at(THU, 7), at(THU, 7, 30), at(THU, 7), at(THU, 7, 30))
        .run();
      expect((await submit(pat, at(FRI, 10))).status).toBe(201);
    });

    it("lets a concurrent pair for the same account succeed only once", async () => {
      const results = await Promise.all([submit(pat, at(FRI, 10)), submit(pat, at(FRI, 10, 30))]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.json.error).toBe("limit_reached");
      expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(1);
    });

    it("is not eligible when the account was deactivated after availability was shown", async () => {
      await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(pat.id).run();
      const res = await submit(pat, at(FRI, 10));
      expect(res.status).toBe(403);
      expect(res.json.error).toBe("not_eligible");
      expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(0);
    });

    it("is not eligible when the contact was deactivated", async () => {
      await env.DB.prepare("UPDATE customer_contacts SET active = 0 WHERE customer_id = ?").bind(pat.id).run();
      expect((await submit(pat, at(FRI, 10))).status).toBe(403);
    });

    it("refuses another customer's account id", async () => {
      const res = await submit(pat, at(FRI, 10), { customerId: sam.id });
      expect(res.status).toBe(403);
      expect(res.json.error).toBe("not_eligible");
    });

    it("rejects slots inside the minimum notice with 400 too_soon", async () => {
      await seedWeekly(4, 600, 660, [team.a, team.b]);
      const res = await submit(pat, at(THU, 10)); // earliest is 12:00 Thursday
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("too_soon");
    });

    it("rejects a start that is not a slot and one beyond the booking horizon", async () => {
      const off = await submit(pat, at(FRI, 10, 15));
      expect([off.status, off.json.error]).toEqual([409, "slot_unavailable"]);
      await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('bookingHorizonDays', '1')").run();
      const far = await submit(pat, at("2026-10-09", 10));
      expect([far.status, far.json.error]).toEqual([409, "slot_unavailable"]);
    });

    it("validates the body", async () => {
      const bad: Array<Record<string, unknown>> = [
        { contactName: "   " },
        { contactName: "x".repeat(101) },
        { phone: "1234" },
        { phone: "call me maybe" },
        { issue: "" },
        { issue: "x".repeat(1001) },
        { idempotencyKey: "not-a-uuid" },
        { startAt: 1.5 },
        { customerId: "1" },
      ];
      for (const over of bad) {
        const res = await submit(pat, at(FRI, 10), over);
        expect(res.status, JSON.stringify(over)).toBe(400);
        expect(res.json.error).toBe("invalid");
      }
      expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(0);
    });

    it("trims name and issue", async () => {
      const res = await submit(pat, at(FRI, 10), { contactName: "  Pat  ", issue: "  slow  " });
      const row = await env.DB.prepare("SELECT contact_name, issue FROM reservations WHERE id = ?").bind(res.json.reservation.id).first<any>();
      expect(row).toEqual({ contact_name: "Pat", issue: "slow" });
    });

    it("requires a customer session", async () => {
      const res = await api("POST", "/api/customer/reservations", { body: body(pat.id, at(FRI, 10)) });
      expect(res.status).toBe(401);
    });

    it("rate-limits to 10 submissions per hour and session", async () => {
      for (let i = 0; i < 10; i++) expect((await submit(pat, at(FRI, 10), { phone: "1" })).status).toBe(400);
      const res = await submit(pat, at(FRI, 10));
      expect(res.status).toBe(429);
      expect(res.json.error).toBe("rate_limited");
      expect((await submit(sam, at(FRI, 10))).status).toBe(201); // other session unaffected
    });

    it("does not touch existing holds when the new request cannot be placed", async () => {
      const first = await submit(pat, at(FRI, 10));
      expect(first.status).toBe(201);
      const pId = first.json.reservation.id;
      const pStaff = await provisional(pId);
      const other = pStaff === team.a ? team.b : team.a;
      // A confirmed reservation fixed to the other technician, with its blocks.
      await env.DB.prepare(
        `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
           assigned_staff_id, idempotency_key, created_at, updated_at)
         VALUES ('c1', 'R-TEST-0001', ?, 'pat@example.test', 'Pat', '000', 'issue', ?, ?, ?, ?, 'confirmed', ?, 'k-c1', 0, 0)`,
      )
        .bind(pat.id, at(FRI, 10), at(FRI, 10, 30), at(FRI, 10), at(FRI, 10, 40), other)
        .run();
      for (let ms = at(FRI, 10); ms < at(FRI, 10) + 40 * MIN; ms += 5 * MIN) {
        await env.DB.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) VALUES (?, ?, 'reservation', 'c1')")
          .bind(other, ms / MIN)
          .run();
      }
      const res = await submit(sam, at(FRI, 10));
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("slot_unavailable");
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(16); // 8 per hold, none orphaned or duplicated
      expect(await provisional(pId)).toBe(pStaff);
      expect(await blockCount(pStaff, pId)).toBe(8);
      expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(2);
    });
  });

  describe("with a single technician", () => {
    beforeEach(async () => {
      await seedWeekly(5, 600, 660, [team.a]);
    });

    it("gives the last spot to exactly one of two concurrent customers", async () => {
      const [r1, r2] = await Promise.all([submit(pat, at(FRI, 10)), submit(sam, at(FRI, 10))]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      expect(loser.json.error).toBe("slot_unavailable");
      expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(8);
    });
  });

  it("moves a pending request to another technician to make room", async () => {
    await seedWeekly(5, 600, 660, [team.a, team.b]);
    // b is away at the end of the 10:30 slot's occupied range, so 10:30 can only be served by a; 10:00 by either.
    await env.DB.prepare("INSERT INTO staff_unavailability(staff_id, start_at, end_at) VALUES (?, ?, ?)")
      .bind(team.b, at(FRI, 10, 45), at(FRI, 11, 15))
      .run();
    const first = await submit(pat, at(FRI, 10));
    expect(first.status).toBe(201);
    const pId = first.json.reservation.id;
    expect(await provisional(pId)).toBe(team.a);

    const second = await submit(sam, at(FRI, 10, 30));
    expect(second.status).toBe(201);
    const sId = second.json.reservation.id;
    expect(await provisional(sId)).toBe(team.a);
    expect(await provisional(pId)).toBe(team.b);

    expect(await blockCount(team.b, pId)).toBe(8);
    expect(await blockCount(team.a, pId)).toBe(0);
    expect(await blockCount(team.a, sId)).toBe(8);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(16);
    const moved = await env.DB.prepare("SELECT updated_at FROM reservations WHERE id = ?").bind(pId).first<{ updated_at: number }>();
    expect(moved!.updated_at).toBe(at(THU, 8));
  });

  it("a moved request closed behind our back fails the move assertion and replans without orphan blocks", async () => {
    await seedWeekly(5, 600, 660, [team.a, team.b]);
    await env.DB.prepare("INSERT INTO staff_unavailability(staff_id, start_at, end_at) VALUES (?, ?, ?)")
      .bind(team.b, at(FRI, 10, 45), at(FRI, 11, 15))
      .run();
    const first = await submit(pat, at(FRI, 10));
    const pId = first.json.reservation.id;
    expect(await provisional(pId)).toBe(team.a);
    // pat's request is declined by a rival without bumping the schedule version: our plan still wants to move it to b.
    const w = withBatchHook(async () => {
      await env.DB.batch([
        env.DB.prepare("UPDATE reservations SET status = 'declined' WHERE id = ?").bind(pId),
        env.DB.prepare("DELETE FROM tech_blocks WHERE owner_id = ?").bind(pId),
      ]);
    });
    const res = await submitReservation(w.env, "sam@example.test", body(sam.id, at(FRI, 10, 30)) as SubmitInput);
    expect(res.created).toBe(true);
    expect(w.calls.batches).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_id = ?", pId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(8);
  });

  describe("conflict handling, forced deterministically", () => {
    const input = (customerId: number, startAt: number): SubmitInput => body(customerId, startAt) as SubmitInput;

    beforeEach(async () => {
      await seedWeekly(5, 600, 660, [team.a]);
    });

    it("version guard: a stale snapshot makes the first batch fail and the retry succeed", async () => {
      const w = withBatchHook(async () => {
        await env.DB.prepare("UPDATE schedule_state SET version = version + 1 WHERE id = 1").run();
      });
      const res = await submitReservation(w.env, "pat@example.test", input(pat.id, at(FRI, 10)));
      expect(res.created).toBe(true);
      expect(w.calls.batches).toBe(2); // first attempt rolled back by the guard, second committed
      expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(8);
      expect(await count("SELECT version AS n FROM schedule_state")).toBe(2);
    });

    it("a rival that commits after our snapshot takes the last spot: we retry and get slot_unavailable", async () => {
      const w = withBatchHook(async () => {
        await submitReservation(env, "sam@example.test", input(sam.id, at(FRI, 10)));
      });
      await expect(submitReservation(w.env, "pat@example.test", input(pat.id, at(FRI, 10)))).rejects.toMatchObject({
        status: 409,
        code: "slot_unavailable",
      });
      expect(w.calls.batches).toBe(1); // the retry fails before reaching a second batch
      expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(8);
    });

    it("version guard serializes the per-account limit: a same-account rival committing after our snapshot makes us hit limit_reached", async () => {
      await env.DB.prepare("DELETE FROM availability_windows").run();
      await seedWeekly(5, 600, 720, [team.a]); // two non-overlapping slots, no capacity conflict: only the limit can reject
      const w = withBatchHook(async () => {
        await submitReservation(env, "pat@example.test", input(pat.id, at(FRI, 11)));
      });
      await expect(submitReservation(w.env, "pat@example.test", input(pat.id, at(FRI, 10)))).rejects.toMatchObject({
        status: 409,
        code: "limit_reached",
      });
      expect(await count("SELECT COUNT(*) AS n FROM reservations WHERE customer_id = ?", pat.id)).toBe(1);
    });

    it("a concurrent duplicate idempotency key (UNIQUE) resolves to the existing reservation", async () => {
      const dup = input(pat.id, at(FRI, 10));
      // Inserted without bumping the schedule version, so the guard passes and only UNIQUE can reject the batch.
      const w = withBatchHook(async () => {
        await env.DB.prepare(
          `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
             idempotency_key, created_at, updated_at)
           VALUES ('dup1', 'R-DUPL-0001', ?, 'pat@example.test', 'Pat', '000', 'issue', ?, ?, ?, ?, 'pending', ?, 0, 0)`,
        )
          .bind(pat.id, at(FRI, 10), at(FRI, 10, 30), at(FRI, 10), at(FRI, 10, 40), dup.idempotencyKey)
          .run();
      });
      const res = await submitReservation(w.env, "pat@example.test", dup);
      expect(res).toMatchObject({ id: "dup1", ref: "R-DUPL-0001", status: "pending", created: false });
      expect(w.calls.batches).toBe(1); // no retry: the UNIQUE failure was resolved by lookup
      expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(0); // our batch rolled back completely
    });

    it("a UNIQUE duplicate owned by someone else is an idempotency_conflict", async () => {
      const dup = input(pat.id, at(FRI, 10));
      const w = withBatchHook(async () => {
        await env.DB.prepare(
          `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
             idempotency_key, created_at, updated_at)
           VALUES ('dup1', 'R-DUPL-0001', ?, 'sam@example.test', 'Sam', '000', 'issue', ?, ?, ?, ?, 'pending', ?, 0, 0)`,
        )
          .bind(sam.id, at(FRI, 10), at(FRI, 10, 30), at(FRI, 10), at(FRI, 10, 40), dup.idempotencyKey)
          .run();
      });
      await expect(submitReservation(w.env, "pat@example.test", dup)).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    });
  });
});

describe("GET /api/customer/accounts: open reservations and the limit", () => {
  beforeEach(async () => {
    await seedWeekly(5, 600, 720, [team.a, team.b]);
  });
  const accounts = async (who: { cookie: string }) => {
    const res = await api("GET", "/api/customer/accounts", { cookie: who.cookie });
    expect(res.status).toBe(200);
    return res.json.accounts as Array<{ id: number; openLimit: number; open: Array<Record<string, unknown>> }>;
  };

  it("lists nothing open and the configured limit for a fresh account", async () => {
    expect((await accounts(pat))[0]).toMatchObject({ id: pat.id, openLimit: 1, open: [] });
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('maxActivePerAccount', '3')").run();
    expect((await accounts(pat))[0]!.openLimit).toBe(3);
  });

  it("lists the open request that blocks another booking, exactly as the submit check counts it", async () => {
    const first = await submit(pat, at(FRI, 10));
    const [a] = await accounts(pat);
    expect(a!.open).toEqual([
      { id: first.json.reservation.id, ref: first.json.reservation.ref, status: "pending", startAt: at(FRI, 10), endAt: at(FRI, 10, 30) },
    ]);
    expect(a!.open.length >= a!.openLimit).toBe(true);
    expect((await submit(pat, at(FRI, 11))).json.error).toBe("limit_reached");
    // Another account is unaffected.
    expect((await accounts(sam))[0]!.open).toEqual([]);
  });

  it("does not list an appointment that has already ended", async () => {
    await env.DB.prepare(
      `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
         idempotency_key, created_at, updated_at)
       VALUES ('past1', 'R-PAST-0001', ?, 'pat@example.test', 'Pat', '000', 'issue', ?, ?, ?, ?, 'confirmed', 'past-key', 0, 0)`,
    )
      .bind(pat.id, at(THU, 7), at(THU, 7, 30), at(THU, 7), at(THU, 7, 30))
      .run();
    expect((await accounts(pat))[0]!.open).toEqual([]);
  });

  it("lists a reservation with a pending change request once (the original), not the change request", async () => {
    const original = await submit(pat, at(FRI, 10));
    const change = await submit(pat, at(FRI, 11), { replacesId: original.json.reservation.id });
    expect(change.status).toBe(201);
    expect((await accounts(pat))[0]!.open.map((r) => r.ref)).toEqual([original.json.reservation.ref]);
  });

  it("lists several open reservations in time order when the limit allows them", async () => {
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('maxActivePerAccount', '2')").run();
    const later = await submit(pat, at(FRI, 11));
    const sooner = await submit(pat, at(FRI, 10));
    const [a] = await accounts(pat);
    expect(a!.open.map((r) => r.ref)).toEqual([sooner.json.reservation.ref, later.json.reservation.ref]);
    expect(a!.openLimit).toBe(2);
  });
});
