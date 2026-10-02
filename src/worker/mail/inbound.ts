import PostalMime from "postal-mime";
import type { Env } from "../env";
import { clock } from "../lib/clock";
import { sha256Hex } from "../lib/crypto";
import { rateLimit } from "../lib/rate-limit";
import { notifyStaff } from "../repos/staff";
import { enqueueEmail, kickOutbox, safeError } from "./outbox";

const MAX_RAW_BYTES = 1_048_576;
const MAX_SUBJECT = 200;
const MAX_EXCERPT = 4000;
/** Text examined before normalising: bounded work however large the message is. */
const MAX_TEXT_SCAN = 4 * MAX_EXCERPT;
const MAX_HTML_SCAN = 100_000;
const SENDER_LIMIT = 20;
const GLOBAL_LIMIT = 200;
const WINDOW_MS = 3_600_000;
/** Same alphabet as src/domain/ref.ts (no 0/1/I/L/O). */
const REF_RE = /(?<![A-Z0-9-])R-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}(?![A-Z0-9-])/i;
const ADDRESS_RE = /^(?=[\u0021-\u007e]+$)[^<>,;"()[\]\\@\s]+@[^<>,;"()[\]\\@\s]+$/;
const AUTOMATED_LOCALS = new Set(["mailer-daemon", "postmaster", "no-reply", "noreply", "no_reply", "do-not-reply", "donotreply", "bounce", "bounces"]);
/** C0 controls other than tab and newline, DEL/C1, zero-width and bidi controls, BOM. */
const HIDDEN_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
/** Local part without a +tag, lowercased. */
const localOf = (address: string): string => address.slice(0, address.lastIndexOf("@")).toLowerCase().split("+")[0]!;

/** `s.slice(0, n)` that never ends in half a surrogate pair. */
function sliceSafe(s: string, n: number): string {
  const cut = s.slice(0, n);
  return /[\ud800-\udbff]$/.test(cut) && s.length > n ? cut.slice(0, -1) : cut;
}

function cleanAddress(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const a = v.trim().replace(/^<|>$/g, "").toLowerCase();
  return a.length <= 254 && ADDRESS_RE.test(a) ? a : null;
}

/** One line of printable text: control characters (line breaks included) become spaces. */
function oneLine(v: unknown, max: number): string {
  return typeof v === "string" ? sliceSafe(v.slice(0, max * 4).replace(/[\n\t]/g, " ").replace(HIDDEN_CHARS, " ").trim(), max) : "";
}

/** The raw message, or null when it exceeds `max` bytes (whatever its declared size). */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Loops, bounces, bulk mail and automatic replies: never relayed, never answered. */
function isAutomated(h: Headers): boolean {
  const auto = h.get("auto-submitted")?.trim().toLowerCase();
  if (auto !== undefined && auto !== "no") return true;
  if (/\b(bulk|list|junk|auto_reply)\b/i.test(h.get("precedence") ?? "")) return true;
  if (/^\s*multipart\/report\b/i.test(h.get("content-type") ?? "")) return true;
  return ["x-autoreply", "x-autorespond", "x-auto-response-suppress", "x-failed-recipients", "list-id"].some((k) => h.has(k));
}

const isAutomatedSender = (address: string, ownDomain: string): boolean =>
  AUTOMATED_LOCALS.has(localOf(address)) || domainOf(address) === ownDomain;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const BLOCK_TAGS = new Set(["p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table", "pre"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "title"]);
const TAG_NAME = /<(\/?)([a-z][a-z0-9]*)/iy;

/**
 * Visible text of an HTML body: nothing from it is ever rendered as HTML, it is only read as text. A single linear pass
 * over at most 100k characters (every search resumes where the last one ended), so adversarial markup cannot make it slow:
 * an unclosed comment or script/style/title element ends the text at its opener.
 */
export function htmlToText(input: string): string {
  const html = input.slice(0, MAX_HTML_SCAN);
  let out = "";
  let i = 0;
  let nextGt = -1; // cached position of the next ">" at or after the scan point (-2: there is none)
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    i = lt + 1;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (nextGt !== -2 && nextGt < lt) nextGt = html.indexOf(">", lt);
    if (nextGt < 0) {
      nextGt = -2;
      out += "<" + html.slice(i); // no ">" anywhere after: the rest is text
      break;
    }
    TAG_NAME.lastIndex = lt;
    const m = TAG_NAME.exec(html);
    const isDecl = html[lt + 1] === "!";
    if (!m && !isDecl) {
      out += "<";
      continue;
    }
    // A "<" before the ">" means this one is not a tag after all.
    const inner = html.indexOf("<", lt + 1);
    if (inner >= 0 && inner < nextGt) {
      out += "<";
      continue;
    }
    i = nextGt + 1;
    if (!m) continue;
    const name = m[2]!.toLowerCase();
    if (m[1] === "") {
      if (name === "br") out += "\n";
      else if (RAW_TEXT_TAGS.has(name)) {
        const close = new RegExp(`</${name}[\\s>]`, "gi");
        close.lastIndex = i;
        const found = close.exec(html);
        if (!found) break;
        const end = html.indexOf(">", found.index);
        if (end < 0) break;
        i = end + 1;
      }
    } else if (BLOCK_TAGS.has(name)) out += "\n";
  }
  return out.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const cp = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

/** The first 4000 characters of a text, tidied: hidden characters gone, trailing spaces trimmed, blank-line runs collapsed. */
export function excerptOf(text: string): string {
  const lines = sliceSafe(text, MAX_TEXT_SCAN)
    .replace(/\r\n?/g, "\n")
    .replace(HIDDEN_CHARS, "")
    .split("\n");
  const kept: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    const l = line.trimEnd();
    blanks = l === "" ? blanks + 1 : 0;
    if (blanks <= 2) kept.push(l);
  }
  const t = kept.join("\n").trim();
  return t.length <= MAX_EXCERPT ? t : `${sliceSafe(t, MAX_EXCERPT - 1)}…`;
}

async function findReservation(db: D1Database, ref: string | null): Promise<string | null> {
  if (!ref) return null;
  const r = await db.prepare("SELECT id FROM reservations WHERE ref = ?").bind(ref).first<{ id: string }>();
  return r?.id ?? null;
}

/** The header block (up to the first blank line) of a raw message, as text. */
function headerBlock(raw: Uint8Array): string {
  let end = raw.length;
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i] === 10 && (raw[i + 1] === 10 || (raw[i + 1] === 13 && raw[i + 2] === 10))) {
      end = i;
      break;
    }
  }
  return new TextDecoder().decode(raw.subarray(0, end));
}

/**
 * Cloudflare Email Routing delivers mail for the app hostname here. A customer's reply is relayed to every staff member
 * who receives request notifications (Reply-To the customer); it is never answered and its attachments are never forwarded.
 * Automatic mail is dropped silently; mail for another domain or over 1 MB is rejected at the SMTP level.
 */
export async function handleInbound(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  const own = (cleanAddress(env.MAIL_FROM) ?? env.MAIL_FROM).toLowerCase();
  const ownDomain = domainOf(own);
  if (!(message.to ?? "").includes("@") || domainOf(message.to) !== ownDomain) {
    message.setReject("Unknown recipient");
    return;
  }
  if (message.rawSize > MAX_RAW_BYTES) {
    message.setReject("Message too large");
    return;
  }

  const envelopeFrom = cleanAddress(message.from);
  if (!envelopeFrom || isAutomatedSender(envelopeFrom, ownDomain) || isAutomated(message.headers)) return;
  if (!(await rateLimit(env.DB, `inbound:sender:${envelopeFrom}`, SENDER_LIMIT, WINDOW_MS))) {
    console.warn("inbound mail rate limited", domainOf(envelopeFrom));
    return;
  }
  if (!(await rateLimit(env.DB, "inbound:all", GLOBAL_LIMIT, WINDOW_MS))) {
    console.warn("inbound mail over the global hourly limit of", GLOBAL_LIMIT);
    return;
  }

  const raw = await readCapped(message.raw, MAX_RAW_BYTES);
  if (!raw) {
    message.setReject("Message too large");
    return;
  }
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    parsed = await PostalMime.parse(raw);
  } catch (e) {
    console.warn("inbound mail unreadable", safeError(e));
    return;
  }

  // The reply goes to the From header (what a mail client would answer); the envelope sender is the fallback.
  const fromAddress = cleanAddress(parsed.from?.address) ?? envelopeFrom;
  if (isAutomatedSender(fromAddress, ownDomain)) return;
  // A display name that is itself an address is a spoofing aid.
  const rawName = oneLine(parsed.from?.name, 100);
  const fromName = rawName.includes("@") ? "" : rawName;

  const subject = oneLine(parsed.subject, MAX_SUBJECT);
  const text = parsed.text?.trim() ? parsed.text : parsed.html ? htmlToText(parsed.html) : "";
  const textExcerpt = excerptOf(text);
  const ref = (REF_RE.exec(subject) ?? REF_RE.exec(textExcerpt))?.[0].toUpperCase() ?? null;
  const reservationId = await findReservation(env.DB, ref);

  const staff = await notifyStaff(env.DB);
  if (staff.length === 0) {
    console.warn("inbound mail not relayed: no staff receive notifications");
    return;
  }

  // Bounded key: hashed with the envelope sender, from the Message-ID or (without one) the header block.
  const id = parsed.messageId?.trim() || headerBlock(raw);
  const key = await sha256Hex(`${envelopeFrom}\n${id}`);
  const payload = {
    from: { address: fromAddress, name: fromName },
    ...(domainOf(envelopeFrom) !== domainOf(fromAddress) ? { envelopeFrom } : {}),
    subject,
    textExcerpt,
    attachmentsCount: parsed.attachments.length,
    receivedAt: clock.now(),
    ...(ref ? { ref } : {}),
    ...(reservationId ? { reservationId } : {}),
  };
  const details = { from: fromAddress, fromDomain: domainOf(fromAddress), ...(ref ? { ref } : {}) };
  await env.DB.batch([
    // First, so it sees the queue as it was: a redelivery (the first job already exists) is not audited twice.
    env.DB
      .prepare(
        `INSERT INTO audit_log(at, actor_kind, actor, action, reservation_id, customer_id, details)
         SELECT ?, 'system', NULL, 'email.inbound_relayed', ?, NULL, ?
         WHERE NOT EXISTS (SELECT 1 FROM email_jobs WHERE dedupe_key = ?)`,
      )
      .bind(clock.now(), reservationId, JSON.stringify(details), `reply:${key}:${staff[0]!.id}`),
    ...staff.map((s) =>
      enqueueEmail(env.DB, { template: "reply_relay", to: s.email, dedupeKey: `reply:${key}:${s.id}`, reservationId, payload }),
    ),
  ]);
  kickOutbox({ env, executionCtx: ctx });
}
