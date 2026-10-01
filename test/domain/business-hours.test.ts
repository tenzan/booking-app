import { describe, it, expect } from "vitest";
import { addBusinessMinutes } from "../../src/domain/business-hours";
import { wallToUtc } from "../../src/domain/time";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";
const tz = "Asia/Tokyo";
const ctx = { tz, hours: DEFAULT_SETTINGS.businessHours, holidays: new Set<string>(["2026-10-12"]) };
const at = (d: string, hh: number, mm = 0) => wallToUtc(d, hh * 60 + mm, tz);
describe("addBusinessMinutes", () => {
  it("within the same day", () => expect(addBusinessMinutes(at("2026-10-01", 10), 120, ctx)).toBe(at("2026-10-01", 12)));
  it("rolls overnight", () => expect(addBusinessMinutes(at("2026-10-01", 17), 120, ctx)).toBe(at("2026-10-02", 10)));
  it("starts before opening", () => expect(addBusinessMinutes(at("2026-10-01", 6), 60, ctx)).toBe(at("2026-10-01", 10)));
  it("skips weekend (Fri 17:00 + 3h → Mon 11:00)", () => expect(addBusinessMinutes(at("2026-10-02", 17), 180, ctx)).toBe(at("2026-10-05", 11)));
  it("skips holiday (Fri 18:00 + 60 → Tue 10:00 when Mon is holiday)", () => expect(addBusinessMinutes(at("2026-10-09", 18), 60, ctx)).toBe(at("2026-10-13", 10)));
  it("zero minutes returns input", () => expect(addBusinessMinutes(at("2026-10-03", 3), 0, ctx)).toBe(at("2026-10-03", 3)));
});
