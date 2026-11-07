// The page's languages. Text is written in English where it is used, and that
// English is the key: tr("Fee rate {min} to {max}", { min, max }). Another
// language maps each key to its own text, with the same {names}; a key it lacks
// shows in English. tests/i18n.test.mjs checks that every key used in src/ is
// translated, with the same names.
//
// Numbers in {names} are written the language's way: grouped thousands, its
// decimal mark. Amounts the user types are read by amount.js, which never lets
// the language turn one number into another.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { PT_BR } from "./lang-pt-BR.js";

export const LANGUAGES = [["en", "English"], ["pt-BR", "Português (Brasil)"]];
const TABLES = { en: null, "pt-BR": PT_BR };
const MARKS = { en: { decimal: ".", group: "," }, "pt-BR": { decimal: ",", group: "." } };

let current = "en";

export const language = () => current;
export const marks = () => MARKS[current];

export function setLanguage(lang) {
  current = lang in TABLES ? lang : "en";
}

// The language to start in: the one chosen before, else the browser's.
export function startLanguage(saved, browser = []) {
  if (saved in TABLES) return saved;
  return browser.some((l) => /^pt\b/i.test(l)) ? "pt-BR" : "en";
}

// A whole number, its thousands grouped: 1,234 or 1.234
export function formatInt(n) {
  const s = String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+$)/g, marks().group);
  return `${n < 0 ? "-" : ""}${s}`;
}

// A decimal number with at most `places` decimals, as the language writes it.
export function formatDecimal(x, places = 2) {
  const [whole, frac] = Math.abs(x).toFixed(places).split(".");
  const trimmed = (frac || "").replace(/0+$/, "");
  return `${x < 0 ? "-" : ""}${formatInt(Number(whole))}${trimmed ? marks().decimal + trimmed : ""}`;
}

// Cents as the language writes money: 1,234.56 or 1.234,56
export function formatCents(cents) {
  const n = Math.abs(Math.round(cents));
  return `${cents < 0 ? "-" : ""}${formatInt(Math.floor(n / 100))}${marks().decimal}${String(n % 100).padStart(2, "0")}`;
}

const show = (v) => (typeof v === "number" ? (Number.isInteger(v) ? formatInt(v) : formatDecimal(v)) : String(v));

export function tr(text, params = {}) {
  const table = TABLES[current];
  const s = (table && table[text]) || text;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? show(params[k]) : m));
}

// One of two keys by count: plural(n, "{n} code", "{n} codes")
export const plural = (n, one, many, params = {}) => tr(n === 1 ? one : many, { n, ...params });

export function formatDate(seconds) {
  return new Intl.DateTimeFormat(current, { dateStyle: "medium" }).format(new Date(seconds * 1000));
}
