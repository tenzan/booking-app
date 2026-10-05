export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const BUTTON_STYLE =
  "display:inline-block;padding:14px 24px;border-radius:8px;font-size:16px;font-weight:600;background:#1d4ed8;color:#fff;text-decoration:none";
const SECONDARY_STYLE = "display:inline-block;padding:14px 8px;font-size:16px;color:#1d4ed8;text-decoration:underline";
const CALENDAR_LINK_STYLE =
  "display:inline-block;margin:0 6px 8px 0;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;color:#1d4ed8;text-decoration:none";
const BANNER_COLORS = {
  amber: "background:#fef3c7;color:#78350f",
  green: "background:#dcfce7;color:#14532d",
  red: "background:#fee2e2;color:#7f1d1d",
} as const;

export function primaryButton(label: string, url: string): string {
  return `<a href="${escapeHtml(url)}" style="${BUTTON_STYLE}">${escapeHtml(label)}</a>`;
}

export function secondaryLink(label: string, url: string): string {
  return `<a href="${escapeHtml(url)}" style="${SECONDARY_STYLE}">${escapeHtml(label)}</a>`;
}

export interface EmailSpec {
  orgName: string;
  /** Prominent status line, shown as a coloured block above the body. */
  banner?: { text: string; tone: keyof typeof BANNER_COLORS };
  paragraphs: string[];
  facts?: Array<[label: string, value: string]>;
  /** Third-party text shown as an escaped, preformatted block (never rendered as HTML). */
  quote?: string;
  actions?: Array<{ label: string; url: string; primary?: boolean }>;
  /** "Add to calendar": a row of small links after the actions. The text version lists each URL once. */
  calendar?: { heading: string; links: Array<{ label: string; url: string }> };
  /** Paragraphs shown after the actions. */
  after?: string[];
  footer: string;
}

/** Build both the HTML (table layout, 560px max, escaped values) and the plain-text alternative. */
export function renderEmail(spec: EmailSpec): { html: string; text: string } {
  const p = (s: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5">${escapeHtml(s)}</p>`;
  const rows: string[] = [];
  if (spec.banner) {
    rows.push(
      `<tr><td style="padding:16px 24px 0"><div style="${BANNER_COLORS[spec.banner.tone]};padding:12px 16px;border-radius:8px;font-size:16px;font-weight:600">${escapeHtml(spec.banner.text)}</div></td></tr>`,
    );
  }
  rows.push(`<tr><td style="padding:24px 24px 8px">${spec.paragraphs.map(p).join("")}</td></tr>`);
  if (spec.facts?.length) {
    const facts = spec.facts
      .map(
        ([l, v]) =>
          `<tr><td style="padding:6px 12px 6px 0;font-size:14px;color:#555;vertical-align:top;white-space:nowrap">${escapeHtml(l)}</td><td style="padding:6px 0;font-size:16px;vertical-align:top;white-space:pre-wrap">${escapeHtml(v)}</td></tr>`,
      )
      .join("");
    rows.push(`<tr><td style="padding:0 24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${facts}</table></td></tr>`);
  }
  if (spec.quote) {
    rows.push(
      `<tr><td style="padding:0 24px 16px"><div style="padding:12px 16px;background:#f3f4f6;border-left:3px solid #9ca3af;border-radius:4px;font-size:15px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${escapeHtml(spec.quote)}</div></td></tr>`,
    );
  }
  if (spec.actions?.length) {
    const actions = spec.actions
      .map((a) => `<div style="margin:0 0 12px">${a.primary ? primaryButton(a.label, a.url) : secondaryLink(a.label, a.url)}</div>`)
      .join("");
    rows.push(`<tr><td style="padding:8px 24px 16px">${actions}</td></tr>`);
  }
  if (spec.calendar) {
    const links = spec.calendar.links.map((l) => `<a href="${escapeHtml(l.url)}" style="${CALENDAR_LINK_STYLE}">${escapeHtml(l.label)}</a>`).join("");
    rows.push(
      `<tr><td style="padding:0 24px 16px"><p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#374151">${escapeHtml(spec.calendar.heading)}</p>${links}</td></tr>`,
    );
  }
  if (spec.after?.length) rows.push(`<tr><td style="padding:0 24px 8px">${spec.after.map(p).join("")}</td></tr>`);
  rows.push(
    `<tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.4;color:#666">${escapeHtml(spec.footer)}</td></tr>`,
  );

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:#f3f4f6;font-family:${FONT};color:#111">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:16px 8px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px">` +
    `<tr><td style="padding:20px 24px;border-bottom:1px solid #e5e7eb;font-size:18px;font-weight:700">${escapeHtml(spec.orgName)}</td></tr>` +
    rows.join("") +
    `</table></td></tr></table></body></html>`;

  const text = [
    spec.banner?.text,
    ...spec.paragraphs,
    spec.facts?.map(([l, v]) => `${l}: ${v}`).join("\n"),
    spec.quote,
    spec.actions?.map((a) => `${a.label}: ${a.url}`).join("\n"),
    spec.calendar && calendarText(spec.calendar),
    ...(spec.after ?? []),
    `--\n${spec.footer}`,
  ]
    .filter((s): s is string => !!s)
    .join("\n\n");
  return { html, text };
}

/** The calendar links as text: links sharing a URL (the .ics file) are listed once, their labels joined. */
function calendarText(c: NonNullable<EmailSpec["calendar"]>): string {
  const byUrl = new Map<string, string[]>();
  for (const l of c.links) byUrl.set(l.url, [...(byUrl.get(l.url) ?? []), l.label]);
  return [`${c.heading}:`, ...[...byUrl].map(([url, labels]) => `${labels.join(" / ")}: ${url}`)].join("\n");
}
