import { describe, expect, it } from "vitest";
import { buildIcs, foldLine, escapeText, formatUtc } from "../../src/domain/ics";

const base = {
  uid: "R-ABCD-EFGH@booking.example.com",
  sequence: 3,
  method: "PUBLISH" as const,
  status: "CONFIRMED" as const,
  startAt: Date.parse("2026-10-05T01:30:00Z"),
  endAt: Date.parse("2026-10-05T02:00:00Z"),
  stamp: Date.parse("2026-10-02T08:09:10.789Z"),
  summary: "Remote support",
  description: "Line one",
  url: "https://booking.example.com/r",
};
const lines = (ics: string) => ics.split("\r\n");
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

describe("formatUtc", () => {
  it("formats YYYYMMDDTHHMMSSZ in UTC without milliseconds", () => {
    expect(formatUtc(Date.parse("2026-10-05T01:30:00Z"))).toBe("20261005T013000Z");
    expect(formatUtc(Date.parse("2026-12-31T23:59:59.999Z"))).toBe("20261231T235959Z");
  });
});

describe("escapeText", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf\rg")).toBe("a\\\\b\\;c\\,d\\ne\\nf\\ng");
  });
  it("drops other control characters", () => {
    expect(escapeText("a\u0000b\u0007c\u007Fd\te")).toBe("abcd\te");
  });
});

describe("foldLine", () => {
  it("leaves lines up to 75 octets alone", () => {
    const l = "X".repeat(75);
    expect(foldLine(l)).toBe(l);
  });
  it("folds at 75 octets with a single-space continuation", () => {
    const folded = foldLine("X".repeat(200)).split("\r\n");
    expect(folded.map((l) => l.length)).toEqual([75, 75, 52]);
    expect(folded.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(folded.join("").replace(/ /g, "")).toBe("X".repeat(200));
  });
  it("counts octets, never splits a multi-byte character, and unfolds losslessly", () => {
    const text = "日本語のサポート予約🙂".repeat(12) + "é";
    const folded = foldLine(`SUMMARY:${text}`).split("\r\n");
    const enc = new TextEncoder();
    for (const l of folded) expect(enc.encode(l).length).toBeLessThanOrEqual(75);
    expect(folded.length).toBeGreaterThan(2);
    // Each physical line decodes strictly (no split sequences) and the logical line is intact.
    const strict = new TextDecoder("utf-8", { fatal: true });
    for (const l of folded) expect(() => strict.decode(enc.encode(l))).not.toThrow();
    expect(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(`SUMMARY:${text}`);
  });
  it("fills lines as full as the character boundaries allow", () => {
    // 3-byte characters: first line holds 8 + 22*3 = 74 octets (a 23rd would be 77).
    const folded = foldLine(`SUMMARY:${"日".repeat(40)}`).split("\r\n");
    expect(new TextEncoder().encode(folded[0]!).length).toBe(74);
    expect(new TextEncoder().encode(folded[1]!).length).toBe(1 + 18 * 3);
  });
});

describe("buildIcs", () => {
  const ics = buildIcs(base);

  it("is CRLF-terminated with no bare LF", () => {
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("has the calendar and event envelope", () => {
    const l = lines(ics);
    expect(l.slice(0, 5)).toEqual(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Remote Support Booking//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"]);
    expect(l.slice(-3)).toEqual(["END:VEVENT", "END:VCALENDAR", ""]);
    expect(l).toContain("BEGIN:VEVENT");
  });

  it("writes uid, sequence, status, UTC times and DTSTAMP", () => {
    const l = lines(ics);
    expect(l).toContain("UID:R-ABCD-EFGH@booking.example.com");
    expect(l).toContain("SEQUENCE:3");
    expect(l).toContain("STATUS:CONFIRMED");
    expect(l).toContain("DTSTART:20261005T013000Z");
    expect(l).toContain("DTEND:20261005T020000Z");
    expect(l).toContain("DTSTAMP:20261002T080910Z");
    expect(l).toContain("URL:https://booking.example.com/r");
    expect(l).toContain("SUMMARY:Remote support");
  });

  it("carries CANCELLED and the version as sequence", () => {
    const l = lines(buildIcs({ ...base, status: "CANCELLED", sequence: 7 }));
    expect(l).toContain("STATUS:CANCELLED");
    expect(l).toContain("SEQUENCE:7");
  });

  it("does not include an alarm", () => {
    expect(ics).not.toContain("VALARM");
  });

  it("escapes text values and folds long lines", () => {
    const out = buildIcs({ ...base, summary: "A, B; C\\D", description: `ref\nphone, +81;${"é".repeat(100)}`, location: "Room 1, Floor 2" });
    const l = lines(unfold(out));
    expect(l).toContain("SUMMARY:A\\, B\\; C\\\\D");
    expect(l.find((x) => x.startsWith("DESCRIPTION:"))).toBe(`DESCRIPTION:ref\\nphone\\, +81\\;${"é".repeat(100)}`);
    expect(l).toContain("LOCATION:Room 1\\, Floor 2");
    const enc = new TextEncoder();
    for (const phys of lines(out)) expect(enc.encode(phys).length).toBeLessThanOrEqual(75);
  });

  it("omits LOCATION when none is given", () => {
    expect(ics).not.toContain("LOCATION");
  });

  it("cannot be injected into through text values", () => {
    const out = buildIcs({ ...base, description: "x\r\nEND:VEVENT\r\nBEGIN:VEVENT" });
    expect(lines(out).filter((x) => x === "END:VEVENT")).toHaveLength(1);
  });
});
