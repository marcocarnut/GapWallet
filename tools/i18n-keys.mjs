// Lists the keys of tr() and plural() in src/, for tests/i18n.test.mjs and
// for whoever adds a language: every literal first argument (and plural's
// second and third), in the order they appear. A key that isn't a literal
// there comes from a table marked "// keys for tr()" in the source, which is
// listed too.
//
//   node tools/i18n-keys.mjs     prints them, one JSON string a line
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const STRING = /"((?:[^"\\]|\\.)*)"/y;

export function keysIn(text) {
  const source = text.replace(/^\s*\/\/.*$/gm, ""); // comments' examples aren't keys
  const keys = [];
  const take = (at) => {
    STRING.lastIndex = at;
    const m = STRING.exec(source);
    return m ? { key: JSON.parse(`"${m[1]}"`), end: STRING.lastIndex } : null;
  };
  const skip = (at) => { while (/\s/.test(source[at])) at++; return at; };
  for (const m of source.matchAll(/\b(tr|plural)\(/g)) {
    let at = skip(m.index + m[0].length);
    if (m[1] === "plural") { // the count, then two keys
      at = source.indexOf(",", at) + 1;
      for (let k = 0; k < 2; k++) {
        const got = take(skip(at));
        if (!got) break;
        keys.push(got.key);
        at = source.indexOf(",", got.end) + 1;
      }
      continue;
    }
    // anything else is a key from a table marked below
    const got = take(at);
    if (got) keys.push(got.key);
  }
  // tables of keys
  for (const line of text.split("\n").filter((l) => l.includes("keys for tr()"))) {
    const start = text.indexOf(line);
    const end = Math.min(...["];", "};"].map((e) => text.indexOf(e, start)).filter((i) => i >= 0));
    // the strings, less object keys ({ Z: … } has none quoted)
    for (const s of text.slice(start, end).matchAll(/"((?:[^"\\]|\\.)*)"(?!\s*:)/g)) keys.push(JSON.parse(`"${s[1]}"`));
  }
  return keys;
}

export function allKeys() {
  const keys = new Set();
  for (const f of readdirSync(SRC).filter((f) => f.endsWith(".js") && !f.startsWith("lang-")).sort()) {
    for (const k of keysIn(readFileSync(join(SRC, f), "utf8"))) keys.add(k);
  }
  return [...keys];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) for (const k of allKeys()) console.log(JSON.stringify(k));
