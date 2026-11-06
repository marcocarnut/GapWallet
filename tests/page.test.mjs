// The built page, in headless Chromium, against the stub chain over HTTP.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { Chain, haveSigner, loadSigner, MASTER_FINGERPRINT } from "./helpers.mjs";
import { addressAt } from "../src/account.js";
import { parseAccount } from "../src/descriptor.js";
import { makeQr } from "../src/qr.js";
import { fromBase64, toHex } from "../vendor/zerogap/psbt/bytes.js";

const CHROME = ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
let puppeteer = null;
try {
  puppeteer = (await import("puppeteer-core")).default;
} catch { /* skipped */ }
const skip = !CHROME || !puppeteer || !haveSigner ? "needs Chromium, puppeteer-core and the zerogap repository" : false;

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
  chain.limit = { perWindow: 3, windowMs: 1000 };
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
  assert.equal(await page.$("#drop-previous"), null, "a small PSBT isn't offered the choice");

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

test("a transaction other than the one built needs an explicit yes; a big PSBT's choice is explicit", { skip }, async () => {
  chain = new Chain("signet");
  const a = account();
  // previous transactions so large that the PSBT can't fit one code
  for (let i = 0; i < 4; i++) {
    const { txid } = chain.fund(addressAt(a, 0, i).address, 20000);
    const t = chain.txs.get(txid);
    t.tx.outputs.push(...Array.from({ length: 40 }, (_, k) => ({ value: 1000 + k, script: t.tx.outputs[0].script.map((b, j) => (j > 1 ? (b + k + 1) & 255 : b)) })));
    chain.txs.delete(txid);
    chain.txs.set(chain.add(t.tx, t.height, t.inputs), t);
  }
  const { page, ctx } = await open();
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
  // the button stays off until the user acknowledges
  assert.equal(await page.$eval("#drop-previous", (e) => e.disabled), true);
  await click(page, "#ack-previous");
  await click(page, "#drop-previous");
  await page.waitForSelector("#psbt-qr");
  await hasText(page, "Previous transactions are left out");
  await hasText(page, "can't prove");

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
