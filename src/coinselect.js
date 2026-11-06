// Fees, sizes and choosing coins (docs/ESPLORA.md, "Building a transaction").
// Everything here is deterministic: the same coins, amount and rate give the
// same choice. The random order of inputs and outputs is build.js's.
import { compactSizeLength } from "../vendor/zerogap/psbt/bytes.js";

export const MIN_RATE = 0.1, MAX_RATE = 10000;
export const CHANGE_SCRIPT = 22; // P2WPKH
export const DUST = { p2wpkh: 294, p2sh: 540, p2pkh: 546, p2wsh: 330, p2tr: 330 };

const INPUT_WEIGHT = 272; // 41 × 4, and a witness of 1 + (1 + 72) + (1 + 33): a signature's 71 bytes and the sighash byte
const outputWeight = (scriptLength) => 4 * (8 + compactSizeLength(scriptLength) + scriptLength);

// A P2WPKH-input transaction's size; `scripts`: its output scripts' lengths.
export function vsizeOf(inputs, scripts) {
  const base = 4 * (4 + 4 + compactSizeLength(inputs) + compactSizeLength(scripts.length)) + 2; // version, locktime, counts, segwit marker
  const weight = base + inputs * INPUT_WEIGHT + scripts.reduce((sum, n) => sum + outputWeight(n), 0);
  return Math.ceil(weight / 4);
}

// In whole satoshis, up. (The small margin is for rates like 1.1, whose
// product with a size lands just above a whole number.)
export const feeFor = (vsize, rate) => Math.ceil(vsize * rate - 1e-9);

// A server's estimates, fit to use: real ones arrive as 0.09999999999999999,
// which is below the lowest rate we accept and no way to show a number.
export function cleanEstimates(estimates) {
  const out = {};
  for (const [blocks, rate] of Object.entries(estimates)) {
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      out[blocks] = Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(rate * 1000) / 1000));
    }
  }
  return out;
}

export class SelectError extends Error {
  constructor(message) {
    super(message);
    this.name = "SelectError";
  }
}

const byValue = (a, b) => a.value - b.value || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout);

// With these inputs: { inputs, change, fee, dropped (to the fee, satoshis), vsize }, or null if they fall short.
function settle(inputs, amount, scripts, rate) {
  const total = inputs.reduce((sum, c) => sum + c.value, 0);
  const withChange = vsizeOf(inputs.length, [...scripts, CHANGE_SCRIPT]);
  const change = total - amount - feeFor(withChange, rate);
  if (change >= DUST.p2wpkh) return { inputs, change, fee: total - amount - change, dropped: 0, vsize: withChange };
  const vsize = vsizeOf(inputs.length, scripts);
  const fee = feeFor(vsize, rate);
  if (total < amount + fee) return null;
  return { inputs, change: 0, fee: total - amount, dropped: total - amount - fee, vsize };
}

// request: { coins (Coin[]), amount (satoshis; ignored by sendAll), scripts
// (the payments' script lengths), rate, manual (spend exactly `coins`),
// sendAll } -> settle()'s, plus `amount`, `skipped` (coins worth less than
// they cost to spend).
export function selectCoins({ coins, amount, scripts, rate, manual = false, sendAll = false }) {
  if (coins.length === 0) throw new SelectError(manual ? "Choose at least one coin." : "There are no coins to spend.");
  if (sendAll) {
    const usable = manual ? coins : coins.filter((c) => c.confirmed);
    if (usable.length === 0) throw new SelectError("There are no confirmed coins yet.");
    const total = usable.reduce((sum, c) => sum + c.value, 0);
    const vsize = vsizeOf(usable.length, scripts);
    const fee = feeFor(vsize, rate);
    if (total - fee <= 0) throw new SelectError("These coins don't cover the fee at this rate.");
    return { inputs: usable, change: 0, fee, dropped: 0, vsize, amount: total - fee, skipped: 0 };
  }
  if (manual) {
    const got = settle(coins, amount, scripts, rate);
    if (!got) throw new SelectError("The coins you chose don't cover the amount and the fee.");
    return { ...got, amount, skipped: 0 };
  }

  const unconfirmed = coins.filter((c) => !c.confirmed).reduce((sum, c) => sum + c.value, 0);
  const inputCost = feeFor(INPUT_WEIGHT / 4, rate);
  const confirmed = coins.filter((c) => c.confirmed);
  const worth = confirmed.filter((c) => c.value > inputCost).sort(byValue);
  const skipped = confirmed.length - worth.length;
  const done = (got) => ({ ...got, amount, skipped });

  // 1. One coin, close enough that change wouldn't pay for itself
  const changeCost = feeFor(vsizeOf(1, [...scripts, CHANGE_SCRIPT]), rate) - feeFor(vsizeOf(1, scripts), rate);
  for (const c of worth) {
    const fee = feeFor(vsizeOf(1, scripts), rate);
    const excess = c.value - amount - fee;
    if (excess >= 0 && excess <= changeCost) return done({ inputs: [c], change: 0, fee: fee + excess, dropped: excess, vsize: vsizeOf(1, scripts) });
  }
  // 2. The smallest coin that covers it
  for (const c of worth) {
    const got = settle([c], amount, scripts, rate);
    if (got) return done(got);
  }
  // 3. The largest coins, one by one
  const inputs = [];
  for (const c of [...worth].reverse()) {
    inputs.push(c);
    const got = settle([...inputs], amount, scripts, rate);
    if (got) return done(got);
  }
  const held = unconfirmed > 0 ? ` Another ${unconfirmed} sat is unconfirmed: choose those coins by hand to spend them.` : "";
  throw new SelectError(`Confirmed coins don't cover the amount and the fee.${held}`);
}

// What the user must acknowledge. `estimate`: the 1-block rate, if known.
export function feeWarnings({ fee, amount, rate, estimate }) {
  const out = [];
  if (fee > amount * 0.05) out.push(`The fee is ${((fee / amount) * 100).toFixed(1)}% of the amount sent.`);
  if (estimate && rate > estimate * 3) out.push(`${rate} sat/vB is more than 3 times the server's 1-block estimate (${estimate}).`);
  return out;
}
