// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import "./helpers.mjs";
import { parseBtc, formatBtc } from "../src/amount.js";
import { load, save } from "../src/store.js";

test("amounts never go through floating point", () => {
  assert.equal(parseBtc("0.00000001"), 1);
  assert.equal(parseBtc("0.1"), 10000000);
  assert.equal(parseBtc(".5"), 50000000);
  assert.equal(parseBtc("1."), 100000000);
  assert.equal(parseBtc("20999999.97690000"), 2099999997690000);
  assert.equal(parseBtc("0.07"), 7000000); // 0.07 * 1e8 is 7000000.000000001 in floating point
  assert.equal(parseBtc("1.1"), 110000000);
  for (const bad of ["", ".", "abc", "1e3", "-1", "0.000000001", "21000001", "1,000"]) assert.throws(() => parseBtc(bad), RangeError, bad);
  assert.equal(formatBtc(1), "0.00000001");
  assert.equal(formatBtc(-150000000), "-1.50000000");
  assert.equal(formatBtc(2099999997690000), "20,999,999.97690000");
  for (const n of [1, 999, 123456789, 2099999997690000]) assert.equal(parseBtc(formatBtc(n)), n);
});

test("the store survives nonsense", () => {
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  assert.deepEqual(load(storage), { accounts: [], current: null, servers: {} });
  m.set("gapwallet.v1", "{not json");
  assert.deepEqual(load(storage).accounts, []);
  save({ accounts: [{ id: "a" }], current: "a", servers: {} }, storage);
  assert.equal(load(storage).current, "a");
});

test("W5: prices read from the common answers, and worth computed in cents", async () => {
  const { parsePrice, parsePriceUrl, valueInCents, PriceError, PRICE_DEFAULTS, fetchPrice } = await import("../src/price.js");
  assert.equal(parsePrice('{"data":{"amount":"64123.45","base":"BTC","currency":"USD"}}', "USD"), 64123.45);
  assert.throws(() => parsePrice('{"data":{"amount":"64123.45","base":"BTC","currency":"EUR"}}', "USD"), PriceError);
  assert.equal(parsePrice('{"bitcoin":{"brl":350000.5}}', "BRL"), 350000.5);
  assert.equal(parsePrice('{"USD":64000,"EUR":59000}', "USD"), 64000);
  assert.equal(parsePrice("64000.5\n", "USD"), 64000.5);
  for (const bad of ["", "{}", "null", '{"data":{"amount":"-1"}}', '{"USD":"lots"}', "<html>", '{"USD":0}']) assert.throws(() => parsePrice(bad, "USD"), PriceError, bad);
  assert.equal(valueInCents(123456789, 50000), 6172839); // 1.23456789 BTC at 50000: 61728.39, and 0.45 of a cent
  assert.equal(valueInCents(1, 50000), 0);
  assert.equal(parsePriceUrl(" https://example.com/p?ids=bitcoin "), "https://example.com/p?ids=bitcoin");
  for (const bad of ["ftp://x/", "https://u:p@x/", "nonsense"]) assert.throws(() => parsePriceUrl(bad), PriceError, bad);
  for (const url of Object.values(PRICE_DEFAULTS)) assert.match(url, /^https:\/\//);
  // the URL is fetched as it is, with nothing else sent
  let asked = null;
  const value = await fetchPrice("https://q.example/p", "USD", { fetch: async (u, init) => {
    asked = { u, init };
    return { ok: true, status: 200, text: async () => '{"USD":10}' };
  } });
  assert.equal(value, 10);
  assert.equal(asked.u, "https://q.example/p");
  assert.equal(asked.init.credentials, "omit");
  assert.equal(asked.init.body, undefined);
  assert.equal(asked.init.method, undefined);
  await assert.rejects(fetchPrice("https://q.example/p", "USD", { fetch: async () => ({ ok: false, status: 503, text: async () => "" }) }), PriceError);
});
