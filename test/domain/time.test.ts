import { it, expect } from "vitest";
import { wallToUtc, utcToWall, addDays, eachDate } from "../../src/domain/time";
it("Tokyo wall time", () => expect(new Date(wallToUtc("2026-10-01", 600, "Asia/Tokyo")).toISOString()).toBe("2026-10-01T01:00:00.000Z"));
it("DST zone", () => expect(new Date(wallToUtc("2026-07-01", 600, "America/New_York")).toISOString()).toBe("2026-07-01T14:00:00.000Z"));
it("roundtrip", () => expect(utcToWall(Date.parse("2026-10-04T01:30:00Z"), "Asia/Tokyo")).toEqual({ date: "2026-10-04", minute: 630, weekday: 0 }));
it("dates", () => { expect(addDays("2026-12-31", 1)).toBe("2027-01-01"); expect(eachDate("2026-10-01", "2026-10-03")).toEqual(["2026-10-01","2026-10-02","2026-10-03"]); });
