// BBQr: the vendored library as the wallet uses it, and a real scan.
//
// tests/fixtures/bbqr-real-scan.txt is test_data/real-scan.txt of
// https://github.com/coinkite/BBQr at 8dc7ef07d0d520763cc0001a885ca8d29ac8719a
// (public domain, per that repository's UNLICENSE.md): 26 codes as a real
// camera read them, 8 parts, repeats and all.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./helpers.mjs";
import { Joiner, split, partCapacity, isBBQr } from "../vendor/zerogap/bbqr.js";
import { KeyReader, SignedReader } from "../src/signed.js";
import { makeQr, decodeFrame } from "../src/qr.js";
import { toHex } from "../vendor/zerogap/psbt/bytes.js";
import { base43Encode } from "../vendor/zerogap/psbt/basen.js";
import { serializeTx, txid as txidOf } from "../vendor/zerogap/psbt/tx.js";
import { MAGIC } from "../vendor/zerogap/psbt/psbt.js";

const scan = readFileSync(new URL("./fixtures/bbqr-real-scan.txt", import.meta.url), "utf8").split("\n").filter((l) => l.trim());

test("a real series, as a camera read it, joins", () => {
  assert.equal(scan.length, 26);
  const j = new Joiner();
  let last = null;
  for (const line of scan) {
    if (last?.done) break;
    last = j.add(line);
  }
  assert.equal(last.done, true);
  assert.equal(last.total, 8);
  const file = j.result();
  assert.equal(file.type, "U");
  assert.equal(file.encoding, "Z");
  const text = new TextDecoder().decode(file.bytes);
  assert.ok(text.includes("Zlib compressed"));
  assert.ok(text.includes("PSBT"));
});

test("every order of the real series gives the same file", () => {
  const distinct = [...new Set(scan)];
  assert.equal(distinct.length, 8);
  const want = (() => {
    const j = new Joiner();
    distinct.forEach((l) => j.add(l));
    return toHex(j.result().bytes);
  })();
  const j = new Joiner();
  [...distinct].reverse().forEach((l) => j.add(l));
  assert.equal(toHex(j.result().bytes), want);
});

test("the key reader takes text from a series, and refuses other files", () => {
  const r = new KeyReader();
  const { parts } = split(new TextEncoder().encode("wpkh(...)".repeat(40)), "U", { encoding: "2", maxParts: 3, minVersion: 3 });
  assert.ok(parts.length > 1);
  let got;
  for (const p of parts) got = r.add(p);
  assert.equal(got.text, "wpkh(...)".repeat(40));
  assert.deepEqual(new KeyReader().add("zpub123"), { text: "zpub123" });
  const other = split(Uint8Array.of(1, 2, 3), "B", { encoding: "2" }).parts[0];
  assert.throws(() => new KeyReader().add(other), /doesn't hold text/);
});

// A signed transaction of no consequence
const TX = { version: 2, locktime: 0, segwit: true, inputs: [{ txid: new Uint8Array(32).fill(7), vout: 1, scriptSig: new Uint8Array(0), sequence: 0xfffffffd,
  witness: [new Uint8Array(71).fill(1), new Uint8Array(33).fill(2)] }], outputs: Array.from({ length: 12 }, (_, i) => ({ value: 1000 + i, script: new Uint8Array(22).fill(i) })) };
const bytes = serializeTx(TX);
const pending = { txid: txidOf(TX), unsignedTxid: txidOf(TX) };

test("the signed reader: a series, in any order, repeats and all", () => {
  for (const encoding of ["Z", "2", "H"]) {
    const { parts } = split(bytes, "T", { encoding, maxParts: 4, minVersion: 3 });
    assert.ok(parts.length > 1);
    const r = new SignedReader(pending);
    assert.deepEqual(r.add(parts[1]), { kind: "progress", have: 1, total: parts.length });
    assert.deepEqual(r.add(parts[1]), { kind: "progress", have: 1, total: parts.length });
    let got;
    for (const p of [...parts].reverse()) if (p !== parts[1]) got = r.add(p);
    assert.equal(got.kind, "tx");
    assert.equal(got.matches, true);
    assert.equal(got.hex, toHex(bytes));
  }
});

test("the signed reader: one code; a PSBT is recognised; other files refused", () => {
  assert.equal(new SignedReader(pending).add(split(bytes, "T", { maxParts: 1 }).parts[0]).kind, "tx");
  assert.throws(() => new SignedReader(pending).add(split(Uint8Array.of(1, 2, 3), "U", { encoding: "2", maxParts: 1 }).parts[0]), /a text file, not a transaction/);
  assert.equal(new SignedReader(pending).add(toHex(bytes)).matches, true);
  assert.throws(() => new SignedReader(pending).add(split(MAGIC, "P", { encoding: "2", maxParts: 1 }).parts[0]), /./);
});

test("the signed reader: a code of another file starts that one over", () => {
  const a = split(bytes, "T", { encoding: "2", maxParts: 4, minVersion: 3 }).parts;
  const b = split(bytes, "T", { encoding: "H", maxParts: 4, minVersion: 3 }).parts;
  const r = new SignedReader(pending);
  r.add(a[0]);
  assert.equal(r.add(b[0]).have, 1);
  let got;
  for (const p of b.slice(1)) got = r.add(p);
  assert.equal(got.kind, "tx");
});

test("the signed reader: damage is reported, and the series can start over", () => {
  const { parts } = split(bytes, "T", { encoding: "H", maxParts: 3, minVersion: 3 });
  const r = new SignedReader(pending);
  r.add(parts[0]);
  assert.throws(() => r.add(`${parts[0].slice(0, -2)}FF`), /started over/);
  let got;
  for (const p of parts) got = r.add(p);
  assert.equal(got.matches, true);
});

test("a Base43 transaction starting B$ stays a transaction", () => {
  // the case the signer's transport allows for: text that is both
  const text = base43Encode(bytes);
  assert.equal(isBBQr(text), text.startsWith("B$"));
  assert.equal(new SignedReader(pending).add(text).matches, true);
});

test("all the codes of a series are the version it says, and read back", () => {
  const data = Uint8Array.from({ length: 3000 }, (_, i) => (i * i * 31 + (i >> 3)) & 255);
  const { version, parts, encoding } = split(data, "P", { maxParts: 6 });
  assert.equal(encoding, "2"); // this doesn't compress
  assert.ok(parts[0].length - 8 <= partCapacity(version, encoding));
  const j = new Joiner();
  for (const p of parts) {
    const qr = makeQr(p, "Alphanumeric", version);
    assert.equal(qr.version, version, "forced, even for a short last part");
    const scale = 3, n = (qr.size + 8) * scale;
    const rgba = new Uint8ClampedArray(n * n * 4).fill(255);
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (!qr.dark(r, c)) continue;
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const at = (((r + 4) * scale + y) * n + (c + 4) * scale + x) * 4;
            rgba[at] = rgba[at + 1] = rgba[at + 2] = 0;
          }
        }
      }
    }
    j.add(decodeFrame(rgba, n, n).text);
  }
  assert.equal(toHex(j.result().bytes), toHex(data));
});
