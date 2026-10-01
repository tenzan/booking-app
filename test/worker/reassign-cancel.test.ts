import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { approveReservation } from "../../src/worker/reservations/approve";
import { reassignReservation } from "../../src/worker/reservations/reassign";
import { cancelReservation } from "../../src/worker/reservations/cancel";
import { processOutbox } from "../../src/worker/mail/outbox";
import { MIN, wallToUtc } from "../../src/domain/time";
import type { StaffPrincipal } from "../../src/worker/env";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);
const TZ_LABEL = "Asia/Tokyo (GMT+9)";

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };
let adminCookie: string;
let techCookie: string;

const principal = (id: number, name: string, role: StaffPrincipal["role"] = "technician"): StaffPrincipal => ({ id, email: "x@example.test", name, role });
const ada = () => principal(team.admin, "Ada Admin", "admin");
const tim = () => principal(team.a, "Tim Tech");
const una = () => principal(team.b, "Una Tech");

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  for (const [id, name] of [
    [team.admin, "Ada Admin"],
    [team.a, "Tim Tech"],
    [team.b, "Una Tech"],
    [team.c, "Cy Tech"],
    [team.d, "Dee Tech"],
  ] as const) {
    await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(name, id).run();
  }
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
  await seedWeekly(5, 600, 660, [team.admin, team.a, team.b]);
});

const submit = async (who: { id: number; cookie: string }, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation.id as string;
};
/** A confirmed appointment (version 2) with `staffId`, approved by the admin; the approval mails are already delivered. */
const confirmedWith = async (who: { id: number; cookie: string }, startAt: number, staffId: number) => {
  const id = await submit(who, startAt);
  const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } });
  expect(res.status).toBe(200);
  return id;
};
const reassign = (cookie: string, id: string, staffId: number, version = 2) =>
  api("POST", `/api/staff/reservations/${id}/reassign`, { cookie, body: { staffId, version } });
const cancel = (cookie: string, id: string, reason: string, version: number) =>
  api("POST", `/api/staff/reservations/${id}/cancel`, { cookie, body: { reason, version } });
const detail = (cookie: string, id: string) => api("GET", `/api/staff/reservations/${id}`, { cookie });
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const row = (id: string) => env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<any>();
const blockCount = (staffId: number, ownerId: string) =>
  count("SELECT COUNT(*) AS n FROM tech_blocks WHERE staff_id = ? AND owner_id = ?", staffId, ownerId);
const allBlocks = () => count("SELECT COUNT(*) AS n FROM tech_blocks");
const jobs = (template: string) => count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = ?", template);
const jobStatus = (dedupeKey: string) => env.DB.prepare("SELECT status FROM email_jobs WHERE dedupe_key = ?").bind(dedupeKey).first<string>("status");
const teamCancelJobs = (id: string) =>
  count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'cancelled' AND reservation_id = ? AND to_email <> 'pat@example.test'", id);
const mailsTo = async (email: string, subjectLike = "%") =>
  (
    await env.DB.prepare("SELECT subject, text, html FROM dev_mailbox WHERE to_email = ? AND subject LIKE ? ORDER BY id")
      .bind(email, subjectLike)
      .all<{ subject: string; text: string; html: string }>()
  ).results;

/** Insert a confirmed appointment on `staffId` with its blocks, as another booking flow would have. */
const seedConfirmed = async (id: string, ref: string, staffId: number, startAt: number) => {
  const occStart = startAt;
  const occEnd = startAt + 40 * MIN;
  await env.DB.prepare(
    `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
       assigned_staff_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 'sam@example.test', 'Sam', '000', 'issue', ?, ?, ?, ?, 'confirmed', ?, ?, 0, 0)`,
  )
    .bind(id, ref, sam.id, startAt, startAt + 30 * MIN, occStart, occEnd, staffId, `k-${id}`)
    .run();
  for (let ms = occStart; ms < occEnd; ms += 5 * MIN) {
    await env.DB.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) VALUES (?, ?, 'reservation', ?)").bind(staffId, ms / MIN, id).run();
  }
};

describe("reassign (same time)", () => {
  it("moves a confirmed appointment to another technician: blocks, version, team mail, audit", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    const res = await reassign(adminCookie, id, team.b);
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({ id, status: "confirmed", version: 3, assignedStaff: { id: team.b, name: "Una Tech" }, startAt: at(FRI, 10) });
    expect(await row(id)).toMatchObject({ status: "confirmed", assigned_staff_id: team.b, version: 3, updated_at: at(THU, 8) });
    expect(await blockCount(team.b, id)).toBe(8);
    expect(await blockCount(team.a, id)).toBe(0);
    expect(await allBlocks()).toBe(8);

    // Every notify staff member except the actor; never the customer by default.
    expect(await jobs("reassigned")).toBe(4);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned' AND to_email = 'admin@example.test'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned' AND to_email = 'pat@example.test'")).toBe(0);
    expect(await jobStatus(`reassigned:${id}:v3:${team.b}`)).toBe("sent");

    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.reassigned'").first<any>();
    expect(a).toMatchObject({ actor_kind: "staff", actor: String(team.admin), reservation_id: id, customer_id: pat.id });
    expect(JSON.parse(a.details)).toEqual({ from: team.a, to: team.b });

    const [m] = await mailsTo("tech-b@example.test", "%reassigned%");
    expect(m!.subject).toContain("reassigned to Una Tech");
    expect(m!.text).toContain("Ada Admin reassigned this appointment from Tim Tech to Una Tech.");
    expect(m!.text).toContain(TZ_LABEL);
    expect(m!.text).toContain((await row(id)).ref);
  });

  it("lets a technician reassign, and moves a pending request off the new technician", async () => {
    const pId = await confirmedWith(pat, at(FRI, 10), team.a);
    const sId = await submit(sam, at(FRI, 10));
    const sStaff = (await row(sId)).provisional_staff_id as number;
    expect([team.admin, team.b]).toContain(sStaff);

    const res = await reassign(techCookie, pId, sStaff);
    expect(res.status).toBe(200);
    expect((await row(pId)).assigned_staff_id).toBe(sStaff);
    const sNow = (await row(sId)).provisional_staff_id as number;
    expect(sNow).not.toBe(sStaff);
    expect(await blockCount(sNow, sId)).toBe(8);
    expect(await blockCount(sStaff, pId)).toBe(8);
    expect(await allBlocks()).toBe(16);
    // The technician acting is not notified; the admin is.
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned' AND to_email = 'tech-a@example.test'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned' AND to_email = 'admin@example.test'")).toBe(1);
  });

  it("refuses a busy or unscheduled target with tech_unavailable and options, and the current technician with same_tech", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    await seedConfirmed("c1", "R-TEST-0001", team.b, at(FRI, 10, 15));

    const busy = await reassign(adminCookie, id, team.b);
    expect([busy.status, busy.json.error]).toEqual([409, "tech_unavailable"]);
    expect(busy.json.details.options.find((o: any) => o.id === team.b)).toMatchObject({ assignable: false, reason: "busy", conflictRef: "R-TEST-0001" });

    const off = await reassign(adminCookie, id, team.c);
    expect([off.status, off.json.error]).toEqual([409, "tech_unavailable"]);
    expect(off.json.details.options.find((o: any) => o.id === team.c)).toMatchObject({ assignable: false, reason: "not_scheduled" });

    const same = await reassign(adminCookie, id, team.a);
    expect([same.status, same.json.error]).toEqual([409, "same_tech"]);

    expect(await row(id)).toMatchObject({ assigned_staff_id: team.a, version: 2 });
    expect(await jobs("reassigned")).toBe(0);
  });

  it("refuses a technician whose time off overlaps the stored range", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    // Only the stored buffer (10:30–10:40) overlaps.
    await env.DB.prepare("INSERT INTO staff_unavailability(staff_id, start_at, end_at) VALUES (?, ?, ?)").bind(team.b, at(FRI, 10, 35), at(FRI, 12)).run();
    const res = await reassign(adminCookie, id, team.b);
    expect([res.status, res.json.error]).toEqual([409, "tech_unavailable"]);
    expect(res.json.details.options.find((o: any) => o.id === team.b)).toMatchObject({ assignable: false, reason: "unavailable" });
  });

  it("refuses stale versions, pending requests, unknown ids and bad bodies", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    const stale = await reassign(adminCookie, id, team.b, 1);
    expect([stale.status, stale.json.error, stale.json.details.current.version]).toEqual([409, "stale", 2]);

    const pending = await submit(sam, at(FRI, 10, 30));
    const p = await reassign(adminCookie, pending, team.b, 1);
    expect([p.status, p.json.error, p.json.details.current.status]).toEqual([409, "stale", "pending"]);

    expect((await reassign(adminCookie, "nope", team.b)).status).toBe(404);
    expect((await api("POST", `/api/staff/reservations/${id}/reassign`, { cookie: adminCookie, body: { staffId: "x", version: 2 } })).status).toBe(400);
    expect(await row(id)).toMatchObject({ assigned_staff_id: team.a, version: 2 });
  });

  it("refuses once the appointment has ended", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    setNow(at(FRI, 10, 30));
    await expect(reassignReservation(env, ada(), id, team.b, 2)).rejects.toMatchObject({ status: 409, code: "too_late" });
  });

  it("tells the customer only when notifyCustomerOnReassign is on, without naming technicians", async () => {
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('notifyCustomerOnReassign', 'true')").run();
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    expect((await reassign(adminCookie, id, team.b)).status).toBe(200);
    expect(await jobStatus(`reassigned-customer:${id}:v3`)).toBe("sent");
    const [m] = await mailsTo("pat@example.test", "%Update%");
    expect(m!.text).toContain("Your appointment details are unchanged.");
    expect(m!.text).toContain(TZ_LABEL);
    expect(m!.text).toContain("http://localhost:5173/r#t=");
    for (const name of ["Tim Tech", "Una Tech", "Ada Admin"]) expect(m!.text).not.toContain(name);
  });

  it("a reassign mail is skipped when the technician changed again before sending", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    await reassignReservation(env, ada(), id, team.b, 2);
    await reassignReservation(env, ada(), id, team.a, 3);
    await processOutbox(env, 50);
    expect(await jobStatus(`reassigned:${id}:v3:${team.c}`)).toBe("skipped");
    expect(await jobStatus(`reassigned:${id}:v4:${team.c}`)).toBe("sent");
  });

  it("detail lists reassign candidates with the current technician flagged", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    const d = await detail(techCookie, id);
    expect(d.json.techOptions.map((o: any) => [o.id, o.assignable, o.reason, o.current ?? false])).toEqual([
      [team.admin, true, null, false],
      [team.a, true, null, true],
      [team.b, true, null, false],
      [team.c, false, "not_scheduled", false],
      [team.d, false, "not_scheduled", false],
    ]);
  });

  it("of two racing reassignments the later one is stale (forced deterministically)", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    const w = withBatchHook(async () => {
      await reassignReservation(env, una(), id, team.b, 2);
    });
    await expect(reassignReservation(w.env, ada(), id, team.admin, 2)).rejects.toMatchObject({
      status: 409,
      code: "stale",
      details: { current: { status: "confirmed", version: 3, assignedStaff: { id: team.b } } },
    });
    expect(w.calls.batches).toBe(1);
    expect(await row(id)).toMatchObject({ assigned_staff_id: team.b, version: 3 });
    expect(await blockCount(team.b, id)).toBe(8);
    expect(await allBlocks()).toBe(8);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reservation.reassigned'")).toBe(1);
  });
});

describe("staff cancellation", () => {
  it("cancels a pending request: blocks freed, provisional cleared, customer and team mailed, audited", async () => {
    const id = await submit(pat, at(FRI, 10));
    expect((await row(id)).provisional_staff_id).not.toBeNull();
    const res = await cancel(techCookie, id, "  Duplicate request  ", 1);
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({
      status: "cancelled",
      version: 2,
      provisionalStaffId: null,
      closedAt: at(THU, 8),
      closedBy: "Tim Tech",
      closeReason: "Duplicate request",
    });
    expect(await row(id)).toMatchObject({ status: "cancelled", closed_by_kind: "staff", closed_by: String(team.a), provisional_staff_id: null });
    expect(await allBlocks()).toBe(0);
    expect(await jobStatus(`cancelled:${id}`)).toBe("sent");
    // Team: every notify staff member except the technician who cancelled.
    expect(await teamCancelJobs(id)).toBe(4);
    expect(await jobStatus(`cancelled-team:${id}:${team.admin}`)).toBe("sent");
    expect(await jobStatus(`cancelled-team:${id}:${team.a}`)).toBeNull();
    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.cancelled'").first<any>();
    expect(a).toMatchObject({ actor_kind: "staff", actor: String(team.a), reservation_id: id, customer_id: pat.id });
    expect(JSON.parse(a.details)).toEqual({ reason: "Duplicate request", from: "pending" });

    // Capacity is back.
    const av = await api("GET", `/api/customer/availability?from=${FRI}&to=${FRI}`, { cookie: sam.cookie });
    expect(av.json.days[0].slots.find((s: any) => s.startAt === at(FRI, 10)).spots).toBe(3);
  });

  it("cancels a confirmed appointment and cancels its unsent reminder and confirmation mails", async () => {
    const id = await submit(pat, at(FRI, 10));
    const other = await submit(sam, at(FRI, 10, 30));
    // Approve without delivering mail, so the confirmation is still queued.
    await approveReservation(env, ada(), id, team.a, 1);
    const ins = (jobId: string, template: string, reservationId: string, status = "queued") =>
      env.DB.prepare(
        `INSERT INTO email_jobs(id, dedupe_key, template, to_email, reservation_id, payload, status, attempts, send_after, created_at)
         VALUES (?, ?, ?, 'pat@example.test', ?, '{}', ?, 0, ?, 0)`,
      )
        .bind(jobId, jobId, template, reservationId, status, at(FRI, 9))
        .run();
    await ins("rem-24", "appointment_reminder", id);
    await ins("rem-sent", "appointment_reminder", id, "sent");
    await ins("appr-rem", "approval_reminder", id);
    await ins("appr-esc", "approval_escalation", id);
    await ins("other-rem", "appointment_reminder", other);

    const r = await cancelReservation(env, { kind: "staff", staff: ada() }, id, { reason: "Technician ill", version: 2 });
    expect(r).toMatchObject({ status: "cancelled", version: 3, closedBy: "Ada Admin", closeReason: "Technician ill" });
    expect(await row(id)).toMatchObject({ status: "cancelled", assigned_staff_id: team.a });
    expect(await blockCount(team.a, id)).toBe(0);
    expect(await allBlocks()).toBe(8); // only sam's pending request

    for (const k of ["rem-24", "appr-rem", "appr-esc", `confirmed:${id}:v2`, `assigned:${id}:v2:${team.a}`]) expect(await jobStatus(k), k).toBe("cancelled");
    expect(await jobStatus("rem-sent")).toBe("sent");
    expect(await jobStatus("other-rem")).toBe("queued");
    expect(await jobStatus(`cancelled:${id}`)).toBe("queued");
    expect(await jobStatus(`cancelled-team:${id}:${team.a}`)).toBe("queued");
    expect(await jobStatus(`cancelled-team:${id}:${team.admin}`)).toBeNull();
  });

  it("customer and team mails carry the facts with time zone labels", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    const ref = (await row(id)).ref as string;
    expect((await cancel(adminCookie, id, "Technician ill", 2)).status).toBe(200);

    const [c] = await mailsTo("pat@example.test", "Cancelled%");
    expect(c!.subject).toContain(ref);
    expect(c!.subject).toContain(TZ_LABEL);
    for (const s of ["Cancelled", ref, TZ_LABEL, "cancelled by our team", "Reason: Technician ill", "Book another time: http://localhost:5173"]) expect(c!.text).toContain(s);
    for (const name of ["Tim Tech", "Ada Admin"]) expect(c!.text).not.toContain(name);

    const [tm] = await mailsTo("tech-a@example.test", "%cancelled%");
    for (const s of ["Ada Admin cancelled this reservation.", ref, "Pat Co", TZ_LABEL, "Technician ill", "Tim Tech"]) expect(tm!.text).toContain(s);
  });

  it("repeating a cancel returns the cancelled reservation unchanged and queues nothing", async () => {
    const id = await submit(pat, at(FRI, 10));
    expect((await cancel(adminCookie, id, "Duplicate", 1)).status).toBe(200);
    const jobsBefore = await count("SELECT COUNT(*) AS n FROM email_jobs");
    for (const version of [1, 2]) {
      const again = await cancel(techCookie, id, "Other reason", version);
      expect(again.status).toBe(200);
      expect(again.json.reservation).toMatchObject({ status: "cancelled", version: 2, closedBy: "Ada Admin", closeReason: "Duplicate" });
    }
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs")).toBe(jobsBefore);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reservation.cancelled'")).toBe(1);
  });

  it("rejects stale versions, closed reservations and bad reasons", async () => {
    const id = await submit(pat, at(FRI, 10));
    expect((await cancel(adminCookie, id, "x", 5)).json.error).toBe("stale");
    for (const reason of ["", "   ", "x".repeat(501)]) {
      const bad = await cancel(adminCookie, id, reason, 1);
      expect([bad.status, bad.json.error]).toEqual([400, "invalid"]);
    }
    await api("POST", `/api/staff/reservations/${id}/decline`, { cookie: adminCookie, body: { reason: "no", version: 1 } });
    const declined = await cancel(adminCookie, id, "x", 2);
    expect([declined.status, declined.json.error, declined.json.details.current.status]).toEqual([409, "stale", "declined"]);
    expect((await cancel(adminCookie, "nope", "x", 1)).status).toBe(404);
  });

  it("staff may cancel until the appointment ends", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    const id2 = await confirmedWith(sam, at(FRI, 10, 30), team.b);
    setNow(at(FRI, 10, 15));
    expect((await cancelReservation(env, { kind: "staff", staff: ada() }, id, { reason: "No answer", version: 2 })).status).toBe("cancelled");
    setNow(at(FRI, 11));
    await expect(cancelReservation(env, { kind: "staff", staff: ada() }, id2, { reason: "late", version: 2 })).rejects.toMatchObject({ status: 409, code: "too_late" });
  });

  it("withdraws the reservation's open proposal and frees its option holds", async () => {
    const id = await submit(pat, at(FRI, 10));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO proposals(id, reservation_id, status, created_at, expires_at) VALUES ('p-old', ?, 'expired', 0, 1)").bind(id),
      env.DB.prepare("INSERT INTO proposals(id, reservation_id, status, created_by, created_at, expires_at) VALUES ('p1', ?, 'open', ?, 0, ?)").bind(id, team.admin, at(FRI, 8)),
      env.DB.prepare("INSERT INTO proposal_options(id, proposal_id, start_at, end_at, occ_start, occ_end, staff_id) VALUES ('o1', 'p1', ?, ?, ?, ?, ?)").bind(
        at(FRI, 10, 30),
        at(FRI, 11),
        at(FRI, 10, 30),
        at(FRI, 11, 10),
        team.c,
      ),
    ]);
    for (let ms = at(FRI, 10, 30); ms < at(FRI, 11, 10); ms += 5 * MIN) {
      await env.DB.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) VALUES (?, ?, 'option', 'o1')").bind(team.c, ms / MIN).run();
    }
    expect((await cancel(adminCookie, id, "Customer called", 1)).status).toBe(200);
    expect(await env.DB.prepare("SELECT status, resolved_at FROM proposals WHERE id = 'p1'").first()).toEqual({ status: "withdrawn", resolved_at: at(THU, 8) });
    expect(await env.DB.prepare("SELECT status FROM proposals WHERE id = 'p-old'").first<string>("status")).toBe("expired");
    expect(await allBlocks()).toBe(0);
  });

  it("cancel vs approve: an approval landing first makes the cancel stale", async () => {
    const id = await submit(pat, at(FRI, 10));
    const w = withBatchHook(async () => {
      await approveReservation(env, tim(), id, team.a, 1);
    });
    await expect(cancelReservation(w.env, { kind: "staff", staff: ada() }, id, { reason: "x", version: 1 })).rejects.toMatchObject({
      status: 409,
      code: "stale",
      details: { current: { status: "confirmed", confirmedBy: { id: team.a } } },
    });
    expect(w.calls.batches).toBe(1);
    expect(await row(id)).toMatchObject({ status: "confirmed", version: 2 });
    expect(await blockCount(team.a, id)).toBe(8);
    expect(await jobs("cancelled")).toBe(0);
  });

  it("cancel vs approve: a cancel landing first makes the approval stale", async () => {
    const id = await submit(pat, at(FRI, 10));
    const w = withBatchHook(async () => {
      await cancelReservation(env, { kind: "staff", staff: una() }, id, { reason: "Customer called", version: 1 });
    });
    await expect(approveReservation(w.env, ada(), id, team.admin, 1)).rejects.toMatchObject({
      status: 409,
      code: "stale",
      details: { current: { status: "cancelled", closedBy: "Una Tech" } },
    });
    expect(w.calls.batches).toBe(1);
    expect(await row(id)).toMatchObject({ status: "cancelled", version: 2, assigned_staff_id: null });
    expect(await allBlocks()).toBe(0);
    expect(await jobs("confirmed")).toBe(0);
  });

  it("decline clears the provisional technician too", async () => {
    const id = await submit(pat, at(FRI, 10));
    expect((await row(id)).provisional_staff_id).not.toBeNull();
    expect((await api("POST", `/api/staff/reservations/${id}/decline`, { cookie: adminCookie, body: { reason: "no", version: 1 } })).status).toBe(200);
    expect((await row(id)).provisional_staff_id).toBeNull();
  });
});

describe("customer cancellation (core, used by the Plan 3 routes)", () => {
  const asPat = { kind: "customer", email: "pat@example.test" } as const;

  it("cancels a pending request any time before it starts, reason optional; the team is told who cancelled", async () => {
    const id = await submit(pat, at(FRI, 10));
    setNow(at(FRI, 9, 59));
    const r = await cancelReservation(env, asPat, id, { version: 1 });
    expect(r).toMatchObject({ status: "cancelled", closedBy: "pat@example.test", closeReason: null, provisionalStaffId: null });
    expect(await row(id)).toMatchObject({ closed_by_kind: "customer", closed_by: "pat@example.test" });
    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.cancelled'").first<any>();
    expect(a).toMatchObject({ actor_kind: "customer", actor: "pat@example.test", reservation_id: id });
    // No staff actor: all five notify staff members hear about it.
    expect(await teamCancelJobs(id)).toBe(5);
    expect(await jobStatus(`cancelled-team:${id}:${team.d}`)).toBe("queued");

    await processOutbox(env, 50);
    const [c] = await mailsTo("pat@example.test", "Cancelled%");
    expect(c!.text).toContain("cancelled as you requested");
    expect(c!.text).not.toContain("our team");
    const [tm] = await mailsTo("admin@example.test", "%cancelled%");
    expect(tm!.text).toContain("The customer (pat@example.test) cancelled this reservation.");
  });

  it("refuses a confirmed appointment inside the cancellation cutoff, and anything that has started", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    const pending = await submit(sam, at(FRI, 10, 30));
    setNow(at(FRI, 9)); // exactly 60 minutes before
    await expect(cancelReservation(env, asPat, id, { version: 2 })).rejects.toMatchObject({ status: 409, code: "past_cutoff" });
    setNow(at(FRI, 8, 59));
    expect((await cancelReservation(env, asPat, id, { reason: "Fixed it myself", version: 2 })).closeReason).toBe("Fixed it myself");

    setNow(at(FRI, 10, 30));
    await expect(cancelReservation(env, { kind: "customer", email: "sam@example.test" }, pending, { version: 1 })).rejects.toMatchObject({
      status: 409,
      code: "too_late",
    });
  });

  it("validates the optional reason length", async () => {
    const id = await submit(pat, at(FRI, 10));
    await expect(cancelReservation(env, asPat, id, { reason: "x".repeat(501), version: 1 })).rejects.toMatchObject({ status: 400, code: "invalid" });
    // Blank means no reason.
    expect((await cancelReservation(env, asPat, id, { reason: "   ", version: 1 })).closeReason).toBeNull();
  });
});

describe("access", () => {
  it("rejects customers and anonymous callers on reassign and cancel", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    for (const [path, body] of [
      [`/api/staff/reservations/${id}/reassign`, { staffId: team.b, version: 2 }],
      [`/api/staff/reservations/${id}/cancel`, { reason: "x", version: 2 }],
    ] as const) {
      expect((await api("POST", path, { cookie: pat.cookie, body })).status, path).toBe(401);
      expect((await api("POST", path, { body })).status, path).toBe(401);
    }
    expect(await row(id)).toMatchObject({ status: "confirmed", assigned_staff_id: team.a, version: 2 });
  });
});
