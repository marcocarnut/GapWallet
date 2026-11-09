// The Esplora client against answers recorded from mempool.space
// (tools/record_fixtures.mjs): the shapes are the real ones.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./helpers.mjs";
import { Esplora, EsploraError, GENESIS } from "../src/esplora.js";
import { historyItem } from "../src/scan.js";
import { fromHex } from "../vendor/gapkeep/psbt/bytes.js";
import { parseTx, txid as txidOf } from "../vendor/gapkeep/psbt/tx.js";

for (const network of ["signet", "testnet4"]) {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/${network}.json`, import.meta.url), "utf8"));
  const fetchFixture = async (url) => {
    const a = f.answers[url.slice(f.base.length)];
    assert.ok(a, `not recorded: ${url}`);
    return { status: a.status, ok: a.status >= 200 && a.status < 300, text: async () => a.body, headers: new Map() };
  };
  const c = new Esplora(f.base, { fetch: fetchFixture, sleep: async () => {} });

  test(`${network}: recorded answers`, async () => {
    await c.checkNetwork(network);
    assert.equal(GENESIS[network], f.answers["/block-height/0"].body);
    assert.ok((await c.tipHeight()) > 100000);
    assert.equal(f.answers["/fee-estimates"].status, 203);
    assert.equal(typeof (await c.feeEstimates())["6"], "number");

    const s = await c.address(f.address);
    for (const side of [s.chain_stats, s.mempool_stats]) {
      for (const k of ["funded_txo_count", "funded_txo_sum", "spent_txo_count", "spent_txo_sum", "tx_count"]) assert.equal(typeof side[k], "number", k);
    }
    const utxos = await c.utxos(f.address);
    for (const u of utxos) {
      assert.match(u.txid, /^[0-9a-f]{64}$/);
      assert.equal(typeof u.vout, "number");
      assert.equal(typeof u.value, "number");
      assert.equal(typeof u.status.confirmed, "boolean");
    }
    const txs = await c.txs(f.address);
    assert.ok(txs.length > 0);
    const mine = new Set([f.address]);
    for (const t of txs) {
      const item = historyItem(t, mine, 300000);
      assert.equal(item.txid, t.txid);
      assert.equal(typeof item.net, "number");
      assert.equal(typeof t.fee, "number");
    }
    const hex = await c.txHex(txs[0].txid);
    assert.equal(txidOf(parseTx(fromHex(hex))), txs[0].txid);

    const last = txs.filter((t) => t.status.confirmed).at(-1);
    const older = await c.txsAfter(f.address, last.txid);
    assert.ok(Array.isArray(older));
  });

  test(`${network}: a bad address's error reads as text`, async () => {
    await assert.rejects(c.address("notanaddress"), (e) => e instanceof EsploraError && /400: Invalid Bitcoin address/.test(e.message));
  });
}
