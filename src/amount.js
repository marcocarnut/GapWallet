// Amounts, as text and whole satoshis. Never through floating point.
//
// Written as the page's language writes numbers: 1,234.5 or 1.234,5. Read so that
// the language never turns one amount into another: what could be read two ways,
// like 1.000 (one, or a thousand), is refused rather than guessed. A lone mark
// that can't be a thousands separator, as in 0.001 or 1,5, is the decimal mark,
// whichever the language: amounts are often copied from elsewhere.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { marks, tr } from "./i18n.js";

export const SATS = 100000000;
const MAX_SATS = 2100000000000000;

const escape = (c) => (c === "." ? "\\." : c);

// "1234.5" from the text as typed, or a RangeError saying why not.
function normalize(text) {
  const { decimal: D, group: G } = marks();
  const s = String(text).trim();
  const example = { example: `0${D}001` };
  if (s === "") throw new RangeError(tr("Enter an amount in BTC, like {example}.", example));
  if (!/^[\d.,]+$/.test(s)) throw new RangeError(tr("Enter an amount in BTC, like {example}.", example));
  const both = s.includes(",") && s.includes(".");
  if (both) {
    const m = new RegExp(`^(\\d{1,3}(?:${escape(G)}\\d{3})*)${escape(D)}(\\d*)$`).exec(s);
    if (!m) throw new RangeError(tr("Write {d} for decimals and {g} between thousands, or leave the thousands separator out.", { d: D, g: G }));
    return `${m[1].split(G).join("")}.${m[2]}`;
  }
  const mark = s.includes(",") ? "," : s.includes(".") ? "." : null;
  if (!mark) return s;
  const pieces = s.split(mark);
  if (pieces.length === 2) {
    const [whole, frac] = pieces;
    if (whole === "" && frac === "") throw new RangeError(tr("Enter an amount in BTC, like {example}.", example));
    // 1.000 or 12,500: a thousand, or one? Refused, in both languages
    if (frac.length === 3 && /^[1-9]\d{0,2}$/.test(whole) && mark !== D) {
      throw new RangeError(tr("“{text}” could be read two ways. Leave out the thousands separator, and write decimals with {d}: 1000 or 1{d}5.", { text: s, d: D }));
    }
    return `${whole}.${frac}`; // the language's own mark, or one that can't be thousands
  }
  // several of the same mark: only thousands, written properly
  if (mark === G && new RegExp(`^\\d{1,3}(?:${escape(G)}\\d{3})+$`).test(s)) return pieces.join("");
  throw new RangeError(tr("Enter an amount in BTC, like {example}.", example));
}

export function parseBtc(text) {
  const n = normalize(text);
  const m = /^(\d*)(?:\.(\d*))?$/.exec(n);
  if (!m || (m[1] === "" && !m[2])) throw new RangeError(tr("Enter an amount in BTC, like {example}.", { example: `0${marks().decimal}001` }));
  if ((m[2] || "").length > 8) throw new RangeError(tr("Bitcoin has 8 decimal places at most."));
  const sats = Number(BigInt(m[1] || "0") * 100000000n + BigInt((m[2] || "").padEnd(8, "0") || "0"));
  if (!Number.isSafeInteger(sats) || sats > MAX_SATS) throw new RangeError(tr("That's more bitcoin than there is."));
  return sats;
}

// A fee rate and the like: small, so no thousands; either mark for decimals.
export function parseDecimal(text) {
  const s = String(text).trim();
  if (!/^\d*(?:[.,]\d*)?$/.test(s) || !/\d/.test(s)) return NaN;
  return Number(s.replace(",", "."));
}

export function formatBtc(sats) {
  const { decimal: D, group: G } = marks();
  const negative = sats < 0;
  const n = Math.abs(sats);
  const whole = String(Math.floor(n / SATS)).replace(/\B(?=(\d{3})+$)/g, G);
  return `${negative ? "-" : ""}${whole}${D}${String(n % SATS).padStart(8, "0")}`;
}
