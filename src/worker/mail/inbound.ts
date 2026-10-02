import PostalMime from "postal-mime";
import type { Env } from "../env";
import { clock } from "../lib/clock";
import { sha256Hex } from "../lib/crypto";
import { audit } from "../lib/db";
import { rateLimit } from "../lib/rate-limit";
import { notifyStaff } from "../repos/staff";
import { enqueueEmail, kickOutbox, safeError } from "./outbox";

const MAX_RAW_BYTES = 1_048_576;
const MAX_SUBJECT = 200;
const MAX_EXCERPT = 4000;
const SENDER_LIMIT = 20;
const SENDER_WINDOW_MS = 3_600_000;
/** Same alphabet as src/domain/ref.ts (no 0/1/I/L/O). */
const REF_RE = /(?<![A-Z0-9-])R-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}(?![A-Z0-9-])/i;
const ADDRESS_RE = /^[^\s<>,;"()[\]\\@]+@[^\s<>,;"()[\]\\@]+$/;
const AUTOMATED_LOCALS = new Set(["mailer-daemon", "postmaster", "no-reply", "noreply"]);

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
const localOf = (address: string): string => address.slice(0, address.lastIndexOf("@")).toLowerCase();

function cleanAddress(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const a = v.trim().replace(/^<|>$/g, "").toLowerCase();
  return a.length <= 254 && ADDRESS_RE.test(a) ? a : null;
}

/** One line of printable text: control characters (line breaks included) become spaces. */
function oneLine(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]+/g, " ").trim().slice(0, max) : "";
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
  return h.has("x-autoreply") || h.has("x-autorespond") || h.has("list-id");
}

const isAutomatedSender = (address: string, ownAddress: string): boolean =>
  AUTOMATED_LOCALS.has(localOf(address)) || address === ownAddress;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Visible text of an HTML body: nothing from it is ever rendered as HTML, it is only read as text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\s*br\b[^>]*>|<\/\s*(p|div|tr|li|h[1-6]|blockquote|table|pre)\s*>/gi, "\n")
    .replace(/<\/?[a-z!][^>]*>/gi, "")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const cp = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    });
}

function excerptOf(text: string): string {
  const t = text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length <= MAX_EXCERPT) return t;
  let cut = t.slice(0, MAX_EXCERPT - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

async function findReservation(db: D1Database, ref: string | null): Promise<string | null> {
  if (!ref) return null;
  const r = await db.prepare("SELECT id FROM reservations WHERE ref = ?").bind(ref).first<{ id: string }>();
  return r?.id ?? null;
}

/**
 * Cloudflare Email Routing delivers mail for the app hostname here. A customer's reply is relayed to every staff member
 * who receives request notifications (Reply-To the customer); it is never answered and its attachments are never forwarded.
 * Automatic mail is dropped silently; mail for another domain or over 1 MB is rejected at the SMTP level.
 */
export async function handleInbound(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  const own = (cleanAddress(env.MAIL_FROM) ?? env.MAIL_FROM).toLowerCase();
  if (domainOf(message.to ?? "") !== domainOf(own) || !(message.to ?? "").includes("@")) {
    message.setReject("Unknown recipient");
    return;
  }
  if (message.rawSize > MAX_RAW_BYTES) {
    message.setReject("Message too large");
    return;
  }

  const envelopeFrom = cleanAddress(message.from);
  if (!envelopeFrom || isAutomatedSender(envelopeFrom, own) || isAutomated(message.headers)) return;
  if (!(await rateLimit(env.DB, `inbound:sender:${envelopeFrom}`, SENDER_LIMIT, SENDER_WINDOW_MS))) {
    console.warn("inbound mail rate limited", domainOf(envelopeFrom));
    return;
  }

  const raw = await readCapped(message.raw, MAX_RAW_BYTES);
  if (!raw) {
    message.setReject("Message too large");
    return;
  }
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    parsed = await PostalMime.parse(raw, { attachmentEncoding: "base64" });
  } catch (e) {
    console.warn("inbound mail unreadable", safeError(e));
    return;
  }

  // The reply goes to the From header (what a mail client would answer); the envelope sender is the fallback.
  const fromAddress = cleanAddress(parsed.from?.address) ?? envelopeFrom;
  if (isAutomatedSender(fromAddress, own)) return;
  const fromName = oneLine(parsed.from?.name, 100);

  const subject = oneLine(parsed.subject, MAX_SUBJECT);
  const text = parsed.text?.trim() ? parsed.text : parsed.html ? htmlToText(parsed.html) : "";
  const textExcerpt = excerptOf(text);
  const ref = (REF_RE.exec(subject) ?? REF_RE.exec(text))?.[0].toUpperCase() ?? null;
  const reservationId = await findReservation(env.DB, ref);

  const staff = await notifyStaff(env.DB);
  if (staff.length === 0) {
    console.warn("inbound mail not relayed: no staff receive notifications");
    return;
  }

  const head = new TextDecoder().decode(raw).split(/\r?\n\r?\n/, 1)[0]!;
  const key = parsed.messageId?.trim() || (await sha256Hex(head));
  const payload = {
    from: { address: fromAddress, name: fromName },
    subject,
    textExcerpt,
    attachmentsCount: parsed.attachments.length,
    receivedAt: clock.now(),
    ...(ref ? { ref } : {}),
    ...(reservationId ? { reservationId } : {}),
  };
  await env.DB.batch([
    ...staff.map((s) =>
      enqueueEmail(env.DB, { template: "reply_relay", to: s.email, dedupeKey: `reply:${key}:${s.id}`, reservationId, payload }),
    ),
    audit(env.DB, {
      actorKind: "system",
      actor: null,
      action: "email.inbound_relayed",
      reservationId,
      details: { from: fromAddress, fromDomain: domainOf(fromAddress), ...(ref ? { ref } : {}) },
    }),
  ]);
  kickOutbox({ env, executionCtx: ctx });
}
