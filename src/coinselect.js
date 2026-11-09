// Fees, sizes and choosing coins (docs/ESPLORA.md, "Building a transaction").
// Everything here is deterministic: the same coins, amount and rate give the
// same choice. The random order of inputs and outputs is build.js's.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { compactSizeLength } from "../vendor/gapkeep/psbt/bytes.js";
import { formatDecimal, tr } from "./i18n.js";

export const MIN_RATE = 0.1, MAX_RATE = 10000;
export const DUST = { p2wpkh: 294, p2sh: 540, p2pkh: 546, p2wsh: 330, p2tr: 330 };

// What an account's script type costs. A witness is 108 WU: 1 + (1 + 72) + (1 + 33),
// a signature's 71 bytes and the sighash byte. An input's fixed part is 41 bytes;
// P2SH-P2WPKH adds a scriptSig of 23.
export const KINDS = {
  p2wpkh: { inputWeight: 41 * 4 + 108, changeScript: 22, changeDust: DUST.p2wpkh },
  "p2sh-p2wpkh": { inputWeight: (41 + 23) * 4 + 108, changeScript: 23, changeDust: DUST.p2sh },
};

const outputWeight = (scriptLength) => 4 * (8 + compactSizeLength(scriptLength) + scriptLength);

// The size of a transaction with `inputs` inputs of this kind; `scripts`: its
// output scripts' lengths.
export function vsizeOf(inputs, scripts, kind = KINDS.p2wpkh) {
  const base = 4 * (4 + 4 + compactSizeLength(inputs) + compactSizeLength(scripts.length)) + 2; // version, locktime, counts, segwit marker
  const weight = base + inputs * kind.inputWeight + scripts.reduce((sum, n) => sum + outputWeight(n), 0);
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
function settle(inputs, amount, scripts, rate, kind) {
  const total = inputs.reduce((sum, c) => sum + c.value, 0);
  const withChange = vsizeOf(inputs.length, [...scripts, kind.changeScript], kind);
  const change = total - amount - feeFor(withChange, rate);
  if (change >= kind.changeDust) return { inputs, change, fee: total - amount - change, dropped: 0, vsize: withChange };
  const vsize = vsizeOf(inputs.length, scripts, kind);
  const fee = feeFor(vsize, rate);
  if (total < amount + fee) return null;
  return { inputs, change: 0, fee: total - amount, dropped: total - amount - fee, vsize };
}

// request: { coins (Coin[]), amount (satoshis; ignored by sendAll), scripts
// (the payments' script lengths), rate, manual (spend exactly `coins`),
// sendAll, kind (of KINDS: the account's) } -> settle()'s, plus `amount`, `skipped` (coins worth less than
// they cost to spend).
export function selectCoins({ coins, amount, scripts, rate, manual = false, sendAll = false, kind = KINDS.p2wpkh }) {
  if (coins.length === 0) throw new SelectError(manual ? tr("Choose at least one coin.") : tr("There are no coins to spend."));
  if (sendAll) {
    const usable = manual ? coins : coins.filter((c) => c.confirmed);
    if (usable.length === 0) throw new SelectError(tr("There are no confirmed coins yet."));
    const total = usable.reduce((sum, c) => sum + c.value, 0);
    const vsize = vsizeOf(usable.length, scripts, kind);
    const fee = feeFor(vsize, rate);
    if (total - fee <= 0) throw new SelectError(tr("These coins don't cover the fee at this rate."));
    return { inputs: usable, change: 0, fee, dropped: 0, vsize, amount: total - fee, skipped: 0 };
  }
  if (manual) {
    const got = settle(coins, amount, scripts, rate, kind);
    if (!got) throw new SelectError(tr("The coins you chose don't cover the amount and the fee."));
    return { ...got, amount, skipped: 0 };
  }

  const unconfirmed = coins.filter((c) => !c.confirmed).reduce((sum, c) => sum + c.value, 0);
  const inputCost = feeFor(kind.inputWeight / 4, rate);
  const confirmed = coins.filter((c) => c.confirmed);
  const worth = confirmed.filter((c) => c.value > inputCost).sort(byValue);
  const skipped = confirmed.length - worth.length;
  const done = (got) => ({ ...got, amount, skipped });

  // 1. One coin, close enough that change wouldn't pay for itself
  const single = vsizeOf(1, scripts, kind);
  const changeCost = feeFor(vsizeOf(1, [...scripts, kind.changeScript], kind), rate) - feeFor(single, rate);
  for (const c of worth) {
    const fee = feeFor(single, rate);
    const excess = c.value - amount - fee;
    if (excess >= 0 && excess <= changeCost) return done({ inputs: [c], change: 0, fee: fee + excess, dropped: excess, vsize: single });
  }
  // 2. The smallest coin that covers it
  for (const c of worth) {
    const got = settle([c], amount, scripts, rate, kind);
    if (got) return done(got);
  }
  // 3. The largest coins, one by one
  const inputs = [];
  for (const c of [...worth].reverse()) {
    inputs.push(c);
    const got = settle([...inputs], amount, scripts, rate, kind);
    if (got) return done(got);
  }
  throw new SelectError(unconfirmed > 0 ? tr("Confirmed coins don't cover the amount and the fee. Another {n} sat is unconfirmed: choose those coins by hand to spend them.", { n: unconfirmed })
    : tr("Confirmed coins don't cover the amount and the fee."));
}

// What the user must acknowledge. `estimate`: the 1-block rate, if known.
export function feeWarnings({ fee, amount, rate, estimate }) {
  const out = [];
  if (fee > amount * 0.05) out.push(tr("The fee is {percent}% of the amount sent.", { percent: formatDecimal((fee / amount) * 100, 1) }));
  if (estimate && rate > estimate * 3) out.push(tr("{rate} sat/vB is more than 3 times the server's 1-block estimate ({estimate}).", { rate, estimate }));
  return out;
}
