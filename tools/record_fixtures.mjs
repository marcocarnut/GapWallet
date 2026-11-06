// Records real answers from mempool.space into tests/fixtures/, for
// tests/fixtures.test.mjs: the answers' shapes are checked against real
// servers, not against what we think they say. Addresses are public test keys'.
//
//   node --experimental-default-type=module tools/record_fixtures.mjs
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, writeFileSync } from "node:fs";
import { PRESETS } from "../src/esplora.js";


const dir = new URL("../tests/fixtures/", import.meta.url);
mkdirSync(dir, { recursive: true });
const recorded = {};
const raw = {};
const say = (s) => process.stderr.write(s + "\n");

// The real answers can be huge (one address has thousands of coins): the
// tests need their shape, so long lists keep their first entries.
function shorten(body) {
  if (body.length < 100000 || !body.startsWith("[")) return body;
  return JSON.stringify(JSON.parse(body).slice(0, 20));
}

async function get(base, path) {
  const r = await fetch(base + path);
  const body = await r.text();
  raw[path] = { status: r.status, type: r.headers.get("content-type"), body: shorten(body) };
  await new Promise((d) => setTimeout(d, 150));
  return r.status === 200 ? body : null;
}

for (const network of ["signet", "testnet4"]) {
  const base = PRESETS[network];
  for (const k of Object.keys(raw)) delete raw[k];
  const address = process.argv[network === "signet" ? 2 : 3];
  await get(base, "/block-height/0");
  await get(base, "/blocks/tip/height");
  await get(base, "/fee-estimates");
  await get(base, `/address/${address}`);
  await get(base, `/address/${address}/utxo`);
  const list = JSON.parse((await get(base, `/address/${address}/txs`)) || "[]");
  const confirmed = list.filter((t) => t.status.confirmed);
  if (confirmed.length) await get(base, `/address/${address}/txs/chain/${confirmed[confirmed.length - 1].txid}`);
  if (list[0]) await get(base, `/tx/${list[0].txid}/hex`);
  await get(base, "/address/notanaddress");
  recorded[network] = { address, base, at: new Date().toISOString().slice(0, 10), answers: { ...raw } };
  say(`${network}: ${address}: ${list.length} txs`);
  writeFileSync(new URL(`${network}.json`, dir), JSON.stringify(recorded[network], null, 1) + "\n");
}
