// The Esplora client. docs/ESPLORA.md lists every request; a request that
// isn't here isn't made.
//

export const GENESIS = {
  mainnet: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
  signet: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
  testnet4: "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043",
};

export const PRESETS = {
  mainnet: "https://mempool.space/api",
  signet: "https://mempool.space/signet/api",
  testnet4: "https://mempool.space/testnet4/api",
};

const MAX_CONCURRENT = 4, TIMEOUT_MS = 20000, RETRIES = 6;

// Requests are paced (docs/ESPLORA.md, "Requests"). mempool.space's limit
// answers 429 with no CORS header, so a browser can't see that answer: fetch
// just fails. Any failure may be the limit, so each one holds every request
// back and slows them all down; a run of successes speeds up again.
//
// The pace: a public server's limit is well under what it can serve, and going
// over it costs more than going slowly (see the measurements there). Only
// a server on your own network starts fast; anywhere else, assume a limit.
export const PUBLIC_INTERVAL_MS = 500, OWN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 4000, SPEED_UP_AFTER = 20;

export function isPrivateHost(base) {
  const host = new URL(base).hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /\.(local|lan|home\.arpa)$/.test(host)
    || /^(127|10)\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
}

const intervalFor = (base) => (isPrivateHost(base) ? OWN_INTERVAL_MS : PUBLIC_INTERVAL_MS);

export class EsploraError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "EsploraError";
    this.status = status;
  }
}

// A server's address, cleaned up: { base, origin }. Throws EsploraError.
export function parseServer(text) {
  let u;
  try {
    u = new URL(String(text).trim());
  } catch {
    throw new EsploraError("That isn't a web address.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new EsploraError("A server's address starts with https:// or http://.");
  if (u.username || u.password) throw new EsploraError("A server's address can't hold a user name or password.");
  if (u.search || u.hash) throw new EsploraError("A server's address has no query or fragment.");
  return { base: u.origin + u.pathname.replace(/\/+$/, ""), origin: u.origin };
}

export class Esplora {
  // options: fetch, sleep and clock (for tests)
  constructor(base, { fetch: f, sleep, clock, timeoutMs, interval } = {}) {
    this.base = base;
    this.fetch = f || ((...a) => globalThis.fetch(...a));
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = timeoutMs ?? TIMEOUT_MS;
    this.clock = clock || (() => Date.now());
    this.running = 0;
    this.waiting = [];
    this.fastest = interval ?? intervalFor(base);
    this.interval = this.fastest;
    this.nextStart = 0; // the time the next request may start
    this.heldUntil = 0; // nothing starts before this, after a failure
    this.goodRun = 0;
    this.onHold = null; // (seconds) -> void: requests are being held back
  }

  // Takes the next place in line and waits for it.
  async pace() {
    const now = this.clock();
    const at = Math.max(now, this.nextStart);
    this.nextStart = at + this.interval;
    if (at > now) await this.sleep(at - now);
    while (this.clock() < this.heldUntil) await this.sleep(this.heldUntil - this.clock());
  }

  succeeded() {
    if (++this.goodRun >= SPEED_UP_AFTER) {
      this.goodRun = 0;
      this.interval = Math.max(this.fastest, this.interval * 0.75);
    }
  }

  // Requests in flight fail together: within a hold they're one event, and
  // slow the pace once.
  failed(waitMs) {
    this.goodRun = 0;
    if (this.clock() >= this.heldUntil) this.interval = Math.min(MAX_INTERVAL_MS, this.interval * 2);
    this.heldUntil = Math.max(this.heldUntil, this.clock() + waitMs);
    if (this.onHold) this.onHold(Math.ceil(waitMs / 1000));
  }

  async slot(fn) {
    if (this.running >= MAX_CONCURRENT) await new Promise((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  async once(path, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetch(this.base + path, { ...init, signal: ctl.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    } finally {
      clearTimeout(timer);
    }
  }

  async get(path) {
    return this.slot(async () => {
      for (let attempt = 0; ; attempt++) {
        await this.pace();
        let response = null, failure = null;
        try {
          response = await this.once(path, {});
        } catch (e) {
          failure = e;
        }
        const busy = response && (response.status === 429 || response.status === 503);
        if (!failure && !busy) {
          this.succeeded();
          const text = await response.text();
          if (!response.ok) throw new EsploraError(`The server answered ${response.status}: ${text.slice(0, 200)}`, response.status);
          return text;
        }
        if (attempt >= RETRIES) {
          if (busy) throw new EsploraError(`The server is busy (${response.status}). Try again later.`, response.status);
          throw new EsploraError(`The server can't be reached, or is limiting requests. Try again later. (${failure.message})`);
        }
        const after = busy ? Number(response.headers.get("retry-after")) : 0;
        this.failed(after > 0 ? after * 1000 : 1000 * 2 ** attempt);
      }
    });
  }

  async json(path) {
    const text = await this.get(path);
    try {
      return JSON.parse(text);
    } catch {
      throw new EsploraError(`The server's answer to ${path.split("/")[1]} isn't JSON.`);
    }
  }

  async checkNetwork(network) {
    const hash = (await this.get("/block-height/0")).trim();
    if (hash !== GENESIS[network]) throw new EsploraError(`This server isn't on ${network}: its first block is a different one.`);
  }

  async tipHeight() {
    const n = Number((await this.get("/blocks/tip/height")).trim());
    if (!Number.isSafeInteger(n) || n < 0) throw new EsploraError("The server gave a bad block height.");
    return n;
  }

  address(a) {
    return this.json(`/address/${a}`);
  }
  utxos(a) {
    return this.json(`/address/${a}/utxo`);
  }
  txs(a) {
    return this.json(`/address/${a}/txs`);
  }
  txsAfter(a, lastTxid) {
    return this.json(`/address/${a}/txs/chain/${lastTxid}`);
  }
  async txHex(txid) {
    return (await this.get(`/tx/${txid}/hex`)).trim();
  }
  feeEstimates() {
    return this.json("/fee-estimates");
  }

  // Never retried (docs/ESPLORA.md). -> the txid the server says.
  async broadcast(hex) {
    return this.slot(async () => {
      await this.pace();
      const r = await this.once("/tx", { method: "POST", headers: { "Content-Type": "text/plain" }, body: hex });
      const text = (await r.text()).trim();
      if (!r.ok) throw new EsploraError(text.slice(0, 500) || `The server answered ${r.status}.`, r.status);
      return text;
    });
  }
}
