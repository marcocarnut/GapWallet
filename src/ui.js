// The page. All text reaches the DOM as text nodes, so nothing a server says
// can become markup.
import { h, mount, copyText, download } from "./dom.js";
import { NETWORK_INFO, parseAccount, accountDescriptor, accountPath, ImportError } from "./descriptor.js";
import { addressAt } from "./account.js";
import { Esplora, EsploraError, PRESETS, parseServer } from "./esplora.js";
import { DEFAULT_GAP, scanAccount } from "./scan.js";
import { MIN_RATE, MAX_RATE, cleanEstimates, feeWarnings } from "./coinselect.js";
import { BuildError, buildSpend, psbtBytes } from "./build.js";
import { readSigned } from "./signed.js";
import { MAX_ALPHANUMERIC, Scanner, drawQr, makeQr } from "./qr.js";
import { parseBtc, formatBtc } from "./amount.js";
import { save } from "./store.js";
import { toBase64 } from "../vendor/zerogap/psbt/bytes.js";
import { electrumQrText } from "../vendor/zerogap/psbt/transport.js";
import { scriptToAddress } from "../vendor/zerogap/psbt/script.js";
import { serializeXpub } from "../vendor/zerogap/bip32.js";

const btc = (sats) => `${formatBtc(sats)} BTC`;
const shortId = (id) => `${id.slice(0, 10)}…${id.slice(-6)}`;
const FEE_TARGETS = [[1, "next block"], [3, "3 blocks"], [6, "about an hour"], [144, "about a day"]];
const LARGE_QR_VERSION = 25;
const RECEIVE_LIST = 5;

const PRIVACY = [
  ["The Esplora server", "Every address of this account, asked in a burst from one IP address and so linked together: the wallet's balance and whole history, and when you open it. Each transaction you send, before anyone else sees it, and the IP that sent it."],
  ["Network observers", "With HTTPS, that this page talks to that server, not what it asks."],
  ["The site serving this page", "That the page was loaded. Nothing else: no request goes to it. Better still, run the file from disk or your own server."],
  ["The camera", "Nothing leaves the page: frames are decoded here and never sent."],
];

function privacyTable() {
  return h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Who"), h("th", {}, "What they learn"))),
    h("tbody", {}, ...PRIVACY.map(([who, what]) => h("tr", {}, h("td", { class: "who" }, who), h("td", {}, what)))));
}

const notice = (kind, ...text) => h("div", { class: `notice ${kind}`, role: kind === "bad" ? "alert" : null }, ...text);

export class App {
  constructor(root, state, record) {
    this.root = root;
    this.state = state;
    this.record = record;
    this.tab = "overview";
    this.adding = !record;
    this.account = null;
    this.scan = null;
    this.scanError = null;
    this.scanning = null;
    this.send = null;
    this.camera = null;
    if (record) {
      this.account = parseAccount(record.key, record.network, record.fingerprint);
      const server = state.servers[record.network];
      if (server) this.client = new Esplora(server);
    }
  }

  persist() {
    save(this.state);
  }

  // The policy is set when the page starts, so these changes take a reload.
  reload() {
    this.persist();
    location.reload();
  }

  start() {
    this.render();
    if (this.client) this.refresh();
  }

  render() {
    this.stopCamera();
    if (this.adding) mount(this.root, this.header(), this.importView());
    else if (!this.client) mount(this.root, this.header(), this.serverView());
    else mount(this.root, this.header(), this.nav(), this[`${this.tab}View`]());
  }

  header() {
    const a = this.record;
    const pick = !a ? null : h("select", { id: "account", "aria-label": "Account", onchange: (e) => {
      if (e.target.value === "") {
        this.adding = true;
        this.render();
        return;
      }
      this.state.current = e.target.value;
      this.reload();
    } }, ...this.state.accounts.map((x) => h("option", { value: x.id, selected: x.id === a.id }, x.label)),
    h("option", { value: "" }, "Add an account…"));
    return h("header", {},
      h("h1", {}, "GapWallet"),
      a ? h("span", { class: `badge${a.network === "mainnet" ? "" : " test"}`, id: "network" }, NETWORK_INFO[a.network].name) : null,
      a && !this.account.fingerprint ? h("span", { class: "badge", id: "watchonly" }, "watch-only") : null,
      h("span", { class: "grow" }), pick,
      a && this.client && !this.adding ? h("button", { id: "refresh", class: "small", disabled: Boolean(this.scanning), onclick: () => this.refresh() }, this.scanning ? "Scanning…" : "Refresh") : null);
  }

  nav() {
    const tabs = [["overview", "Overview"], ["receive", "Receive"], ["send", "Send"], ["settings", "Settings"]];
    return h("nav", { role: "tablist" }, ...tabs.map(([id, name]) => h("button", { id: `tab-${id}`, role: "tab", "aria-selected": String(this.tab === id), onclick: () => {
      this.tab = id;
      this.render();
    } }, name)));
  }

  // ---- Import ----

  importView() {
    const form = { network: null };
    const preview = h("div", { id: "preview" });
    const key = h("textarea", { id: "key", spellcheck: "false", autocapitalize: "off", placeholder: "wpkh([73c5da0a/84h/0h/0h]xpub…/<0;1>/*)#…   or   zpub…" });
    const fp = h("input", { id: "fingerprint", type: "text", spellcheck: "false", placeholder: "73c5da0a", maxlength: "8" });
    const label = h("input", { id: "label", type: "text", value: `Account ${this.state.accounts.length + 1}` });
    const add = h("button", { id: "add", class: "primary", disabled: true }, "Add this account");
    let parsed = null;

    const check = () => {
      parsed = null;
      add.disabled = true;
      if (key.value.trim() === "") {
        mount(preview);
        return;
      }
      try {
        parsed = parseAccount(key.value, form.network, fp.value);
      } catch (e) {
        if (!(e instanceof ImportError)) throw e;
        key.value = /private key or a seed/.test(e.message) ? "" : key.value; // don't leave it lying on the screen
        mount(preview, notice("bad", e.message));
        return;
      }
      add.disabled = false;
      mount(preview,
        h("dl", {},
          h("dt", {}, "Account"), h("dd", { class: "mono" }, `${accountPath(parsed)} (P2WPKH)`),
          h("dt", {}, "Master fingerprint"), h("dd", { class: "mono" }, parsed.fingerprint || "none yet")),
        ...parsed.warnings.map((w) => notice("warn", w)),
        parsed.fingerprint ? null : notice("warn", "Without the master fingerprint this account is watch-only: you'll see its balance and history, but can't build transactions until you add it. The signer shows it with the public key."),
        h("h3", {}, "Its first addresses"),
        h("p", { class: "small dim" }, "Compare these with the device that made the key, before you trust them."),
        ...[0, 1, 2].map((i) => h("div", { class: "mono" }, `${i}  ${addressAt(parsed, 0, i).address}`)));
    };
    key.addEventListener("input", check);
    fp.addEventListener("input", check);
    add.addEventListener("click", () => {
      const id = `a${Date.now().toString(36)}`;
      this.state.accounts.push({ id, label: label.value.trim() || id, network: form.network, key: key.value.trim(), fingerprint: fp.value.trim().toLowerCase(), gapLimit: DEFAULT_GAP });
      this.state.current = id;
      this.reload();
    });

    return h("div", { class: "panel" },
      h("h2", {}, "Add an account"),
      h("p", {}, "GapWallet only ever holds public keys. Nothing here is sent anywhere: the page contacts no server until you choose one."),
      h("label", {}, "Network"),
      ...Object.entries(NETWORK_INFO).map(([id, info]) => h("label", { class: "radio" },
        h("input", { type: "radio", name: "network", value: id, onchange: () => {
          form.network = id;
          check();
        } }), info.name)),
      h("label", { for: "key" }, "Descriptor or zpub"), key,
      h("label", { for: "fingerprint" }, "Master fingerprint (a descriptor already has it)"), fp,
      h("label", { for: "label" }, "Name"), label,
      preview,
      h("div", { class: "row" }, add,
        this.record ? h("button", { onclick: () => {
          this.adding = false;
          this.render();
        } }, "Cancel") : null));
  }

  // ---- Server ----

  serverChooser() {
    const network = this.record.network;
    const url = h("input", { id: "server", type: "text", spellcheck: "false", placeholder: "https://…", value: this.state.servers[network] || "" });
    const message = h("div", {});
    const use = (text) => {
      try {
        this.state.servers[network] = parseServer(text).base;
      } catch (e) {
        if (!(e instanceof EsploraError)) throw e;
        mount(message, notice("bad", e.message));
        return;
      }
      this.reload();
    };
    return h("div", {},
      h("p", {}, `An Esplora server answers for this ${NETWORK_INFO[network].name} account. There is no default: it's your choice, because of what the server learns.`),
      privacyTable(),
      h("div", { class: "row" }, h("button", { id: "preset", class: "primary", onclick: () => use(PRESETS[network]) }, `Use ${new URL(PRESETS[network]).host}`)),
      h("label", { for: "server" }, "Or your own server"), url, message,
      h("div", { class: "row" }, h("button", { id: "use-server", onclick: () => use(url.value) }, "Use this server")));
  }

  serverView() {
    return h("div", { class: "panel" }, h("h2", {}, "Choose a server"), this.serverChooser());
  }

  // ---- Scan ----

  async refresh() {
    if (this.scanning) return;
    this.scanning = { text: "Checking the server…" };
    this.scanError = null;
    this.rerender();
    this.client.onHold = (seconds) => {
      if (!this.scanning) return;
      this.scanning.text = `The server is slowing us down: waiting ${seconds} s…`;
      this.showProgress();
    };
    try {
      await this.client.checkNetwork(this.record.network);
      this.scan = await scanAccount(this.account, this.client, { gapLimit: this.record.gapLimit, onProgress: (text) => {
        this.scanning.text = text;
        this.showProgress();
      } });
    } catch (e) {
      if (!(e instanceof EsploraError)) throw e;
      this.scanError = e.message;
    } finally {
      this.scanning = null;
      this.rerender();
    }
  }

  // Scans finish while the user may be typing or in the send steps: those keep their screen.
  rerender() {
    if (this.tab === "send" && this.send?.stage && this.send.stage !== "form") {
      const r = document.getElementById("refresh");
      if (r) r.disabled = Boolean(this.scanning);
      return;
    }
    if (!this.adding) this.render();
  }

  showProgress() {
    const p = document.getElementById("progress");
    if (p && this.scanning) p.textContent = this.scanning.text;
  }

  status() {
    if (this.scanning) return h("p", { id: "progress", class: "dim" }, this.scanning.text);
    if (this.scanError) return notice("bad", this.scanError);
    return null;
  }

  fingerprintPrompt() {
    const fp = h("input", { id: "add-fingerprint", type: "text", spellcheck: "false", maxlength: "8", placeholder: "73c5da0a" });
    const message = h("div", {});
    return notice("warn",
      h("strong", {}, "Watch-only: no master fingerprint."),
      h("p", {}, "You can see this account, but a signer couldn't find its keys in a transaction built here. The device that made the key shows the fingerprint with it."),
      h("label", { for: "add-fingerprint" }, "Master fingerprint"), fp, message,
      h("div", { class: "row" }, h("button", { id: "save-fingerprint", onclick: () => {
        try {
          parseAccount(this.record.key, this.record.network, fp.value);
          if (!/^[0-9a-fA-F]{8}$/.test(fp.value.trim())) throw new ImportError("A master fingerprint is 8 hexadecimal digits, like 73c5da0a.");
        } catch (e) {
          if (!(e instanceof ImportError)) throw e;
          mount(message, notice("bad", e.message));
          return;
        }
        this.record.fingerprint = fp.value.trim().toLowerCase();
        this.reload();
      } }, "Save fingerprint")));
  }

  // ---- Overview ----

  overviewView() {
    const s = this.scan;
    const body = [this.status(), this.account.fingerprint ? null : this.fingerprintPrompt()];
    if (!s) return h("div", {}, ...body);
    body.push(h("div", { class: "panel" },
      h("div", { class: "dim small" }, "Balance"),
      h("div", { class: "balance", id: "balance" }, btc(s.balance.confirmed)),
      s.balance.unconfirmed ? h("div", { id: "unconfirmed" }, `and ${btc(s.balance.unconfirmed)} unconfirmed`) : null));
    body.push(h("div", { class: "panel" }, h("h2", {}, "History"),
      s.history.length === 0 ? h("p", { class: "dim" }, "Nothing yet.") : h("table", { id: "history" },
        h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "What"), h("th", { class: "num" }, "Amount (BTC)"))),
        h("tbody", {}, ...s.history.map((t) => this.historyRow(t))))));
    return h("div", {}, ...body);
  }

  historyRow(t) {
    const when = t.height === null ? "unconfirmed" : t.time ? new Date(t.time * 1000).toISOString().slice(0, 10) : `block ${t.height}`;
    const what = { in: "Received", out: "Sent", self: "Moved within this account" }[t.kind];
    return h("tr", { class: t.kind },
      h("td", { class: "nowrap" }, when, h("div", { class: "small dim" }, t.height === null ? "" : `${t.confirmations} conf.`)),
      h("td", {}, what, h("div", { class: "small dim mono" }, shortId(t.txid))),
      h("td", { class: "num" }, t.kind === "self" ? h("span", { class: "dim" }, `fee ${formatBtc(t.fee)}`) : h("span", { class: t.net >= 0 ? "good" : "" }, `${t.net >= 0 ? "+" : ""}${formatBtc(t.net)}`)));
  }

  // ---- Receive ----

  receiveView() {
    if (!this.scan) return h("div", {}, this.status(), h("p", { class: "dim" }, "Addresses show once the scan has checked which are used."));
    this.receiveIndex ??= this.scan.next[0];
    if (this.receiveIndex < this.scan.next[0]) this.receiveIndex = this.scan.next[0];
    const first = this.scan.next[0];
    const a = addressAt(this.account, 0, this.receiveIndex);
    const canvas = h("canvas", { class: "code", id: "receive-qr" });
    drawQr(canvas, makeQr(a.address, "Byte"), 6);
    return h("div", { class: "panel" }, this.status(),
      h("h2", {}, "Receive"),
      h("div", { class: "qr" }, canvas),
      h("p", { class: "mono", id: "receive-address" }, a.address),
      h("p", { class: "small dim mono" }, a.path),
      h("div", { class: "row" }, h("button", { class: "small", onclick: () => copyText(a.address) }, "Copy")),
      h("h3", {}, "Next addresses"),
      ...Array.from({ length: RECEIVE_LIST }, (_, i) => {
        const e = addressAt(this.account, 0, first + i);
        return h("div", { class: "row" }, h("button", { class: "small", "aria-pressed": String(e.index === this.receiveIndex), onclick: () => {
          this.receiveIndex = e.index;
          this.render();
        } }, `#${e.index}`), h("span", { class: "mono" }, e.address));
      }),
      h("p", { class: "small dim" }, `The wallet doesn't record which addresses you've given out. If you hand out more than the gap limit (${this.record.gapLimit}) with none paid, a later payment can fall past the scan: raise the gap limit in Settings to see it.`));
  }

  // ---- Send ----

  sendView() {
    if (!this.account.fingerprint) return h("div", {}, this.status(), this.fingerprintPrompt());
    if (!this.scan) return h("div", {}, this.status(), h("p", { class: "dim" }, "Sending needs a finished scan."));
    this.send ??= { stage: "form", form: { address: "", amount: "", sendAll: false, rate: "", hand: false, ticked: new Set() } };
    const steps = [["form", "1 Details"], ["review", "2 Review"], ["show", "3 Sign"], ["scan", "4 Read back"], ["done", "5 Sent"]];
    const body = { form: () => this.sendForm(), review: () => this.sendReview(), show: () => this.sendShow(), scan: () => this.sendScan(), done: () => this.sendDone() }[this.send.stage]();
    return h("div", { class: "panel" },
      h("ol", { class: "steps" }, ...steps.map(([id, name]) => h("li", { "aria-current": id === this.send.stage ? "step" : null }, name))),
      body);
  }

  go(stage) {
    this.send.stage = stage;
    this.render();
  }

  sendForm() {
    const f = this.send.form;
    const message = h("div", { id: "send-error" });
    const address = h("input", { id: "address", type: "text", spellcheck: "false", value: f.address, oninput: (e) => (f.address = e.target.value) });
    const amount = h("input", { id: "amount", type: "text", inputmode: "decimal", placeholder: "0.001", value: f.amount, disabled: f.sendAll, oninput: (e) => (f.amount = e.target.value) });
    const rate = h("input", { id: "rate", type: "text", inputmode: "decimal", value: f.rate, oninput: (e) => {
      f.rate = e.target.value;
      paint();
    } });
    const choices = h("div", { class: "choices", id: "fee-choices" });
    const paint = () => {
      const est = this.send.estimates;
      mount(choices, ...(!est ? [h("span", { class: "dim small" }, "Fetching estimates…")] : FEE_TARGETS.filter(([n]) => est[n] !== undefined).map(([n, name]) => h("button", {
        "aria-pressed": String(Number(f.rate) === est[n]), onclick: () => {
          f.rate = String(est[n]);
          rate.value = f.rate;
          paint();
        } }, `${name}: ${est[n]} sat/vB`))));
    };
    paint();
    if (this.send.estimates === undefined) {
      this.send.estimates = null;
      this.client.feeEstimates().then((answer) => {
        const est = cleanEstimates(answer);
        this.send.estimates = est;
        if (!f.rate && est[6] !== undefined) f.rate = String(est[6]);
        rate.value = f.rate;
        paint();
      }).catch(() => {
        mount(choices, h("span", { class: "small" }, "The server gave no fee estimates: type a rate."));
      });
    }

    const coinList = h("div", { id: "coins" }, ...(this.scan.coins.length === 0 ? [h("p", { class: "dim small" }, "No coins yet.")] : [h("table", {},
      h("tbody", {}, ...this.scan.coins.map((c) => {
        const id = `${c.txid}:${c.vout}`;
        return h("tr", {},
          h("td", {}, h("input", { type: "checkbox", "aria-label": "Spend this coin", checked: f.ticked.has(id), onchange: (e) => {
            if (e.target.checked) f.ticked.add(id);
            else f.ticked.delete(id);
          } })),
          h("td", { class: "mono" }, c.entry.path.split("/").slice(-2).join("/"), c.confirmed ? "" : " (unconfirmed)"),
          h("td", { class: "num" }, formatBtc(c.value)));
      })))]));

    const review = h("button", { id: "review", class: "primary", onclick: async () => {
      mount(message);
      review.disabled = true;
      try {
        await this.buildFromForm();
        this.go("review");
      } catch (e) {
        if (!(e instanceof BuildError || e instanceof RangeError || e instanceof EsploraError)) throw e;
        review.disabled = false;
        mount(message, notice("bad", e.message));
      }
    } }, "Review");

    return h("div", {}, this.status(),
      h("label", { for: "address" }, "Pay to"), address,
      h("label", { for: "amount" }, "Amount (BTC)"), amount,
      h("label", { class: "check" }, h("input", { id: "send-all", type: "checkbox", checked: f.sendAll, onchange: (e) => {
        f.sendAll = e.target.checked;
        amount.disabled = f.sendAll;
      } }), "Send everything (no change)"),
      h("label", { for: "rate" }, `Fee rate (sat/vB, ${MIN_RATE} to ${MAX_RATE})`), choices, h("div", { class: "row" }, rate),
      h("details", { open: f.hand ? true : null, ontoggle: (e) => (f.hand = e.target.open) },
        h("summary", {}, "Choose coins by hand"),
        h("p", { class: "small dim" }, "Exactly the ticked coins are spent, confirmed or not. With none ticked, the wallet chooses among confirmed coins."),
        coinList),
      message,
      h("div", { class: "row" }, review));
  }

  async buildFromForm() {
    const f = this.send.form;
    const sendAll = f.sendAll;
    const amount = sendAll ? 0 : parseBtc(f.amount);
    const rate = Number(f.rate);
    if (f.rate.trim() === "" || !Number.isFinite(rate)) throw new RangeError("Enter a fee rate.");
    const coins = f.hand && f.ticked.size ? this.scan.coins.filter((c) => f.ticked.has(`${c.txid}:${c.vout}`)) : null;
    const spend = await buildSpend(this.account, this.scan, { address: f.address, amount, sendAll, rate, coins }, this.client);
    const send = this.send;
    send.spend = spend;
    send.warnings = feeWarnings({ fee: spend.fee, amount: spend.amount, rate, estimate: send.estimates?.[1] });
    send.includePrevious = true;
    send.signed = null;
  }

  sendReview() {
    const { spend, warnings } = this.send;
    const go = h("button", { id: "to-sign", class: "primary", disabled: warnings.length > 0, onclick: () => this.go("show") }, "Show it to the signer");
    return h("div", {},
      h("h2", {}, "Review"),
      h("dl", {},
        h("dt", {}, "Pay"), h("dd", { class: "mono", id: "review-amount" }, btc(spend.amount)),
        h("dt", {}, "To"), h("dd", { class: "mono" }, spend.outputs.find((o) => !o.change).address),
        h("dt", {}, "Fee"), h("dd", { class: "mono", id: "review-fee" }, `${btc(spend.fee)} (${spend.vsize} vB at ${spend.rate} sat/vB)`),
        ...spend.outputs.filter((o) => o.change).flatMap((o) => [
          h("dt", {}, "Change"), h("dd", { class: "mono" }, `${btc(o.value)} to ${o.address}`, h("div", { class: "small dim" }, o.change.path))]),
        h("dt", {}, "Spends"), h("dd", {}, ...spend.inputs.map((c) => h("div", { class: "mono" }, `${formatBtc(c.value)}  ${c.entry.path}`)))),
      spend.dropped ? notice("warn", `${spend.dropped} sat that would have been change is too small to keep, and goes to the fee.`) : null,
      spend.skipped ? notice("warn", `${spend.skipped} coin(s) were left out: they're worth less than they cost to spend at this rate.`) : null,
      ...warnings.map((w) => notice("warn", w)),
      warnings.length ? h("label", { class: "check" }, h("input", { id: "ack-fee", type: "checkbox", onchange: (e) => (go.disabled = !e.target.checked) }), "I've seen this, and it's what I want.") : null,
      h("p", { class: "small dim" }, "The signer shows all of this again, from the transaction itself. Trust what it shows."),
      h("div", { class: "row" }, h("button", { onclick: () => this.go("form") }, "Back"), go));
  }

  sendShow() {
    const send = this.send;
    const bytes = psbtBytes(this.account, send.spend, { includePrevious: send.includePrevious });
    const text = electrumQrText(bytes);
    const qr = text.length <= MAX_ALPHANUMERIC ? makeQr(text) : null;
    const b64 = toBase64(bytes);
    const parts = [h("h2", {}, "Sign it"),
      h("p", { class: "small dim", id: "psbt-size" }, `PSBT: ${bytes.length} bytes, ${text.length} Base43 characters${qr ? `, QR version ${qr.version}` : ""}${send.includePrevious ? "" : ". Previous transactions left out."}`)];
    if (qr) {
      const canvas = h("canvas", { class: "code", id: "psbt-qr" });
      drawQr(canvas, qr, Math.max(2, Math.floor(620 / (qr.size + 8))));
      parts.push(h("div", { class: "qr" }, canvas),
        h("p", {}, "Read this code with the signer (Electrum's Base43 format)."));
      if (qr.version > LARGE_QR_VERSION) parts.push(notice("warn", "This code is dense. If the camera can't read it, enlarge the window, or see the options below."));
    } else {
      parts.push(notice("bad", `This PSBT doesn't fit in one QR code: ${text.length} characters, ${MAX_ALPHANUMERIC} at most.`));
    }
    if (send.includePrevious && (!qr || qr.version > LARGE_QR_VERSION)) parts.push(this.dropPrevious());
    if (!send.includePrevious) {
      parts.push(notice("warn", "Previous transactions are left out of this PSBT: the signer can't prove the coins' amounts."),
        h("div", { class: "row" }, h("button", { id: "restore-previous", class: "small", onclick: () => {
          send.includePrevious = true;
          this.render();
        } }, "Put them back")));
    }
    parts.push(h("details", {}, h("summary", {}, "The PSBT as text or a file"),
      h("textarea", { id: "psbt-text", readonly: true }, b64),
      h("div", { class: "row" },
        h("button", { class: "small", onclick: () => copyText(b64) }, "Copy Base64"),
        h("button", { class: "small", onclick: () => download(bytes, `${send.spend.txid.slice(0, 8)}.psbt`) }, "Save .psbt"))),
    h("div", { class: "row" }, h("button", { onclick: () => this.go("review") }, "Back"),
      h("button", { id: "to-scan", class: "primary", onclick: () => this.go("scan") }, "It's signed: read it back")));
    return h("div", {}, ...parts);
  }

  dropPrevious() {
    const drop = h("button", { id: "drop-previous", class: "danger", disabled: true, onclick: () => {
      this.send.includePrevious = false;
      this.render();
    } }, "Leave out the previous transactions");
    return notice("warn",
      h("strong", {}, "You can make the code smaller, at a cost."),
      h("p", {}, "The PSBT carries each coin's whole previous transaction, so the signer can prove what the coin is worth. Without it, the signer takes the amounts as given: a lying server could trick it into paying a much higher fee than it shows (the fee attack on segwit)."),
      h("label", { class: "check" }, h("input", { id: "ack-previous", type: "checkbox", onchange: (e) => (drop.disabled = !e.target.checked) }), "I understand, and I got these coins' amounts from a server I trust."),
      h("div", { class: "row" }, drop));
  }

  sendScan() {
    const send = this.send;
    const result = h("div", { id: "scan-result" });
    const pasted = h("textarea", { id: "signed", spellcheck: "false", placeholder: "Or paste the signed transaction: hex, Base64 or Base43" });
    const video = h("video", { muted: true, playsinline: true, id: "camera", hidden: true });
    const accept = (code) => {
      try {
        send.signed = readSigned(code.text, code.bytes, send.spend);
      } catch (e) {
        if (e instanceof RangeError) throw e;
        send.signed = null;
        mount(result, notice("bad", e.message));
        return;
      }
      if (send.signed.kind === "partial") {
        const { signed, total, matches } = send.signed;
        mount(result, notice("warn", `This is a PSBT with ${signed} of ${total} inputs signed${matches ? "" : ", and it isn't the transaction built here"}. It needs its other signatures: take it to the signer holding the other keys.`));
        return;
      }
      this.stopCamera();
      this.showSigned(result);
    };
    const start = h("button", { id: "start-camera", onclick: () => {
      start.disabled = true;
      video.hidden = false;
      this.camera = new Scanner(video, { onCode: accept, onError: (m) => mount(result, notice("bad", m)) });
      this.camera.start();
    } }, "Start the camera");
    if (send.signed?.kind === "tx") this.showSigned(result);
    return h("div", {},
      h("h2", {}, "Read the signed transaction"),
      video,
      h("div", { class: "row" }, start),
      h("label", { for: "signed" }, "Or paste it"), pasted,
      h("div", { class: "row" }, h("button", { id: "read-pasted", onclick: () => accept({ text: pasted.value, bytes: null }) }, "Read")),
      result,
      h("div", { class: "row" }, h("button", { onclick: () => this.go("show") }, "Back")));
  }

  showSigned(into) {
    const send = this.send;
    const { tx, txid, matches, hex } = send.signed;
    const net = NETWORK_INFO[this.record.network].lib;
    const go = h("button", { id: "broadcast", class: "primary", disabled: !matches }, "Broadcast");
    const message = h("div", { id: "broadcast-result" });
    go.addEventListener("click", async () => {
      go.disabled = true;
      mount(message, h("p", { class: "dim" }, "Sending…"));
      try {
        const answered = await this.client.broadcast(hex);
        send.sent = { txid, agrees: answered.toLowerCase() === txid };
        this.go("done");
        await this.refresh();
      } catch (e) {
        if (!(e instanceof EsploraError)) throw e;
        go.disabled = false;
        mount(message, notice("bad", `The server refused it, or couldn't be reached: ${e.message}. It hasn't been retried; broadcasting again is safe.`));
      }
    });
    mount(into,
      matches ? notice("good", "This is the transaction built here, signed.") : notice("bad",
        h("strong", {}, "This isn't the transaction built here."),
        h("p", {}, "It has other inputs or outputs than the ones you reviewed. Check them below."),
        h("label", { class: "check" }, h("input", { id: "ack-different", type: "checkbox", onchange: (e) => (go.disabled = !e.target.checked) }), "I know what this transaction is, and want to broadcast it.")),
      h("dl", {}, h("dt", {}, "Transaction"), h("dd", { class: "mono", id: "signed-txid" }, txid),
        ...tx.outputs.flatMap((o, i) => [h("dt", {}, `Output ${i}`), h("dd", { class: "mono" }, `${btc(o.value)} to ${scriptToAddress(o.script, net) ?? "(no address)"}`)])),
      h("div", { class: "row" }, go), message);
  }

  sendDone() {
    const { txid, agrees } = this.send.sent;
    return h("div", {},
      h("h2", {}, "Sent"),
      notice("good", "The server took the transaction."),
      agrees ? null : notice("bad", "The server answered with a different transaction id. Check the transaction below on another server."),
      h("p", { class: "mono", id: "sent-txid" }, txid),
      h("div", { class: "row" }, h("button", { id: "send-another", onclick: () => {
        this.send = null;
        this.tab = "overview";
        this.render();
      } }, "Done")));
  }

  // ---- Settings ----

  settingsView() {
    const a = this.account, r = this.record;
    const gap = h("input", { id: "gap", type: "number", min: "1", max: "1000", value: String(r.gapLimit) });
    const name = h("input", { id: "rename", type: "text", value: r.label });
    const message = h("div", {});
    const forget = h("div", { class: "row" });
    const askForget = () => mount(forget, h("button", { id: "forget", class: "danger", onclick: () => mount(forget,
      h("span", {}, "Forget this account in this browser?"),
      h("button", { id: "forget-yes", class: "danger", onclick: () => {
        this.state.accounts = this.state.accounts.filter((x) => x.id !== r.id);
        this.state.current = this.state.accounts[0]?.id ?? null;
        this.reload();
      } }, "Yes, forget it"),
      h("button", { onclick: askForget }, "Keep it")) }, "Forget this account"));
    askForget();
    return h("div", {},
      h("div", { class: "panel" }, h("h2", {}, "Account"),
        h("label", { for: "rename" }, "Name"), name,
        h("label", { for: "gap" }, "Gap limit"), gap, message,
        h("div", { class: "row" }, h("button", { id: "save-settings", onclick: () => {
          const n = Number(gap.value);
          if (!Number.isInteger(n) || n < 1 || n > 1000) {
            mount(message, notice("bad", "The gap limit is a whole number from 1 to 1000."));
            return;
          }
          r.gapLimit = n;
          r.label = name.value.trim() || r.label;
          this.reload();
        } }, "Save")),
        h("h3", {}, "Public key"),
        h("p", { class: "small dim" }, "Anyone holding this can see the whole wallet, though they can't spend."),
        h("dl", {},
          h("dt", {}, "Path"), h("dd", { class: "mono" }, accountPath(a)),
          h("dt", {}, "Fingerprint"), h("dd", { class: "mono" }, a.fingerprint || "none"),
          h("dt", {}, a.coinType === 0 ? "zpub" : "vpub"), h("dd", { class: "mono" }, serializeXpub(a.node, a.coinType === 0 ? "zpub" : "vpub")),
          h("dt", {}, "Descriptor"), h("dd", { class: "mono", id: "descriptor" }, accountDescriptor(a))),
        forget),
      h("div", { class: "panel" }, h("h2", {}, "Server"),
        h("p", {}, "Now: ", h("span", { class: "mono", id: "current-server" }, this.state.servers[r.network])),
        this.serverChooser()));
  }

  stopCamera() {
    if (this.camera) this.camera.stop();
    this.camera = null;
  }
}
