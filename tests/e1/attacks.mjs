// E1, part 1, the attacks (docs/E1.md): PSBTs this wallet built, edited as a
// hostile computer would, through the real signer app in zerogap's simulator.
// The signer is the one being tested: the wallet isn't involved after the edit.
//
//   node --experimental-default-type=module tests/e1/attacks.mjs [out-dir]
//
// Needs ZEROGAP_DIR (default ../lvglzero) with sim/build/zgsim built, QR decoder
// included. Not part of npm test. The key is BIP-39's public "abandon ... about",
// typed as zerogap's own scenario does, and nothing here touches a network.
// Exits non-zero if the signer doesn't do what a row expects.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chain, ZEROGAP, loadSigner } from "../helpers.mjs";
import { parseAccount } from "../../src/descriptor.js";
import { addressAt } from "../../src/account.js";
import { Esplora } from "../../src/esplora.js";
import { scanAccount } from "../../src/scan.js";
import { buildSpend, psbtBytes } from "../../src/build.js";
import { toHex } from "../../vendor/zerogap/psbt/bytes.js";
import { GLOBAL, IN, OUT, parsePsbt, serializePsbt, setEntry } from "../../vendor/zerogap/psbt/psbt.js";
import { serializeTx } from "../../vendor/zerogap/psbt/tx.js";
import { electrumQrText } from "../../vendor/zerogap/psbt/transport.js";

const PAYEE = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const COINS = [60000, 70000];
const AMOUNT = 100000;
const LOWER_BY = 30000;
const NO_KEY = new Uint8Array(0);
// BIP-39's phrase split 2-of-3, zerogap's tests/signer/signer.txt.in: public test data.
const SHARES = ["ms12zgsqa40sgqvwltnun3f8drxxujvljm648z42my97v2h0", "MS12 ZGSQ CADP 5Q7M V8JL JHZE GN00 LY7V YXSZ CJRW FVJA X6ZD"];

const s = await loadSigner();
const accountAt = (master, fingerprint, purpose, number) => {
  const node = s.bip32.neuter(s.bip32.derive(master, `m/${purpose}'/1'/${number}'`));
  return parseAccount(s.bip32.serializeXpub(node, purpose === 84 ? "vpub" : "upub"), "signet", fingerprint);
};
const fingerprint = s.bip32.fingerprintHex(s.master);
const attackerMaster = s.bip32.fromSeed(new Uint8Array(32).fill(9));

const derivation = (print, steps) => {
  const v = new DataView(new ArrayBuffer(4 + steps.length * 4));
  print.forEach((b, i) => v.setUint8(i, b));
  steps.forEach((n, i) => v.setUint32(4 + i * 4, n, true));
  return new Uint8Array(v.buffer);
};

// A copy of the PSBT with its change output changed, and nothing else.
function moveChange(bytes, at, { script, pubkey, redeemScript, value }) {
  const psbt = parsePsbt(bytes);
  psbt.tx.outputs[at].script = script;
  setEntry(psbt.global, GLOBAL.UNSIGNED_TX, NO_KEY, serializeTx(psbt.tx, { withWitness: false }));
  const out = psbt.outputs[at];
  const old = out.entries.find((e) => e.type === OUT.BIP32_DERIVATION);
  out.entries = out.entries.filter((e) => e !== old);
  setEntry(out, OUT.BIP32_DERIVATION, pubkey ?? old.key, value ?? old.value);
  if (redeemScript) setEntry(out, OUT.REDEEM_SCRIPT, NO_KEY, redeemScript);
  return serializePsbt(psbt);
}

function lowerAmounts(bytes, inputs) {
  const psbt = parsePsbt(bytes);
  for (const i of inputs) {
    const m = psbt.inputs[i];
    const value = Uint8Array.from(m.entries.find((e) => e.type === IN.WITNESS_UTXO).value);
    const view = new DataView(value.buffer);
    view.setBigUint64(0, view.getBigUint64(0, true) - BigInt(LOWER_BY), true);
    setEntry(m, IN.WITNESS_UTXO, NO_KEY, value);
  }
  return serializePsbt(psbt);
}

async function casesFor(purpose) {
  const account = accountAt(s.master, fingerprint, purpose, 0);
  const chain = new Chain("signet");
  COINS.forEach((v, i) => chain.fund(addressAt(account, 0, i).address, v));
  const client = new Esplora("https://stub.example/api", { fetch: chain.fetch, interval: 0 });
  const scan = await scanAccount(account, client, { gapLimit: 5 });
  const spend = await buildSpend(account, scan, { address: PAYEE, amount: AMOUNT, rate: 3 }, client, { random: () => 0 });
  assert.equal(spend.inputs.length, 2);
  const bytes = psbtBytes(account, spend);
  const at = spend.outputs.findIndex((o) => o.change);
  const change = spend.outputs[at].value;
  const fee = spend.fee;
  const honest = { sent: AMOUNT, change, fee };
  const lost = { sent: AMOUNT + change, change: 0, fee };

  const done = s.sign.finalize(s.sign.signPsbt(parsePsbt(bytes), s.master, { network: "testnet" }).psbt);
  assert.equal(done.txid, spend.txid);
  const signedHash = createHash("sha256").update(done.tx).digest("hex").slice(0, 16);

  // told yes anyway, the signer signs the honest input and leaves the one lied about
  const partly = s.sign.signPsbt(parsePsbt(lowerAmounts(bytes, [0])), s.master, { network: "testnet" });
  assert.deepEqual(partly.signed.map((x) => x.input), [1]);
  assert.match(partly.skipped[0].reason, /disagree/);

  const attacker = addressAt(accountAt(attackerMaster, "01020304", purpose, 0), 1, 0);
  const ours = (a, index) => {
    const e = addressAt(a, 1, index);
    return { ...e, value: derivation(Buffer.from(fingerprint, "hex"), e.steps) };
  };
  const other = accountAt(s.master, fingerprint, purpose, 7);
  const name = (n) => `${purpose === 84 ? "wpkh" : "sh-wpkh"} ${n}`;
  return [
    { name: name("unedited (the control)"), row: "control", psbt: bytes, signedHash,
      want: { sign: 2, checked: 1, stray: 0, refuted: 0, totals: honest, danger: false } },
    { name: name("change script and key swapped, path unchanged"), row: "swap", psbt: moveChange(bytes, at, { script: attacker.script, pubkey: attacker.pubkey, redeemScript: attacker.redeemScript }),
      want: { sign: 2, checked: 0, stray: 0, refuted: 1, totals: lost, danger: true }, askSign: true },
    { name: name("change script swapped, key and path still claim ours"), row: "swap", psbt: moveChange(bytes, at, { script: attacker.script, redeemScript: attacker.redeemScript }),
      want: { sign: 2, checked: 0, stray: 0, refuted: 1, totals: lost, danger: true }, askSign: true },
    { name: name("change at index 500000"), row: "stray", psbt: moveChange(bytes, at, ours(account, 500000)),
      want: { sign: 2, checked: 0, stray: 1, refuted: 0, totals: lost } },
    { name: name("change in account 7"), row: "stray", psbt: moveChange(bytes, at, ours(other, 0)),
      want: { sign: 2, checked: 0, stray: 1, refuted: 0, totals: lost } },
    // inputs are at index 0 and 1, so top is 1: green to top + 20, then change
    // with a note (far) to top + 1000, then stray
    { name: name("change at index 21 (top + 20), the last at home"), row: "home", psbt: moveChange(bytes, at, ours(account, 21)),
      want: { sign: 2, checked: 1, stray: 0, far: 0, refuted: 0, totals: honest, notes: 0 } },
    { name: name("change at index 22 (top + 21), the first far"), row: "far", psbt: moveChange(bytes, at, ours(account, 22)),
      want: { sign: 2, checked: 1, stray: 0, far: 1, refuted: 0, totals: honest, notes: 1 } },
    { name: name("change at index 1001 (top + 1000), the last far"), row: "far", psbt: moveChange(bytes, at, ours(account, 1001)),
      want: { sign: 2, checked: 1, stray: 0, far: 1, refuted: 0, totals: honest, notes: 1 } },
    { name: name("change at index 1002 (top + 1001), the first stray"), row: "stray", psbt: moveChange(bytes, at, ours(account, 1002)),
      want: { sign: 2, checked: 0, stray: 1, far: 0, refuted: 0, totals: lost } },
    { name: name("witness UTXO lowered on both inputs"), row: "lowered", psbt: lowerAmounts(bytes, [0, 1]),
      want: { sign: 0, danger: true, totals: honest } },
    { name: name("witness UTXO lowered on one input"), row: "lowered", psbt: lowerAmounts(bytes, [0]),
      want: { sign: 1, danger: true, totals: honest }, signAnyway: true },
  ];
}

function scenario(cases) {
  const lines = ["expect Keyboard attached 60", "expect launcher ready 60", "tile signer", "expect signer ready 10",
    "expect signer selftest: 4 passed, 0 failed 30", "wait 0.5"];
  const show = (c, n) => {
    lines.push("mark", `camera qr ${electrumQrText(c.psbt)}`, "expect signer: change: 15", "camera scene", "wait 0.5", `shot ${n}`);
  };
  // the first case loads the key: Scan, review, Keys, the shares, review
  lines.push("mark", "key ret", "wait 0.3");
  show(cases[0], "00-claimed");
  lines.push("key ret", "wait 0.3", "key ret", "wait 0.3", `type ${SHARES[0]}`, "key ret", `type ${SHARES[1]}`, "key ret", "wait 0.3",
    "mark", "key ret", "expect signer: key loaded 30", "wait 0.5");
  cases.forEach((c, i) => {
    const n = String(i + 1).padStart(2, "0");
    lines.push(`# ${c.name}`);
    if (i === 0) { // reviewed again, with the key
      lines.push("mark", "key ret", "expect signer: change: 5", "wait 0.5", `shot ${n}`);
    } else {
      show(c, n);
    }
    if (c.signedHash) {
      lines.push("mark", "key ret", `expect signer: signed 2 inputs, transaction complete \\(SHA-256 ${c.signedHash}\\) 30`, "wait 0.3", "key tab", "key ret", "wait 0.3");
      return;
    }
    if (c.signAnyway) {
      lines.push("mark", "key ret", "wait 0.5", "key tab", "key ret", "expect signer: signed 1 input 30", "wait 0.5", `shot ${n}-partly`, "key tab", "key ret", "wait 0.3");
      return;
    }
    if (c.askSign) lines.push("key ret", "wait 0.5", `shot ${n}-sign-anyway`, "key ret", "wait 0.3"); // "Don't sign" has the focus
    lines.push("key esc", "wait 0.3", "mark", "key ret", "wait 0.3");
  });
  return `${lines.join("\n")}\n`;
}

// What the signer logged for each review with the key, in order.
function reviews(log) {
  const found = [];
  let at = null;
  for (const raw of log.split("\n")) {
    if (!raw.includes("app:signer: signer: ")) continue;
    const line = raw.replace(/^.*?app:signer: signer: /, "");
    let m;
    if ((m = /^review: (\d+) inputs?, (\d+) to sign/.exec(line))) {
      at = { inputs: +m[1], sign: +m[2], notes: [] };
    } else if (!at) {
      continue;
    } else if ((m = /^totals: sent (\S+) sat, change (\S+) sat, fee (\S+) sat/.exec(line))) {
      Object.assign(at, { sent: m[1], change: m[2], fee: m[3] });
    } else if ((m = /^change: (\d+) claimed, (\d+) checked, (\d+) stray, (\d+) unverified, (\d+) refuted(?:, (\d+) far)?/.exec(line))) {
      Object.assign(at, { claimed: +m[1], checked: +m[2], stray: +m[3], unverified: +m[4], refuted: +m[5], far: +(m[6] ?? 0) });
      found.push(at);
      at = null;
    } else {
      at.notes.push(line);
    }
  }
  return found;
}

function judge(c, got) {
  const w = c.want;
  const bad = [];
  const same = (what, a, b) => { if (String(a) !== String(b)) bad.push(`${what}: ${a}, wanted ${b}`); };
  same("to sign", got.sign, w.sign);
  for (const k of ["checked", "stray", "far", "refuted"]) if (w[k] !== undefined) same(k, got[k], w[k]);
  if (w.totals) {
    same("sent", got.sent, w.totals.sent);
    same("change", got.change, w.totals.change);
    same("fee", got.fee, w.totals.fee);
  }
  if (w.notes !== undefined) same("notes", got.notes.length, w.notes);
  const danger = got.notes.some((n) => n.startsWith("danger"));
  if (w.danger !== undefined) same("a red warning", danger, w.danger);
  return bad;
}

const OUTDIR = process.argv[2] || mkdtempSync(join(tmpdir(), "gapwallet-e1-"));
const sim = join(ZEROGAP, "sim/build/zgsim");
assert.ok(existsSync(sim), `no simulator at ${sim}: make -C sim`);
const cases = [...await casesFor(84), ...await casesFor(49)];
mkdirSync(OUTDIR, { recursive: true });
const file = join(OUTDIR, "attacks.txt");
writeFileSync(file, scenario(cases));
for (const c of cases) writeFileSync(join(OUTDIR, `${c.name.replace(/\W+/g, "-")}.psbt`), c.psbt);

const card = mkdtempSync(join(tmpdir(), "gapwallet-card-"));
mkdirSync(join(card, "apps"));
for (const a of readdirSync(join(ZEROGAP, "apps"))) {
  if (a !== "launcher") cpSync(join(ZEROGAP, "apps", a), join(card, "apps", a), { recursive: true });
}
const run = spawnSync("python3", ["tools/qemu_harness.py", "--sim", "sim/build/zgsim", "--card", card, "--out", OUTDIR, file],
  { cwd: ZEROGAP, encoding: "utf8", maxBuffer: 1 << 28 });
rmSync(card, { recursive: true, force: true });
const log = run.stdout + run.stderr;
writeFileSync(join(OUTDIR, "attacks.log"), log);

const found = reviews(log).filter((r) => r.claimed === 0); // the first look, with no key, is step 0
let failed = run.status === 0 ? 0 : 1;
if (run.status !== 0) console.log(`The scenario stopped (exit ${run.status}): see ${join(OUTDIR, "attacks.log")}`);
cases.forEach((c, i) => {
  const got = found[i];
  const bad = got ? judge(c, got) : ["no review logged"];
  failed += bad.length ? 1 : 0;
  console.log(`${bad.length ? "FAIL" : "PASS"}  ${c.name}`);
  if (got) console.log(`      ${got.sign} of ${got.inputs} to sign; sent ${got.sent}, change ${got.change}, fee ${got.fee}; ${got.checked} checked, ${got.stray} stray, ${got.far} far, ${got.refuted} refuted${got.notes.map((n) => `\n      ${n}`).join("")}`);
  for (const b of bad) console.log(`      ${b}`);
});
console.log(`${cases.length} cases, ${failed} failed. Output in ${OUTDIR}`);
console.log(`commit of the signer: ${spawnSync("git", ["-C", ZEROGAP, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim()}`);
process.exit(failed ? 1 : 0);
