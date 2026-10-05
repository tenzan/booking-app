/** Which of the calendar's technician colours a staff member wears: pure, no UI. */

/** Colours in the palette (src/web/pages/staff/calendar/colors.ts holds their classes). */
export const TECH_COLOR_COUNT = 8;

/**
 * A technician's colour index: their place among the given staff ids in id order, so renaming or re-sorting never moves
 * a colour and a new colleague (a higher id) takes the next one. Someone not on the list still gets a valid colour.
 */
export function techColorIndex(staffIds: number[], id: number): number {
  const sorted = [...new Set(staffIds)].sort((a, b) => a - b);
  const at = sorted.indexOf(id);
  return (at === -1 ? id : at) % TECH_COLOR_COUNT;
}
