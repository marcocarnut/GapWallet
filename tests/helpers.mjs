// What the tests share: a small chain in memory that speaks Esplora, and the
// real signer.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { webcrypto } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installCrypto } from "../src/crypto.js";
import { fromHex, fromHexReversed, toHex } from "../vendor/zerogap/psbt/bytes.js";
import { serializeTx, txid as txidOf } from "../vendor/zerogap/psbt/tx.js";
import { GENESIS } from "../src/esplora.js";
import { addressToScript, scriptToAddress } from "../vendor/zerogap/psbt/script.js";

installCrypto();
globalThis.crypto ??= webcrypto; // Node 18

const HERE = dirname(fileURLToPath(import.meta.url));
export const ZEROGAP = resolve(process.env.ZEROGAP_DIR || join(HERE, "..", "..", "lvglzero"));
export const haveSigner = existsSync(join(ZEROGAP, "apps/signer/lib/sign.js"));

// BIP-84's vectors' wallet, public from its first day.
export const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const MASTER_FINGERPRINT = "73c5da0a";
export const ZPUB0 = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

// The signer's own libraries, under Node, with its reference cryptography.
export async function loadSigner() {
  const url = (p) => pathToFileURL(join(ZEROGAP, p)).href;
  const ref = await import(url("tests/signer/crypto_ref.mjs"));
  const { setCrypto } = await import(url("apps/signer/lib/crypto.js"));
  setCrypto(ref);
  const bip32 = await import(url("apps/signer/lib/bip32.js"));
  const bip39 = await import(url("apps/signer/lib/bip39.js"));
  const sign = await import(url("apps/signer/lib/sign.js"));
  const psbtLib = await import(url("apps/signer/lib/psbt/psbt.js"));
  const transport = await import(url("apps/signer/lib/psbt/transport.js"));
  const codes = await import(url("apps/signer/lib/codes.js"));
  const master = bip32.fromSeed(bip39.seedFromMnemonic(MNEMONIC, ""));
  return { ref, bip32, sign, psbtLib, transport, codes, master };
}

const json = (body) => ({ status: 200, body: JSON.stringify(body), type: "application/json" });
const text = (body) => ({ status: 200, body: String(body), type: "text/plain" });
const stats = (funded, fundedSum, spent, spentSum, txs) => ({ funded_txo_count: funded, funded_txo_sum: fundedSum,
  spent_txo_count: spent, spent_txo_sum: spentSum, tx_count: txs });

// A chain: transactions added by fund()/add(), confirmed at a height, or in
// the mempool with `height: null`.
export class Chain {
  constructor(network = "signet", { pageSize = 25 } = {}) {
    this.network = network;
    this.tip = 200000;
    this.txs = new Map(); // txid -> { tx, height, inputs: [{ address, value }] }
    this.pageSize = pageSize;
    this.requests = [];
    this.fees = { 1: 12, 3: 8, 6: 4.5, 144: 1.5, 1008: 1 };
    this.broadcasts = [];
    this.overrides = []; // [(method, path, body) -> response | null]
    this.nonce = 0;
    this.limit = null; // { perWindow, windowMs, clock }: like mempool.space's nginx
    this.times = [];
    this.limited = 0;
    this.lib = network === "mainnet" ? "mainnet" : "testnet";
  }

  // Pays `value` to each address from an outside coin. -> { txid, vout }
  fund(address, value, height = this.tip - 10) {
    const script = addressToScript(address, this.lib);
    const tx = { version: 2, locktime: 0, segwit: true,
      inputs: [{ txid: fromHex((++this.nonce).toString(16).padStart(64, "a")), vout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff,
        witness: [Uint8Array.of(1, 2, 3)] }],
      outputs: [{ value, script }] };
    return { txid: this.add(tx, height, [{ address: "tb1qq0000000000000000000000000000000outside", value: value + 1000 }]), vout: 0 };
  }

  add(tx, height, inputs) {
    const txid = txidOf(tx);
    this.txs.set(txid, { tx, height, inputs });
    return txid;
  }

  address(a) {
    const script = toHex(addressToScript(a, this.lib));
    const funded = [], spent = [];
    for (const [txid, t] of this.txs) {
      t.tx.outputs.forEach((o, vout) => {
        if (toHex(o.script) === script) funded.push({ txid, vout, value: o.value, height: t.height });
      });
      t.inputs.forEach((i) => {
        if (i.address === a) spent.push({ value: i.value, height: t.height, txid });
      });
    }
    return { funded, spent };
  }

  isSpent(txid, vout) {
    for (const t of this.txs.values()) {
      if (t.tx.inputs.some((i) => toHex(Uint8Array.from(i.txid).reverse()) === txid && i.vout === vout)) return true;
    }
    return false;
  }

  esploraTx(txid) {
    const t = this.txs.get(txid);
    const status = t.height === null ? { confirmed: false } : { confirmed: true, block_height: t.height, block_time: 1700000000 + t.height };
    return { txid, fee: 1000, status,
      vin: t.tx.inputs.map((_, i) => ({ txid: "00".repeat(32), vout: 0,
        prevout: t.inputs[i] ? { scriptpubkey_address: t.inputs[i].address, value: t.inputs[i].value } : null })),
      vout: t.tx.outputs.map((o) => ({ scriptpubkey_address: scriptToAddress(o.script, this.lib), value: o.value })) };
  }

  txsOf(a) {
    const script = toHex(addressToScript(a, this.lib));
    return [...this.txs].filter(([, t]) => t.tx.outputs.some((o) => toHex(o.script) === script) || t.inputs.some((i) => i.address === a))
      .sort(([, x], [, y]) => (y.height ?? Infinity) - (x.height ?? Infinity)).map(([id]) => id);
  }

  // True when this request is over the limit
  overLimit() {
    if (!this.limit) return false;
    const { perWindow, windowMs, clock = Date.now } = this.limit;
    const now = clock();
    this.times = this.times.filter((t) => now - t < windowMs);
    if (this.times.length >= perWindow) {
      this.limited++;
      return true;
    }
    this.times.push(now);
    return false;
  }

  handle(method, path, body) {
    this.requests.push(`${method} ${path}`);
    for (const o of this.overrides) {
      const r = o(method, path, body);
      if (r) return r;
    }
    let m;
    if (path === "/block-height/0") return text(GENESIS[this.network]);
    if (path === "/blocks/tip/height") return text(this.tip);
    if (path === "/fee-estimates") return { ...json(this.fees), status: 203 };
    if (method === "POST" && path === "/tx") {
      this.broadcasts.push(body);
      return text(this.onBroadcast ? this.onBroadcast(body) : "00".repeat(32));
    }
    if ((m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path))) {
      const t = this.txs.get(m[1]);
      return t ? text(toHex(serializeTx(t.tx))) : { status: 404, body: "Transaction not found", type: "text/plain" };
    }
    if ((m = /^\/address\/([^/]+)$/.exec(path))) {
      const { funded, spent } = this.address(m[1]);
      const side = (conf) => stats(funded.filter((f) => (f.height !== null) === conf).length,
        funded.filter((f) => (f.height !== null) === conf).reduce((s, f) => s + f.value, 0),
        spent.filter((f) => (f.height !== null) === conf).length, spent.filter((f) => (f.height !== null) === conf).reduce((s, f) => s + f.value, 0),
        this.txsOf(m[1]).filter((id) => (this.txs.get(id).height !== null) === conf).length);
      return json({ address: m[1], chain_stats: side(true), mempool_stats: side(false) });
    }
    if ((m = /^\/address\/([^/]+)\/utxo$/.exec(path))) {
      return json(this.address(m[1]).funded.filter((f) => !this.isSpent(f.txid, f.vout)).map((f) => ({ txid: f.txid, vout: f.vout, value: f.value,
        status: f.height === null ? { confirmed: false } : { confirmed: true, block_height: f.height, block_time: 1700000000 } })));
    }
    if ((m = /^\/address\/([^/]+)\/txs$/.exec(path))) {
      const all = this.txsOf(m[1]);
      const pool = all.filter((id) => this.txs.get(id).height === null);
      const conf = all.filter((id) => this.txs.get(id).height !== null).slice(0, this.pageSize);
      return json([...pool, ...conf].map((id) => this.esploraTx(id)));
    }
    if ((m = /^\/address\/([^/]+)\/txs\/chain\/([0-9a-f]{64})$/.exec(path))) {
      const conf = this.txsOf(m[1]).filter((id) => this.txs.get(id).height !== null);
      return json(conf.slice(conf.indexOf(m[2]) + 1, conf.indexOf(m[2]) + 1 + this.pageSize).map((id) => this.esploraTx(id)));
    }
    return { status: 404, body: "not in the stub: " + path, type: "text/plain" };
  }

  // A fetch() that goes to handle(), for Esplora({ fetch })
  fetch = async (url, init = {}) => {
    // what a browser sees of a 429 with no CORS header: no answer at all
    if (this.overLimit()) throw new TypeError("Failed to fetch");
    const path = url.replace(/^https?:\/\/[^/]+(\/api)?/, "");
    const r = this.handle(init.method || "GET", path, init.body);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body,
      headers: new Map(Object.entries(r.headers || {})) };
  };
}
