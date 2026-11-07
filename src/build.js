// Builds the transaction and its PSBT (BITCOIN.md, "PSBTs"; docs/ESPLORA.md).
//
//   buildSpend(account, scan, request, client, { random }) -> Spend
//   psbtBytes(account, spend) -> Uint8Array
//
// The server is not believed: each coin's previous transaction is hashed
// here, and its output must match what the server said and what we derive.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { addressAt } from "./account.js";
import { NETWORK_INFO } from "./descriptor.js";
import { MIN_RATE, MAX_RATE, DUST, KINDS, SelectError, selectCoins } from "./coinselect.js";
import { concat, fromHex, fromHexReversed, toHex, equal, Writer, DecodeError } from "../vendor/zerogap/psbt/bytes.js";
import { addressToScript, classify } from "../vendor/zerogap/psbt/script.js";
import { parseTx, serializeTx, txid as txidOf } from "../vendor/zerogap/psbt/tx.js";
import { parsePsbt, serializePsbt, setEntry, GLOBAL, IN, OUT } from "../vendor/zerogap/psbt/psbt.js";
import { tr } from "./i18n.js";

export const SEQUENCE_RBF = 0xfffffffd;

export class BuildError extends Error {
  constructor(message) {
    super(message);
    this.name = "BuildError";
  }
}

// Fisher-Yates, with crypto.getRandomValues unless a test gives its own
// `random(n)` -> an integer in [0, n).
export function randomBelow(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a);
  while (a[0] >= limit);
  return a[0] % n;
}

function shuffled(list, random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The script of an address on the account's network. BuildError.
export function paymentScript(address, account) {
  const net = NETWORK_INFO[account.network];
  try {
    return addressToScript(address.trim(), net.lib);
  } catch (e) {
    if (e instanceof DecodeError) throw new BuildError(tr("That isn't a {network} address.", { network: net.name }));
    throw e;
  }
}

// Fetches and checks a coin's previous transaction.
async function previousOf(coin, client) {
  const raw = fromHex(await client.txHex(coin.txid));
  let tx;
  try {
    tx = parseTx(raw);
  } catch {
    throw new BuildError(tr("The server's copy of transaction {txid} can't be read.", { txid: coin.txid }));
  }
  if (txidOf(tx) !== coin.txid) throw new BuildError(tr("The server gave the wrong transaction for {txid}. It can't be trusted: nothing was built.", { txid: coin.txid }));
  const out = tx.outputs[coin.vout];
  if (!out) throw new BuildError(tr("Transaction {txid} has no output {vout}, though the server says it does.", { txid: coin.txid, vout: coin.vout }));
  if (out.value !== coin.value) {
    throw new BuildError(tr("The server said a coin holds {said} sat, but its transaction says {has}. It can't be trusted: nothing was built.", { said: coin.value, has: out.value }));
  }
  if (!equal(out.script, coin.entry.script)) {
    throw new BuildError(tr("A coin the server listed doesn't pay this account's address. It can't be trusted: nothing was built."));
  }
  return serializeTx(tx, { withWitness: false }); // the txid needs no witnesses, and they would only make the codes bigger
}

// request: { address, amount (satoshis), sendAll, rate, coins (chosen by
// hand) | null }.
// Spend = { txid (of the finished transaction), unsignedTxid, tx, inputs: [Coin + previous], outputs: [{ address, value, script, change: entry | null }],
//           fee, vsize, amount, rate, dropped, skipped }
export async function buildSpend(account, scan, request, client, { random = randomBelow } = {}) {
  if (!account.fingerprint) {
    throw new BuildError(tr("This account has no master fingerprint, so a signer couldn't find its keys. Add the fingerprint first."));
  }
  const { rate, sendAll = false } = request;
  if (!(rate >= MIN_RATE && rate <= MAX_RATE)) throw new BuildError(tr("A fee rate is between {min} and {max} sat/vB.", { min: MIN_RATE, max: MAX_RATE }));
  const script = paymentScript(request.address, account);
  const type = classify(script).type;
  const dust = DUST[type];
  if (dust === undefined) throw new BuildError(tr("That kind of address isn't supported."));
  if (!sendAll && !(Number.isSafeInteger(request.amount) && request.amount > 0)) throw new BuildError(tr("Enter an amount."));
  if (!sendAll && request.amount < dust) throw new BuildError(tr("That's below the dust limit for this address: {dust} sat.", { dust }));

  let chosen;
  try {
    chosen = selectCoins({ coins: request.coins || scan.coins, amount: request.amount, scripts: [script.length], rate,
      manual: Boolean(request.coins), sendAll, kind: KINDS[account.script] });
  } catch (e) {
    if (e instanceof SelectError) throw new BuildError(e.message);
    throw e;
  }
  if (sendAll && chosen.amount < dust) throw new BuildError(tr("After the fee that's below the dust limit for this address: {dust} sat.", { dust }));

  const change = chosen.change > 0 ? addressAt(account, 1, scan.next[1]) : null;
  const previous = await Promise.all(chosen.inputs.map((c) => previousOf(c, client)));
  const tipHeight = await client.tipHeight();

  const inputs = shuffled(chosen.inputs.map((c, i) => ({ ...c, previous: previous[i] })), random);
  const outputs = shuffled([
    { address: request.address.trim(), value: chosen.amount, script, change: null },
    ...(change ? [{ address: change.address, value: chosen.change, script: change.script, change }] : []),
  ], random);

  const tx = { version: 2, locktime: tipHeight, segwit: false,
    inputs: inputs.map((c) => ({ txid: fromHexReversed(c.txid), vout: c.vout, scriptSig: new Uint8Array(0), sequence: SEQUENCE_RBF, witness: [] })),
    outputs: outputs.map((o) => ({ value: o.value, script: o.script })) };
  return { txid: finishedTxid(tx, inputs), unsignedTxid: txidOf(tx), tx, inputs, outputs, fee: chosen.fee, vsize: chosen.vsize, amount: chosen.amount, rate,
    dropped: chosen.dropped, skipped: chosen.skipped };
}

// The txid once signed. Witnesses don't count, but a P2SH-P2WPKH input's
// scriptSig does, and it is known already: one push of the redeemScript. So a
// signed transaction with any other scriptSig isn't the one built here.
function finishedTxid(tx, inputs) {
  const scriptSig = (c) => (c.entry.redeemScript ? concat([Uint8Array.of(c.entry.redeemScript.length), c.entry.redeemScript]) : new Uint8Array(0));
  return txidOf({ ...tx, inputs: tx.inputs.map((input, i) => ({ ...input, scriptSig: scriptSig(inputs[i]) })) });
}

// PSBT_*_BIP32_DERIVATION's value: the master fingerprint, then the path.
function derivationValue(account, entry) {
  const w = new Writer(24);
  w.bytes(fromHex(account.fingerprint));
  for (const step of entry.steps) w.u32(step);
  return w.done();
}

function witnessUtxo(coin) {
  const w = new Writer(40);
  w.u64(coin.value).varBytes(coin.entry.script);
  return w.done();
}

const NO_KEY = new Uint8Array(0);

export function psbtBytes(account, spend) {
  if (!account.fingerprint) throw new BuildError(tr("This account has no master fingerprint."));
  const global = { entries: [] };
  setEntry(global, GLOBAL.UNSIGNED_TX, NO_KEY, serializeTx(spend.tx, { withWitness: false }));
  const inputs = spend.inputs.map((c) => {
    const map = { entries: [] };
    setEntry(map, IN.NON_WITNESS_UTXO, NO_KEY, c.previous);
    setEntry(map, IN.WITNESS_UTXO, NO_KEY, witnessUtxo(c));
    if (c.entry.redeemScript) setEntry(map, IN.REDEEM_SCRIPT, NO_KEY, c.entry.redeemScript);
    setEntry(map, IN.BIP32_DERIVATION, c.entry.pubkey, derivationValue(account, c.entry));
    return map;
  });
  const outputs = spend.outputs.map((o) => {
    const map = { entries: [] };
    if (o.change?.redeemScript) setEntry(map, OUT.REDEEM_SCRIPT, NO_KEY, o.change.redeemScript);
    if (o.change) setEntry(map, OUT.BIP32_DERIVATION, o.change.pubkey, derivationValue(account, o.change));
    return map;
  });
  const bytes = serializePsbt({ global, inputs, outputs });
  parsePsbt(bytes); // what we made must read back
  return bytes;
}

export const hexOf = toHex;
