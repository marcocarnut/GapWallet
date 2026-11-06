// QR codes out (qrcode-generator) and in (jsQR, on the camera's frames, in this
// page: no frame leaves it).
//
// SPDX-License-Identifier: GPL-3.0-or-later
import qrcode from "../vendor/qrcode-generator/qrcode.mjs";
import jsQR from "../vendor/jsqr/jsQR.cjs";

// The largest QR code (version 40, error correction L) in alphanumeric mode
export const MAX_ALPHANUMERIC = 4296;

const QUIET = 4;

// -> { size (modules), version, dark(row, col) } or null if it doesn't fit.
// `version` 0 takes the smallest that fits; a BBQr series gives its own, the
// same for every code, since readers expect that.
export function makeQr(text, mode = "Alphanumeric", version = 0) {
  const q = qrcode(version, "L");
  try {
    q.addData(text, mode);
    q.make();
  } catch {
    return null;
  }
  const size = q.getModuleCount();
  return { size, version: (size - 17) / 4, dark: (r, c) => q.isDark(r, c) };
}

export function drawQr(canvas, qr, scale) {
  const n = (qr.size + 2 * QUIET) * scale;
  canvas.width = n;
  canvas.height = n;
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, n, n);
  g.fillStyle = "#000";
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.dark(r, c)) g.fillRect((c + QUIET) * scale, (r + QUIET) * scale, scale, scale);
    }
  }
}

// A code read from an image's RGBA pixels: { text, bytes } or null.
export function decodeFrame(rgba, width, height) {
  const got = jsQR(rgba, width, height, { inversionAttempts: "attemptBoth" });
  return got ? { text: got.data, bytes: Uint8Array.from(got.binaryData) } : null;
}

const MAX_WIDTH = 1280, PAUSE_MS = 80;

// Reads the camera until stop(). onCode({ text, bytes }) for each different code.
export class Scanner {
  constructor(video, { onCode, onError }) {
    this.video = video;
    this.onCode = onCode;
    this.onError = onError;
    this.canvas = document.createElement("canvas");
    this.stream = null;
    this.timer = null;
    this.last = null;
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
    } catch (e) {
      this.onError(`The camera can't be opened: ${e.message}`);
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    this.tick();
  }

  tick = () => {
    if (!this.stream) return;
    const v = this.video;
    if (v.videoWidth > 0) {
      const scale = Math.min(1, MAX_WIDTH / v.videoWidth);
      const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
      this.canvas.width = w;
      this.canvas.height = h;
      const g = this.canvas.getContext("2d", { willReadFrequently: true });
      g.drawImage(v, 0, 0, w, h);
      const code = decodeFrame(g.getImageData(0, 0, w, h).data, w, h);
      if (code && code.text !== this.last) {
        this.last = code.text;
        this.onCode(code);
      }
    }
    if (this.stream) this.timer = setTimeout(this.tick, PAUSE_MS);
  };

  stop() {
    clearTimeout(this.timer);
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
}
