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
  for (const bad of ["", ".", "abc", "1e3", "-1", "0.000000001", "21000001", "1,5"]) assert.throws(() => parseBtc(bad), RangeError, bad);
  assert.equal(formatBtc(1), "0.00000001");
  assert.equal(formatBtc(-150000000), "-1.50000000");
  assert.equal(formatBtc(2099999997690000), "20999999.97690000");
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
