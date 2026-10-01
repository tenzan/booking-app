// Plain-node tests for scripts/render-wrangler.mjs (the Vitest pool runs inside workerd and cannot spawn processes).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./render-wrangler.mjs", import.meta.url));

const PROD = {
  APP_DOMAIN: "booking.example.com",
  MAIL_FROM: "no-reply@booking.example.com",
  MAIL_FROM_NAME: "Example Support",
  ORG_NAME: "Example Support",
  APP_TIMEZONE: "Asia/Tokyo",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  D1_DATABASE_ID: "12345678-90ab-cdef-1234-567890abcdef",
};

/** Run the script in an empty temp dir with exactly `vars` (plus PATH), optionally with a .env file. */
function render(vars, { strict = true, dotenv } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "render-wrangler-"));
  try {
    if (dotenv) writeFileSync(join(dir, ".env"), dotenv);
    const r = spawnSync(process.execPath, [SCRIPT, ...(strict ? ["--strict"] : [])], {
      cwd: dir,
      env: { PATH: process.env.PATH, ...vars },
      encoding: "utf8",
    });
    const out = join(dir, "wrangler.jsonc");
    const config = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
    return { status: r.status, stderr: r.stderr, config };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("strict renders a production config that sends real mail", () => {
  const r = render(PROD);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.config.vars.MAIL_MODE, "cloudflare");
  assert.equal(r.config.vars.APP_BASE_URL, "https://booking.example.com");
  assert.equal(r.config.account_id, PROD.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(r.config.d1_databases[0].database_id, PROD.D1_DATABASE_ID);
  assert.equal(r.config.workers_dev, false);
  assert.equal(r.config.preview_urls, false);
});

test("strict refuses a placeholder in an optional value", () => {
  const r = render({ ...PROD, TURNSTILE_SITE_KEY: "SET_BY_deploy" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TURNSTILE_SITE_KEY is a placeholder/);
});

test("strict accepts an explicit MAIL_MODE=cloudflare", () => {
  assert.equal(render({ ...PROD, MAIL_MODE: "cloudflare" }).status, 0);
});

for (const mode of ["dev", "Cloudflare", "smtp"]) {
  test(`strict refuses MAIL_MODE=${mode} and writes nothing`, () => {
    const r = render({ ...PROD, MAIL_MODE: mode });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /MAIL_MODE must be "cloudflare"/);
    assert.equal(r.config, null);
  });
}

test("strict refuses MAIL_MODE=dev picked up from a local .env file", () => {
  const r = render(PROD, { dotenv: "MAIL_MODE=dev\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MAIL_MODE must be "cloudflare"/);
  assert.equal(r.config, null);
});

for (const [key, value] of [
  ["CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000"],
  ["D1_DATABASE_ID", "00000000-0000-0000-0000-000000000000"],
]) {
  test(`strict refuses an all-zero ${key}`, () => {
    const r = render({ ...PROD, [key]: value });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`${key} is a placeholder`));
    assert.equal(r.config, null);
  });
}

for (const value of ["REPLACE_ME", "REPLACE_ME_with_your_domain", "SET_BY_DOPPLER"]) {
  test(`strict refuses a placeholder value (${value})`, () => {
    const r = render({ ...PROD, APP_DOMAIN: value });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /APP_DOMAIN is a placeholder/);
    assert.equal(r.config, null);
  });
}

test("strict reports every problem at once", () => {
  const r = render({ ...PROD, MAIL_MODE: "dev", D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000", ORG_NAME: "SET_BY_CI" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MAIL_MODE/);
  assert.match(r.stderr, /D1_DATABASE_ID/);
  assert.match(r.stderr, /ORG_NAME/);
});

test("strict still refuses missing values", () => {
  const { APP_DOMAIN: _omit, ...rest } = PROD;
  const r = render(rest);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing env vars: APP_DOMAIN/);
  assert.equal(r.config, null);
});

test("non-strict (local dev) keeps working with placeholders and dev mail", () => {
  const r = render({}, { strict: false });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.config.vars.MAIL_MODE, "dev");
  assert.equal(r.config.vars.APP_BASE_URL, "http://localhost:5173");
});
