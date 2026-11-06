// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Chain, ZPUB0, MASTER_FINGERPRINT, ZEROGAP, haveSigner, loadSigner } from "./helpers.mjs";
import { parseAccount, accountDescriptor, descriptorChecksum, ImportError } from "../src/descriptor.js";
import { addressAt } from "../src/account.js";
import { Esplora, EsploraError, OWN_INTERVAL_MS, PRESETS, PUBLIC_INTERVAL_MS, parseServer } from "../src/esplora.js";
import { scanAccount } from "../src/scan.js";
import { cleanEstimates, selectCoins, vsizeOf, feeFor, feeWarnings, MIN_RATE, SelectError } from "../src/coinselect.js";
import { buildSpend, psbtBytes, BuildError, SEQUENCE_RBF } from "../src/build.js";
import { readSigned } from "../src/signed.js";
import { toHex, fromHex } from "../vendor/zerogap/psbt/bytes.js";
import { parsePsbt } from "../vendor/zerogap/psbt/psbt.js";
import { serializeXpub, parseXpub } from "../vendor/zerogap/bip32.js";
import { electrumQrText } from "../vendor/zerogap/psbt/transport.js";
import { parseTx, serializeTx, txid as txidOf } from "../vendor/zerogap/psbt/tx.js";

// A client on a clock of its own: sleeping takes no real time.
function client(chain, opts) {
  let now = 1000;
  const clock = () => now;
  if (chain.limit) chain.limit.clock = clock;
  return new Esplora("https://stub.example/api", { fetch: chain.fetch, clock, sleep: async (ms) => { now += ms; }, ...opts });
}
const fixed = () => 0; // a shuffle that always takes the first
const mainAccount = () => parseAccount(ZPUB0, "mainnet", MASTER_FINGERPRINT);

// The test wallet on signet, from the signer's own derivation of the same seed
async function signetAccount() {
  const s = await loadSigner();
  const node = s.bip32.neuter(s.bip32.derive(s.master, "m/84'/1'/0'"));
  return { s, account: parseAccount(s.bip32.serializeXpub(node, "vpub"), "signet", s.bip32.fingerprintHex(s.master)) };
}
// A signet account with no signer around: BIP-84's key, version changed.
function testAccount(network = "signet", fp = MASTER_FINGERPRINT) {
  const { node } = parseXpub(ZPUB0);
  return parseAccount(serializeXpub(node, "vpub"), network, fp);
}

test("BIP-380 checksum", () => {
  assert.equal(descriptorChecksum("raw(deadbeef)"), "89f8spxm");
});

test("BIP-84 addresses from the zpub", () => {
  const V = JSON.parse(readFileSync(`${ZEROGAP}/tests/signer/vectors.json`, "utf8")).bip84;
  const a = mainAccount();
  assert.equal(a.account, 0);
  for (const v of V.addresses) {
    const [, , , , chain, index] = v.path.split("/");
    const got = addressAt(a, Number(chain), Number(index));
    assert.equal(got.address, v.address);
    assert.equal(toHex(got.pubkey), v.pubkey);
    assert.equal(got.path, v.path);
  }
});

test("descriptor round trip", () => {
  const a = mainAccount();
  const d = accountDescriptor(a);
  assert.match(d, /^wpkh\(\[73c5da0a\/84h\/0h\/0h\]xpub.*\/<0;1>\/\*\)#[a-z0-9]{8}$/);
  const b = parseAccount(d, "mainnet");
  assert.equal(b.fingerprint, MASTER_FINGERPRINT);
  assert.deepEqual(b.warnings, []);
  assert.equal(addressAt(b, 0, 0).address, addressAt(a, 0, 0).address);
  assert.equal(parseAccount(d.replace(/h\//g, "'/").replace("0h]", "0']").replace(/#.*/, ""), "mainnet").warnings.length, 1);
});

test("imports refused", () => {
  const d = accountDescriptor(mainAccount());
  const refuse = (text, net, re, fp) => assert.throws(() => parseAccount(text, net, fp), (e) => e instanceof ImportError && re.test(e.message));
  refuse(d.slice(0, -1) + (d.endsWith("q") ? "p" : "q"), "mainnet", /checksum/);
  refuse(ZPUB0, "signet", /for mainnet/);
  refuse(d, "testnet4", /for mainnet/);
  refuse(serializeXpub(parseXpub(ZPUB0).node, "vpub"), "mainnet", /test network/);
  refuse("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi", "mainnet", /private key/);
  refuse(`wpkh(xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi/<0;1>/*)`, "mainnet", /private key/);
  refuse("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "mainnet", /seed/);
  refuse("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn", "mainnet", /private key/);
  refuse(ZPUB0.slice(0, -1) + "t", "mainnet", /can't be read/);
  refuse(serializeXpub(parseXpub(ZPUB0).node, "xpub"), "mainnet", /descriptor/);
  refuse(d.replace("84h/0h/0h", "84h/0h/1h").replace(/#.*/, ""), "mainnet", /origin/);
  refuse(d.replace("<0;1>", "0").replace(/#.*/, ""), "mainnet", /one chain/);
  refuse(`sh(${d.replace(/#.*/, "")})`, "mainnet", /wpkh/);
  refuse(ZPUB0, "mainnet", /8 hexadecimal/, "xyz");
  refuse(d, "mainnet", /isn't the one/, "00000000");
  const shallow = { ...parseXpub(ZPUB0).node, depth: 2 };
  refuse(serializeXpub(shallow, "zpub"), "mainnet", /depth 2/);
  const soft = { ...parseXpub(ZPUB0).node, childNumber: 5 };
  refuse(serializeXpub(soft, "zpub"), "mainnet", /hardened/);
});

test("the account comes from the key's child number; a zpub without fingerprint is watch-only", () => {
  const node = { ...parseXpub(ZPUB0).node, childNumber: 0x80000007 };
  const a = parseAccount(serializeXpub(node, "zpub"), "mainnet");
  assert.equal(a.account, 7);
  assert.equal(a.fingerprint, null);
  assert.equal(addressAt(a, 1, 2).path, "m/84'/0'/7'/1/2");
});

test("server addresses", () => {
  assert.deepEqual(parseServer(" https://mempool.space/signet/api/ "), { base: "https://mempool.space/signet/api", origin: "https://mempool.space" });
  assert.equal(parseServer("http://192.168.1.5:3002").base, "http://192.168.1.5:3002");
  for (const bad of ["mempool.space", "ftp://x.y", "https://u:p@x.y/", "https://x.y/?a=1"]) assert.throws(() => parseServer(bad), EsploraError);
});

test("a server on the wrong network is refused", async () => {
  await client(new Chain("signet")).checkNetwork("signet");
  await assert.rejects(client(new Chain("signet")).checkNetwork("testnet4"), /isn't on testnet4/);
});

test("retries: a 429 we can see, then success; POST never retried; 203 is success", async () => {
  const chain = new Chain("signet");
  let n = 0;
  chain.overrides.push((m, p) => (p === "/blocks/tip/height" && n++ < 2 ? { status: 429, body: "slow down", type: "text/plain" } : null));
  assert.equal(await client(chain).tipHeight(), 200000);
  assert.equal(n, 3);
  assert.equal((await client(chain).feeEstimates())[6], 4.5);

  const failing = new Chain("signet");
  failing.overrides.push((m, p) => (p === "/tx" ? { status: 400, body: 'sendrawtransaction RPC error: {"code":-25}', type: "text/plain" } : null));
  await assert.rejects(client(failing).broadcast("00"), /RPC error/);
  assert.equal(failing.requests.filter((r) => r === "POST /tx").length, 1);

  const down = new Chain("signet");
  down.overrides.push(() => ({ status: 503, body: "", type: "text/plain" }));
  await assert.rejects(client(down).tipHeight(), /busy/);
  assert.equal(down.requests.length, 7);
});

test("a server that hides its limit from the browser: the scan slows down and finishes", async () => {
  const a = testAccount();
  const chain = new Chain("signet");
  chain.limit = { perWindow: 3, windowMs: 1000 }; // about what a busy public server allows
  chain.fund(addressAt(a, 0, 4).address, 12345);
  chain.fund(addressAt(a, 1, 1).address, 1000);
  const c = client(chain);
  const held = [];
  c.onHold = (s) => held.push(s);
  const scan = await scanAccount(a, c, { gapLimit: 20 });
  assert.equal(scan.balance.confirmed, 13345);
  assert.ok(chain.limited > 0, "the limit was reached");
  assert.ok(held.length > 0, "the wait was reported");
});

test("a server that stays down gives up, with a message that doesn't blame the wrong thing", async () => {
  const chain = new Chain("signet");
  chain.limit = { perWindow: 0, windowMs: 1000 };
  await assert.rejects(client(chain).tipHeight(), /can't be reached, or is limiting requests/);
  assert.equal(chain.limited, 7);
});

test("requests are paced from the start, and a failure holds them all", async () => {
  const chain = new Chain("signet");
  const starts = [];
  let now = 0;
  const f = async (url, init) => {
    starts.push(now);
    return chain.fetch(url, init);
  };
  // Virtual time: sleepers wake one by one, earliest first, so overlapping
  // sleeps overlap as they do on a real clock.
  const timers = [];
  const sleep = (ms) => new Promise((wake) => timers.push({ at: now + ms, wake }));
  const run = async (work) => {
    let done = false;
    const result = work().finally(() => { done = true; });
    while (!done) {
      await new Promise((r) => setImmediate(r));
      if (timers.length) {
        timers.sort((x, y) => x.at - y.at);
        const t = timers.shift();
        now = Math.max(now, t.at);
        t.wake();
      }
    }
    return result;
  };
  const c = new Esplora("https://stub.example/api", { fetch: f, clock: () => now, sleep, interval: OWN_INTERVAL_MS });
  await run(() => Promise.all(Array.from({ length: 8 }, () => c.tipHeight())));
  assert.equal(starts.length, 8);
  starts.forEach((t, i) => assert.ok(i === 0 || t - starts[i - 1] >= OWN_INTERVAL_MS, `start ${i} at ${t}, the one before at ${starts[i - 1]}`));
  c.failed(5000);
  const before = now;
  await run(() => c.tipHeight());
  assert.ok(starts.at(-1) - before >= 5000);
  assert.equal(c.interval, OWN_INTERVAL_MS * 2);
  for (const pub of [PRESETS.signet, "https://blockstream.info/signet/api", "https://esplora.example.com", "http://172.32.0.1", "http://192.169.1.1"]) {
    assert.equal(new Esplora(pub).interval, PUBLIC_INTERVAL_MS, pub);
  }
  for (const own of ["http://192.168.1.5:3002", "http://localhost:3002", "http://127.0.0.1:3002", "http://10.1.2.3", "http://172.16.0.1", "http://nas.local:3002", "http://[::1]:3002"]) {
    assert.equal(new Esplora(own).interval, OWN_INTERVAL_MS, own);
  }
});

test("an empty account costs exactly twice the gap limit, plus the tip", async () => {
  const chain = new Chain("signet");
  const scan = await scanAccount(testAccount(), client(chain), { gapLimit: 20 });
  assert.equal(chain.requests.filter((r) => r.startsWith("GET /address/")).length, 40);
  assert.deepEqual(scan.next, [0, 0]);
  assert.deepEqual(scan.balance, { confirmed: 0, unconfirmed: 0 });
});

test("the gap: a coin at the last index the gap reaches is found, one past isn't", async () => {
  const a = testAccount();
  const chain = new Chain("signet");
  chain.fund(addressAt(a, 0, 19).address, 1000);
  const scan = await scanAccount(a, client(chain), { gapLimit: 20 });
  assert.equal(scan.balance.confirmed, 1000);
  assert.equal(scan.next[0], 20);
  assert.equal(chain.requests.filter((r) => /\/address\/[^/]+$/.test(r)).length, 40 + 20);

  const far = new Chain("signet");
  far.fund(addressAt(a, 0, 20).address, 1000);
  assert.equal((await scanAccount(a, client(far), { gapLimit: 20 })).balance.confirmed, 0);
  assert.equal((await scanAccount(a, client(far), { gapLimit: 21 })).balance.confirmed, 1000);
});

test("history pages, balances, unconfirmed coins", async () => {
  const a = testAccount();
  const chain = new Chain("signet", { pageSize: 3 });
  const addr = addressAt(a, 0, 0).address;
  for (let i = 0; i < 8; i++) chain.fund(addr, 1000 + i, 1000 + i);
  chain.fund(addressAt(a, 0, 2).address, 5000, null);
  const scan = await scanAccount(a, client(chain), { gapLimit: 5 });
  assert.equal(scan.history.length, 9);
  assert.equal(scan.history[0].height, null);
  assert.equal(scan.history[1].height, 1007);
  assert.equal(scan.balance.confirmed, 8028);
  assert.equal(scan.balance.unconfirmed, 5000);
  assert.equal(scan.coins[0].confirmed, false);
  assert.equal(scan.history[1].confirmations, chain.tip - 1007 + 1);
  assert.deepEqual(scan.next, [3, 0]);
});

test("a self-transfer is marked, not shown as zero", async () => {
  const { historyItem } = await import("../src/scan.js");
  const mine = new Set(["a", "b"]);
  const tx = (vin, vout) => ({ txid: "t", fee: 200, status: { confirmed: true, block_height: 10 },
    vin: vin.map(([scriptpubkey_address, value]) => ({ prevout: { scriptpubkey_address, value } })),
    vout: vout.map(([scriptpubkey_address, value]) => ({ scriptpubkey_address, value })) });
  const self = historyItem(tx([["a", 1000]], [["b", 800]]), mine, 10);
  assert.equal(self.kind, "self");
  assert.equal(self.net, -200);
  const out = historyItem(tx([["a", 1000]], [["b", 300], ["x", 500]]), mine, 10);
  assert.equal(out.kind, "out");
  assert.equal(out.net, -700);
  const inward = historyItem(tx([["x", 1000]], [["a", 800]]), mine, 12);
  assert.equal(inward.kind, "in");
  assert.equal(inward.net, 800);
  assert.equal(inward.confirmations, 3);
});

test("sizes against a real transaction's arithmetic", () => {
  assert.equal(vsizeOf(1, [22, 22]), 141); // the familiar 1-in 2-out P2WPKH with 72-byte signature
  assert.equal(vsizeOf(2, [22, 22]), 209);
  assert.equal(feeFor(141, 1.1), 156);
  assert.equal(feeFor(100, 1.1), 110);
  assert.equal(feeFor(141, 0.1), 15);
});

const coin = (value, n, confirmed = true) => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value, confirmed });
const SCRIPT = [22];

test("selection: exact, smallest cover, largest first, dust to fee, determinism", () => {
  const coins = [coin(100000, 1), coin(50000, 2), coin(30000, 3), coin(9000, 4)];
  const rate = 2;
  const noChange = feeFor(vsizeOf(1, SCRIPT), rate);
  // 1. a coin just over amount + fee: no change
  let s = selectCoins({ coins, amount: 50000 - noChange - 20, scripts: SCRIPT, rate });
  assert.equal(s.inputs.length, 1);
  assert.equal(s.inputs[0].value, 50000);
  assert.equal(s.change, 0);
  assert.equal(s.fee, noChange + 20);
  // 2. smallest cover, with change
  s = selectCoins({ coins, amount: 20000, scripts: SCRIPT, rate });
  assert.equal(s.inputs[0].value, 30000);
  assert.equal(s.change, 30000 - 20000 - feeFor(vsizeOf(1, [22, 22]), rate));
  // 3. largest first
  s = selectCoins({ coins, amount: 120000, scripts: SCRIPT, rate });
  assert.deepEqual(s.inputs.map((c) => c.value), [100000, 50000]);
  assert.equal(s.inputs.reduce((n, c) => n + c.value, 0), s.amount + s.fee + s.change);
  // the same inputs in any order give the same answer
  assert.deepEqual(selectCoins({ coins: [...coins].reverse(), amount: 120000, scripts: SCRIPT, rate }).inputs.map((c) => c.txid), s.inputs.map((c) => c.txid));
  // change under dust goes to the fee, and says so
  const withChange = feeFor(vsizeOf(1, [22, 22]), rate);
  s = selectCoins({ coins: [coin(100000, 1)], amount: 100000 - withChange - 200, scripts: SCRIPT, rate });
  assert.equal(s.change, 0);
  assert.ok(s.dropped > 0);
  assert.equal(s.fee + s.amount, 100000);
});

test("selection: unconfirmed left alone, by hand or not; dust-sized coins skipped; send everything", () => {
  const coins = [coin(5000, 1), coin(70000, 2, false), coin(50, 3)];
  assert.throws(() => selectCoins({ coins, amount: 40000, scripts: SCRIPT, rate: 1 }), (e) => e instanceof SelectError && /70000 sat is unconfirmed/.test(e.message));
  const hand = selectCoins({ coins: [coins[1]], manual: true, amount: 40000, scripts: SCRIPT, rate: 1 });
  assert.equal(hand.inputs.length, 1);
  assert.equal(hand.change, 70000 - 40000 - 141);
  assert.equal(selectCoins({ coins, amount: 1000, scripts: SCRIPT, rate: 10 }).skipped, 1);
  const all = selectCoins({ coins, sendAll: true, scripts: SCRIPT, rate: 1 });
  assert.equal(all.inputs.length, 2);
  assert.equal(all.change, 0);
  assert.equal(all.amount, 5050 - all.fee);
  assert.throws(() => selectCoins({ coins: [coin(100, 1)], sendAll: true, scripts: SCRIPT, rate: 10 }), SelectError);
});

test("estimates as a real server gives them", () => {
  const got = cleanEstimates({ 1: 5.029, 6: 1.0000000000000002, 144: 0.09999999999999999, 500: 0.01, 900: "x", 1000: null });
  assert.deepEqual(got, { 1: 5.029, 6: 1, 144: MIN_RATE, 500: MIN_RATE });
});

test("fee warnings", () => {
  assert.equal(feeWarnings({ fee: 100, amount: 100000, rate: 1, estimate: 1 }).length, 0);
  assert.match(feeWarnings({ fee: 6000, amount: 100000, rate: 1, estimate: 1 })[0], /6\.0%/);
  assert.match(feeWarnings({ fee: 10, amount: 100000, rate: 40, estimate: 10 })[0], /3 times/);
});

async function funded(values = [100000], account = testAccount()) {
  const chain = new Chain(account.network);
  values.forEach((v, i) => chain.fund(addressAt(account, 0, i).address, v));
  const c = client(chain);
  return { chain, c, account, scan: await scanAccount(account, c, { gapLimit: 5 }) };
}
const PAYEE = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

test("a PSBT holds what BITCOIN.md asks for", async () => {
  const { account, scan, c, chain } = await funded([100000]);
  const spend = await buildSpend(account, scan, { address: PAYEE, amount: 20000, rate: 2 }, c, { random: fixed });
  const psbt = parsePsbt(psbtBytes(account, spend));
  assert.equal(psbt.version, 0);
  assert.equal(psbt.tx.version, 2);
  assert.equal(psbt.tx.locktime, chain.tip);
  assert.ok(psbt.tx.inputs.every((i) => i.sequence === SEQUENCE_RBF));
  const input = psbt.inputs[0].fields;
  assert.ok(input.witnessUtxo);
  assert.equal(input.witnessUtxo.value, 100000);
  assert.ok(input.nonWitnessUtxo);
  assert.equal(input.bip32.length, 1);
  assert.equal(toHex(input.bip32[0].fingerprint), MASTER_FINGERPRINT);
  assert.equal(input.bip32[0].path.length, 5);
  assert.equal(input.bip32[0].path[0], 0x80000054);
  const changeOut = spend.outputs.findIndex((o) => o.change);
  assert.equal(spend.outputs[changeOut].change.path, "m/84'/1'/0'/1/0");
  assert.equal(psbt.outputs[changeOut].fields.bip32.length, 1);
  assert.equal(psbt.outputs[1 - changeOut].fields.bip32.length, 0);
  assert.equal(spend.outputs[changeOut].value, 100000 - 20000 - spend.fee);
  // without the previous transaction: the same transaction, smaller
  const small = psbtBytes(account, spend, { includePrevious: false });
  assert.ok(small.length < psbtBytes(account, spend).length);
  assert.equal(txidOf(parsePsbt(small).tx), spend.txid);
  assert.equal(parsePsbt(small).inputs[0].fields.nonWitnessUtxo, undefined);
});

test("no fingerprint, no PSBT", async () => {
  const account = testAccount("signet", "");
  const { scan, c } = await funded([100000], account);
  await assert.rejects(buildSpend(account, scan, { address: PAYEE, amount: 20000, rate: 2 }, c), /fingerprint/);
});

test("requests refused", async () => {
  const { account, scan, c } = await funded([100000]);
  const go = (r) => buildSpend(account, scan, { address: PAYEE, rate: 2, amount: 20000, ...r }, c);
  await assert.rejects(go({ address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" }), /isn't a Signet address/);
  await assert.rejects(go({ address: "nonsense" }), /isn't a Signet address/);
  await assert.rejects(go({ amount: 100 }), /dust/);
  await assert.rejects(go({ amount: 0 }), /Enter an amount/);
  await assert.rejects(go({ rate: 0.01 }), /fee rate/);
  await assert.rejects(go({ rate: 20000 }), /fee rate/);
  await assert.rejects(go({ amount: 1e9 }), /don't cover/);
});

test("random order uses every position; change is at the next index", async () => {
  const { account, c } = await funded([1000]);
  const chain = new Chain("signet");
  chain.fund(addressAt(account, 0, 0).address, 100000);
  chain.fund(addressAt(account, 1, 0).address, 100000);
  chain.fund(addressAt(account, 1, 1).address, 100000);
  const k = client(chain);
  const scan = await scanAccount(account, k, { gapLimit: 5 });
  assert.deepEqual(scan.next, [1, 2]);
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const s = await buildSpend(account, scan, { address: PAYEE, amount: 20000, rate: 2 }, k);
    seen.add(s.outputs.findIndex((o) => o.change));
    assert.equal(s.outputs.find((o) => o.change).change.index, 2);
  }
  assert.equal(seen.size, 2);
  void c;
});

test("a server that lies about a coin stops the build", async () => {
  const setup = await funded([100000]);
  const { account, scan, c, chain } = setup;
  const req = { address: PAYEE, amount: 20000, rate: 2 };
  // wrong amount
  await assert.rejects(buildSpend(account, { ...scan, coins: [{ ...scan.coins[0], value: 900000 }] }, { ...req, amount: 500000 }, c), /can't be trusted/);
  // a coin that doesn't pay us
  const other = addressAt(account, 0, 1);
  await assert.rejects(buildSpend(account, { ...scan, coins: [{ ...scan.coins[0], entry: other }] }, req, c), /can't be trusted/);
  // another transaction than the one asked for
  const decoy = chain.fund(addressAt(account, 0, 2).address, 100000);
  const hex = chain.handle("GET", `/tx/${decoy.txid}/hex`).body;
  chain.overrides.push((m, p) => (p.startsWith(`/tx/${scan.coins[0].txid}`) ? { status: 200, body: hex, type: "text/plain" } : null));
  await assert.rejects(buildSpend(account, scan, req, c), /wrong transaction/);
});

test("the signed code: same transaction or not", async () => {
  const { account, scan, c } = await funded([100000]);
  const spend = await buildSpend(account, scan, { address: PAYEE, amount: 20000, rate: 2 }, c, { random: fixed });
  const signed = structuredClone(spend.tx);
  signed.inputs.forEach((i) => { i.witness = [new Uint8Array(71), new Uint8Array(33)]; });
  signed.segwit = true;
  const bytes = serializeTx(signed);
  const got = readSigned(electrumQrText(bytes), null, spend);
  assert.equal(got.kind, "tx");
  assert.equal(got.matches, true);
  assert.equal(got.txid, spend.txid);
  assert.equal(got.hex, toHex(bytes));
  assert.equal(readSigned(toHex(bytes), null, spend).matches, true);

  const changed = structuredClone(signed);
  changed.outputs[0].value -= 1;
  assert.equal(readSigned(toHex(serializeTx(changed)), null, spend).matches, false);
  assert.equal(readSigned(toHex(bytes), null, null).matches, false);

  const partial = readSigned(electrumQrText(psbtBytes(account, spend)), null, spend);
  assert.deepEqual([partial.kind, partial.signed, partial.total, partial.matches], ["partial", 0, 1, true]);
  assert.throws(() => readSigned(toHex(serializeTx(spend.tx)), null, spend), /isn't signed/);
  assert.throws(() => readSigned("B$HP0200AABB", null, spend), /./);
  assert.throws(() => readSigned("hello world?", null, spend), /./);
});

test("the private-key functions aren't there", async () => {
  const { cr } = await import("../vendor/zerogap/crypto.js");
  assert.throws(() => cr().ecdsaSign(new Uint8Array(32), new Uint8Array(32)), /watch-only/);
  assert.throws(() => cr().privateKeyTweakAdd(new Uint8Array(32), new Uint8Array(32)), /watch-only/);
});

test("the real signer signs what the wallet builds", { skip: !haveSigner && "no zerogap repository" }, async () => {
  const { s, account } = await signetAccount();
  const chain = new Chain("signet");
  chain.fund(addressAt(account, 0, 0).address, 60000);
  chain.fund(addressAt(account, 0, 3).address, 70000);
  chain.fund(addressAt(account, 1, 0).address, 5000);
  const c = client(chain);
  const scan = await scanAccount(account, c, { gapLimit: 5 });
  const spend = await buildSpend(account, scan, { address: PAYEE, amount: 120000, rate: 3 }, c);
  assert.equal(spend.inputs.length, 2);

  const psbt = s.psbtLib.parsePsbt(psbtBytes(account, spend));
  const options = { network: "testnet" };
  const plan = s.sign.plan(psbt, s.master, options);
  assert.ok(plan.inputs.every((i) => i.sign), JSON.stringify(plan.inputs.map((i) => i.reason)));
  assert.equal(plan.signable, 2);
  const out = plan.outputs.find((o) => o.ours);
  assert.ok(out, "the signer calls the change ours");
  assert.equal(out.role, "change");
  assert.equal(out.problem, null);
  assert.equal(plan.outputs.filter((o) => o.ours).length, 1);

  const signed = s.sign.signPsbt(psbt, s.master, options);
  assert.equal(signed.signed.length, 2);
  const done = s.sign.finalize(signed.psbt);
  assert.equal(done.txid, spend.txid);
  assert.ok(done.vsize <= spend.vsize, `estimated ${spend.vsize}, real ${done.vsize}`);
  assert.ok(spend.vsize - done.vsize <= 2);

  // back through the code the signer shows, and out to the server
  const got = readSigned(s.transport.electrumQrText(done.tx), null, spend);
  assert.equal(got.matches, true);
  chain.onBroadcast = () => got.txid;
  assert.equal(await c.broadcast(got.hex), spend.txid);
  assert.equal(chain.broadcasts[0], toHex(done.tx));
});

test("the signer also takes the PSBT without the previous transaction", { skip: !haveSigner && "no zerogap repository" }, async () => {
  const { s, account } = await signetAccount();
  const { scan, c } = await funded([100000], account);
  const spend = await buildSpend(account, scan, { address: PAYEE, amount: 20000, rate: 2 }, c);
  const psbt = s.psbtLib.parsePsbt(psbtBytes(account, spend, { includePrevious: false }));
  const plan = s.sign.plan(psbt, s.master, { network: "testnet" });
  assert.equal(plan.signable, 1);
  assert.equal(s.sign.finalize(s.sign.signPsbt(psbt, s.master, { network: "testnet" }).psbt).txid, spend.txid);
});

test("a change output that isn't really ours would be caught by the signer", { skip: !haveSigner && "no zerogap repository" }, async () => {
  const { s, account } = await signetAccount();
  const { scan, c } = await funded([100000], account);
  const spend = await buildSpend(account, scan, { address: PAYEE, amount: 20000, rate: 2 }, c);
  const o = spend.outputs.find((x) => x.change);
  o.change = { ...o.change, steps: [...o.change.steps.slice(0, 4), 7] }; // a path that derives another key
  const plan = s.sign.plan(s.psbtLib.parsePsbt(psbtBytes(account, spend)), s.master, { network: "testnet" });
  assert.equal(plan.outputs.filter((x) => x.ours).length, 0);
});

test("failures together slow the pace once, and successes bring it back", () => {
  let now = 0;
  const c = new Esplora("http://own.example", { clock: () => now, fetch: async () => null, interval: 100 });
  c.failed(1000);
  c.failed(2000);
  c.failed(1000);
  assert.equal(c.interval, 200);
  assert.equal(c.heldUntil, 2000);
  now = 2000;
  c.failed(1000);
  assert.equal(c.interval, 400);
  for (let i = 0; i < 200; i++) c.succeeded();
  assert.equal(c.interval, 100);
});
