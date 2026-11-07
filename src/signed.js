// What came back from the signer: a code's text, or something pasted.
//
//   readSigned(text, bytes, pending) -> { kind: "tx", tx, txid, hex, matches (pending's txid) }
//                                     | { kind: "partial", signed, total, matches }
//   new SignedReader(pending).add(text, bytes)
//     -> the same, or { kind: "progress", have, total } for a part of a BBQr series
//   readFile(bytes, pending) -> the same as readSigned: a file holding a raw
//     transaction, a PSBT, or their text forms (hex, Base64, Base43, BBQr lines)
//
// Throws DecodeError with a message for people. A finished transaction with
// the expected txid is the one we built, signed: a segwit txid doesn't
// cover the signatures but does cover every input and output, and the
// scriptSig of a nested input (build.js, finishedTxid).
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { toHex, DecodeError } from "../vendor/zerogap/psbt/bytes.js";
import { readPayload } from "../vendor/zerogap/psbt/transport.js";
import { isPsbt, parsePsbt } from "../vendor/zerogap/psbt/psbt.js";
import { parseTx, txid as txidOf, serializeTx } from "../vendor/zerogap/psbt/tx.js";
import { BBQrError, FILE_TYPES, Joiner, isBBQr } from "../vendor/zerogap/bbqr.js";
import { tr } from "./i18n.js";

// The most a series may unpack to. A signed transaction is far smaller; this
// keeps a hostile code from filling memory.
const MAX_FILE = 4 * 1024 * 1024;

function psbtResult(bytes, pending) {
  const psbt = parsePsbt(bytes);
  const signed = psbt.inputs.filter((m) => m.fields.partialSigs?.length || m.fields.finalScriptWitness).length;
  return { kind: "partial", signed, total: psbt.inputs.length, matches: Boolean(pending) && txidOf(psbt.tx) === pending.unsignedTxid };
}

function txResult(bytes, pending) {
  const tx = parseTx(bytes);
  // Every input here is segwit. Legacy accounts (S3) have no witness: this has
  // to change with them.
  if (tx.inputs.some((i) => i.witness.length === 0)) {
    throw new DecodeError(tr("This transaction isn't signed yet."));
  }
  const txid = txidOf(tx);
  return { kind: "tx", tx, txid, hex: toHex(serializeTx(tx)), matches: Boolean(pending) && txid === pending.txid };
}

export function readSigned(text, bytes, pending) {
  const payload = readPayload(text, bytes);
  return payload.kind === "psbt" ? psbtResult(payload.bytes, pending) : txResult(payload.bytes, pending);
}

// A file that has come whole out of a BBQr series, and says what it is.
function fromSeries({ type, bytes }, pending) {
  if (type === "P") return psbtResult(bytes, pending);
  if (type === "T") return txResult(bytes, pending);
  throw new DecodeError(FILE_TYPES[type] ? tr("This series holds a {kind} file, not a transaction.", { kind: FILE_TYPES[type] }) : tr("This series holds an unknown file, not a transaction."));
}

// Codes as they arrive: whole ones, and the parts of a series in any order,
// each as often as it comes round.
export class SignedReader {
  constructor(pending) {
    this.pending = pending;
    this.joiner = new Joiner({ maxBytes: MAX_FILE });
  }

  add(text, bytes = null) {
    if (typeof text !== "string" || !isBBQr(text)) return readSigned(text, bytes, this.pending);
    // BBQr's text is also Base43. As the signer does: it's BBQr unless it reads
    // as a transaction. (The series' parts never do.)
    try {
      return readSigned(text, bytes, this.pending);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
    }
    try {
      let step;
      try {
        step = this.joiner.add(text);
      } catch (e) {
        // a code of another file means the user moved on to that one
        if (!(e instanceof BBQrError) || e.code !== "series") throw e;
        this.joiner.reset();
        step = this.joiner.add(text);
      }
      if (!step.done) return { kind: "progress", have: step.have, total: step.total };
      const file = this.joiner.result();
      this.joiner.reset();
      return fromSeries(file, this.pending);
    } catch (e) {
      if (!(e instanceof BBQrError)) throw e;
      this.joiner.reset();
      throw new DecodeError(tr("This series can't be read, so it was started over: {reason}", { reason: e.message }));
    }
  }
}

const isText = (bytes) => bytes.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));

// The same checks as a code, from a file's bytes.
export function readFile(bytes, pending) {
  if (bytes.length === 0) throw new DecodeError(tr("The file is empty."));
  if (bytes.length > MAX_FILE) throw new DecodeError(tr("The file is too big to be a transaction."));
  if (isPsbt(bytes)) return psbtResult(bytes, pending);
  if (!isText(bytes)) {
    try {
      return txResult(bytes, pending);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      throw new DecodeError(tr("This file isn't a transaction: {reason}", { reason: e.message }));
    }
  }
  const lines = new TextDecoder().decode(bytes).split(/\s+/).filter(Boolean);
  if (lines.length === 0) throw new DecodeError(tr("The file is empty."));
  if (lines.length === 1 || !lines.every(isBBQr)) return readSigned(lines.join(""), null, pending);
  const reader = new SignedReader(pending);
  let got;
  for (const line of lines) got = reader.add(line);
  if (got.kind === "progress") throw new DecodeError(tr("This file has {have} of the series' {total} codes.", got));
  return got;
}

// A public key read from a code: its text, whole or from a BBQr series of
// text. -> { text } or { have, total } while a series is coming in. Throws
// DecodeError.
export class KeyReader {
  constructor() {
    this.joiner = new Joiner({ maxBytes: 16384 });
  }

  add(text) {
    if (typeof text !== "string" || !isBBQr(text)) return { text };
    try {
      const step = this.joiner.add(text);
      if (!step.done) return { have: step.have, total: step.total };
      const { type, bytes } = this.joiner.result();
      this.joiner.reset();
      if (type !== "U") throw new DecodeError(tr("This series doesn't hold text, so it isn't a public key."));
      return { text: new TextDecoder().decode(bytes) };
    } catch (e) {
      if (!(e instanceof BBQrError)) throw e;
      this.joiner.reset();
      throw new DecodeError(tr("This series can't be read, so it was started over: {reason}", { reason: e.message }));
    }
  }
}
