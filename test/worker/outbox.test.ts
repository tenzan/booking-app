import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../helpers";
import { setNow } from "../../src/worker/lib/clock";
import { sha256Hex } from "../../src/worker/lib/crypto";
import { enqueueEmail, processOutbox, type TemplateName } from "../../src/worker/mail/outbox";
import { mailerFor, type Mailer } from "../../src/worker/mail/adapters";
import { fmtDateTime, t, tzLabel } from "../../src/shared/i18n/i18n";

afterEach(() => setNow(null));

const T0 = Date.UTC(2026, 9, 1, 0, 0); // 2026-10-01 09:00 Asia/Tokyo
const START = Date.UTC(2026, 9, 2, 1, 0); // 2026-10-02 10:00 Asia/Tokyo

async function seedReservation(o: { status?: string; issue?: string; staff?: boolean } = {}) {
  const db = env.DB;
  await db.batch([
    db.prepare("INSERT INTO customers(id, customer_number, name, created_at, updated_at) VALUES (1, 'C-001', 'Acme Test Co', 0, 0)"),
    db.prepare("INSERT INTO staff(id, email, name, role, created_at, updated_at) VALUES (1, 'ada@example.test', 'Ada Approver', 'admin', 0, 0)"),
    db.prepare("INSERT INTO staff(id, email, name, role, created_at, updated_at) VALUES (2, 'tom@example.test', 'Tom Tech', 'technician', 0, 0)"),
    db.prepare(
      `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
         assigned_staff_id, confirmed_by, idempotency_key, created_at, updated_at, close_reason)
       VALUES ('res-1', 'RS-1001', 1, 'pat@example.test', 'Pat Contact', '+81-3-0000-0000', ?, ?, ?, ?, ?, ?, ?, ?, 'k1', 0, 0, 'No capacity')`,
    ).bind(o.issue ?? "Printer offline", START, START + 30 * 60_000, START, START + 30 * 60_000, o.status ?? "pending", o.staff ? 2 : null, o.staff ? 1 : null),
  ]);
}

async function enqueue(template: TemplateName, to: string, reservationId: string | null = "res-1", payload?: Record<string, unknown>) {
  await enqueueEmail(env.DB, { template, to, dedupeKey: `${template}:${reservationId}:${to}`, reservationId, payload }).run();
}

const mailbox = async () =>
  (await env.DB.prepare("SELECT * FROM dev_mailbox ORDER BY id").all<{ to_email: string; subject: string; html: string; text: string }>()).results;
const job = (id?: string) =>
  env.DB.prepare(`SELECT * FROM email_jobs ${id ? "WHERE id = ?" : ""}`).bind(...(id ? [id] : [])).first<any>();

describe("enqueueEmail", () => {
  it("is idempotent per dedupeKey", async () => {
    const j = { template: "customer_login" as const, to: "pat@example.test", dedupeKey: "login:1" };
    await enqueueEmail(env.DB, j).run();
    await enqueueEmail(env.DB, j).run();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM email_jobs").first<{ n: number }>())!.n).toBe(1);
  });
});

describe("send-time status re-check", () => {
  it("skips a job whose reservation was cancelled after it was claimed and rendered, without sending", async () => {
    await seedReservation({ status: "confirmed", staff: true });
    await enqueue("confirmed", "pat@example.test");
    // The reservation is cancelled while the job is being rendered (the render mints the access token).
    const real = env.DB;
    const racing = {
      prepare: (q: string) => {
        const stmt = real.prepare(q);
        if (!q.includes("INSERT INTO access_tokens")) return stmt;
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              const r = await stmt.bind(...args).run();
              await real.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = 'res-1'").run();
              return r;
            },
          }),
        };
      },
      batch: (stmts: D1PreparedStatement[]) => real.batch(stmts),
    } as unknown as D1Database;
    expect(await processOutbox({ ...env, DB: racing } as typeof env)).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(await mailbox()).toEqual([]);
    expect((await job()).status).toBe("skipped");
  });

  it("also skips when the cancellation lands while the calendar links are being made", async () => {
    await seedReservation({ status: "confirmed", staff: true });
    await enqueue("confirmed", "pat@example.test");
    const real = env.DB;
    const racing = {
      prepare: (q: string) => {
        const stmt = real.prepare(q);
        if (!q.includes("INSERT INTO access_tokens")) return stmt;
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              const r = await stmt.bind(...args).run();
              await real.prepare("UPDATE reservations SET status = 'cancelled', confirmed_at = 1 WHERE id = 'res-1'").run();
              return r;
            },
          }),
        };
      },
      batch: (stmts: D1PreparedStatement[]) => real.batch(stmts),
    } as unknown as D1Database;
    expect(await processOutbox({ ...env, DB: racing } as typeof env)).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(await mailbox()).toEqual([]);
    expect(await real.prepare("SELECT COUNT(*) AS n FROM calendar_tokens").first("n")).toBe(0);
  });

  it("still sends when the reservation stays valid", async () => {
    await seedReservation({ status: "confirmed", staff: true });
    await enqueue("confirmed", "pat@example.test");
    expect(await processOutbox(env)).toEqual({ sent: 1, failed: 0, skipped: 0 });
  });
});

describe("processOutbox", () => {
  it("renders a customer login in dev mode with a hashed single-use token", async () => {
    setNow(T0);
    await enqueue("customer_login", "pat@example.test", null, { redirectPath: "/book" });
    expect(await processOutbox(env)).toEqual({ sent: 1, failed: 0, skipped: 0 });
    const [m] = await mailbox();
    expect(m!.subject).toBe("Your link to book remote support");
    expect(m!.to_email).toBe("pat@example.test");
    const token = /http:\/\/localhost:5173\/auth\/verify#t=([A-Za-z0-9_-]+)/.exec(m!.text)?.[1];
    expect(token).toBeTruthy();
    const rows = (await env.DB.prepare("SELECT * FROM auth_tokens").all<any>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "customer",
      email: "pat@example.test",
      redirect_path: "/book",
      created_at: T0,
      expires_at: T0 + 15 * 60_000,
      used_at: null,
      token_hash: await sha256Hex(token!),
    });
    const j = await job();
    expect(j.status).toBe("sent");
    expect(j.sent_at).toBe(T0);
    expect(j.payload).not.toContain(token);
    expect(JSON.stringify(j)).not.toContain(token);
  });

  it("renders a staff login to the staff verify URL and drops unsafe redirect paths", async () => {
    await enqueue("staff_login", "ada@example.test", null, { redirectPath: "https://evil.example.com/" });
    await processOutbox(env);
    const [m] = await mailbox();
    expect(m!.subject).toBe("Sign in to Example Support scheduling");
    expect(m!.text).toContain("http://localhost:5173/staff/auth/verify#t=");
    const row = await env.DB.prepare("SELECT kind, redirect_path FROM auth_tokens").first<any>();
    expect(row).toEqual({ kind: "staff", redirect_path: null });
  });

  it("backs off on failure and gives up after 6 attempts, without leaking URLs in last_error", async () => {
    setNow(T0);
    await enqueue("customer_login", "pat@example.test", null);
    const failing: Mailer = {
      send: async () => {
        throw new Error("boom https://x.example.com/p?a=1 /auth/verify#t=SECRETTOKEN rest " + "x".repeat(600));
      },
    };
    expect(await processOutbox(env, 20, failing)).toEqual({ sent: 0, failed: 1, skipped: 0 });
    let j = await job();
    expect(j).toMatchObject({ status: "queued", attempts: 1, send_after: T0 + 60_000, locked_until: null });
    expect(j.last_error.length).toBeLessThanOrEqual(500);
    expect(j.last_error).not.toContain("SECRETTOKEN");
    expect(j.last_error).not.toContain("example.com");
    // not due yet
    expect(await processOutbox(env, 20, failing)).toEqual({ sent: 0, failed: 0, skipped: 0 });

    for (let attempt = 2; attempt <= 6; attempt++) {
      setNow(j.send_after);
      await processOutbox(env, 20, failing);
      j = await job();
      expect(j.attempts).toBe(attempt);
      expect(j.status).toBe(attempt < 6 ? "queued" : "failed");
    }
  });

  it("uses the documented backoff schedule", async () => {
    setNow(T0);
    await enqueue("customer_login", "pat@example.test", null);
    const failing: Mailer = { send: async () => { throw new Error("nope"); } };
    const gaps: number[] = [];
    let now = T0;
    for (let i = 0; i < 5; i++) {
      setNow(now);
      await processOutbox(env, 20, failing);
      const j = await job();
      gaps.push((j.send_after - now) / 60_000);
      now = j.send_after;
    }
    expect(gaps).toEqual([1, 5, 15, 60, 240]);
  });

  it("reclaims a stale 'sending' job but not a live lock", async () => {
    setNow(T0);
    await enqueue("customer_login", "pat@example.test", null);
    await env.DB.prepare("UPDATE email_jobs SET status='sending', locked_until=?").bind(T0 + 1000).run();
    expect(await processOutbox(env)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    setNow(T0 + 2000);
    expect(await processOutbox(env)).toEqual({ sent: 1, failed: 0, skipped: 0 });
  });

  it("skips a template whose reservation precondition no longer holds", async () => {
    await seedReservation({ status: "pending" });
    await enqueue("confirmed", "pat@example.test");
    expect(await processOutbox(env)).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect((await job()).status).toBe("skipped");
    expect(await mailbox()).toHaveLength(0);
  });

  it("skips cancelled and reassigned notices whose state no longer holds", async () => {
    await seedReservation({ status: "confirmed", staff: true });
    await enqueue("cancelled", "pat@example.test", "res-1", { audience: "customer" });
    await enqueue("reassigned", "ada@example.test", "res-1", { audience: "team", from: 1, to: 1, by: 1 });
    expect(await processOutbox(env)).toEqual({ sent: 0, failed: 0, skipped: 2 });
  });

  it("skips a reservation template whose reservation is missing", async () => {
    await enqueue("request_received", "pat@example.test", "gone");
    expect(await processOutbox(env)).toEqual({ sent: 0, failed: 0, skipped: 1 });
  });

  it("escapes HTML in user-supplied text", async () => {
    await seedReservation({ issue: "<script>alert(1)</script> & more" });
    await enqueue("new_request", "ada@example.test");
    await processOutbox(env);
    const [m] = await mailbox();
    expect(m!.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(m!.html).not.toContain("<script>");
  });

  it("new_request shows the facts and the staff action links", async () => {
    await seedReservation();
    await enqueue("new_request", "ada@example.test");
    await processOutbox(env);
    const [m] = await mailbox();
    expect(m!.subject).toBe("New remote support request RS-1001 — Fri, Oct 2, 2026, 10:00 Asia/Tokyo (GMT+9)");
    for (const s of ["Acme Test Co", "C-001", "Pat Contact", "pat@example.test", "+81-3-0000-0000", "Printer offline", "Asia/Tokyo (GMT+9)", "RS-1001", "Pending approval — not yet confirmed"]) {
      expect(m!.text).toContain(s);
    }
    const base = "http://localhost:5173/staff/r/res-1";
    for (const u of [base, `${base}?action=approve&assign=me`, `${base}?action=approve`, `${base}?action=propose`]) {
      expect(m!.text.split("\n").some((l) => l.endsWith(`: ${u}`))).toBe(true);
    }
    expect(m!.html).toContain("padding:14px 24px");
    expect(m!.html).toContain("max-width:560px");
  });

  it("request_received mints an access token with a view link and a cancel link for the same token", async () => {
    await seedReservation();
    await enqueue("request_received", "pat@example.test");
    await processOutbox(env);
    const [m] = await mailbox();
    expect(m!.subject).toBe("Request received — not yet confirmed (RS-1001)");
    const token = /\/r#t=([A-Za-z0-9_-]+)\n/.exec(m!.text)?.[1];
    expect(token).toBeTruthy();
    expect(m!.text).toContain(`Cancel reservation: http://localhost:5173/r#t=${token}&action=cancel`);
    expect(m!.html).toContain(`/r#t=${token}&amp;action=cancel`);
    const row = await env.DB.prepare("SELECT * FROM access_tokens").first<any>();
    expect(row).toMatchObject({
      reservation_id: "res-1",
      token_hash: await sha256Hex(token!),
      expires_at: START + 30 * 60_000 + 14 * 86_400_000,
    });
  });

  it("confirmed tells the customer who will call and which tool to prepare", async () => {
    await seedReservation({ status: "confirmed", staff: true });
    await enqueue("confirmed", "pat@example.test");
    await processOutbox(env);
    const [m] = await mailbox();
    expect(m!.subject).toBe("Confirmed: remote support on Fri, Oct 2, 2026, 10:00 Asia/Tokyo (GMT+9) (RS-1001)");
    expect(m!.text).toContain("A technician will telephone you at +81-3-0000-0000 at the appointment time. Please have your computer turned on and TeamViewer ready.");
    expect(m!.text).toMatch(/Cancel reservation: http:\/\/localhost:5173\/r#t=[A-Za-z0-9_-]+&action=cancel/);
  });

  it("assigned names the approver and the technician", async () => {
    await seedReservation({ status: "confirmed", staff: true });
    await enqueue("assigned", "ada@example.test");
    await processOutbox(env);
    const [m] = await mailbox();
    expect(m!.subject).toBe("RS-1001 confirmed — assigned to Tom Tech");
    expect(m!.text).toContain("Ada Approver approved this request and assigned Tom Tech.");
  });

  it("declined includes the reason", async () => {
    await seedReservation({ status: "declined" });
    await enqueue("declined", "pat@example.test");
    await processOutbox(env);
    const [m] = await mailbox();
    expect(m!.subject).toBe("We couldn't confirm your request (RS-1001)");
    expect(m!.text).toContain("Reason: No capacity");
  });

  it("an unknown template fails (retry path) rather than skipping", async () => {
    await env.DB.prepare(
      "INSERT INTO email_jobs(id, dedupe_key, template, to_email, status, send_after, created_at) VALUES ('j', 'k', 'bogus', 'a@example.test', 'queued', 0, 0)",
    ).run();
    expect(await processOutbox(env)).toEqual({ sent: 0, failed: 1, skipped: 0 });
  });
});

describe("dev mailbox route", () => {
  it("lists messages in dev mode and 404s otherwise", async () => {
    await enqueue("customer_login", "pat@example.test", null);
    await processOutbox(env);
    const ok = await api("GET", "/api/dev/mail");
    expect(ok.status).toBe(200);
    expect(ok.json.messages).toHaveLength(1);
    expect(ok.json.messages[0]).toMatchObject({ to: "pat@example.test", subject: "Your link to book remote support" });

    const { default: worker } = await import("../../src/worker/index");
    const res = await worker.fetch!(new Request("http://localhost:5173/api/dev/mail") as any, { ...env, MAIL_MODE: "cloudflare" } as any, { waitUntil() {}, passThroughOnException() {} } as any);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it.each(["https://booking.example.com", "http://192.0.2.10:5173", "http://localhost.example.com"])(
    "404s in dev mode when the app is not served from localhost (%s)",
    async (base) => {
      const { default: worker } = await import("../../src/worker/index");
      const res = await worker.fetch!(new Request(`${base}/api/dev/mail`) as any, { ...env, MAIL_MODE: "dev", APP_BASE_URL: base } as any, { waitUntil() {}, passThroughOnException() {} } as any);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    },
  );

  it.each(["http://127.0.0.1:5173", "http://[::1]:5173"])("serves the mailbox on %s too", async (base) => {
    const { default: worker } = await import("../../src/worker/index");
    const res = await worker.fetch!(new Request(`${base}/api/dev/mail`) as any, { ...env, APP_BASE_URL: base } as any, { waitUntil() {}, passThroughOnException() {} } as any);
    expect(res.status).toBe(200);
  });
});

describe("mailerFor", () => {
  it("refuses dev mail outside localhost instead of silently filling the dev mailbox", async () => {
    expect(() => mailerFor({ ...env, MAIL_MODE: "dev", APP_BASE_URL: "https://booking.example.com" })).toThrow(/MAIL_MODE=dev/);
    await enqueue("customer_login", "pat@example.test", null);
    await expect(processOutbox({ ...env, MAIL_MODE: "dev", APP_BASE_URL: "https://booking.example.com" })).rejects.toThrow(/MAIL_MODE=dev/);
    expect(await mailbox()).toHaveLength(0);
  });

  it("the cron handler logs that configuration error (sanitized) instead of leaving it unhandled", async () => {
    const { default: worker } = await import("../../src/worker/index");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const waits: Promise<unknown>[] = [];
    try {
      await worker.scheduled!({} as any, { ...env, MAIL_MODE: "dev", APP_BASE_URL: "https://booking.example.com" } as any, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as any);
      await Promise.all(waits);
      expect(errors).toHaveBeenCalledWith("outbox", expect.stringContaining("MAIL_MODE=dev"));
      expect(String(errors.mock.calls[0]![1])).not.toContain("https://");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("i18n", () => {
  it("interpolates, resolves dot paths and falls back to the key", () => {
    expect(t("email.assigned.intro", { approver: "A", tech: "B" })).toBe("A approved this request and assigned B.");
    expect(t("email.nope.nothing")).toBe("email.nope.nothing");
    expect(t("email")).toBe("email");
    expect(t("email.assigned.subject", { ref: "R" })).toBe("R confirmed — assigned to {tech}");
  });
  it("every email template has a label for the Emails page and Activity (the record must name each template)", () => {
    const all: Record<TemplateName, true> = {
      customer_login: true,
      staff_login: true,
      request_received: true,
      new_request: true,
      confirmed: true,
      assigned: true,
      declined: true,
      cancelled: true,
      reassigned: true,
      expired: true,
      approval_reminder: true,
      approval_escalation: true,
      appointment_reminder: true,
      proposal: true,
      proposal_outcome: true,
      rescheduled: true,
      reply_relay: true,
    };
    const missing = Object.keys(all).filter((name) => t(`web.staff.emails.templates.${name}`) === `web.staff.emails.templates.${name}`);
    expect(missing).toEqual([]);
    expect(t("web.staff.emails.templates.reply_relay")).toBe("Customer reply (relayed)");
  });
  it("formats date-times and zone labels in the target zone", () => {
    expect(fmtDateTime(Date.UTC(2026, 9, 1, 1, 0), "Asia/Tokyo", "en-US")).toBe("Thu, Oct 1, 2026, 10:00");
    expect(tzLabel("Asia/Tokyo", Date.UTC(2026, 9, 1), "en-US")).toBe("Asia/Tokyo (GMT+9)");
  });
});
