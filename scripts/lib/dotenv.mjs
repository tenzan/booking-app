// Minimal .env parser shared by the scripts (no dependency, no variable expansion).
//
// Supported: `KEY=value`, `export KEY=value`, blank lines, full-line `#` comments, an inline ` #` comment on an
// unquoted value, single-quoted values (literal) and double-quoted values (`\n`, `\"` and `\\` escapes; `#` is
// kept inside quotes). Keys match [A-Za-z_][A-Za-z0-9_]*; other lines are ignored. Later duplicates win.

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** @param {string} text @returns {Record<string, string>} */
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    out[m[1]] = parseValue(m[2]);
  }
  return out;
}

function parseValue(rest) {
  const v = rest.trimStart();
  const quote = v[0];
  if (quote === '"' || quote === "'") {
    const quoted = readQuoted(v, quote);
    if (quoted !== null) return quoted;
    // Unterminated quote: fall through and keep the text literally.
  }
  // `rest` still has its leading whitespace, so `KEY= # comment` is an empty value.
  const comment = /\s#/.exec(rest);
  return (comment ? rest.slice(0, comment.index) : rest).trim();
}

/** The content of the quoted string at the start of `v`, or null when the quote is never closed. */
function readQuoted(v, quote) {
  if (quote === "'") {
    const end = v.indexOf("'", 1);
    return end === -1 ? null : v.slice(1, end);
  }
  let value = "";
  for (let i = 1; i < v.length; i++) {
    const ch = v[i];
    if (ch === '"') return value;
    if (ch === "\\" && i + 1 < v.length) {
      const next = v[++i];
      value += next === "n" ? "\n" : next === '"' || next === "\\" ? next : `\\${next}`;
    } else {
      value += ch;
    }
  }
  return null;
}
