// What came back from the signer: a code's text, or something pasted.
//
//   readSigned(text, bytes, pending) -> { kind: "tx", tx, txid, hex, matches (pending's txid) }
//                                     | { kind: "partial", signed, total, matches }
//
// Throws DecodeError with a message for people. A finished transaction with
// the expected txid is the one we built, signed: a segwit txid doesn't
// cover the signatures but does cover every input and output.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { toHex, DecodeError } from "../vendor/zerogap/psbt/bytes.js";
import { readPayload } from "../vendor/zerogap/psbt/transport.js";
import { parsePsbt } from "../vendor/zerogap/psbt/psbt.js";
import { parseTx, txid as txidOf, serializeTx } from "../vendor/zerogap/psbt/tx.js";

export function readSigned(text, bytes, pending) {
  const payload = readPayload(text, bytes);
  if (payload.kind === "psbt") {
    const psbt = parsePsbt(payload.bytes);
    const signed = psbt.inputs.filter((m) => m.fields.partialSigs?.length || m.fields.finalScriptWitness).length;
    return { kind: "partial", signed, total: psbt.inputs.length, matches: Boolean(pending) && txidOf(psbt.tx) === pending.txid };
  }
  const tx = parseTx(payload.bytes);
  if (tx.inputs.some((i) => i.witness.length === 0 && i.scriptSig.length === 0)) {
    throw new DecodeError("This transaction isn't signed yet.");
  }
  const txid = txidOf(tx);
  return { kind: "tx", tx, txid, hex: toHex(serializeTx(tx)), matches: Boolean(pending) && txid === pending.txid };
}
