import { it, expect } from "vitest";
import { approvalDeadlines } from "../../src/domain/deadlines";
import { newRef } from "../../src/domain/ref";
import { DEFAULT_SETTINGS as S } from "../../src/domain/settings";
import { wallToUtc } from "../../src/domain/time";

const tz = "Asia/Tokyo", bh = { tz, hours: S.businessHours, holidays: new Set<string>() };
const at = (d: string, h: number) => wallToUtc(d, h * 60, tz);

it("normal weekday request", () => {
  const r = approvalDeadlines(at("2026-10-01", 10), at("2026-10-05", 15), S, bh);
  expect(r.reminderAt).toBe(at("2026-10-01", 12));
  expect(r.escalationAt).toBe(at("2026-10-01", 14));
  expect(r.expiresAt).toBe(at("2026-10-01", 18));         // 10:00 + 8 BH = 18:00 same day (exactly at close)
});

it("near-start request expires one hour before start", () => {
  const r = approvalDeadlines(at("2026-10-01", 10), at("2026-10-01", 14), S, bh);
  expect(r.expiresAt).toBe(at("2026-10-01", 13));
  expect(r.escalationAt).toBe(at("2026-10-01", 12) + 30 * 60000); // clamped to expires − 30m
});

it("ref format", () => expect(newRef()).toMatch(/^R-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/));
