import { it, expect } from "vitest";
import { generateSlots, blockMinutes, occupiedRange } from "../../src/domain/slots";
import type { WindowDef } from "../../src/domain/slots";
import { wallToUtc } from "../../src/domain/time";
const tz = "Asia/Tokyo";
const cfg = { tz, durationMin: 30, stepMin: 30, bufferBeforeMin: 0, bufferAfterMin: 10 };
const base = { holidays: new Set<string>(), overrideDates: new Set<string>(), unavailability: [], bookableStaff: new Set([1, 2, 3, 4]), cfg };
const w = (o: Partial<WindowDef>): WindowDef => ({ id: 1, kind: "weekly", weekday: 4, date: null, startMin: 600, endMin: 660, staffIds: [1, 2], ...o });
it("weekly window yields two 30-min slots on Thursday 2026-10-01", () => {
  const s = generateSlots({ ...base, fromDate: "2026-10-01", toDate: "2026-10-01", windows: [w({})] });
  expect(s.map((x) => x.startAt)).toEqual([wallToUtc("2026-10-01", 600, tz), wallToUtc("2026-10-01", 630, tz)]);
  expect(s[0]!.staffIds).toEqual([1, 2]);
});
it("override replaces weekly; holiday closes", () => {
  const ov = generateSlots({ ...base, fromDate: "2026-10-01", toDate: "2026-10-01", overrideDates: new Set(["2026-10-01"]), windows: [w({}), w({ id: 2, kind: "date", weekday: null, date: "2026-10-01", startMin: 840, endMin: 870, staffIds: [3] })] });
  expect(ov).toHaveLength(1); expect(ov[0]!.staffIds).toEqual([3]);
  expect(generateSlots({ ...base, fromDate: "2026-10-01", toDate: "2026-10-01", holidays: new Set(["2026-10-01"]), windows: [w({})] })).toHaveLength(0);
});
it("unavailability removes staff incl. buffer; merges windows", () => {
  const start = wallToUtc("2026-10-01", 630, tz);
  const s = generateSlots({ ...base, fromDate: "2026-10-01", toDate: "2026-10-01", windows: [w({}), w({ id: 3, staffIds: [3] })],
    unavailability: [{ staffId: 2, startAt: start + 35 * 60000, endAt: start + 60 * 60000 }] });
  expect(s[0]!.staffIds).toEqual([1, 2, 3]);
  expect(s[1]!.staffIds).toEqual([1, 3]); // 10:30 slot occupies until 11:10 → overlaps 11:05
});
it("blocks cover duration + buffers on 5-min grid", () => {
  const st = Date.parse("2026-10-01T01:00:00Z");
  expect(occupiedRange(st, st + 30 * 60000, cfg)).toEqual([st, st + 40 * 60000]);
  expect(blockMinutes(st, st + 30 * 60000, cfg)).toHaveLength(8);
});
