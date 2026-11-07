// The user's own records: which receive addresses were handed
// out and to whom, and a note on each transaction. Kept in this browser with
// the account, and exported and imported as BIP-329 labels (JSON Lines), which
// Sparrow, Electrum and others read:
//
//   {"type":"addr","ref":"bc1q…","label":"To: Alice","origin":"wpkh([73c5da0a/84h/0h/0h])"}
//   {"type":"tx","ref":"<txid>","label":"Rent, March","origin":"wpkh([73c5da0a/84h/0h/0h])"}
//
// An address is handed out if it has a record; its label is the "To:" text,
// which may be empty. Nothing here changes which addresses are derived or how
// far a scan goes.
//
// An imported file is untrusted: each line is checked, refs must look like an
// address or a txid, labels are cut to MAX_LABEL characters and only ever
// shown as text. Records for another account or wallet are not applied, and
// are listed as such.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { addressAt } from "./account.js";
import { SCRIPT_INFO } from "./descriptor.js";
import { tr } from "./i18n.js";

export const MAX_LABEL = 255; // BIP-329's limit
export const MAX_FILE = 1 << 20;
const MAX_ORPHANS_SHOWN = 20;

const TXID = /^[0-9a-f]{64}$/;
const ADDRESS = /^[a-zA-Z0-9]{14,90}$/; // base58 or bech32: no punctuation, so never "__proto__"

export class LabelError extends Error {
  constructor(message) {
    super(message);
    this.name = "LabelError";
  }
}

// The record's labels, made safe to use: only well-formed refs, as Maps.
export function labelsOf(record) {
  const l = record.labels || {};
  const pick = (o, ok) => new Map(Object.entries(o && typeof o === "object" ? o : {})
    .filter(([k, v]) => ok.test(k) && typeof v === "string").map(([k, v]) => [k, clean(v)]));
  return { addr: pick(l.addr, ADDRESS), tx: pick(l.tx, TXID) };
}

export function saveLabels(record, { addr, tx }) {
  record.labels = { addr: Object.fromEntries(addr), tx: Object.fromEntries(tx) };
}

// Text kept as typed, cut to the limit, less what could change how text
// around it reads: control characters, and the bidi and line controls that
// would reorder an amount or address beside a label.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
export function clean(s) {
  return [...String(s).replace(CONTROLS, " ")].slice(0, MAX_LABEL).join("");
}

// BIP-329's origin: the account's descriptor without the key, wpkh([fp/84h/0h/0h])
export function originOf(account) {
  if (!account.fingerprint) return null;
  return SCRIPT_INFO[account.script].wrap(`[${account.fingerprint}/${account.purpose}h/${account.coinType}h/${account.account}h]`);
}

const normalOrigin = (s) => String(s).replace(/'/g, "h").replace(/\[([0-9a-fA-F]{8})/, (m, fp) => `[${fp.toLowerCase()}`).replace(/\s/g, "");

export function exportLabels(account, record) {
  const { addr, tx } = labelsOf(record);
  const origin = originOf(account);
  const line = (type, ref, label) => JSON.stringify({ type, ref, label, ...(origin ? { origin } : {}) });
  return [...[...addr].map(([ref, label]) => line("addr", ref, label)), ...[...tx].map(([ref, label]) => line("tx", ref, label))].join("\n") + "\n";
}

// The account's addresses up to `upTo` on each chain, for telling its own from others'
export function ownAddresses(account, upTo) {
  const own = new Set();
  for (const chain of [0, 1]) for (let i = 0; i < upTo; i++) own.add(addressAt(account, chain, i).address);
  return own;
}

// Reads a BIP-329 file into the record's labels. `own`: the account's addresses
// (ownAddresses), `txids`: its transactions. Returns what happened, for the page.
export function importLabels(text, account, record, { own, txids }) {
  if (text.length > MAX_FILE) throw new LabelError(tr("The file is too big to be labels."));
  const labels = labelsOf(record);
  const origin = originOf(account) && normalOrigin(originOf(account));
  const done = { addr: 0, tx: 0, orphans: [], skipped: 0, bad: 0 };
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new LabelError(tr("The file is empty."));
  for (const l of lines) {
    let r;
    try {
      r = JSON.parse(l);
    } catch {
      done.bad++;
      continue;
    }
    if (!r || typeof r !== "object" || typeof r.type !== "string" || typeof r.ref !== "string") {
      done.bad++;
      continue;
    }
    if (r.type !== "addr" && r.type !== "tx") { // pubkey, xpub, input, output: not kept here
      done.skipped++;
      continue;
    }
    const label = clean(typeof r.label === "string" ? r.label : "");
    const ref = r.type === "tx" ? r.ref.toLowerCase() : r.ref;
    if (!(r.type === "tx" ? TXID : ADDRESS).test(ref)) {
      done.bad++;
      continue;
    }
    const otherOrigin = typeof r.origin === "string" && origin && normalOrigin(r.origin) !== origin;
    const mine = !otherOrigin && (r.type === "addr" ? own.has(ref) : txids.has(ref));
    if (!mine) {
      done.orphans.push({ type: r.type, ref, label });
      continue;
    }
    labels[r.type].set(ref, label);
    done[r.type]++;
  }
  saveLabels(record, labels);
  done.orphansShown = done.orphans.slice(0, MAX_ORPHANS_SHOWN);
  return done;
}
