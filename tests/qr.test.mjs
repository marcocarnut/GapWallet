// Codes made here read back, through the decoder the page uses.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { makeQr, decodeFrame, MAX_ALPHANUMERIC } from "../src/qr.js";

function pixels(qr, scale = 4, quiet = 4) {
  const n = (qr.size + 2 * quiet) * scale;
  const rgba = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.dark(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const at = (((r + quiet) * scale + y) * n + (c + quiet) * scale + x) * 4;
          rgba[at] = rgba[at + 1] = rgba[at + 2] = 0;
        }
      }
    }
  }
  return { rgba, n };
}

test("alphanumeric round trip, small to large", () => {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-./:";
  for (const length of [20, 300, 1200, 2500]) {
    const text = Array.from({ length }, (_, i) => alphabet[(i * 7 + (i >> 3)) % 43]).join("");
    const qr = makeQr(text);
    const { rgba, n } = pixels(qr, length > 1000 ? 3 : 4);
    assert.equal(decodeFrame(rgba, n, n)?.text, text, `length ${length}`);
  }
});

test("the size limit is what it says", () => {
  assert.equal(makeQr("A".repeat(MAX_ALPHANUMERIC)).version, 40);
  assert.equal(makeQr("A".repeat(MAX_ALPHANUMERIC + 1)), null);
});

test("a lower-case address in byte mode", () => {
  const text = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
  const { rgba, n } = pixels(makeQr(text, "Byte"));
  assert.equal(decodeFrame(rgba, n, n).text, text);
});
