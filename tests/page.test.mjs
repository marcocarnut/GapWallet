// The built page, in headless Chromium, against the stub chain over HTTP.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chain, haveSigner, loadSigner, MASTER_FINGERPRINT } from "./helpers.mjs";
import { addressAt } from "../src/account.js";
import { accountDescriptor, parseAccount } from "../src/descriptor.js";
import { makeQr } from "../src/qr.js";
import { fromBase64, toHex } from "../vendor/zerogap/psbt/bytes.js";

const CHROME = ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
let puppeteer = null;
try {
  puppeteer = (await import("puppeteer-core")).default;
} catch { /* skipped */ }
const skip = !CHROME || !puppeteer || !haveSigner ? "needs Chromium, puppeteer-core and the ZeroGap repository" : false;

const HTML = readFileSync(new URL("../gapwallet.html", import.meta.url), "utf8");
const cors = { "Access-Control-Allow-Origin": "*" };
let browser, signer, vpub, pageServer, chainServer, otherServer, pageUrl, chainUrl, otherUrl, chain, otherHits;

const listen = (handler) => new Promise((done) => {
  const s = createServer(handler);
  s.listen(0, "127.0.0.1", () => done(s));
});
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;

before(async () => {
  if (skip) return;
  signer = await loadSigner();
  vpub = signer.bip32.serializeXpub(signer.bip32.neuter(signer.bip32.derive(signer.master, "m/84'/1'/0'")), "vpub");
  pageServer = await listen((q, r) => {
    r.writeHead(200, { "Content-Type": "text/html" });
    r.end(HTML);
  });
  otherHits = 0;
  otherServer = await listen((q, r) => {
    otherHits++;
    r.writeHead(200, cors);
    r.end("hello");
  });
  chainServer = await listen((q, r) => {
    let body = "";
    q.on("data", (d) => (body += d));
    q.on("end", () => {
      if (q.method === "OPTIONS") {
        r.writeHead(204, { ...cors, "Access-Control-Allow-Headers": "content-type" });
        r.end();
        return;
      }
      if (chain.overLimit()) { // as mempool.space's nginx: 429, no CORS header
        r.writeHead(429, { "Content-Type": "text/html" });
        r.end("<html>429 Too Many Requests</html>");
        return;
      }
      const a = chain.handle(q.method, q.url.replace(/^\/api/, ""), body);
      r.writeHead(a.status, { ...cors, "Content-Type": a.type });
      r.end(a.body);
    });
  });
  pageUrl = urlOf(pageServer);
  chainUrl = urlOf(chainServer) + "/api";
  otherUrl = urlOf(otherServer);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
});

after(async () => {
  if (skip) return;
  await browser.close();
  for (const s of [pageServer, chainServer, otherServer]) s.close();
});

// A fresh browser profile with the requests it makes on record
async function open() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const seen = { requests: [], errors: [] };
  page.on("request", (r) => seen.requests.push(r.url()));
  page.on("pageerror", (e) => seen.errors.push(e.message));
  await page.goto(pageUrl);
  return { page, ctx, seen };
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent);
const click = (page, sel) => page.click(sel);
const hasText = (page, needle) => page.waitForFunction((n) => document.body.innerText.includes(n), { timeout: 8000 }, needle);
const fetchFrom = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.text()).catch((e) => `blocked: ${e.message}`), url);

async function importAccount(page, { key = vpub, fingerprint = MASTER_FINGERPRINT, network = "signet" } = {}) {
  await click(page, `input[value=${network}]`);
  await page.type("#key", key);
  if (fingerprint) await page.type("#fingerprint", fingerprint);
  await page.waitForFunction(() => !document.getElementById("add").disabled);
  await Promise.all([page.waitForNavigation(), click(page, "#add")]);
}

async function chooseServer(page) {
  await page.type("#server", chainUrl);
  await Promise.all([page.waitForNavigation(), click(page, "#use-server")]);
}

const account = () => parseAccount(vpub, "signet", MASTER_FINGERPRINT);
const PAYEE = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

test("nothing is contacted before a server is chosen, and the first run says so", { skip }, async () => {
  chain = new Chain("signet");
  const { page, ctx, seen } = await open();
  assert.match(await fetchFrom(page, otherUrl), /^blocked/); // connect-src 'none'
  await importAccount(page);
  await hasText(page, "Choose a server");
  await hasText(page, "There is no default");
  await hasText(page, "Every address of this account");
  assert.equal(chain.requests.length, 0);
  assert.equal(otherHits, 0);
  assert.deepEqual([...new Set(seen.requests.map((u) => new URL(u).origin))], [pageUrl]);
  assert.deepEqual(seen.errors, []);
  await ctx.close();
});

test("the import preview shows addresses offline, and refuses private keys", { skip }, async () => {
  const { page, ctx } = await open();
  await click(page, "input[value=signet]");
  await page.type("#key", vpub);
  await hasText(page, addressAt(account(), 0, 0).address);
  await hasText(page, "watch-only");
  await page.$eval("#key", (e) => { // pasted
    e.value = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    e.dispatchEvent(new Event("input"));
  });
  await hasText(page, "private key or a seed");
  assert.equal(await page.$eval("#key", (e) => e.value), "");
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), "{}");
  await ctx.close();
});

test("the policy holds: after narrowing, only the chosen server can be reached", { skip }, async () => {
  chain = new Chain("signet");
  const { page, ctx, seen } = await open();
  await importAccount(page);
  await chooseServer(page);
  await page.waitForSelector("#balance");
  // the same request: allowed to the server, stopped to any other origin
  assert.match(await fetchFrom(page, `${chainUrl}/blocks/tip/height`), /^\d+$/);
  otherHits = 0;
  assert.match(await fetchFrom(page, otherUrl), /^blocked/);
  assert.equal(otherHits, 0, "the request must not reach the other server");
  // no inline script can be added, and an injected image can't phone home
  const ran = await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__ran = 1";
    document.body.append(s);
    return window.__ran === 1;
  });
  assert.equal(ran, false);
  otherHits = 0;
  await page.evaluate((u) => new Promise((done) => {
    const i = new Image();
    i.onload = i.onerror = done;
    i.src = `${u}/x.png`;
  }), otherUrl);
  assert.equal(otherHits, 0);
  const origins = new Set(seen.requests.map((u) => new URL(u).origin));
  assert.ok(![...origins].some((o) => o !== pageUrl && o !== new URL(chainUrl).origin && o !== otherUrl && !o.startsWith("data")), [...origins].join());
  await ctx.close();
});

test("a server on another network is refused", { skip }, async () => {
  chain = new Chain("testnet4");
  const { page, ctx } = await open();
  await importAccount(page);
  await chooseServer(page);
  await hasText(page, "isn't on signet");
  assert.equal(chain.requests.filter((r) => r.includes("/address/")).length, 0);
  await ctx.close();
});

test("watch-only: the fingerprint can be added where it's needed, with no new import", { skip }, async () => {
  chain = new Chain("signet");
  chain.fund(addressAt(account(), 0, 0).address, 50000);
  const { page, ctx } = await open();
  await importAccount(page, { fingerprint: "" });
  await chooseServer(page);
  await page.waitForSelector("#balance");
  assert.ok(await page.$("#watchonly"));
  await click(page, "#tab-send");
  await hasText(page, "no master fingerprint");
  assert.equal(await page.$("#review"), null);
  await page.type("#add-fingerprint", "xyz");
  await click(page, "#save-fingerprint");
  await hasText(page, "8 hexadecimal digits");
  await page.$eval("#add-fingerprint", (e) => { e.value = ""; });
  await page.type("#add-fingerprint", MASTER_FINGERPRINT);
  await Promise.all([page.waitForNavigation(), click(page, "#save-fingerprint")]);
  await page.waitForSelector("#balance");
  assert.equal(await page.$("#watchonly"), null);
  await ctx.close();
});

test("a real 429 with no CORS header: the browser can't see it, and the scan still finishes", { skip, timeout: 120000 }, async () => {
  chain = new Chain("signet");
  chain.fund(addressAt(account(), 0, 1).address, 42000);
  chain.limit = { perWindow: 6, windowMs: 1000 };
  const { page, ctx } = await open();
  await importAccount(page);
  await chooseServer(page);
  await page.waitForSelector("#balance", { timeout: 100000 });
  assert.equal(await text(page, "#balance"), "0.00042000 BTC");
  assert.ok(chain.limited > 0, "the limit was reached");
  chain.limit = null;
  await ctx.close();
});

test("opened from disk, it works the same", { skip }, async () => {
  chain = new Chain("signet");
  chain.fund(addressAt(account(), 0, 0).address, 50000);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(new URL("../gapwallet.html", import.meta.url).href);
  await importAccount(page);
  await chooseServer(page);
  await page.waitForSelector("#balance");
  assert.equal(await text(page, "#balance"), "0.00050000 BTC");
  assert.match(await fetchFrom(page, otherUrl), /^blocked/);
  await ctx.close();
});

test("a high fee must be acknowledged", { skip }, async () => {
  chain = new Chain("signet");
  chain.fund(addressAt(account(), 0, 0).address, 500000);
  const { page, ctx } = await open();
  await importAccount(page);
  await chooseServer(page);
  await page.waitForSelector("#balance");
  await click(page, "#tab-send");
  await page.waitForSelector("#address");
  await hasText(page, "about an hour");
  await page.type("#address", PAYEE);
  await page.type("#amount", "0.0001");
  await page.$eval("#rate", (e) => { e.value = ""; });
  await page.type("#rate", "100");
  await click(page, "#review");
  await hasText(page, "more than 3 times");
  await hasText(page, "of the amount sent");
  assert.equal(await page.$eval("#to-sign", (e) => e.disabled), true);
  await click(page, "#ack-fee");
  assert.equal(await page.$eval("#to-sign", (e) => e.disabled), false);
  await ctx.close();
});

test("what a server says stays text", { skip }, async () => {
  chain = new Chain("signet");
  chain.overrides.push((m, p) => (p === "/blocks/tip/height" ? { status: 500, body: "<img src=x onerror=window.__pwned=1>", type: "text/plain" } : null));
  const { page, ctx } = await open();
  await importAccount(page);
  await chooseServer(page);
  await hasText(page, "<img src=x");
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.$("#app img"), null);
  await ctx.close();
});

test("start to end: scan, receive, build, real signer, camera, broadcast", { skip }, async () => {
  chain = new Chain("signet");
  const a = account();
  chain.fund(addressAt(a, 0, 0).address, 150000);
  chain.fund(addressAt(a, 0, 1).address, 60000);
  chain.fund(addressAt(a, 0, 2).address, 7777, null);
  const { page, ctx, seen } = await open();
  await importAccount(page);
  await chooseServer(page);
  await page.waitForSelector("#balance");
  assert.equal(await text(page, "#balance"), "0.00210000 BTC");
  assert.match(await text(page, "#unconfirmed"), /0\.00007777/);
  assert.equal((await page.$$("#history tbody tr")).length, 3);

  await click(page, "#tab-receive");
  await page.waitForSelector("#receive-address");
  assert.equal(await text(page, "#receive-address"), addressAt(a, 0, 3).address);

  await click(page, "#tab-send");
  await page.waitForSelector("#address");
  await hasText(page, "about an hour: 4.5 sat/vB");
  assert.equal(await page.$eval("#rate", (e) => e.value), "4.5");
  await page.type("#address", PAYEE);
  await page.type("#amount", "0.0012");
  await click(page, "#review");
  await page.waitForSelector("#review-amount");
  assert.equal(await text(page, "#review-amount"), "0.00120000 BTC");
  await hasText(page, "m/84'/1'/0'/1/0");
  await click(page, "#to-sign");
  await page.waitForSelector("#psbt-qr");

  // what the page shows goes to the real signer
  await page.$eval("details", (e) => { e.open = true; });
  const b64 = await page.$eval("#psbt-text", (e) => e.value);
  const psbt = signer.psbtLib.parsePsbt(fromBase64(b64));
  const plan = signer.sign.plan(psbt, signer.master, { network: "testnet" });
  assert.equal(plan.signable, psbt.inputs.length);
  assert.equal(plan.outputs.filter((o) => o.ours && o.role === "change").length, 1);
  const done = signer.sign.finalize(signer.sign.signPsbt(psbt, signer.master, { network: "testnet" }).psbt);
  // the code on the screen holds that same PSBT
  const shown = await page.evaluate(() => {
    const c = document.getElementById("psbt-qr");
    return { w: c.width, data: Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data) };
  });
  const { decodeFrame } = await import("../src/qr.js");
  const read = decodeFrame(Uint8ClampedArray.from(shown.data), shown.w, shown.w);
  assert.equal(toHex(signer.transport.readPayload(read.text).bytes), toHex(fromBase64(b64)));

  await click(page, "#to-scan");
  await page.waitForSelector("#start-camera");
  // a fake camera showing the signer's code, through the real <video> and decoder
  const qr = makeQr(signer.transport.electrumQrText(done.tx));
  const scale = Math.floor(600 / (qr.size + 8));
  const dark = [];
  for (let r = 0; r < qr.size; r++) for (let c = 0; c < qr.size; c++) if (qr.dark(r, c)) dark.push([r, c]);
  await page.evaluate(({ dark, size, scale }) => {
    const canvas = document.createElement("canvas");
    const n = (size + 8) * scale;
    canvas.width = canvas.height = n;
    const g = canvas.getContext("2d");
    const draw = () => {
      g.fillStyle = "#fff";
      g.fillRect(0, 0, n, n);
      g.fillStyle = "#000";
      for (const [r, c] of dark) g.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
    };
    draw();
    setInterval(draw, 100);
    navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(10);
  }, { dark, size: qr.size, scale });
  await click(page, "#start-camera");
  await hasText(page, "This is the transaction built here, signed.");
  chain.onBroadcast = () => done.txid;
  await click(page, "#broadcast");
  await page.waitForSelector("#sent-txid");
  assert.equal(await text(page, "#sent-txid"), done.txid);
  assert.equal(chain.broadcasts[0], toHex(done.tx));

  const origins = new Set(seen.requests.map((u) => new URL(u).origin));
  assert.deepEqual([...origins].sort(), [pageUrl, new URL(chainUrl).origin].sort());
  assert.deepEqual(seen.errors, []);
  await ctx.close();
});

test("a nested segwit account, through the page and the real signer", { skip }, async () => {
  chain = new Chain("signet");
  const upub = signer.bip32.serializeXpub(signer.bip32.neuter(signer.bip32.derive(signer.master, "m/49'/1'/0'")), "upub");
  const a = parseAccount(upub, "signet", MASTER_FINGERPRINT);
  chain.fund(addressAt(a, 0, 0).address, 90000);
  const { page, ctx, seen } = await open();
  await click(page, "input[value=signet]");
  await page.type("#key", upub);
  await hasText(page, "m/49'/1'/0' (P2SH-P2WPKH)");
  await hasText(page, addressAt(a, 0, 0).address);
  await page.type("#fingerprint", MASTER_FINGERPRINT);
  await page.waitForFunction(() => !document.getElementById("add").disabled);
  await Promise.all([page.waitForNavigation(), click(page, "#add")]);
  await chooseServer(page);
  await page.waitForSelector("#balance");
  assert.equal(await text(page, "#balance"), "0.00090000 BTC");

  await click(page, "#tab-receive");
  await page.waitForSelector("#receive-address");
  assert.equal(await text(page, "#receive-address"), addressAt(a, 0, 1).address);

  await click(page, "#tab-send");
  await page.waitForSelector("#address");
  await hasText(page, "about an hour");
  await page.type("#address", PAYEE);
  await page.type("#amount", "0.0002");
  await click(page, "#review");
  await page.waitForSelector("#review-amount");
  await hasText(page, "m/49'/1'/0'/1/0");
  await click(page, "#to-sign");
  await page.waitForSelector("#psbt-qr");
  await page.$eval("details", (e) => { e.open = true; });
  const psbt = signer.psbtLib.parsePsbt(fromBase64(await page.$eval("#psbt-text", (e) => e.value)));
  const plan = signer.sign.plan(psbt, signer.master, { network: "testnet" });
  assert.equal(plan.signable, 1);
  assert.equal(plan.outputs.filter((o) => o.ours && o.role === "change").length, 1);
  const done = signer.sign.finalize(signer.sign.signPsbt(psbt, signer.master, { network: "testnet" }).psbt);

  await click(page, "#to-scan");
  await page.waitForSelector("#signed");
  await page.$eval("#signed", (e, v) => { e.value = v; }, signer.transport.electrumQrText(done.tx));
  await click(page, "#read-pasted");
  await hasText(page, "This is the transaction built here, signed.");
  assert.equal(await text(page, "#signed-txid"), done.txid);

  await click(page, "#tab-settings");
  await page.waitForSelector("#descriptor");
  assert.match(await text(page, "#descriptor"), /^sh\(wpkh\(\[73c5da0a\/49h\/1h\/0h\]tpub/);
  await hasText(page, upub);
  assert.deepEqual(seen.errors, []);
  await ctx.close();
});

// A fake camera: a canvas stream showing these codes in turn, through the real
// <video> and decoder.
async function fakeCamera(page, codes, ms) {
  const frames = codes.map((text) => {
    const qr = makeQr(text);
    const dark = [];
    for (let r = 0; r < qr.size; r++) for (let c = 0; c < qr.size; c++) if (qr.dark(r, c)) dark.push([r, c]);
    return { dark, size: qr.size };
  });
  await page.evaluate(({ frames, ms }) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 720;
    const g = canvas.getContext("2d");
    let at = 0;
    const draw = () => {
      const { dark, size } = frames[at];
      const scale = Math.floor(720 / (size + 8));
      g.fillStyle = "#fff";
      g.fillRect(0, 0, 720, 720);
      g.fillStyle = "#000";
      for (const [r, c] of dark) g.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
    };
    draw();
    setInterval(() => {
      at = (at + 1) % frames.length;
      draw();
    }, ms);
    navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(20);
  }, { frames, ms });
}

// A large PSBT: previous transactions with many outputs, so several codes are needed.
function bigChain(a) {
  const c = new Chain("signet");
  for (let i = 0; i < 4; i++) {
    const { txid } = c.fund(addressAt(a, 0, i).address, 20000);
    const t = c.txs.get(txid);
    t.tx.outputs.push(...Array.from({ length: 40 }, (_, k) => ({ value: 1000 + k, script: t.tx.outputs[0].script.map((b, j) => (j > 1 ? (b + k + 1) & 255 : b)) })));
    c.txs.delete(txid);
    c.add(t.tx, t.height, t.inputs);
  }
  return c;
}

test("W2: a large PSBT as an animated series, read off the screen and signed; the signed series read back", { skip, timeout: 120000 }, async () => {
  const a = account();
  chain = bigChain(a);
  const { page, ctx, seen } = await open();
  await importAccount(page);
  await chooseServer(page);
  await page.waitForSelector("#balance");
  await click(page, "#tab-send");
  await page.waitForSelector("#address");
  await hasText(page, "about an hour");
  await page.type("#address", PAYEE);
  await page.type("#amount", "0.0007");
  await page.$eval("#rate", (e) => { e.value = ""; });
  await page.type("#rate", "1");
  await click(page, "#review");
  await page.waitForSelector("#to-sign");
  await click(page, "#to-sign");
  await page.waitForSelector("#series-qr");
  const info = await text(page, "#qr-info");
  assert.match(info, /BBQr, compressed: \d+ codes of QR version \d+/);
  const total = Number(/: (\d+) codes/.exec(info)[1]);
  const version = Number(/version (\d+)/.exec(info)[1]);
  assert.ok(total > 1 && version <= 12, info);

  // what's on the screen, frame by frame, through the page's decoder, as a camera would
  const { decodeFrame } = await import("../src/qr.js");
  const { Joiner } = await import("../vendor/zerogap/bbqr.js");
  const j = new Joiner();
  const seenParts = new Set();
  for (let tries = 0; tries < 200 && seenParts.size < total; tries++) {
    const frame = await page.evaluate(() => {
      const c = document.getElementById("series-qr");
      return { part: c.dataset.part, w: c.width, data: Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data) };
    });
    const read = decodeFrame(Uint8ClampedArray.from(frame.data), frame.w, frame.w);
    assert.ok(read, `part ${frame.part} reads`);
    assert.equal(read.text.length <= 8 + 2000, true);
    j.add(read.text);
    seenParts.add(frame.part);
    await new Promise((d) => setTimeout(d, 150));
  }
  assert.equal(seenParts.size, total, "the series comes round");
  const file = j.result();
  assert.equal(file.type, "P");
  await page.$eval("details", (e) => { e.open = true; });
  assert.equal(toHex(file.bytes), toHex(fromBase64(await page.$eval("#psbt-text", (e) => e.value))));

  // Pause holds it; a smaller series can be chosen
  await click(page, "#series-pause");
  const held = await page.$eval("#series-qr", (e) => e.dataset.part);
  await new Promise((d) => setTimeout(d, 700));
  assert.equal(await page.$eval("#series-qr", (e) => e.dataset.part), held);
  await page.select("#series-speed", "250");
  await page.waitForSelector("#series-qr");

  // sign what came off the screen, and answer with a series through the fake camera
  const psbt = signer.psbtLib.parsePsbt(file.bytes);
  const done = signer.sign.finalize(signer.sign.signPsbt(psbt, signer.master, { network: "testnet" }).psbt);
  const { split } = await import("../vendor/zerogap/bbqr.js");
  const series = split(done.tx, "T", { encoding: "2", maxParts: 4 });
  assert.ok(series.parts.length > 1, "the signed transaction needs several codes here");
  await click(page, "#to-scan");
  await page.waitForSelector("#start-camera");
  await fakeCamera(page, series.parts, 250);
  await click(page, "#start-camera");
  await hasText(page, "of " + series.parts.length + " codes");
  await page.waitForFunction(() => document.body.innerText.includes("This is the transaction built here, signed."), { timeout: 30000 });
  assert.equal(await text(page, "#signed-txid"), done.txid);
  assert.deepEqual(seen.errors, []);
  await ctx.close();
});

test("W2: a series pasted as lines; a damaged one is said to be", { skip }, async () => {
  chain = new Chain("signet");
  chain.fund(addressAt(account(), 0, 0).address, 90000);
  const { page, ctx } = await open();
  await importAccount(page);
  await chooseServer(page);
  await page.waitForSelector("#balance");
  await click(page, "#tab-send");
  await page.waitForSelector("#address");
  await hasText(page, "about an hour");
  await page.type("#address", PAYEE);
  await page.type("#amount", "0.0002");
  await click(page, "#review");
  await page.waitForSelector("#to-sign");
  await click(page, "#to-sign");
  await page.waitForSelector("#psbt-qr");
  await click(page, "#format-bbqr"); // by choice, though it fits one code
  await page.waitForSelector("#series-qr");
  assert.match(await text(page, "#qr-info"), /1 code of QR version/);
  await page.$eval("details", (e) => { e.open = true; });
  const psbt = signer.psbtLib.parsePsbt(fromBase64(await page.$eval("#psbt-text", (e) => e.value)));
  const done = signer.sign.finalize(signer.sign.signPsbt(psbt, signer.master, { network: "testnet" }).psbt);
  await click(page, "#to-scan");
  await page.waitForSelector("#signed");

  const { split } = await import("../vendor/zerogap/bbqr.js");
  const { parts } = split(done.tx, "T", { encoding: "H", maxParts: 3, minVersion: 3 });
  const paste = async (v) => {
    await page.$eval("#signed", (e, x) => { e.value = x; }, v);
    await click(page, "#read-pasted");
  };
  await paste(`${parts[0]}\n${parts[0].slice(0, -2)}FF`);
  await hasText(page, "started over");
  await paste([...parts].reverse().join("\n"));
  await hasText(page, "This is the transaction built here, signed.");
  assert.equal(await text(page, "#signed-txid"), done.txid);
  await ctx.close();
});

test("files: the PSBT saved under the page's policy, signed, and the transaction opened through the same checks", { skip }, async () => {
  chain = new Chain("signet");
  chain.fund(addressAt(account(), 0, 0).address, 90000);
  const { page, ctx, seen } = await open();
  const dir = mkdtempSync(join(tmpdir(), "gapwallet-"));
  try {
    await importAccount(page);
    await chooseServer(page);
    await page.waitForSelector("#balance");
    await click(page, "#tab-send");
    await page.waitForSelector("#address");
    await hasText(page, "about an hour");
    await page.type("#address", PAYEE);
    await page.type("#amount", "0.0002");
    await click(page, "#review");
    await page.waitForSelector("#to-sign");
    await click(page, "#to-sign");
    await page.waitForSelector("#psbt-qr");
    await page.$eval("details", (e) => { e.open = true; });
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, browserContextId: ctx.id, eventsEnabled: true });
    await click(page, "#save-psbt");
    let names = [];
    for (let i = 0; i < 50 && !names.some((n) => n.endsWith(".psbt")); i++) {
      await new Promise((d) => setTimeout(d, 100));
      names = readdirSync(dir);
    }
    const saved = names.find((n) => n.endsWith(".psbt"));
    assert.ok(saved, `saved: ${names}`);
    const bytes = readFileSync(join(dir, saved));
    assert.equal(toHex(bytes), toHex(fromBase64(await page.$eval("#psbt-text", (e) => e.value))));

    // the saved file goes to the real signer
    const psbt = signer.psbtLib.parsePsbt(new Uint8Array(bytes));
    const signedPsbt = signer.sign.signPsbt(psbt, signer.master, { network: "testnet" }).psbt;
    const done = signer.sign.finalize(signedPsbt);

    await click(page, "#to-scan");
    await page.waitForSelector("#signed-file");
    const open_ = async (name, data) => {
      writeFileSync(join(dir, name), data);
      const input = await page.$("#signed-file");
      await input.uploadFile(join(dir, name));
    };
    // a file that isn't one; a PSBT not yet finished; another transaction: none goes through
    await open_("junk.txn", Uint8Array.of(0, 1, 2, 200, 201));
    await hasText(page, "isn't a transaction");
    await open_("unsigned.psbt", bytes);
    await hasText(page, "0 of 1 inputs signed");
    assert.equal(await page.$("#broadcast"), null);
    const tampered = Uint8Array.from(done.tx);
    tampered[tampered.length - 200] ^= 1;
    await open_("other.txn", tampered);
    await hasText(page, "isn't the transaction built here");
    assert.equal(await page.$eval("#broadcast", (e) => e.disabled), true);
    // the real one, raw, then as hex
    await open_("signed.txn", done.tx);
    await hasText(page, "This is the transaction built here, signed.");
    assert.equal(await text(page, "#signed-txid"), done.txid);
    assert.equal(await page.$eval("#broadcast", (e) => e.disabled), false);
    await open_("signed.hex", `${toHex(done.tx)}\n`);
    await hasText(page, "This is the transaction built here, signed.");
    assert.deepEqual(seen.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await ctx.close();
  }
});

test("W2: a public key read with the camera; a seed's code doesn't reach the screen", { skip, timeout: 60000 }, async () => {
  const { page, ctx } = await open();
  await click(page, "input[value=signet]");
  await fakeCamera(page, ["02640321987654321098765432109876543210987654"], 200);
  await click(page, "#import-start");
  await hasText(page, "isn't a descriptor");
  assert.equal(await page.$eval("#key", (e) => e.value), "");
  assert.equal(await page.evaluate(() => document.body.innerText.includes("0264032198")), false);
  await ctx.close();

  const second = await open();
  await click(second.page, "input[value=signet]");
  const { split } = await import("../vendor/zerogap/bbqr.js");
  const descriptor = accountDescriptor(account());
  const { parts } = split(new TextEncoder().encode(descriptor), "U", { encoding: "2", maxParts: 2, minVersion: 2 });
  assert.equal(parts.length, 2);
  await fakeCamera(second.page, parts, 250);
  await click(second.page, "#import-start");
  await hasText(second.page, addressAt(account(), 0, 0).address);
  assert.equal(await second.page.$eval("#key", (e) => e.value), descriptor);
  assert.equal(await second.page.$eval("#add", (e) => e.disabled), false);
  await second.ctx.close();
});

test("a PSBT too big for one code goes out whole; a transaction other than the one built needs an explicit yes", { skip }, async () => {
  chain = bigChain(account()); // previous transactions so large that the PSBT can't fit one code
  const { page, ctx, seen } = await open();
  await importAccount(page);
  await chooseServer(page);
  await page.waitForSelector("#balance");
  await click(page, "#tab-send");
  await page.waitForSelector("#address");
  await page.type("#address", PAYEE);
  await page.type("#amount", "0.0007");
  await page.$eval("#rate", (e) => { e.value = ""; });
  await page.type("#rate", "1");
  await click(page, "#review");
  await page.waitForSelector("#to-sign");
  await click(page, "#to-sign");
  await hasText(page, "doesn't fit in one QR code");
  assert.equal(await page.$("#format-base43:disabled") !== null, true);
  await page.waitForSelector("#series-qr");
  // the previous transactions stay in: nothing offers to take them out
  assert.equal(await page.$("#drop-previous"), null);
  await page.$eval("details", (e) => { e.open = true; });
  const whole = signer.psbtLib.parsePsbt(fromBase64(await page.$eval("#psbt-text", (e) => e.value)));
  assert.ok(whole.inputs.every((m) => m.fields.nonWitnessUtxo));
  assert.deepEqual(seen.errors, []);

  await click(page, "#to-scan");
  await page.waitForSelector("#signed");
  const other = "02000000000101" + "11".repeat(32) + "00000000" + "00" + "fdffffff" + "01" + "e803000000000000" + "160014" + "22".repeat(20) + "02" + "47" + "33".repeat(71) + "21" + "44".repeat(33) + "00000000";
  await page.type("#signed", other);
  await click(page, "#read-pasted");
  await hasText(page, "isn't the transaction built here");
  assert.equal(await page.$eval("#broadcast", (e) => e.disabled), true);
  await click(page, "#ack-different");
  assert.equal(await page.$eval("#broadcast", (e) => e.disabled), false);
  chain.overrides.push((m, p) => (m === "POST" ? { status: 400, body: 'sendrawtransaction RPC error: {"code":-25,"message":"missing inputs"}', type: "text/plain" } : null));
  await click(page, "#broadcast");
  await hasText(page, "missing inputs");
  assert.equal(chain.requests.filter((r) => r === "POST /tx").length, 1);
  await ctx.close();
});

test("W4: pt-BR chosen in the header and kept; amounts read its way, the ambiguous refused; a seed cleared in it too", { skip }, async () => {
  chain = new Chain("signet");
  chain.fund(addressAt(account(), 0, 0).address, 500000);
  const { page, ctx, seen } = await open();
  await page.select("#language", "pt-BR");
  await hasText(page, "Adicionar uma conta");
  assert.equal(await page.evaluate(() => document.documentElement.lang), "pt-BR");
  await click(page, "input[value=signet]");
  await page.$eval("#key", (e) => {
    e.value = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    e.dispatchEvent(new Event("input"));
  });
  await hasText(page, "chave privada ou uma semente");
  assert.equal(await page.$eval("#key", (e) => e.value), "");
  await page.reload();
  await importAccount(page);
  await hasText(page, "Escolha um servidor"); // kept across the reload
  await chooseServer(page);
  await page.waitForSelector("#balance");
  assert.equal(await text(page, "#balance"), "0,00500000 BTC");
  await click(page, "#tab-send");
  await page.waitForSelector("#address");
  await page.type("#address", PAYEE);
  await page.type("#amount", "1.000");
  await hasText(page, "pode ser lido de duas formas");
  await page.$eval("#amount", (e) => { e.value = ""; });
  await page.type("#amount", "0,0001");
  assert.equal(await text(page, "#amount-read"), "= 0,00010000 BTC");
  await page.$eval("#rate", (e) => { e.value = ""; });
  await page.type("#rate", "1,5");
  await click(page, "#review");
  await page.waitForSelector("#to-sign");
  assert.equal(await text(page, "#review-amount"), "0,00010000 BTC");
  assert.match(await text(page, "#review-fee"), /a 1,5 sat\/vB/);
  assert.equal(await text(page, "#to-sign"), "Preparar para Assinatura");
  await click(page, "#to-sign");
  await hasText(page, "Assine Externamente");
  await hasText(page, "aplicativos de assinatura externos");
  await page.select("#language", "en"); // mid-send, the step stays
  await hasText(page, "Sign it Externally");
  assert.deepEqual(seen.errors, []);
  await ctx.close();
});
