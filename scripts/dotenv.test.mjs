// Plain-node tests for scripts/lib/dotenv.mjs. Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDotenv } from "./lib/dotenv.mjs";

test("plain KEY=value pairs", () => {
  assert.deepEqual(parseDotenv("A=1\nB=two words\n"), { A: "1", B: "two words" });
});

test("export prefix is accepted", () => {
  assert.deepEqual(parseDotenv("export A=1\nexport   B = 2"), { A: "1", B: "2" });
});

test("blank lines and full-line comments are skipped", () => {
  assert.deepEqual(parseDotenv("\n# a comment\n   # indented comment\n\nA=1\n"), { A: "1" });
});

test("inline ' #' comments are stripped from unquoted values", () => {
  assert.deepEqual(parseDotenv("A=value # note\nB=x\t# tab note\nC= # only a comment"), { A: "value", B: "x", C: "" });
});

test("a # not preceded by whitespace stays in an unquoted value", () => {
  assert.deepEqual(parseDotenv("A=abc#def\nB=#hash"), { A: "abc#def", B: "#hash" });
});

test("double-quoted values keep # and surrounding spaces, and expand \\n, \\\" and \\\\", () => {
  const out = parseDotenv('A="x # y"\nB="  padded  "\nC="line1\\nline2"\nD="say \\"hi\\""\nE="back\\\\slash"');
  assert.deepEqual(out, { A: "x # y", B: "  padded  ", C: "line1\nline2", D: 'say "hi"', E: "back\\slash" });
});

test("single-quoted values are literal (no escapes, # kept)", () => {
  assert.deepEqual(parseDotenv("A='x # y'\nB='a\\nb'"), { A: "x # y", B: "a\\nb" });
});

test("a comment after a closing quote is ignored", () => {
  assert.deepEqual(parseDotenv('A="v" # c\nB=\'w\'   # c'), { A: "v", B: "w" });
});

test("surrounding whitespace is trimmed and = may have spaces around it", () => {
  assert.deepEqual(parseDotenv("  A  =  spaced out   \n"), { A: "spaced out" });
});

test("empty values", () => {
  assert.deepEqual(parseDotenv('A=\nB=""\nC=\'\''), { A: "", B: "", C: "" });
});

test("values may contain = signs", () => {
  assert.deepEqual(parseDotenv("A=b=c=="), { A: "b=c==" });
});

test("invalid keys are ignored; lowercase and underscore keys are valid", () => {
  const out = parseDotenv("1BAD=x\nBAD-KEY=y\nBAD KEY=z\n=nokey\nnot an assignment\n_ok=1\nmixed_Case9=2");
  assert.deepEqual(out, { _ok: "1", mixed_Case9: "2" });
});

test("CRLF line endings; later duplicates win", () => {
  assert.deepEqual(parseDotenv("A=1\r\nB=2\r\nA=3\r\n"), { A: "3", B: "2" });
});

test("an unterminated quote is kept literally", () => {
  assert.deepEqual(parseDotenv('A="oops'), { A: '"oops' });
});
