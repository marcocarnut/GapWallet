// The languages: every key translated, and amounts that no language can turn
// into other amounts (BITCOIN.md, W4).
//
// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers.mjs";
import { allKeys } from "../tools/i18n-keys.mjs";
import { PT_BR } from "../src/lang-pt-BR.js";
import { formatDecimal, formatInt, plural, setLanguage, startLanguage, tr } from "../src/i18n.js";
import { formatBtc, parseBtc, parseDecimal } from "../src/amount.js";

const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const inLanguage = (lang, f) => {
  setLanguage(lang);
  try {
    return f();
  } finally {
    setLanguage("en");
  }
};

test("every key in src/ is in pt-BR, with the same {names}, and nothing else is", () => {
  const keys = allKeys();
  assert.ok(keys.length > 200, `only ${keys.length} keys found`);
  const missing = keys.filter((k) => !(k in PT_BR));
  assert.deepEqual(missing, []);
  const stale = Object.keys(PT_BR).filter((k) => !keys.includes(k));
  assert.deepEqual(stale, []);
  for (const k of keys) assert.deepEqual(names(PT_BR[k]), names(k), k);
});

test("tr fills in names, numbers the language's way", () => {
  assert.equal(tr("PSBT: {n} bytes", { n: 12345 }), "PSBT: 12,345 bytes");
  assert.equal(inLanguage("pt-BR", () => tr("PSBT: {n} bytes", { n: 12345 })), "PSBT: 12.345 bytes");
  assert.equal(inLanguage("pt-BR", () => tr("A key no table has")), "A key no table has");
  assert.equal(plural(1, "{n} coin was left out: it's worth less than it costs to spend at this rate.", "{n} coins were left out: they're worth less than they cost to spend at this rate."),
    "1 coin was left out: it's worth less than it costs to spend at this rate.");
  assert.equal(formatInt(-1234567), "-1,234,567");
  assert.equal(inLanguage("pt-BR", () => formatDecimal(1234.5, 2)), "1.234,5");
  assert.equal(formatDecimal(2, 2), "2");
  assert.equal(startLanguage(undefined, ["pt-BR", "en"]), "pt-BR");
  assert.equal(startLanguage(undefined, ["pt-PT"]), "pt-BR");
  assert.equal(startLanguage(undefined, ["fr"]), "en");
  assert.equal(startLanguage("en", ["pt-BR"]), "en");
  assert.equal(startLanguage("xx", ["en"]), "en");
});

test("amounts: what one language could misread is refused in both", () => {
  // [typed, en, pt-BR]: sats, or null for refused
  const cases = [
    ["1.000", 100000000, null], // en: one; pt-BR: a thousand or one?
    ["1,000", null, 100000000], // en: a thousand or one?; pt-BR: one
    ["0,001", 100000, 100000], // no thousands can start with 0: a decimal mark either way
    ["0.001", 100000, 100000],
    ["12.500", 1250000000, null],
    ["12,500", null, 1250000000],
    ["1.5", 150000000, 150000000],
    ["1,5", 150000000, 150000000],
    ["1.0000", 100000000, 100000000],
    ["1,234.5", 123450000000, null],
    ["1.234,5", null, 123450000000],
    ["1,000,000", 100000000000000, null], // several separators can only be thousands, in the language's own mark
    ["1.000.000", null, 100000000000000],
    ["22.000.000", null, null], // more bitcoin than there is
    ["1.2.3", null, null],
    ["1,2,3", null, null],
  ];
  for (const [typed, en, pt] of cases) {
    for (const [lang, want] of [["en", en], ["pt-BR", pt]]) {
      const got = inLanguage(lang, () => {
        try {
          return parseBtc(typed);
        } catch (e) {
          assert.ok(e instanceof RangeError);
          return null;
        }
      });
      assert.equal(got, want, `${typed} in ${lang}`);
    }
  }
  // grouped and decimal both, in the language's own marks, is a clear number
  assert.equal(inLanguage("pt-BR", () => parseBtc("1.000,000")), 100000000000);
  assert.throws(() => parseBtc("1.000,000"), RangeError);
  assert.equal(parseBtc("100,000.5"), 10000050000000);
  // the warning names the mark to use
  assert.match(inLanguage("pt-BR", () => { try { parseBtc("1.000"); } catch (e) { return e.message; } }), /1000 ou 1,5/);
});

test("amounts round trip through the language's own writing", () => {
  for (const lang of ["en", "pt-BR"]) {
    inLanguage(lang, () => {
      for (const n of [1, 999, 100000, 123456789, 100000000000, 2099999997690000]) assert.equal(parseBtc(formatBtc(n)), n, `${n} in ${lang}`);
    });
  }
  assert.equal(inLanguage("pt-BR", () => formatBtc(2099999997690000)), "20.999.999,97690000");
  assert.equal(inLanguage("pt-BR", () => formatBtc(-150000000)), "-1,50000000");
});

test("fee rates take either mark and nothing else", () => {
  assert.equal(parseDecimal("1,5"), 1.5);
  assert.equal(parseDecimal("1.5"), 1.5);
  assert.equal(parseDecimal("12"), 12);
  for (const bad of ["", ",", "1,000.5", "1.2.3", "abc", "1e3"]) assert.ok(Number.isNaN(parseDecimal(bad)), bad);
});
