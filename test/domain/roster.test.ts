import { describe, it, expect } from "vitest";
import { rosterImpact, type RosterHold, type RosterInput } from "../../src/domain/roster";
import type { SlotInput, WindowDef } from "../../src/domain/slots";
import { wallToUtc } from "../../src/domain/time";

const tz = "Asia/Tokyo";
const MIN = 60_000;
const cfg = { tz, durationMin: 30, stepMin: 30, bufferBeforeMin: 0, bufferAfterMin: 10 };
const D = "2026-10-01"; // Thursday
const at = (minute: number) => wallToUtc(D, minute, tz);
const win = (o: Partial<WindowDef> = {}): WindowDef => ({ id: 1, kind: "weekly", weekday: 4, date: null, startMin: 600, endMin: 720, staffIds: [1, 2], ...o });
const proposed = (o: Partial<SlotInput> = {}): SlotInput => ({
  fromDate: D, toDate: D, windows: [win()], overrideDates: new Set(), holidays: new Set(), unavailability: [],
  bookableStaff: new Set([1, 2, 3]), cfg, ...o,
});
const hold = (id: string, minute: number, o: Partial<RosterHold> = {}): RosterHold => ({
  id, kind: "reservation", status: "confirmed", ref: `ref-${id}`, slotStart: at(minute), occStart: at(minute), occEnd: at(minute) + 40 * MIN, staffId: 1, ...o,
});
const pending = (id: string, minute: number, staffId: number | null = 1, o: Partial<RosterHold> = {}) => hold(id, minute, { status: "pending", staffId, ...o });
const alt = (staffId: number, displaces: string[] = []) => ({ staffId, displaces });
const run = (holds: RosterHold[], slotInput: SlotInput = proposed(), budget?: number) => rosterImpact({ holds, slotInput } satisfies RosterInput, budget);

describe("rosterImpact", () => {
  it("no-op change → nothing moved, nothing in conflict", () => {
    const r = run([hold("c", 600, { staffId: 2 }), pending("p", 600, 1)]);
    expect(r.moved).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.assignment.get("c")).toBe(2);
    expect(r.assignment.get("p")).toBe(1);
  });

  it("confirmed hold whose technician left the window → tech_removed, alternatives = free technicians", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const r = run([hold("c", 600, { staffId: 2 })], input);
    expect(r.conflicts).toEqual([
      { id: "c", kind: "reservation", status: "confirmed", ref: "ref-c", slotStart: at(600), staffId: 2, reason: "tech_removed", alternatives: [alt(1)] },
    ]);
    expect(r.assignment.has("c")).toBe(false);
  });

  it("alternatives are empty when the remaining technician is busy", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const r = run([hold("c", 600, { staffId: 2 }), hold("busy", 610, { staffId: 1 })], input);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ id: "c", reason: "tech_removed", alternatives: [] });
    expect(r.assignment.get("busy")).toBe(1);
  });

  it("confirmed holds outrank pendings: the alternative is offered and names the pending it would displace", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const r = run([hold("c", 600, { staffId: 2 }), pending("p", 600, 1)], input);
    expect(r.conflicts.map((c) => c.id)).toEqual(["c"]);
    expect(r.conflicts[0]).toMatchObject({ id: "c", reason: "tech_removed", alternatives: [alt(1, ["p"])] });
    expect(r.assignment.get("p")).toBe(1);
  });

  it("an alternative that only needs an accepted pending to move displaces nothing", () => {
    // window [1,2,3 minus]: c's tech 3 leaves; p on 1 can move to 2, so c may take 1 without displacing p
    const input = proposed({ windows: [win({ staffIds: [1, 2] })] });
    const r = run([hold("c", 600, { staffId: 3 }), pending("p", 600, 1)], input);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ id: "c", alternatives: [alt(1), alt(2)] });
    expect(r.assignment.get("p")).toBe(1);
  });

  it("alternatives are per-conflict options, each checked against valid fixed holds only", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const r = run([hold("c1", 600, { staffId: 2 }), hold("c2", 600, { staffId: 3 })], input);
    expect(r.conflicts.map((c) => [c.id, c.alternatives])).toEqual([["c1", [alt(1)]], ["c2", [alt(1)]]]);
  });

  it("technician on leave or no longer bookable is tech_removed", () => {
    const leave = proposed({ unavailability: [{ staffId: 2, startAt: at(600), endAt: at(660) }] });
    expect(run([hold("c", 600, { staffId: 2 })], leave).conflicts[0]).toMatchObject({ reason: "tech_removed", alternatives: [alt(1)] });
    const inactive = proposed({ bookableStaff: new Set([1]) });
    expect(run([hold("c", 600, { staffId: 2 })], inactive).conflicts[0]).toMatchObject({ reason: "tech_removed", alternatives: [alt(1)] });
  });

  it("leave is judged against the hold's own stored occupied range, not current settings", () => {
    // stored range is 10:00–11:30 (long appointment); leave starts 11:10, after the slot's 40-min range would end
    const longHold = hold("c", 600, { staffId: 2, occEnd: at(690) });
    const leave = proposed({ unavailability: [{ staffId: 2, startAt: at(670), endAt: at(700) }] });
    expect(run([longHold], leave).conflicts[0]).toMatchObject({ reason: "tech_removed" });
    expect(run([hold("c", 600, { staffId: 2 })], leave).conflicts).toEqual([]);
  });

  it("removing the whole window → slot_removed with no alternatives", () => {
    const r = run([hold("c", 600, { staffId: 2 })], proposed({ windows: [] }));
    expect(r.conflicts[0]).toMatchObject({ id: "c", reason: "slot_removed", alternatives: [] });
  });

  it("a holiday closes the day → slot_removed", () => {
    const r = run([hold("c", 600)], proposed({ holidays: new Set([D]) }));
    expect(r.conflicts[0]).toMatchObject({ reason: "slot_removed" });
  });

  it("a hold still inside a window stays valid even if the duration no longer fits", () => {
    const input = proposed({ windows: [win({ startMin: 600, endMin: 620 })] });
    expect(run([hold("c", 600, { staffId: 2 })], input).conflicts).toEqual([]);
  });

  it("pending on a removed technician moves to a free one", () => {
    const input = proposed({ windows: [win({ staffIds: [2] })] });
    const r = run([pending("p", 600, 1)], input);
    expect(r.moved).toEqual([{ id: "p", ref: "ref-p", from: 1, to: 2 }]);
    expect(r.conflicts).toEqual([]);
    expect(r.assignment.get("p")).toBe(2);
  });

  it("pending with no provisional technician reports from=null", () => {
    const r = run([pending("p", 600, null)]);
    expect(r.moved).toEqual([{ id: "p", ref: "ref-p", from: null, to: 1 }]);
  });

  it("pending prefers to stay put", () => {
    const r = run([pending("p", 600, 2)]);
    expect(r.moved).toEqual([]);
    expect(r.assignment.get("p")).toBe(2);
  });

  it("pending whose slot disappeared → slot_removed; with all techs on leave → no_capacity", () => {
    const gone = run([pending("p", 600)], proposed({ windows: [] }));
    expect(gone.conflicts[0]).toMatchObject({ id: "p", status: "pending", reason: "slot_removed", alternatives: [] });
    const leave = proposed({ unavailability: [1, 2].map((staffId) => ({ staffId, startAt: at(590), endAt: at(700) })) });
    const none = run([pending("p", 600)], leave);
    expect(none.conflicts[0]).toMatchObject({ id: "p", reason: "no_capacity", alternatives: [] });
  });

  it("two pendings, one technician left → first (slotStart, id) is kept, the other no_capacity", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const r = run([pending("b", 600, 2), pending("a", 600, 1)], input);
    expect(r.assignment.get("a")).toBe(1);
    expect(r.conflicts.map((c) => [c.id, c.reason])).toEqual([["b", "no_capacity"]]);
    expect(r.moved).toEqual([]);
  });

  it("earlier slot wins over later id", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const r = run([pending("a", 610, 1), pending("z", 600, 2)], input);
    expect(r.assignment.get("z")).toBe(1);
    expect(r.conflicts.map((c) => c.id)).toEqual(["a"]);
  });

  it("option hold is fixed like a confirmed one", () => {
    const input = proposed({ windows: [win({ staffIds: [2] })] });
    const r = run([hold("o", 600, { kind: "option", status: "option", staffId: 1 })], input);
    expect(r.conflicts[0]).toMatchObject({ id: "o", kind: "option", status: "option", reason: "tech_removed", alternatives: [alt(2)] });
    // a valid option blocks its technician for pendings
    const ok = run([hold("o", 600, { kind: "option", status: "option", staffId: 2 }), pending("p", 600, 2)]);
    expect(ok.assignment.get("p")).toBe(1);
    expect(ok.moved).toEqual([{ id: "p", ref: "ref-p", from: 2, to: 1 }]);
  });

  it("valid fixed holds are never moved to make room for pendings", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const r = run([hold("c", 600, { staffId: 1 }), pending("p", 600, 1)], input);
    expect(r.assignment.get("c")).toBe(1);
    expect(r.conflicts.map((c) => [c.id, c.reason])).toEqual([["p", "no_capacity"]]);
  });

  it("is deterministic and independent of input order; output sorted by (slotStart, id)", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const holds = [pending("d", 630, 2), pending("c", 600, 2), hold("b", 600, { staffId: 2 }), hold("a", 630, { staffId: 3 }), pending("e", 600, 1)];
    const one = run(holds, input);
    const two = run([...holds].reverse(), input);
    expect(two.moved).toEqual(one.moved);
    expect(two.conflicts).toEqual(one.conflicts);
    expect(new Map([...two.assignment].sort())).toEqual(new Map([...one.assignment].sort()));
    const keys = one.conflicts.map((c) => [c.slotStart, c.id] as const);
    expect(keys).toEqual([...keys].sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : 1)));
    expect(one.conflicts.map((c) => c.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("budget exhaustion on a pending → too_complex", () => {
    const r = run([pending("p", 600, 1)], proposed(), 0);
    expect(r.conflicts[0]).toMatchObject({ id: "p", reason: "too_complex" });
  });

  it("a window whose technicians are all unbookable is tech_removed, not slot_removed", () => {
    const input = proposed({ windows: [win({ staffIds: [2] })], bookableStaff: new Set([1]) });
    const r = run([hold("c", 600, { staffId: 2 }), pending("p", 600, 2)], input);
    expect(r.conflicts.map((c) => [c.id, c.reason, c.alternatives])).toEqual([["c", "tech_removed", []], ["p", "no_capacity", []]]);
  });

  it("a pending moves to make room for a later pending that has fewer options", () => {
    // n (10:30) can only use 1 because 2 is on leave from 10:50; p (10:00) is eligible for both and sits on 1
    const input = proposed({ unavailability: [{ staffId: 2, startAt: at(650), endAt: at(700) }] });
    const r = run([pending("p", 600, 1), pending("n", 630, 1)], input);
    expect(r.conflicts).toEqual([]);
    expect(r.assignment.get("n")).toBe(1);
    expect(r.moved).toEqual([{ id: "p", ref: "ref-p", from: 1, to: 2 }]);
  });

  it("a pending bridging two otherwise separate groups is solved together with both", () => {
    const holds = [hold("f1", 600, { staffId: 1 }), hold("f2", 680, { staffId: 2 }), pending("p", 630, 1), pending("q", 660, 2)];
    const r = run(holds);
    expect(r.conflicts).toEqual([]);
    expect(r.assignment.get("p")).toBe(2); // overlaps f1 on 1
    expect(r.assignment.get("q")).toBe(1); // overlaps f2 on 2 and p on 2
    expect(r.moved).toEqual([{ id: "p", ref: "ref-p", from: 1, to: 2 }, { id: "q", ref: "ref-q", from: 2, to: 1 }]);
  });

  it("is maximal, not maximum: an earlier pending is never displaced by later ones", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const long = pending("a", 600, 1, { occEnd: at(700) }); // blocks b and c, which fit together
    const r = run([long, pending("b", 610, 1), pending("c", 660, 1)], input);
    expect(r.assignment.has("a")).toBe(true);
    expect(r.conflicts.map((c) => [c.id, c.reason])).toEqual([["b", "no_capacity"], ["c", "no_capacity"]]);
  });

  it("same-start tie-break: a pending whose technician is untouched is kept over one that was moved onto it", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const r = run([pending("a", 600, 2), pending("b", 600, 1)], input);
    expect(r.assignment.get("b")).toBe(1);
    expect(r.conflicts.map((c) => c.id)).toEqual(["a"]);
    expect(r.moved).toEqual([]);
  });

  it("same-start tie-break: older createdAt wins before id", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const r = run([pending("a", 600, 1, { createdAt: 2 }), pending("b", 600, 1, { createdAt: 1 })], input);
    expect(r.assignment.get("b")).toBe(1);
    expect(r.conflicts.map((c) => c.id)).toEqual(["a"]);
  });

  it("displaces lists only accepted pendings that would lose their place, in (slotStart, id) order", () => {
    const input = proposed({ windows: [win({ staffIds: [1] })] });
    const r = run([hold("c", 600, { staffId: 2 }), pending("p2", 620, 1), pending("p1", 600, 1)], input);
    // c takes 1 → p1 (10:00) displaced; p2 (10:20) was rejected anyway (overlaps p1 on the only technician)
    expect(r.conflicts.find((c) => c.id === "c")!.alternatives).toEqual([alt(1, ["p1"])]);
  });
});
