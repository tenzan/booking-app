import { describe, expect, it } from "vitest";
import { TECH_COLOR_COUNT, techColorIndex } from "../../src/domain/tech-colors";

describe("techColorIndex", () => {
  it("gives each technician a colour by their place in staff-id order, so names and sorting don't move colours", () => {
    const ids = [7, 3, 12];
    expect(techColorIndex(ids, 3)).toBe(0);
    expect(techColorIndex(ids, 7)).toBe(1);
    expect(techColorIndex(ids, 12)).toBe(2);
  });

  it("keeps existing colours when someone joins later (a higher id)", () => {
    const before = [3, 7, 12].map((id) => techColorIndex([3, 7, 12], id));
    const after = [3, 7, 12].map((id) => techColorIndex([3, 7, 12, 20], id));
    expect(after).toEqual(before);
  });

  it("cycles through the palette for large teams, and never returns an index outside it", () => {
    const ids = Array.from({ length: TECH_COLOR_COUNT + 3 }, (_, i) => i + 1);
    expect(techColorIndex(ids, TECH_COLOR_COUNT + 1)).toBe(0);
    for (const id of ids) expect(techColorIndex(ids, id)).toBeLessThan(TECH_COLOR_COUNT);
  });

  it("gives someone not on the list (a deactivated technician) a colour that is still valid", () => {
    const i = techColorIndex([1, 2], 99);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(TECH_COLOR_COUNT);
  });
});
