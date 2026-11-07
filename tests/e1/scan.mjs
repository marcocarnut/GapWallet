// E1: the test wallet's coins, read through the public signet server at its pace.
//
//   node --experimental-default-type=module tests/e1/scan.mjs
//
// Reads only. Not part of npm test.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import "../helpers.mjs";
import { parseAccount } from "../../src/descriptor.js";
import { addressAt } from "../../src/account.js";
import { Esplora } from "../../src/esplora.js";
import { scanAccount } from "../../src/scan.js";
import { DESCRIPTORS, FINGERPRINT, RECEIVE, SERVER } from "./wallet.mjs";

const client = new Esplora(SERVER);
await client.checkNetwork("signet");
console.log(`signet confirmed by genesis hash, interval ${client.interval} ms`);
for (const purpose of [84, 49]) {
  const account = parseAccount(DESCRIPTORS[purpose], "signet", FINGERPRINT);
  RECEIVE[purpose].forEach((a, i) => assert.equal(addressAt(account, 0, i).address, a));
  const t0 = Date.now();
  const scan = await scanAccount(account, client);
  console.log(`${purpose}h: tip ${scan.tip}, balance ${JSON.stringify(scan.balance)}, next ${scan.next}, ${scan.history.length} history rows, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const c of scan.coins) {
    console.log(`  ${c.entry.path} ${c.value} sat, ${c.height ? `height ${c.height}` : "unconfirmed"}, ${c.txid}:${c.vout}`);
  }
}
