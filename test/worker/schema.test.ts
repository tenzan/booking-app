import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const insertWindow = (kind: string, weekday: number | null, date: string | null, start: number, end: number) =>
  env.DB.prepare("INSERT INTO availability_windows(kind, weekday, date, start_min, end_min) VALUES (?, ?, ?, ?, ?)")
    .bind(kind, weekday, date, start, end)
    .run();

describe("availability_windows constraints", () => {
  it("accepts well-formed weekly and date windows, including a window ending at midnight", async () => {
    await insertWindow("weekly", 1, null, 540, 720);
    await insertWindow("date", null, "2026-10-02", 0, 1440);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM availability_windows").first("n")).toBe(2);
  });

  it.each([
    ["start off the 5-minute grid", "weekly", 1, null, 541, 720],
    ["end off the 5-minute grid", "weekly", 1, null, 540, 722],
    ["negative start", "weekly", 1, null, -5, 60],
    ["end after midnight", "weekly", 1, null, 1380, 1445],
    ["empty range", "weekly", 1, null, 600, 600],
    ["weekly without weekday", "weekly", null, null, 540, 720],
    ["weekly with a date", "weekly", 1, "2026-10-02", 540, 720],
    ["date without date", "date", null, null, 540, 720],
    ["date with a weekday", "date", 1, "2026-10-02", 540, 720],
  ] as const)("rejects %s", async (_label, kind, weekday, date, start, end) => {
    await expect(insertWindow(kind, weekday, date, start, end)).rejects.toThrow(/CHECK constraint failed/);
  });
});

it("has the lookup indexes the outbox, sessions and token cleanup rely on", async () => {
  const { results } = await env.DB.prepare(
    "SELECT tbl_name AS t, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
  ).all<{ t: string; sql: string }>();
  const cols = (t: string) => results.filter((r) => r.t === t).map((r) => r.sql.replace(/^.*\((.*)\)$/s, "$1").replace(/\s+/g, ""));
  expect(cols("email_jobs")).toContain("reservation_id,status");
  expect(cols("sessions")).toContain("staff_id");
  expect(cols("auth_tokens")).toContain("expires_at");
  expect(cols("access_tokens")).toContain("expires_at");
  expect(cols("calendar_tokens")).toContain("expires_at");
});

it("finds a contact's recent bookings by email through an index (0006)", async () => {
  const index = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_res_contact_email_created'").first<{ sql: string }>();
  expect(index?.sql.replace(/\s+/g, " ")).toMatch(/ON reservations\(contact_email, created_at DESC\)/);
  // The query lastPhonesForEmail runs (repos/customers.ts) searches that index instead of scanning reservations.
  const { results } = await env.DB.prepare(
    "EXPLAIN QUERY PLAN SELECT customer_id AS customerId, phone FROM reservations WHERE contact_email = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
  )
    .bind("pat@example.test", 20)
    .all<{ detail: string }>();
  expect(results.map((r) => r.detail).join("\n")).toMatch(/SEARCH reservations USING INDEX idx_res_contact_email_created \(contact_email=\?\)/);
});
