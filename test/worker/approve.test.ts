import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { approveReservation } from "../../src/worker/reservations/approve";
import { MIN, wallToUtc } from "../../src/domain/time";
import type { StaffPrincipal } from "../../src/worker/env";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };
let adminCookie: string;
let techCookie: string;

const principal = (id: number, name: string): StaffPrincipal => ({ id, email: "x@example.test", name, role: "technician" });

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  await env.DB.prepare("UPDATE staff SET name = 'Ada Admin' WHERE id = ?").bind(team.admin).run();
  await env.DB.prepare("UPDATE staff SET name = 'Tim Tech' WHERE id = ?").bind(team.a).run();
  await env.DB.prepare("UPDATE staff SET name = 'Una Tech' WHERE id = ?").bind(team.b).run();
  await env.DB.prepare("UPDATE staff SET name = 'Cy Tech' WHERE id = ?").bind(team.c).run();
  await env.DB.prepare("UPDATE staff SET name = 'Dee Tech' WHERE id = ?").bind(team.d).run();
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
});

const submit = async (who: { id: number; cookie: string }, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation.id as string;
};
const approve = (cookie: string, id: string, staffId: number, version = 1) =>
  api("POST", `/api/staff/reservations/${id}/approve`, { cookie, body: { staffId, version } });
const decline = (cookie: string, id: string, reason: string, version = 1) =>
  api("POST", `/api/staff/reservations/${id}/decline`, { cookie, body: { reason, version } });
const detail = (cookie: string, id: string) => api("GET", `/api/staff/reservations/${id}`, { cookie });
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const row = (id: string) => env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<any>();
const blockCount = (staffId: number, ownerId: string) =>
  count("SELECT COUNT(*) AS n FROM tech_blocks WHERE staff_id = ? AND owner_id = ?", staffId, ownerId);
const jobs = (template: string) => count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = ?", template);

describe("with two eligible technicians plus the admin", () => {
  beforeEach(async () => {
    await seedWeekly(5, 600, 660, [team.admin, team.a, team.b]);
  });

  it("approves with the approver as technician: confirmed, blocks moved, mails queued, audited", async () => {
    const id = await submit(pat, at(FRI, 10));
    const before = await row(id);
    const res = await approve(adminCookie, id, team.admin);
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({
      id,
      status: "confirmed",
      version: 2,
      assignedStaff: { id: team.admin, name: "Ada Admin" },
      provisionalStaffId: null,
      confirmedBy: { id: team.admin, name: "Ada Admin" },
      confirmedAt: at(THU, 8),
    });
    const after = await row(id);
    expect(after).toMatchObject({ status: "confirmed", assigned_staff_id: team.admin, provisional_staff_id: null, confirmed_by: team.admin, version: 2, updated_at: at(THU, 8) });

    expect(await blockCount(team.admin, id)).toBe(8);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(8);
    if (before.provisional_staff_id !== team.admin) expect(await blockCount(before.provisional_staff_id, id)).toBe(0);

    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'confirmed' AND to_email = 'pat@example.test' AND dedupe_key = ?", `confirmed:${id}:v2`)).toBe(1);
    // Every other staff member who gets request notifications (the approver already knows).
    expect(await jobs("assigned")).toBe(4);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE dedupe_key = ?", `assigned:${id}:v2:${team.a}`)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'assigned' AND to_email = 'admin@example.test'")).toBe(0);

    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.approved'").first<any>();
    expect(a).toMatchObject({ actor_kind: "staff", actor: String(team.admin), reservation_id: id, customer_id: pat.id });
    expect(JSON.parse(a.details)).toEqual({ assignedStaffId: team.admin });
  });

  it("lets another technician take the request, moving the displaced pending request", async () => {
    const pId = await submit(pat, at(FRI, 10));
    const sId = await submit(sam, at(FRI, 10));
    const pStaff = (await row(pId)).provisional_staff_id as number;
    const res = await approve(adminCookie, sId, pStaff); // take the technician pat's request currently holds
    expect(res.status).toBe(200);
    expect((await row(sId)).assigned_staff_id).toBe(pStaff);
    const pNow = (await row(pId)).provisional_staff_id as number;
    expect(pNow).not.toBe(pStaff);
    expect(await blockCount(pNow, pId)).toBe(8);
    expect(await blockCount(pStaff, pId)).toBe(0);
    expect(await blockCount(pStaff, sId)).toBe(8);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(16);
  });

  it("lists and shows requests with technician options and an audit trail (staff only)", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(adminCookie, id, team.a);
    const id2 = await submit(sam, at(FRI, 10));

    const list = await api("GET", "/api/staff/reservations?status=pending", { cookie: techCookie });
    expect(list.status).toBe(200);
    expect(list.json.reservations.map((r: any) => r.id)).toEqual([id2]);
    const all = await api("GET", `/api/staff/reservations?status=pending,confirmed&from=${at(FRI, 9)}&to=${at(FRI, 11)}&staffId=${team.a}`, { cookie: techCookie });
    expect(all.json.reservations.map((r: any) => r.id)).toEqual([id]);
    expect((await api("GET", "/api/staff/reservations?status=bogus", { cookie: techCookie })).status).toBe(400);

    const d = await detail(techCookie, id);
    expect(d.json.techOptions).toEqual([]); // not pending any more
    expect(d.json.audit.map((r: any) => [r.actorKind, r.actor, r.action])).toEqual([
      ["customer", "pat@example.test", "reservation.requested"],
      ["staff", "Ada Admin", "reservation.approved"],
    ]);
    const d2 = await detail(techCookie, id2);
    expect(d2.json.reservation).toMatchObject({ id: id2, status: "pending", customer: { id: sam.id, number: expect.any(String), name: "Sam Co", active: true }, contactEmail: "sam@example.test" });
    // Assignable first, then by name.
    expect(d2.json.techOptions.map((o: any) => [o.id, o.assignable, o.reason])).toEqual([
      [team.admin, true, null],
      [team.b, true, null],
      [team.c, false, "not_scheduled"],
      [team.d, false, "not_scheduled"],
      [team.a, false, "busy"],
    ]);
    expect((await detail(techCookie, "nope")).status).toBe(404);
  });

  it("only one of two parallel approvals succeeds; the loser gets stale naming the winner", async () => {
    const id = await submit(pat, at(FRI, 10));
    const [r1, r2] = await Promise.all([approve(adminCookie, id, team.admin), approve(techCookie, id, team.a)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const [win, lose] = r1.status === 200 ? [r1, r2] : [r2, r1];
    expect(lose.json.error).toBe("stale");
    expect(lose.json.details.current.status).toBe("confirmed");
    expect(lose.json.details.current.confirmedBy.name).toBe(win === r1 ? "Ada Admin" : "Tim Tech");
    expect(await jobs("confirmed")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reservation.approved'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(8);
  });

  it("repeating an approval with the same version is stale and queues nothing", async () => {
    const id = await submit(pat, at(FRI, 10));
    expect((await approve(adminCookie, id, team.admin)).status).toBe(200);
    const jobsBefore = await count("SELECT COUNT(*) AS n FROM email_jobs");
    const again = await approve(adminCookie, id, team.admin);
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("stale");
    expect(again.json.details.current).toMatchObject({ status: "confirmed", version: 2 });
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs")).toBe(jobsBefore);
    expect(await row(id)).toMatchObject({ version: 2 });
  });

  it("a stale version on a still-pending request is stale too", async () => {
    const id = await submit(pat, at(FRI, 10));
    const res = await approve(adminCookie, id, team.admin, 7);
    expect([res.status, res.json.error, res.json.details.current.status]).toEqual([409, "stale", "pending"]);
  });

  it("refuses once the appointment time has arrived (too_late) and changes nothing", async () => {
    const id = await submit(pat, at(FRI, 10));
    setNow(at(FRI, 10));
    await expect(approveReservation(env, principal(team.admin, "Ada Admin"), id, team.admin, 1)).rejects.toMatchObject({
      status: 409,
      code: "too_late",
    });
    expect((await row(id)).status).toBe("pending");
    expect(await jobs("confirmed")).toBe(0);
  });

  it("refuses when the account was deactivated after the request", async () => {
    const id = await submit(pat, at(FRI, 10));
    await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(pat.id).run();
    const res = await approve(adminCookie, id, team.admin);
    expect([res.status, res.json.error]).toEqual([409, "customer_ineligible"]);
    expect((await row(id)).status).toBe("pending");
  });

  it("refuses when the contact was deactivated", async () => {
    const id = await submit(pat, at(FRI, 10));
    await env.DB.prepare("UPDATE customer_contacts SET active = 0 WHERE customer_id = ?").bind(pat.id).run();
    const res = await approve(adminCookie, id, team.admin);
    expect([res.status, res.json.error]).toEqual([409, "customer_ineligible"]);
  });

  it("refuses a technician who is not scheduled for the slot, returning options", async () => {
    const id = await submit(pat, at(FRI, 10));
    const res = await approve(adminCookie, id, team.c);
    expect([res.status, res.json.error]).toEqual([409, "tech_unavailable"]);
    expect(res.json.details.options.find((o: any) => o.id === team.c)).toMatchObject({ assignable: false, reason: "not_scheduled" });
    expect((await row(id)).status).toBe("pending");
  });

  it("shows a technician with a confirmed appointment on top as busy with its reference", async () => {
    const id = await submit(pat, at(FRI, 10));
    const other = (await row(id)).provisional_staff_id === team.b ? team.a : team.b;
    await env.DB.prepare(
      `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
         assigned_staff_id, idempotency_key, created_at, updated_at)
       VALUES ('c1', 'R-TEST-0001', ?, 'sam@example.test', 'Sam', '000', 'issue', ?, ?, ?, ?, 'confirmed', ?, 'k-c1', 0, 0)`,
    )
      .bind(sam.id, at(FRI, 10, 15), at(FRI, 10, 45), at(FRI, 10, 5), at(FRI, 10, 55), other)
      .run();
    for (let ms = at(FRI, 10, 5); ms < at(FRI, 10, 55); ms += 5 * MIN) {
      await env.DB.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) VALUES (?, ?, 'reservation', 'c1')").bind(other, ms / MIN).run();
    }
    const d = await detail(adminCookie, id);
    const busy = d.json.techOptions.find((o: any) => o.id === other);
    expect(busy).toMatchObject({ assignable: false, reason: "busy", conflictRef: "R-TEST-0001" });
    const res = await approve(adminCookie, id, other);
    expect(res.json.error).toBe("tech_unavailable");
    expect(res.json.details.options.find((o: any) => o.id === other).conflictRef).toBe("R-TEST-0001");
    // Everyone else stays assignable and sorts first.
    expect(d.json.techOptions[0].assignable).toBe(true);
    expect(d.json.techOptions.at(-1).id).toBe(other);
  });

  describe("declining", () => {
    it("declines with a reason: blocks removed, capacity restored, customer mailed, audited", async () => {
      const id = await submit(pat, at(FRI, 10));
      const res = await decline(techCookie, id, "  Out of scope  ");
      expect(res.status).toBe(200);
      expect(res.json.reservation).toMatchObject({ status: "declined", version: 2, closedAt: at(THU, 8), closedBy: "Tim Tech", closeReason: "Out of scope" });
      expect(await row(id)).toMatchObject({ status: "declined", closed_by_kind: "staff", closed_by: String(team.a), close_reason: "Out of scope" });
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'declined' AND to_email = 'pat@example.test' AND dedupe_key = ?", `declined:${id}`)).toBe(1);
      const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.declined'").first<any>();
      expect(a).toMatchObject({ actor_kind: "staff", actor: String(team.a), reservation_id: id });

      const av = await api("GET", `/api/customer/availability?from=${FRI}&to=${FRI}`, { cookie: sam.cookie });
      expect(av.json.days[0].slots.find((s: any) => s.startAt === at(FRI, 10)).spots).toBe(3);
      // The customer can book again.
      expect((await submit(pat, at(FRI, 10))).length).toBeGreaterThan(0);
    });

    it("rejects stale versions, closed requests and bad reasons", async () => {
      const id = await submit(pat, at(FRI, 10));
      expect((await decline(techCookie, id, "no", 9)).json.error).toBe("stale");
      for (const reason of ["", "   ", "x".repeat(501)]) {
        const bad = await decline(techCookie, id, reason);
        expect([bad.status, bad.json.error]).toEqual([400, "invalid"]);
      }
      expect((await decline(techCookie, id, "ok")).status).toBe(200);
      const again = await decline(techCookie, id, "ok");
      expect([again.status, again.json.error, again.json.details.current.status]).toEqual([409, "stale", "declined"]);
      expect(await jobs("declined")).toBe(1);
    });

    it("cannot approve a declined request", async () => {
      const id = await submit(pat, at(FRI, 10));
      await decline(techCookie, id, "no");
      const res = await approve(adminCookie, id, team.a, 2);
      expect([res.status, res.json.error]).toEqual([409, "stale"]);
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(0);
    });
  });

  describe("conflict handling, forced deterministically", () => {
    it("a rival approval landing between our snapshot and our batch makes us stale on the retry", async () => {
      const id = await submit(pat, at(FRI, 10));
      const w = withBatchHook(async () => {
        await approveReservation(env, principal(team.a, "Tim Tech"), id, team.a, 1);
      });
      await expect(approveReservation(w.env, principalOf(team.admin, "Ada Admin"), id, team.admin, 1)).rejects.toMatchObject({
        status: 409,
        code: "stale",
        details: { current: { status: "confirmed", confirmedBy: { id: team.a, name: "Tim Tech" } } },
      });
      expect(w.calls.batches).toBe(1);
      expect(await jobs("confirmed")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(8);
    });

    it("an unrelated schedule change only costs a retry", async () => {
      const id = await submit(pat, at(FRI, 10));
      const w = withBatchHook(async () => {
        await env.DB.prepare("UPDATE schedule_state SET version = version + 1 WHERE id = 1").run();
      });
      const res = await approveReservation(w.env, principalOf(team.admin, "Ada Admin"), id, team.admin, 1);
      expect(res.status).toBe("confirmed");
      expect(w.calls.batches).toBe(2);
    });

    it("a customer deactivated after our precheck still blocks the batch", async () => {
      const id = await submit(pat, at(FRI, 10));
      const w = withBatchHook(async () => {
        await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(pat.id).run();
      });
      await expect(approveReservation(w.env, principalOf(team.admin, "Ada Admin"), id, team.admin, 1)).rejects.toMatchObject({ status: 409, code: "customer_ineligible" });
      expect((await row(id)).status).toBe("pending");
      expect(await jobs("confirmed")).toBe(0);
    });

    it("a rival submit that changes a moved request's technician fails the move assertion and replans", async () => {
      const pId = await submit(pat, at(FRI, 10));
      const sId = await submit(sam, at(FRI, 10));
      const pStaff = (await row(pId)).provisional_staff_id as number;
      const w = withBatchHook(async () => {
        // pat's request swaps technicians behind our back (without bumping the schedule version).
        const sStaff = (await row(sId)).provisional_staff_id as number;
        await env.DB.batch([
          env.DB.prepare("DELETE FROM tech_blocks WHERE owner_id IN (?, ?)").bind(pId, sId),
          env.DB.prepare("UPDATE reservations SET provisional_staff_id = ? WHERE id = ?").bind(sStaff, pId),
          env.DB.prepare("UPDATE reservations SET provisional_staff_id = ? WHERE id = ?").bind(pStaff, sId),
        ]);
        for (const [staff, owner] of [[sStaff, pId], [pStaff, sId]] as const) {
          for (let ms = at(FRI, 9, 55); ms < at(FRI, 10, 35); ms += 5 * MIN) {
            await env.DB.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) VALUES (?, ?, 'reservation', ?)").bind(staff, ms / MIN, owner).run();
          }
        }
      });
      const res = await approveReservation(w.env, principalOf(team.admin, "Ada Admin"), sId, pStaff, 1);
      expect(res.assignedStaff?.id).toBe(pStaff);
      expect(w.calls.batches).toBe(2);
      expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(16);
      const pNow = (await row(pId)).provisional_staff_id as number;
      expect(pNow).not.toBe(pStaff);
      expect(await blockCount(pNow, pId)).toBe(8);
    });
  });
});

const principalOf = principal;

describe("when a pending request holds a technician another request needs", () => {
  beforeEach(async () => {
    await seedWeekly(5, 600, 660, [team.a, team.b]);
    // b is away at the end of the 10:30 slot, so only a can serve 10:30; 10:00 can use either.
    await env.DB.prepare("INSERT INTO staff_unavailability(staff_id, start_at, end_at) VALUES (?, ?, ?)").bind(team.b, at(FRI, 10, 45), at(FRI, 11, 15)).run();
  });

  it("refuses with tech_unavailable and explains who is needed elsewhere", async () => {
    const early = await submit(pat, at(FRI, 10));
    const late = await submit(sam, at(FRI, 10, 30));
    expect((await row(late)).provisional_staff_id).toBe(team.a);

    const res = await approve(adminCookie, early, team.a);
    expect([res.status, res.json.error]).toEqual([409, "tech_unavailable"]);
    expect(res.json.details.options.map((o: any) => [o.id, o.assignable, o.reason])).toEqual([
      [team.b, true, null],
      [team.admin, false, "not_scheduled"],
      [team.c, false, "not_scheduled"],
      [team.d, false, "not_scheduled"],
      [team.a, false, "needed_for_other_request"],
    ]);
    expect(await row(early)).toMatchObject({ status: "pending", version: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(16);

    const d = await detail(adminCookie, early);
    expect(d.json.techOptions).toEqual(res.json.details.options);

    // The other technician works.
    expect((await approve(adminCookie, early, team.b)).status).toBe(200);
  });

  it("shows a scheduled technician on leave as unavailable", async () => {
    const late = await submit(sam, at(FRI, 10, 30));
    const d = await detail(adminCookie, late);
    expect(d.json.techOptions.map((o: any) => [o.id, o.assignable, o.reason])).toEqual([
      [team.a, true, null],
      [team.admin, false, "not_scheduled"],
      [team.c, false, "not_scheduled"],
      [team.d, false, "not_scheduled"],
      [team.b, false, "unavailable"],
    ]);
    const res = await approve(adminCookie, late, team.b);
    expect(res.json.error).toBe("tech_unavailable");
  });
});

describe("access", () => {
  it("rejects customers and anonymous callers on every staff reservation route", async () => {
    await seedWeekly(5, 600, 660, [team.a]);
    const id = await submit(pat, at(FRI, 10));
    for (const [method, path, body] of [
      ["GET", "/api/staff/reservations", undefined],
      ["GET", `/api/staff/reservations/${id}`, undefined],
      ["POST", `/api/staff/reservations/${id}/approve`, { staffId: team.a, version: 1 }],
      ["POST", `/api/staff/reservations/${id}/decline`, { reason: "x", version: 1 }],
    ] as const) {
      expect((await api(method, path, { cookie: pat.cookie, body })).status, `${method} ${path}`).toBe(401);
      expect((await api(method, path, { body })).status).toBe(401);
    }
    expect((await row(id)).status).toBe("pending");
  });

  it("keeps /api/staff/me working", async () => {
    const res = await api("GET", "/api/staff/me", { cookie: adminCookie });
    expect(res.status).toBe(200);
    expect(res.json.email).toBe("admin@example.test");
  });
});
