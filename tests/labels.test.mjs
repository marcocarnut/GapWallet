// W6: BIP-329 labels, read from an untrusted file.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers.mjs";
import { haveSigner, loadSigner, MASTER_FINGERPRINT } from "./helpers.mjs";
import { addressAt } from "../src/account.js";
import { parseAccount } from "../src/descriptor.js";
import { LabelError, MAX_LABEL, exportLabels, importLabels, labelsOf, originOf, ownAddresses } from "../src/labels.js";

const skip = !haveSigner ? "needs the ZeroGap repository" : false;
const TXID = "a".repeat(64);
const OTHER_TXID = "b".repeat(64);

async function setup() {
  const s = await loadSigner();
  const key = (path, v) => s.bip32.serializeXpub(s.bip32.neuter(s.bip32.derive(s.master, path)), v);
  const account = parseAccount(key("m/84'/1'/0'", "vpub"), "signet", MASTER_FINGERPRINT);
  const other = parseAccount(key("m/84'/1'/1'", "vpub"), "signet", MASTER_FINGERPRINT);
  return { account, other, own: ownAddresses(account, 30), txids: new Set([TXID]) };
}

test("export, then import into a fresh record, gives the same labels", { skip }, async () => {
  const { account, own, txids } = await setup();
  const a0 = addressAt(account, 0, 0).address;
  const record = { labels: { addr: { [a0]: "To: Alice" }, tx: { [TXID]: "Rent" } } };
  const text = exportLabels(account, record);
  assert.equal(originOf(account), `wpkh([${MASTER_FINGERPRINT}/84h/1h/0h])`);
  assert.deepEqual(text.trim().split("\n").map((l) => JSON.parse(l)), [
    { type: "addr", ref: a0, label: "To: Alice", origin: originOf(account) },
    { type: "tx", ref: TXID, label: "Rent", origin: originOf(account) },
  ]);
  const fresh = {};
  const done = importLabels(text, account, fresh, { own, txids });
  assert.deepEqual([done.addr, done.tx, done.orphans.length, done.bad], [1, 1, 0, 0]);
  assert.deepEqual(fresh.labels, record.labels);
});

test("an untrusted file: hostile labels stay text, odd refs are refused, others' records are orphans", { skip }, async () => {
  const { account, other, own, txids } = await setup();
  const a1 = addressAt(account, 0, 1).address;
  const theirs = addressAt(other, 0, 0).address;
  const lines = [
    { type: "addr", ref: a1, label: "<img src=x onerror=window.__pwned=1>\u0007\nnext" },
    { type: "tx", ref: TXID.toUpperCase(), label: "x".repeat(1000), origin: `wpkh([${MASTER_FINGERPRINT.toUpperCase()}/84'/1'/0'])` },
    { type: "addr", ref: "__proto__", label: "polluted" },
    { type: "tx", ref: "constructor", label: "polluted" },
    { type: "addr", ref: theirs, label: "theirs" }, // no origin: not among this account's addresses
    { type: "addr", ref: a1, label: "other origin", origin: `wpkh([${MASTER_FINGERPRINT}/84h/1h/1h])` },
    { type: "tx", ref: OTHER_TXID, label: "not in history" },
    { type: "xpub", ref: "tpub…", label: "skipped" },
    { type: "addr", ref: a1, label: 42 },
  ].map((r) => JSON.stringify(r));
  lines.splice(3, 0, "{not json", "null", '"a string"', "[]");
  const record = {};
  const done = importLabels(lines.join("\n"), account, record, { own, txids });
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(record.labels.addr), Object.prototype);
  assert.deepEqual(Object.keys(record.labels.addr), [a1]);
  assert.deepEqual(Object.keys(record.labels.tx), [TXID]);
  // the last record for a1 wins, and a number for a label is no label
  assert.equal(record.labels.addr[a1], "");
  assert.equal([...record.labels.tx[TXID]].length, MAX_LABEL);
  assert.deepEqual(done.orphans.map((o) => o.label), ["theirs", "other origin", "not in history"]);
  assert.equal(done.bad, 6); // four unreadable lines, two refs that are neither address nor txid
  assert.equal(done.skipped, 1);
  // the hostile label, read on its own: kept as text, control characters made spaces
  const one = {};
  importLabels(lines[0], account, one, { own, txids });
  assert.equal(one.labels.addr[a1], "<img src=x onerror=window.__pwned=1>  next");
  assert.throws(() => importLabels("\n\n", account, {}, { own, txids }), LabelError);
  assert.throws(() => importLabels("x".repeat((1 << 20) + 1), account, {}, { own, txids }), LabelError);
});

test("labels read from storage are checked the same way", () => {
  const got = labelsOf({ labels: { addr: { __proto__: "x", "tb1qok00000000000000": "fine", "bad ref!": "no" }, tx: { [TXID]: 5, [OTHER_TXID]: "ok" } } });
  assert.deepEqual([...got.addr], [["tb1qok00000000000000", "fine"]]);
  assert.deepEqual([...got.tx], [[OTHER_TXID, "ok"]]);
  assert.deepEqual([...labelsOf({}).addr], []);
});
