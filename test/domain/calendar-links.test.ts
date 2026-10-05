import { describe, expect, it } from "vitest";
import { calendarWebLinks, googleCalendarUrl, LINK_DESCRIPTION_MAX, outlookUrl } from "../../src/domain/calendar-links";

const event = {
  startAt: Date.parse("2026-10-05T01:30:00Z"),
  endAt: Date.parse("2026-10-05T02:00:00Z"),
  summary: "Remote support — Acme, Support & Co",
  description: "Reference: R-ABCD\nA technician will call you at +81 3-1234-5678.\n<Have AnyDesk ready>",
};

describe("googleCalendarUrl", () => {
  it("pre-fills a Google Calendar event with UTC dates, title and details", () => {
    const url = new URL(googleCalendarUrl(event));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("dates")).toBe("20261005T013000Z/20261005T020000Z");
    expect(url.searchParams.get("text")).toBe(event.summary);
    // Plain text: newlines kept, nothing HTML-escaped.
    expect(url.searchParams.get("details")).toBe(event.description);
  });

  it("encodes every value (no raw spaces, ampersands or newlines in the URL)", () => {
    const raw = googleCalendarUrl(event);
    expect(raw).not.toMatch(/[\s<>]/);
    expect(raw.split("&").filter((p) => p.startsWith("text=") || p.startsWith("details="))).toHaveLength(2);
  });
});

describe("outlookUrl", () => {
  for (const [kind, host] of [
    ["outlook", "outlook.live.com"],
    ["office365", "outlook.office.com"],
  ] as const) {
    it(`pre-fills an ${kind} compose form on ${host} with ISO UTC times`, () => {
      const url = new URL(outlookUrl(event, kind));
      expect(url.origin + url.pathname).toBe(`https://${host}/calendar/0/action/compose`);
      expect(url.searchParams.get("rru")).toBe("addevent");
      expect(url.searchParams.get("startdt")).toBe("2026-10-05T01:30:00Z");
      expect(url.searchParams.get("enddt")).toBe("2026-10-05T02:00:00Z");
      expect(url.searchParams.get("subject")).toBe(event.summary);
    });
  }

  it("sends the body as HTML: text escaped, line breaks as <br>", () => {
    const body = new URL(outlookUrl(event, "outlook")).searchParams.get("body");
    expect(body).toBe("Reference: R-ABCD<br>A technician will call you at +81 3-1234-5678.<br>&lt;Have AnyDesk ready&gt;");
  });
});

describe("calendarWebLinks", () => {
  it("builds the Google, Outlook.com and Microsoft 365 links together", () => {
    const links = calendarWebLinks(event);
    expect(links.google).toBe(googleCalendarUrl(event));
    expect(links.outlook).toBe(outlookUrl(event, "outlook"));
    expect(links.office365).toBe(outlookUrl(event, "office365"));
  });

  it("shortens a long description with an ellipsis so links stay a manageable length", () => {
    const long = { ...event, description: "x".repeat(LINK_DESCRIPTION_MAX + 500) };
    const details = new URL(calendarWebLinks(long).google).searchParams.get("details")!;
    expect(details).toHaveLength(LINK_DESCRIPTION_MAX);
    expect(details.endsWith("…")).toBe(true);
    const body = new URL(calendarWebLinks(long).outlook).searchParams.get("body")!;
    expect(body.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair when shortening", () => {
    const long = { ...event, description: "😀".repeat(LINK_DESCRIPTION_MAX) };
    const details = new URL(calendarWebLinks(long).google).searchParams.get("details")!;
    expect(details).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(details.endsWith("…")).toBe(true);
  });
});
