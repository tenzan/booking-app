import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { setNow } from "../../src/worker/lib/clock";
import { htmlToText, excerptOf } from "../../src/worker/mail/inbound";
import { mailerFor } from "../../src/worker/mail/adapters";
import { processOutbox } from "../../src/worker/mail/outbox";
import { seedStaff } from "../fixtures";

const T0 = Date.UTC(2026, 9, 2, 3, 0); // 2026-10-02 12:00 Asia/Tokyo
const REF = "R-ABCD-2345";

beforeEach(() => setNow(T0));
afterEach(() => setNow(null));

interface Delivery {
  from?: string;
  to?: string;
  rawSize?: number;
}

/** A fake ForwardableEmailMessage over an RFC 822 string, run through the worker's email() export. */
async function deliver(raw: string, o: Delivery = {}) {
  const normalized = raw.replace(/\r?\n/g, "\r\n");
  const bytes = new TextEncoder().encode(normalized);
  const headers = new Headers();
  const head = normalized.split("\r\n\r\n")[0]!.replace(/\r\n[ \t]+/g, " ");
  for (const line of head.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const spies = { setReject: vi.fn(), forward: vi.fn(), reply: vi.fn() };
  const message = {
    from: o.from === undefined ? "pat@example.test" : o.from,
    to: o.to ?? "no-reply@example.com",
    headers,
    raw: new Response(bytes).body!,
    rawSize: o.rawSize ?? bytes.byteLength,
    ...spies,
  };
  const ctx = createExecutionContext();
  await worker.email!(message as any, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return spies;
}

let n = 0;
function mail(o: { subject?: string; body?: string; headers?: string[]; from?: string; contentType?: string; id?: string | null } = {}): string {
  const id = o.id === undefined ? `<m${++n}@mail.example.test>` : o.id;
  return [
    `From: ${o.from ?? "Pat Contact <pat@example.test>"}`,
    "To: no-reply@example.com",
    `Subject: ${o.subject ?? "Question about my booking"}`,
    ...(id ? [`Message-ID: ${id}`] : []),
    "Date: Fri, 02 Oct 2026 03:00:00 +0000",
    "MIME-Version: 1.0",
    `Content-Type: ${o.contentType ?? "text/plain; charset=utf-8"}`,
    ...(o.headers ?? []),
    "",
    o.body ?? "Hello, can we move the appointment?",
    "",
  ].join("\n");
}

const jobs = async () =>
  (await env.DB.prepare("SELECT * FROM email_jobs WHERE template = 'reply_relay' ORDER BY id").all<any>()).results;
const mailbox = async () => (await env.DB.prepare("SELECT * FROM dev_mailbox ORDER BY id").all<any>()).results;

async function seedTeam() {
  const a = await seedStaff("ada@example.test", "admin");
  const b = await seedStaff("tom@example.test", "technician");
  await seedStaff("quiet@example.test", "technician"); // notify off
  await env.DB.prepare("UPDATE staff SET notify = 0 WHERE email = 'quiet@example.test'").run();
  await seedStaff("gone@example.test", "technician", false);
  return { a, b };
}

async function seedReservation(ref = REF) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO customers(id, customer_number, name, created_at, updated_at) VALUES (1, 'C-001', 'Acme Test Co', 0, 0)"),
    env.DB.prepare(
      `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status, idempotency_key, created_at, updated_at)
       VALUES ('res-1', ?, 1, 'pat@example.test', 'Pat Contact', '000', 'x', ?, ?, ?, ?, 'pending', 'k1', 0, 0)`,
    ).bind(ref, T0 + 86_400_000, T0 + 86_400_000 + 1_800_000, T0 + 86_400_000, T0 + 86_400_000 + 1_800_000),
  ]);
}

describe("inbound relay", () => {
  it("relays a plain-text reply to every active notify staff member, with Reply-To the customer, and never answers the sender", async () => {
    const { a, b } = await seedTeam();
    const spies = await deliver(mail({ subject: "Re: Your booking", body: "Hello, can we move the appointment?" }));
    expect(spies.setReject).not.toHaveBeenCalled();
    expect(spies.forward).not.toHaveBeenCalled();
    expect(spies.reply).not.toHaveBeenCalled();

    const rows = await jobs();
    expect(rows.map((r) => r.to_email).sort()).toEqual(["ada@example.test", "tom@example.test"]);
    expect(rows[0].dedupe_key).toMatch(/^reply:[0-9a-f]{64}:\d+$/);
    expect(rows.map((r) => r.dedupe_key.split(":").pop()).sort()).toEqual([String(a), String(b)].sort());
    const payload = JSON.parse(rows[0].payload);
    expect(payload).toMatchObject({
      from: { address: "pat@example.test", name: "Pat Contact" },
      subject: "Re: Your booking",
      textExcerpt: "Hello, can we move the appointment?",
      attachmentsCount: 0,
      receivedAt: T0,
    });
    expect(payload.ref).toBeUndefined();

    await processOutbox(env, 50);
    const sent = await mailbox();
    expect(sent).toHaveLength(2);
    expect(sent[0].subject).toBe("Customer reply: Re: Your booking");
    expect(sent[0].reply_to).toBe("pat@example.test");
    expect(sent[0].text).toContain("From: pat@example.test (Pat Contact)");
    expect(sent[0].text).toContain("Message received at no-reply@example.com. The sender address is not verified.");
    expect(sent[0].text).toContain("> Hello, can we move the appointment?");
    expect(sent[0].text).toContain("Hello, can we move the appointment?");
    expect(sent[0].text).toContain("Asia/Tokyo (GMT+9)");
    expect(sent[0].text).not.toContain("not forwarded");
    expect(sent[0].text).not.toContain("View reservation");
  });

  it("uses (no subject) when the reply has none", async () => {
    await seedTeam();
    await deliver(mail({ subject: "" }));
    await processOutbox(env, 50);
    expect((await mailbox())[0].subject).toBe("Customer reply: (no subject)");
  });

  it("converts an HTML-only reply to text: no tags, scripts or styles, entities decoded", async () => {
    await seedTeam();
    await deliver(
      mail({
        contentType: "text/html; charset=utf-8",
        body: '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>Hi&nbsp;there &amp; <b>thanks</b></p><div>Second<br>line</div><a href="http://evil.example.test">link</a></body></html>',
      }),
    );
    const payload = JSON.parse((await jobs())[0].payload);
    expect(payload.textExcerpt).toBe("Hi there & thanks\nSecond\nline\nlink");
    await processOutbox(env, 50);
    const sent = (await mailbox())[0];
    expect(sent.html).not.toContain("evil.example.test");
    expect(sent.html).not.toContain("<script");
  });

  it("escapes HTML written in a plain-text reply", async () => {
    await seedTeam();
    await deliver(mail({ body: '<script>alert("x")</script><img src=x onerror=alert(1)>' }));
    await processOutbox(env, 50);
    const sent = (await mailbox())[0];
    expect(sent.html).not.toContain("<script");
    expect(sent.html).not.toContain("<img");
    expect(sent.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(sent.text).toContain('<script>alert("x")</script>');
  });

  it("truncates the excerpt to 4000 characters and the subject to 200, and strips line breaks from the subject", async () => {
    await seedTeam();
    await deliver(mail({ subject: "S".repeat(300), body: "x".repeat(9000) }));
    const payload = JSON.parse((await jobs())[0].payload);
    expect(payload.textExcerpt.length).toBeLessThanOrEqual(4000);
    expect(payload.textExcerpt.startsWith("xxx")).toBe(true);
    expect(payload.subject).toBe("S".repeat(200));
  });

  it("cannot smuggle line breaks into the relayed subject or name through encoded words", async () => {
    await seedTeam();
    // "=0D=0A" decodes to CRLF: a header-injection attempt if it reached the outgoing Subject.
    await deliver(mail({ subject: "=?utf-8?Q?Hi=0D=0ABcc:_evil@example.test?=", from: '"=?utf-8?Q?Pat=0D=0AX?=" <pat@example.test>' }));
    const payload = JSON.parse((await jobs())[0].payload);
    expect(payload.subject).not.toMatch(/[\r\n]/);
    expect(payload.subject).toContain("Hi");
    expect(payload.from.name).not.toMatch(/[\r\n]/);
  });

  it("counts attachments, never forwards them, and says so in the mail", async () => {
    await seedTeam();
    const boundary = "BOUNDARY";
    const raw = mail({
      contentType: `multipart/mixed; boundary=${boundary}`,
      body: [
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "See the attached screenshots.",
        `--${boundary}`,
        'Content-Type: image/png; name="a.png"',
        'Content-Disposition: attachment; filename="a.png"',
        "Content-Transfer-Encoding: base64",
        "",
        "iVBORw0KGgo=",
        `--${boundary}`,
        'Content-Type: application/pdf; name="b.pdf"',
        'Content-Disposition: attachment; filename="b.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERi0xLjQ=",
        `--${boundary}--`,
      ].join("\n"),
    });
    await deliver(raw);
    const payload = JSON.parse((await jobs())[0].payload);
    expect(payload.attachmentsCount).toBe(2);
    expect(payload.textExcerpt).toBe("See the attached screenshots.");
    await processOutbox(env, 50);
    const sent = (await mailbox())[0];
    expect(sent.text).toContain("2 attachments were not forwarded — ask the customer to resend if needed");
    expect(sent.text).not.toContain("iVBORw0KGgo");
  });

  it("uses the singular for one attachment", async () => {
    await seedTeam();
    const boundary = "B2";
    await deliver(
      mail({
        contentType: `multipart/mixed; boundary=${boundary}`,
        body: [`--${boundary}`, "Content-Type: text/plain", "", "hi", `--${boundary}`, 'Content-Type: image/png; name="a.png"', 'Content-Disposition: attachment; filename="a.png"', "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", `--${boundary}--`].join("\n"),
      }),
    );
    await processOutbox(env, 50);
    expect((await mailbox())[0].text).toContain("1 attachment was not forwarded — ask the customer to resend if needed");
  });

  it("writes an audit entry with the sender and the reference", async () => {
    await seedTeam();
    await seedReservation();
    await deliver(mail({ subject: `Re: ${REF}` }));
    const row = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'email.inbound_relayed'").first<any>();
    expect(row.actor_kind).toBe("system");
    expect(row.reservation_id).toBe("res-1");
    expect(JSON.parse(row.details)).toMatchObject({ from: "pat@example.test", fromDomain: "example.test", ref: REF });
  });

  it("does nothing, and does not fail, when no one is set to receive notifications", async () => {
    await seedStaff("quiet@example.test");
    await env.DB.prepare("UPDATE staff SET notify = 0").run();
    const spies = await deliver(mail());
    expect(spies.setReject).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(0);
  });

  it("deduplicates a redelivery by Message-ID, and by header hash when there is no Message-ID", async () => {
    await seedTeam();
    const withId = mail({ id: "<same@mail.example.test>" });
    await deliver(withId);
    await deliver(withId);
    expect(await jobs()).toHaveLength(2);
    const noId = mail({ id: null, subject: "no id" });
    await deliver(noId);
    await deliver(noId);
    const rows = await jobs();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => /^reply:[0-9a-f]{64}:\d+$/.test(r.dedupe_key))).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'email.inbound_relayed'").first<any>()).n).toBe(2);
  });

  it("keeps the dedupe key bounded however long the Message-ID is, and a redelivery is not audited again", async () => {
    await seedTeam();
    const huge = mail({ id: `<${"a".repeat(200_000)}@mail.example.test>` });
    await deliver(huge);
    await deliver(huge);
    const rows = await jobs();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.dedupe_key.length < 100)).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'email.inbound_relayed'").first<any>()).n).toBe(1);
  });

  it("keys by sender as well: the same Message-ID from two senders is two relays", async () => {
    await seedTeam();
    const m = mail({ id: "<shared@mail.example.test>" });
    await deliver(m, { from: "pat@example.test" });
    await deliver(m, { from: "sam@example.test" });
    expect(await jobs()).toHaveLength(4);
  });
});

describe("spoofing aids", () => {
  it("shows the address first, drops a display name that looks like an address, and shows a differing envelope sender", async () => {
    await seedTeam();
    await deliver(mail({ from: '"billing@example.test" <pat@example.test>' }), { from: "bounce-me@other.example.test" });
    const payload = JSON.parse((await jobs())[0].payload);
    expect(payload.from).toEqual({ address: "pat@example.test", name: "" });
    expect(payload.envelopeFrom).toBe("bounce-me@other.example.test");
    await processOutbox(env, 50);
    const sent = (await mailbox())[0];
    expect(sent.text).toContain("From: pat@example.test\n");
    expect(sent.text).toContain("Envelope sender: bounce-me@other.example.test");
    expect(sent.text).not.toContain("billing@example.test");
  });

  it("omits the envelope sender when it is on the From domain", async () => {
    await seedTeam();
    await deliver(mail(), { from: "mailer@example.test" });
    expect(JSON.parse((await jobs())[0].payload).envelopeFrom).toBeUndefined();
  });

  it("quotes every line of the customer's text, so it cannot pass for ours", async () => {
    await seedTeam();
    await deliver(mail({ body: "line one\n\nApproved. Call 555-0100.\nline four" }));
    await processOutbox(env, 50);
    expect((await mailbox())[0].text).toContain("> line one\n>\n> Approved. Call 555-0100.\n> line four");
  });

  it("strips hidden and bidi control characters from the excerpt, and does not split a surrogate pair", () => {
    expect(excerptOf("a\u202eb\u2066c\u2069d\u0007e\u200bf\tg\r\nh")).toBe("abcdef\tg\nh");
    expect(excerptOf("😀".repeat(2500)).length).toBeLessThanOrEqual(4000);
    expect(excerptOf("😀".repeat(2500)).endsWith("…")).toBe(true);
    expect(/[\ud800-\udbff]…$/.test(excerptOf("😀".repeat(2500)))).toBe(false);
  });
});

describe("hostile input stays cheap", () => {
  const MB = 1_000_000;
  const cases: Array<[string, string]> = [
    ["space runs between newlines", ("x" + " ".repeat(5000) + "y\n").repeat(190)],
    ["spaces then no newline", " ".repeat(MB)],
    ["unclosed comments", "<!--".repeat(MB / 4)],
    ["unclosed script openers", "<script>".repeat(MB / 8)],
    ["unclosed style then text", "<style>" + "a".repeat(MB)],
    ["tag openers without a close", "<a ".repeat(MB / 3)],
    ["bare less-than signs", "<".repeat(MB)],
    ["less-than then greater-than far away", "<a".repeat(MB / 4) + ">"],
    ["nested openers before one close", "<b".repeat(MB / 4) + ">x"],
    ["ampersand runs", "&#x".repeat(MB / 3)],
    ["doctype openers", "<!x".repeat(MB / 3)],
    ["closing script tags", "</script ".repeat(MB / 9)],
  ];
  it.each(cases)("htmlToText: %s", (_name, html) => {
    const t0 = Date.now();
    const out = htmlToText(html);
    excerptOf(out);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it.each(cases)("excerptOf: %s", (_name, text) => {
    const t0 = Date.now();
    expect(excerptOf(text).length).toBeLessThanOrEqual(4000);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("relays a 1 MB adversarial HTML-only message promptly", async () => {
    await seedTeam();
    const t0 = Date.now();
    await deliver(mail({ contentType: "text/html", body: "<!--".repeat(230_000) + " ".repeat(50_000) + "<b" }));
    await deliver(mail({ contentType: "text/html", body: ("x" + " ".repeat(2000) + "\n").repeat(400) }));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await jobs()).toHaveLength(4);
  });

  it("converts ordinary markup correctly (script/style/title/comments out, block tags break lines, bad entities kept)", () => {
    expect(htmlToText("<title>T</title><!-- c --><style>x{}</style><p>One</p><P>Two<BR/>Three</P><b>&amp;&#65;&#x42;&bogus;&#0;</b> a < b")).toBe(
      "One\nTwo\nThree\n&AB&bogus;&#0; a < b",
    );
    expect(htmlToText("before<script>never")).toBe("before");
    expect(htmlToText("before<!-- never")).toBe("before");
  });
});

describe("reservation reference", () => {
  it("finds the reference in the subject and links the staff detail page", async () => {
    await seedTeam();
    await seedReservation();
    await deliver(mail({ subject: `Re: Confirmed: remote support (${REF})` }));
    const [row] = await jobs();
    expect(row.reservation_id).toBe("res-1");
    expect(JSON.parse(row.payload)).toMatchObject({ ref: REF, reservationId: "res-1" });
    await processOutbox(env, 50);
    const sent = (await mailbox())[0];
    expect(sent.text).toContain(REF);
    expect(sent.text).toContain("View reservation: http://localhost:5173/staff/r/res-1");
    expect(sent.html).toContain('href="http://localhost:5173/staff/r/res-1"');
  });

  it("finds a lower-case reference in the body when the subject has none", async () => {
    await seedTeam();
    await seedReservation();
    await deliver(mail({ subject: "hello", body: `About my booking ${REF.toLowerCase()} please` }));
    expect(JSON.parse((await jobs())[0].payload)).toMatchObject({ ref: REF, reservationId: "res-1" });
  });

  it("finds the reference in an HTML-only body", async () => {
    await seedTeam();
    await seedReservation();
    await deliver(mail({ contentType: "text/html", body: `<p>Ref <b>${REF}</b></p>` }));
    expect(JSON.parse((await jobs())[0].payload).reservationId).toBe("res-1");
  });

  it("keeps a well-formed reference that matches no reservation, without a link", async () => {
    await seedTeam();
    await deliver(mail({ subject: "R-ZZZZ-9999" }));
    const [row] = await jobs();
    expect(row.reservation_id).toBeNull();
    const payload = JSON.parse(row.payload);
    expect(payload.ref).toBe("R-ZZZZ-9999");
    expect(payload.reservationId).toBeUndefined();
    await processOutbox(env, 50);
    expect((await mailbox())[0].text).not.toContain("View reservation");
  });

  it("ignores text that is not a valid reference (characters outside the alphabet, wrong shape)", async () => {
    await seedTeam();
    await deliver(mail({ subject: "R-0O1I-LLLL and R-ABC-1234 and XR-ABCD-2345" }));
    expect(JSON.parse((await jobs())[0].payload).ref).toBeUndefined();
  });
});

describe("what is not relayed", () => {
  const dropped: Array<[string, { headers?: string[]; from?: string; headerFrom?: string; contentType?: string }]> = [
    ["Auto-Submitted: auto-replied", { headers: ["Auto-Submitted: auto-replied"] }],
    ["Auto-Submitted: auto-generated", { headers: ["Auto-Submitted: auto-generated"] }],
    ["Precedence: bulk", { headers: ["Precedence: bulk"] }],
    ["Precedence: list", { headers: ["Precedence: list"] }],
    ["Precedence: junk", { headers: ["Precedence: Junk"] }],
    ["Precedence: auto_reply", { headers: ["Precedence: auto_reply"] }],
    ["X-Autoreply", { headers: ["X-Autoreply: yes"] }],
    ["X-Autorespond", { headers: ["X-Autorespond: yes"] }],
    ["List-Id", { headers: ["List-Id: <news.example.test>"] }],
    ["mailer-daemon sender", { from: "MAILER-DAEMON@example.test" }],
    ["postmaster sender", { from: "postmaster@example.test" }],
    ["no-reply sender", { from: "no-reply@example.test" }],
    ["noreply sender", { from: "NoReply@example.test" }],
    ["empty envelope sender", { from: "" }],
    ["null envelope sender", { from: "<>" }],
    ["our own address", { from: "No-Reply@Example.com" }],
    ["our own address in the From header", { headerFrom: "Us <no-reply@example.com>" }],
    ["another address at our own domain", { from: "someone@example.com" }],
    ["a +tag variant of an automated local part", { from: "no-reply+abc@example.test" }],
    ["bounce sender", { from: "bounces@example.test" }],
    ["do-not-reply sender", { from: "Do-Not-Reply@example.test" }],
    ["donotreply sender", { from: "donotreply@example.test" }],
    ["no_reply sender", { from: "no_reply@example.test" }],
    ["multipart/report (a bounce)", { contentType: "multipart/report; report-type=delivery-status; boundary=b" }],
    ["X-Failed-Recipients", { headers: ["X-Failed-Recipients: someone@example.test"] }],
    ["X-Auto-Response-Suppress", { headers: ["X-Auto-Response-Suppress: All"] }],
    ["automation in the From header", { headerFrom: "Daemon <mailer-daemon@example.test>" }],
  ];
  it.each(dropped)("drops %s silently", async (_name, c) => {
    await seedTeam();
    const spies = await deliver(mail({ headers: c.headers, from: c.headerFrom, contentType: c.contentType }), { from: c.from });
    expect(spies.setReject).not.toHaveBeenCalled();
    expect(spies.forward).not.toHaveBeenCalled();
    expect(spies.reply).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'email.inbound_relayed'").first<any>()).n).toBe(0);
  });

  it("relays when Auto-Submitted is 'no'", async () => {
    await seedTeam();
    await deliver(mail({ headers: ["Auto-Submitted: no"] }));
    expect(await jobs()).toHaveLength(2);
  });

  it("drops a message with no usable sender address", async () => {
    await seedTeam();
    await deliver(mail({ from: "Nobody" }), { from: "not-an-address" });
    expect(await jobs()).toHaveLength(0);
  });
});

describe("recipient and size", () => {
  it("rejects mail for another domain", async () => {
    await seedTeam();
    const spies = await deliver(mail(), { to: "someone@example.org" });
    expect(spies.setReject).toHaveBeenCalledWith("Unknown recipient");
    expect(await jobs()).toHaveLength(0);
  });

  it("does not accept a lookalike domain", async () => {
    await seedTeam();
    for (const to of ["x@evil-example.com", "x@example.com.evil.test", "x@sub.example.com", "nodomain"]) {
      const spies = await deliver(mail(), { to });
      expect(spies.setReject).toHaveBeenCalledWith("Unknown recipient");
    }
    expect(await jobs()).toHaveLength(0);
  });

  it("accepts any address at the sender's domain, case-insensitively", async () => {
    await seedTeam();
    const spies = await deliver(mail(), { to: "Anything@EXAMPLE.com" });
    expect(spies.setReject).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(2);
  });

  it("rejects an oversize message by its declared size", async () => {
    await seedTeam();
    const spies = await deliver(mail(), { rawSize: 1_048_577 });
    expect(spies.setReject).toHaveBeenCalledWith("Message too large");
    expect(await jobs()).toHaveLength(0);
  });

  it("accepts a message of exactly 1 MB declared size", async () => {
    await seedTeam();
    const spies = await deliver(mail(), { rawSize: 1_048_576 });
    expect(spies.setReject).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(2);
  });

  it("rejects a stream larger than the cap even when the declared size is a lie", async () => {
    await seedTeam();
    const big = mail({ body: "y".repeat(1_100_000) });
    const spies = await deliver(big, { rawSize: 100 });
    expect(spies.setReject).toHaveBeenCalledWith("Message too large");
    expect(await jobs()).toHaveLength(0);
  });
});

describe("global ceiling", () => {
  it("drops everything over 200 messages an hour across all senders, logging only a count", async () => {
    await seedTeam();
    await env.DB.prepare("INSERT INTO rate_limits(key, window_start, count) VALUES ('inbound:all', ?, 199)").bind(T0).run();
    await deliver(mail(), { from: "one@example.test" }); // the 200th
    expect(await jobs()).toHaveLength(2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spies = await deliver(mail(), { from: "two@example.test" });
    expect(spies.setReject).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]!.join(" "))).toContain("200");
    expect(String(warn.mock.calls[0]!.join(" "))).not.toContain("two@");
    warn.mockRestore();
    setNow(T0 + 61 * 60_000);
    await deliver(mail(), { from: "two@example.test" });
    expect(await jobs()).toHaveLength(4);
  });

  it("does not spend the global allowance on mail that is dropped earlier", async () => {
    await seedTeam();
    await deliver(mail({ headers: ["Precedence: bulk"] }));
    await deliver(mail(), { from: "no-reply@example.test" });
    expect(await env.DB.prepare("SELECT count FROM rate_limits WHERE key = 'inbound:all'").first()).toBeNull();
  });
});

describe("relay sends", () => {
  async function relayJob(): Promise<void> {
    await seedTeam();
    await deliver(mail());
    // The relay's own outbox kick has already delivered to the dev mailbox: put the jobs back to send them through a mock binding.
    await env.DB.prepare("UPDATE email_jobs SET status = 'queued', sent_at = NULL").run();
    await env.DB.prepare("DELETE FROM dev_mailbox").run();
  }
  const cfEnv = (send: (m: any) => Promise<void>) => ({ ...env, MAIL_MODE: "cloudflare", EMAIL: { send } }) as any;

  it("asks the Cloudflare binding for Reply-To and auto-response-suppressing headers", async () => {
    await relayJob();
    const sent: any[] = [];
    await processOutbox(env, 50, mailerFor(cfEnv(async (m) => void sent.push(m))));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ replyTo: "pat@example.test", headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" } });
  });

  it("retries without the headers when the binding refuses them, keeping Reply-To", async () => {
    await relayJob();
    const sent: any[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await processOutbox(
      env,
      50,
      mailerFor(
        cfEnv(async (m) => {
          if (m.headers) throw new Error("headers not allowed");
          sent.push(m);
        }),
      ),
    );
    warn.mockRestore();
    expect(out).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[0].headers).toBeUndefined();
    expect(sent[0].replyTo).toBe("pat@example.test");
  });

  it("other mail is sent without extra headers", async () => {
    const sent: any[] = [];
    await mailerFor(cfEnv(async (m) => void sent.push(m))).send({ to: "a@example.test", subject: "s", html: "h", text: "t" });
    expect(sent[0].headers).toBeUndefined();
  });
});

describe("failures", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a database failure while handling is logged once and swallowed, never thrown to the runtime", async () => {
    await seedTeam();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const batch = vi.spyOn(env.DB, "batch").mockRejectedValue(new Error("D1_ERROR: database unavailable, see https://db.example.test/x#t=secret"));
    const spies = await deliver(mail());
    batch.mockRestore();
    expect(spies.setReject).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toBe("inbound mail failed");
    expect(String(error.mock.calls[0]![1])).toContain("D1_ERROR: database unavailable");
    expect(String(error.mock.calls[0]![1])).not.toContain("#t=");
    error.mockRestore();
    expect(await jobs()).toHaveLength(0);
  });

  it("a failure before the rate limit (the first query) is swallowed too", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("D1_ERROR: no such table");
    });
    const spies = await deliver(mail());
    prepare.mockRestore();
    expect(spies.setReject).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("deliberate rejections are unchanged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const spies = await deliver(mail(), { to: "someone@elsewhere.example" });
    expect(spies.setReject).toHaveBeenCalledWith("Unknown recipient");
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("rate limit", () => {
  it("relays at most 20 messages an hour per sender (case-insensitive), then drops silently", async () => {
    await seedTeam();
    for (let i = 0; i < 20; i++) await deliver(mail(), { from: i % 2 ? "PAT@example.test" : "pat@example.test" });
    expect(await jobs()).toHaveLength(40);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spies = await deliver(mail(), { from: "Pat@Example.test" });
    expect(spies.setReject).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(40);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]!.join(" "))).toContain("example.test");
    expect(String(warn.mock.calls[0]!.join(" "))).not.toContain("pat@");
    warn.mockRestore();

    // Another sender is unaffected; the same sender is let in again after the hour.
    await deliver(mail(), { from: "sam@example.test" });
    expect(await jobs()).toHaveLength(42);
    setNow(T0 + 61 * 60_000);
    await deliver(mail(), { from: "pat@example.test" });
    expect(await jobs()).toHaveLength(44);
  });
});
