// The page. All text reaches the DOM as text nodes, so nothing a server says
// can become markup.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { h, mount, copyText, download } from "./dom.js";
import { NETWORK_INFO, SCRIPT_INFO, parseAccount, accountDescriptor, accountPath, accountSlip132, ImportError } from "./descriptor.js";
import { addressAt } from "./account.js";
import { Esplora, EsploraError, PRESETS, parseServer } from "./esplora.js";
import { DEFAULT_GAP, scanAccount } from "./scan.js";
import { MIN_RATE, MAX_RATE, cleanEstimates, feeWarnings } from "./coinselect.js";
import { BuildError, buildSpend, psbtBytes } from "./build.js";
import { KeyReader, SignedReader, readFile } from "./signed.js";
import { MAX_ALPHANUMERIC, Scanner, drawQr, makeQr } from "./qr.js";
import { parseBtc, parseDecimal, formatBtc } from "./amount.js";
import { LANGUAGES, formatCents, formatDate, formatDecimal, language, plural, setLanguage, tr } from "./i18n.js";
import { save } from "./store.js";
import { CURRENCIES, PRICE_DEFAULTS, PriceError, fetchPrice, parsePriceUrl, valueInCents } from "./price.js";
import { toBase64 } from "../vendor/zerogap/psbt/bytes.js";
import { electrumQrText } from "../vendor/zerogap/psbt/transport.js";
import { BBQrError, split } from "../vendor/zerogap/bbqr.js";
import { DecodeError } from "../vendor/zerogap/psbt/bytes.js";
import { scriptToAddress } from "../vendor/zerogap/psbt/script.js";

const btc = (sats) => `${formatBtc(sats)} BTC`;
const shortId = (id) => `${id.slice(0, 10)}…${id.slice(-6)}`;
const FEE_TARGETS = [[1, "next block"], [3, "3 blocks"], [6, "about an hour"], [144, "about a day"]]; // keys for tr()
const HISTORY_KINDS = { in: "Received", out: "Sent", self: "Moved within this account" }; // keys for tr()
const ENCODINGS = { Z: "compressed", 2: "base32", H: "hex" }; // keys for tr()
const LARGE_QR_VERSION = 25;
const RECEIVE_LIST = 5;
const SERIES_SIZES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64, 128]; // codes in a series
const SERIES_SPEEDS = [[250, "fast"], [500, "normal"], [1000, "slow"], [2000, "very slow"]]; // ms per code; keys for tr()
const SERIES_VERSION = 12; // the densest code a series starts with; camera-tuned on the rig (BITCOIN.md, B2)

const PRIVACY = [ // keys for tr()
  ["The Esplora server", "Every address of this account, asked in a burst from one IP address and so linked together: the wallet's balance and whole history, and when you open it. Each transaction you send, before anyone else sees it, and the IP that sent it."],
  ["Network observers", "With HTTPS, that this page talks to that server, not what it asks."],
  ["The site serving this page", "That the page was loaded. Nothing else: no request goes to it. Better still, run the file from disk or your own server."],
  ["The camera", "Nothing leaves the page: frames are decoded here and never sent."],
];

function privacyTable() {
  return h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, tr("Who")), h("th", {}, tr("What they learn")))),
    h("tbody", {}, ...PRIVACY.map(([who, what]) => h("tr", {}, h("td", { class: "who" }, tr(who)), h("td", {}, tr(what))))));
}

// The quote URL the page fetches for this network: none off mainnet, or with no currency chosen
export function priceUrlFor(state, network) {
  const p = state.price;
  if (network !== "mainnet" || !p?.currency) return null;
  return p.urls?.[p.currency] || PRICE_DEFAULTS[p.currency];
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
    this.stopSeries();
    if (this.adding) mount(this.root, this.header(), this.importView());
    else if (!this.client) mount(this.root, this.header(), this.serverView());
    else mount(this.root, this.header(), this.nav(), this[`${this.tab}View`]());
  }

  header() {
    const a = this.record;
    const pick = !a ? null : h("select", { id: "account", "aria-label": tr("Account"), onchange: (e) => {
      if (e.target.value === "") {
        this.adding = true;
        this.render();
        return;
      }
      this.state.current = e.target.value;
      this.reload();
    } }, ...this.state.accounts.map((x) => h("option", { value: x.id, selected: x.id === a.id }, x.label)),
    h("option", { value: "" }, tr("Add an account…")));
    const lang = h("select", { id: "language", "aria-label": tr("Language"), onchange: (e) => {
      setLanguage(e.target.value);
      this.state.language = language();
      this.persist();
      document.documentElement.lang = language();
      this.render();
    } }, ...LANGUAGES.map(([id, name]) => h("option", { value: id, selected: id === language() }, name)));
    return h("header", {},
      h("h1", {}, "GapWallet"),
      a ? h("span", { class: `badge${a.network === "mainnet" ? "" : " test"}`, id: "network" }, NETWORK_INFO[a.network].name) : null,
      a && !this.account.fingerprint ? h("span", { class: "badge", id: "watchonly" }, tr("watch-only")) : null,
      h("span", { class: "grow" }), pick,
      a && this.client && !this.adding ? h("button", { id: "refresh", class: this.scanning ? "small pulse" : "small", disabled: Boolean(this.scanning), onclick: () => this.refresh() }, this.scanning ? tr("Scanning…") : tr("Refresh")) : null,
      lang);
  }

  nav() {
    const tabs = { overview: "Overview", receive: "Receive", send: "Send", settings: "Settings" }; // keys for tr()
    return h("nav", { role: "tablist" }, ...Object.entries(tabs).map(([id, name]) => h("button", { id: `tab-${id}`, role: "tab", "aria-selected": String(this.tab === id), onclick: () => {
      this.tab = id;
      this.render();
    } }, tr(name))));
  }

  // ---- Import ----

  importView() {
    const form = { network: null };
    const preview = h("div", { id: "preview" });
    const key = h("textarea", { id: "key", spellcheck: "false", autocapitalize: "off", placeholder: "wpkh([73c5da0a/84h/0h/0h]xpub…/<0;1>/*)#…   or   zpub…, ypub…" });
    const fp = h("input", { id: "fingerprint", type: "text", spellcheck: "false", placeholder: "73c5da0a", maxlength: "8" });
    const label = h("input", { id: "label", type: "text", value: tr("Account {n}", { n: this.state.accounts.length + 1 }) });
    const add = h("button", { id: "add", class: "primary", disabled: true }, tr("Add this account"));
    const video = h("video", { muted: true, playsinline: true, id: "import-camera", hidden: true });
    const reading = h("div", { id: "import-reading" });
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
        key.value = e.secret ? "" : key.value; // don't leave it lying on the screen
        mount(preview, notice("bad", e.message));
        return;
      }
      add.disabled = false;
      mount(preview,
        h("dl", {},
          h("dt", {}, tr("Account")), h("dd", { class: "mono", id: "preview-path" }, `${accountPath(parsed)} (${SCRIPT_INFO[parsed.script].name})`),
          h("dt", {}, tr("Master fingerprint")), h("dd", { class: "mono" }, parsed.fingerprint || tr("none yet"))),
        ...parsed.warnings.map((w) => notice("warn", w)),
        parsed.fingerprint ? null : notice("warn", tr("Without the master fingerprint this account is watch-only: you'll see its balance and history, but can't build transactions until you add it. The signer shows it with the public key.")),
        h("h3", {}, tr("Its first addresses")),
        h("p", { class: "small dim" }, tr("Compare these with the device that made the key, before you trust them.")),
        ...[0, 1, 2].map((i) => h("div", { class: "mono" }, `${i}  ${addressAt(parsed, 0, i).address}`)));
    };
    key.addEventListener("input", check);
    fp.addEventListener("input", check);

    // What a code holds goes in the box only if it is a public key: a seed's
    // QR code, shown to this camera by mistake, mustn't appear on the screen.
    const startCamera = h("button", { id: "import-start", onclick: () => {
      const reader = new KeyReader();
      startCamera.disabled = true;
      video.hidden = false;
      this.camera = new Scanner(video, { onError: (m) => mount(reading, notice("bad", m)), onCode: ({ text }) => {
        try {
          const got = reader.add(text);
          if (got.text === undefined) {
            mount(reading, h("p", { class: "small" }, tr("Read {have} of {total} codes…", got)));
            return;
          }
          parseAccount(got.text, form.network, fp.value);
          key.value = got.text.trim();
          this.stopCamera();
          video.hidden = true;
          startCamera.disabled = false;
          mount(reading);
          check();
        } catch (e) {
          if (!(e instanceof ImportError || e instanceof DecodeError)) throw e;
          mount(reading, notice("bad", e.message));
        }
      } });
      this.camera.start();
    } }, tr("Read it with the camera"));
    add.addEventListener("click", () => {
      const id = `a${Date.now().toString(36)}`;
      this.state.accounts.push({ id, label: label.value.trim() || id, network: form.network, key: key.value.trim(), fingerprint: fp.value.trim().toLowerCase(), gapLimit: DEFAULT_GAP });
      this.state.current = id;
      this.reload();
    });

    return h("div", { class: "panel" },
      h("h2", {}, tr("Add an account")),
      h("p", {}, tr("GapWallet only ever holds public keys. Nothing here is sent anywhere: the page contacts no server until you choose one.")),
      h("label", {}, tr("Network")),
      ...Object.entries(NETWORK_INFO).map(([id, info]) => h("label", { class: "radio" },
        h("input", { type: "radio", name: "network", value: id, onchange: () => {
          form.network = id;
          check();
        } }), info.name)),
      h("label", { for: "key" }, tr("Descriptor, zpub or ypub")), key,
      h("div", { class: "row" }, startCamera), video, reading,
      h("label", { for: "fingerprint" }, tr("Master fingerprint (a descriptor already has it)")), fp,
      h("label", { for: "label" }, tr("Name")), label,
      preview,
      h("div", { class: "row" }, add,
        this.record ? h("button", { onclick: () => {
          this.adding = false;
          this.render();
        } }, tr("Cancel")) : null));
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
      h("p", {}, tr("An Esplora server answers for this {network} account. There is no default: it's your choice, because of what the server learns.", { network: NETWORK_INFO[network].name })),
      privacyTable(),
      h("div", { class: "row" }, h("button", { id: "preset", class: "primary", onclick: () => use(PRESETS[network]) }, tr("Use {host}", { host: new URL(PRESETS[network]).host }))),
      h("label", { for: "server" }, tr("Or your own server")), url, message,
      h("div", { class: "row" }, h("button", { id: "use-server", onclick: () => use(url.value) }, tr("Use this server"))));
  }

  serverView() {
    return h("div", { class: "panel" }, h("h2", {}, tr("Choose a server")), this.serverChooser());
  }

  // ---- Scan ----

  async refresh() {
    if (this.scanning) return;
    this.scanning = { text: tr("Checking the server…") };
    this.scanError = null;
    this.rerender();
    this.client.onHold = (seconds) => {
      if (!this.scanning) return;
      this.scanning.text = tr("The server is slowing us down: waiting {seconds} s…", { seconds });
      this.showProgress();
    };
    try {
      await this.client.checkNetwork(this.record.network);
      this.refreshPrice();
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

  // The price, beside the scan: its failure is only a line under the balance.
  async refreshPrice() {
    const url = priceUrlFor(this.state, this.record.network);
    if (!url) return;
    const currency = this.state.price.currency;
    try {
      this.price = { currency, value: await fetchPrice(url, currency) };
    } catch (e) {
      if (!(e instanceof PriceError)) throw e;
      this.price = { currency, error: e.message };
    }
    if (this.tab === "overview" && !this.scanning) this.rerender();
  }

  // What the balance is worth: test coins nothing, mainnet coins money.
  valueLine(sats) {
    if (this.record.network !== "mainnet") {
      return h("div", { id: "no-value", class: "no-value" }, tr("TEST ONLY — NO MONETARY VALUE"));
    }
    const p = this.price;
    if (!this.state.price?.currency) {
      const currency = language() === "pt-BR" ? "BRL" : "USD";
      return h("div", { id: "fiat-offer", class: "small" }, tr("These are real bitcoins, with real monetary value."), " ",
        h("button", { id: "show-price", class: "small", onclick: () => {
          this.state.price = { ...(this.state.price || {}), currency, urls: this.state.price?.urls || {} };
          this.reload();
        } }, tr("Show their value in {currency}", { currency })),
        h("div", { class: "small dim" }, tr("The price comes from {host}, which learns your IP address and when you look. Change it in Settings.", { host: new URL(PRICE_DEFAULTS[currency]).host })));
    }
    if (!p) return h("div", { id: "fiat", class: "fiat dim" }, tr("Fetching the price…"));
    if (p.error) return h("div", { id: "fiat", class: "fiat small" }, tr("Real bitcoins, but no price: {reason}", { reason: p.error }));
    return h("div", { id: "fiat", class: "fiat" }, tr("About {amount} {currency}", { amount: formatCents(valueInCents(sats, p.value)), currency: p.currency }));
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
    if (this.scanning) return h("p", { id: "progress", class: "dim pulse" }, this.scanning.text);
    if (this.scanError) return notice("bad", this.scanError);
    return null;
  }

  fingerprintPrompt() {
    const fp = h("input", { id: "add-fingerprint", type: "text", spellcheck: "false", maxlength: "8", placeholder: "73c5da0a" });
    const message = h("div", {});
    return notice("warn",
      h("strong", {}, tr("Watch-only: no master fingerprint.")),
      h("p", {}, tr("You can see this account, but a signer couldn't find its keys in a transaction built here. The device that made the key shows the fingerprint with it.")),
      h("label", { for: "add-fingerprint" }, tr("Master fingerprint")), fp, message,
      h("div", { class: "row" }, h("button", { id: "save-fingerprint", onclick: () => {
        try {
          parseAccount(this.record.key, this.record.network, fp.value);
          if (!/^[0-9a-fA-F]{8}$/.test(fp.value.trim())) throw new ImportError(tr("A master fingerprint is 8 hexadecimal digits, like 73c5da0a."));
        } catch (e) {
          if (!(e instanceof ImportError)) throw e;
          mount(message, notice("bad", e.message));
          return;
        }
        this.record.fingerprint = fp.value.trim().toLowerCase();
        this.reload();
      } }, tr("Save fingerprint"))));
  }

  // ---- Overview ----

  overviewView() {
    const s = this.scan;
    const body = [this.status(), this.account.fingerprint ? null : this.fingerprintPrompt()];
    if (!s) return h("div", {}, ...body, this.record.network !== "mainnet" ? this.valueLine(0) : null);
    body.push(h("div", { class: "panel" },
      h("div", { class: "dim small" }, tr("Balance")),
      h("div", { class: "balance", id: "balance" }, btc(s.balance.confirmed)),
      this.valueLine(s.balance.confirmed),
      s.balance.unconfirmed ? h("div", { id: "unconfirmed" }, tr("and {amount} unconfirmed", { amount: btc(s.balance.unconfirmed) })) : null));
    body.push(h("div", { class: "panel" }, h("h2", {}, tr("History")),
      s.history.length === 0 ? h("p", { class: "dim" }, tr("Nothing yet.")) : h("table", { id: "history" },
        h("thead", {}, h("tr", {}, h("th", {}, tr("When")), h("th", {}, tr("What")), h("th", { class: "num" }, tr("Amount (BTC)")))),
        h("tbody", {}, ...s.history.map((t) => this.historyRow(t))))));
    return h("div", {}, ...body);
  }

  historyRow(t) {
    const when = t.height === null ? tr("unconfirmed") : t.time ? formatDate(t.time) : tr("block {height}", { height: t.height });
    const what = tr(HISTORY_KINDS[t.kind]);
    return h("tr", { class: t.kind },
      h("td", { class: "nowrap" }, when, h("div", { class: "small dim" }, t.height === null ? "" : tr("{n} conf.", { n: t.confirmations }))),
      h("td", {}, what, h("div", { class: "small dim mono" }, shortId(t.txid))),
      h("td", { class: "num" }, t.kind === "self" ? h("span", { class: "dim" }, tr("fee {amount}", { amount: formatBtc(t.fee) })) : h("span", { class: t.net >= 0 ? "good" : "" }, `${t.net >= 0 ? "+" : ""}${formatBtc(t.net)}`)));
  }

  // ---- Receive ----

  receiveView() {
    if (!this.scan) return h("div", {}, this.status(), h("p", { class: "dim" }, tr("Addresses show once the scan has checked which are used.")));
    this.receiveIndex ??= this.scan.next[0];
    if (this.receiveIndex < this.scan.next[0]) this.receiveIndex = this.scan.next[0];
    const first = this.scan.next[0];
    const a = addressAt(this.account, 0, this.receiveIndex);
    const canvas = h("canvas", { class: "code", id: "receive-qr" });
    drawQr(canvas, makeQr(a.address, "Byte"), 6);
    return h("div", { class: "panel" }, this.status(),
      h("h2", {}, tr("Receive")),
      h("div", { class: "qr" }, canvas),
      h("p", { class: "mono", id: "receive-address" }, a.address),
      h("p", { class: "small dim mono" }, a.path),
      h("div", { class: "row" }, h("button", { class: "small", onclick: () => copyText(a.address) }, tr("Copy"))),
      h("h3", {}, tr("Next addresses")),
      ...Array.from({ length: RECEIVE_LIST }, (_, i) => {
        const e = addressAt(this.account, 0, first + i);
        return h("div", { class: "row" }, h("button", { class: "small", "aria-pressed": String(e.index === this.receiveIndex), onclick: () => {
          this.receiveIndex = e.index;
          this.render();
        } }, `#${e.index}`), h("span", { class: "mono" }, e.address));
      }),
      h("p", { class: "small dim" }, tr("The wallet doesn't record which addresses you've given out. If you hand out more than the gap limit ({gap}) with none paid, a later payment can fall past the scan: raise the gap limit in Settings to see it.", { gap: this.record.gapLimit })));
  }

  // ---- Send ----

  sendView() {
    if (!this.account.fingerprint) return h("div", {}, this.status(), this.fingerprintPrompt());
    if (!this.scan) return h("div", {}, this.status(), h("p", { class: "dim" }, tr("Sending needs a finished scan.")));
    this.send ??= { stage: "form", form: { address: "", amount: "", sendAll: false, rate: "", hand: false, ticked: new Set() } };
    const steps = [["form", tr("1 Details")], ["review", tr("2 Review")], ["show", tr("3 Sign externally")], ["scan", tr("4 Read back")], ["done", tr("5 Sent")]];
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
    // What the amount typed is read as, while it's typed: a mark misread can't pass unseen
    const reads = h("div", { id: "amount-read", class: "small dim mono" });
    const readBack = () => {
      if (f.sendAll || f.amount.trim() === "") return mount(reads);
      try {
        mount(reads, `= ${btc(parseBtc(f.amount))}`);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        mount(reads, e.message);
      }
    };
    const amount = h("input", { id: "amount", type: "text", inputmode: "decimal", placeholder: formatBtc(100000).replace(/0+$/, ""), value: f.amount, disabled: f.sendAll, oninput: (e) => {
      f.amount = e.target.value;
      readBack();
    } });
    readBack();
    const rateRead = h("div", { id: "rate-read", class: "small dim mono" });
    const rate = h("input", { id: "rate", type: "text", inputmode: "decimal", value: f.rate, oninput: (e) => {
      f.rate = e.target.value;
      paint();
    } });
    const choices = h("div", { class: "choices", id: "fee-choices" });
    const paint = () => {
      const read = parseDecimal(f.rate);
      mount(rateRead, f.rate.trim() === "" ? "" : Number.isFinite(read) ? tr("= {rate} sat/vB", { rate: read }) : tr("Enter a fee rate."));
      const est = this.send.estimates;
      mount(choices, ...(!est ? [h("span", { class: "dim small" }, tr("Fetching estimates…"))] : FEE_TARGETS.filter(([n]) => est[n] !== undefined).map(([n, name]) => h("button", {
        "aria-pressed": String(parseDecimal(f.rate) === est[n]), onclick: () => {
          f.rate = formatDecimal(est[n], 2);
          rate.value = f.rate;
          paint();
        } }, tr("{target}: {rate} sat/vB", { target: tr(name), rate: est[n] })))));
    };
    paint();
    if (this.send.estimates === undefined) {
      this.send.estimates = null;
      this.client.feeEstimates().then((answer) => {
        const est = cleanEstimates(answer);
        this.send.estimates = est;
        if (!f.rate && est[6] !== undefined) f.rate = formatDecimal(est[6], 2);
        rate.value = f.rate;
        paint();
      }).catch(() => {
        mount(choices, h("span", { class: "small" }, tr("The server gave no fee estimates: type a rate.")));
      });
    }

    const coinList = h("div", { id: "coins" }, ...(this.scan.coins.length === 0 ? [h("p", { class: "dim small" }, tr("No coins yet."))] : [h("table", {},
      h("tbody", {}, ...this.scan.coins.map((c) => {
        const id = `${c.txid}:${c.vout}`;
        return h("tr", {},
          h("td", {}, h("input", { type: "checkbox", "aria-label": tr("Spend this coin"), checked: f.ticked.has(id), onchange: (e) => {
            if (e.target.checked) f.ticked.add(id);
            else f.ticked.delete(id);
          } })),
          h("td", { class: "mono" }, c.entry.path.split("/").slice(-2).join("/"), c.confirmed ? "" : ` (${tr("unconfirmed")})`),
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
    } }, tr("Review"));

    return h("div", {}, this.status(),
      h("label", { for: "address" }, tr("Pay to")), address,
      h("label", { for: "amount" }, tr("Amount (BTC)")), amount, reads,
      h("label", { class: "check" }, h("input", { id: "send-all", type: "checkbox", checked: f.sendAll, onchange: (e) => {
        f.sendAll = e.target.checked;
        amount.disabled = f.sendAll;
        readBack();
      } }), tr("Send everything (no change)")),
      h("label", { for: "rate" }, tr("Fee rate (sat/vB, {min} to {max})", { min: MIN_RATE, max: MAX_RATE })), choices, h("div", { class: "row" }, rate), rateRead,
      h("details", { open: f.hand ? true : null, ontoggle: (e) => (f.hand = e.target.open) },
        h("summary", {}, tr("Choose coins by hand")),
        h("p", { class: "small dim" }, tr("Exactly the ticked coins are spent, confirmed or not. With none ticked, the wallet chooses among confirmed coins.")),
        coinList),
      message,
      h("div", { class: "row" }, review));
  }

  async buildFromForm() {
    const f = this.send.form;
    const sendAll = f.sendAll;
    const amount = sendAll ? 0 : parseBtc(f.amount);
    const rate = parseDecimal(f.rate);
    if (!Number.isFinite(rate)) throw new RangeError(tr("Enter a fee rate."));
    const coins = f.hand && f.ticked.size ? this.scan.coins.filter((c) => f.ticked.has(`${c.txid}:${c.vout}`)) : null;
    const spend = await buildSpend(this.account, this.scan, { address: f.address, amount, sendAll, rate, coins }, this.client);
    const send = this.send;
    send.spend = spend;
    send.warnings = feeWarnings({ fee: spend.fee, amount: spend.amount, rate, estimate: send.estimates?.[1] });
    send.signed = null;
  }

  sendReview() {
    const { spend, warnings } = this.send;
    const go = h("button", { id: "to-sign", class: "primary", disabled: warnings.length > 0, onclick: () => this.go("show") }, tr("Prepare for Signing"));
    return h("div", {},
      h("h2", {}, tr("Review")),
      h("dl", {},
        h("dt", {}, tr("Pay")), h("dd", { class: "mono", id: "review-amount" }, btc(spend.amount)),
        h("dt", {}, tr("To")), h("dd", { class: "mono" }, spend.outputs.find((o) => !o.change).address),
        h("dt", {}, tr("Fee")), h("dd", { class: "mono", id: "review-fee" }, tr("{amount} ({vsize} vB at {rate} sat/vB)", { amount: btc(spend.fee), vsize: spend.vsize, rate: spend.rate })),
        ...spend.outputs.filter((o) => o.change).flatMap((o) => [
          h("dt", {}, tr("Change")), h("dd", { class: "mono" }, tr("{amount} to {address}", { amount: btc(o.value), address: o.address }), h("div", { class: "small dim" }, o.change.path))]),
        h("dt", {}, tr("Spends")), h("dd", {}, ...spend.inputs.map((c) => h("div", { class: "mono" }, `${formatBtc(c.value)}  ${c.entry.path}`)))),
      spend.dropped ? notice("warn", tr("{n} sat that would have been change is too small to keep, and goes to the fee.", { n: spend.dropped })) : null,
      spend.skipped ? notice("warn", plural(spend.skipped, "{n} coin was left out: it's worth less than it costs to spend at this rate.", "{n} coins were left out: they're worth less than they cost to spend at this rate.")) : null,
      ...warnings.map((w) => notice("warn", w)),
      warnings.length ? h("label", { class: "check" }, h("input", { id: "ack-fee", type: "checkbox", onchange: (e) => (go.disabled = !e.target.checked) }), tr("I've seen this, and it's what I want.")) : null,
      h("p", { class: "small dim" }, tr("The signer shows all of this again, from the transaction itself. Trust what it shows.")),
      h("div", { class: "row" }, h("button", { onclick: () => this.go("form") }, tr("Back")), go));
  }

  sendShow() {
    const send = this.send;
    const bytes = psbtBytes(this.account, send.spend);
    const text = electrumQrText(bytes);
    const single = text.length <= MAX_ALPHANUMERIC ? makeQr(text) : null;
    const b64 = toBase64(bytes);
    const format = single ? send.format || "base43" : "bbqr";
    const choose = (id, name, disabled) => h("label", { class: "radio" }, h("input", { type: "radio", name: "format", id: `format-${id}`, checked: format === id, disabled,
      onchange: () => {
        send.format = id;
        this.render();
      } }), name);
    const parts = [h("h2", {}, tr("Sign it Externally")),
      h("p", { id: "sign-externally" }, tr("This wallet is designed to be used with external signing apps — below you can export the prepared transaction in various formats to the signing app of your choice.")),
      h("p", { class: "small dim", id: "psbt-size" }, tr("PSBT: {n} bytes", { n: bytes.length })),
      choose("base43", tr("One code (Base43: Electrum, and ZeroGap's signer)"), !single),
      choose("bbqr", tr("BBQr: a series of codes (ZeroGap's signer, Coldcard, Sparrow)"), false)];
    if (!single) parts.push(notice("warn", tr("This PSBT doesn't fit in one QR code: {n} characters, {max} at most. It goes out as a series. Electrum doesn't read those: for Electrum, save the PSBT as a file.", { n: text.length, max: MAX_ALPHANUMERIC })));
    if (format === "base43") {
      const canvas = h("canvas", { class: "code", id: "psbt-qr" });
      drawQr(canvas, single, Math.max(2, Math.floor(620 / (single.size + 8))));
      parts.push(h("div", { class: "qr" }, canvas),
        h("p", { class: "small dim", id: "qr-info" }, tr("{n} characters, QR version {version}", { n: text.length, version: single.version })));
      if (single.version > LARGE_QR_VERSION) parts.push(notice("warn", tr("This code is dense. If the camera can't read it, enlarge the window or use a series.")));
    } else {
      parts.push(this.series(bytes));
    }
    parts.push(h("details", {}, h("summary", {}, tr("The PSBT as text or a file")),
      h("textarea", { id: "psbt-text", readonly: true }, b64),
      h("div", { class: "row" },
        h("button", { class: "small", onclick: () => copyText(b64) }, tr("Copy Base64")),
        h("button", { id: "save-psbt", class: "small", onclick: () => download(bytes, `${send.spend.txid.slice(0, 8)}.psbt`) }, tr("Save .psbt")))),
    h("div", { class: "row" }, h("button", { onclick: () => this.go("review") }, tr("Back")),
      h("button", { id: "to-scan", class: "primary", onclick: () => this.go("scan") }, tr("It's signed: read it back"))));
    return h("div", {}, ...parts);
  }

  // The PSBT as an animated series: all its codes the same version. The user
  // picks how many codes, since what suits a camera is found by trying.
  series(bytes) {
    const send = this.send;
    // split() refuses a file that can't fit that many codes: only sizes that hold this one are offered
    const fits = new Map();
    for (const n of SERIES_SIZES) {
      try {
        fits.set(n, split(bytes, "P", { maxParts: n }));
      } catch (e) {
        if (!(e instanceof BBQrError)) throw e;
      }
    }
    const sizes = [...fits.keys()];
    if (sizes.length === 0) return notice("bad", tr("This PSBT is too big even for a series of codes. Save it as a file instead."));
    if (!fits.has(send.seriesSize)) send.seriesSize = sizes.find((n) => fits.get(n).version <= SERIES_VERSION) ?? sizes.at(-1);
    send.seriesSpeed ??= 500;
    const made = fits.get(send.seriesSize);
    const codes = made.parts.map((p) => makeQr(p, "Alphanumeric", made.version));
    const canvas = h("canvas", { class: "code", id: "series-qr" });
    const label = h("span", { class: "small dim", id: "series-part" });
    const scale = Math.max(2, Math.floor(620 / (codes[0].size + 8)));
    let at = 0;
    const show = () => {
      drawQr(canvas, codes[at], scale);
      label.textContent = tr("Code {at} of {n}", { at: at + 1, n: codes.length });
      canvas.dataset.part = String(at);
    };
    const play = () => {
      this.seriesTimer = setInterval(() => {
        at = (at + 1) % codes.length;
        show();
      }, send.seriesSpeed);
    };
    show();
    const select = (id, name, value, options, set) => h("label", { class: "inline", for: id }, name, " ",
      h("select", { id, onchange: (e) => {
        set(Number(e.target.value));
        this.render();
      } }, ...options.map(([v, text]) => h("option", { value: String(v), selected: v === value }, text))));
    const pause = h("button", { id: "series-pause", class: "small", onclick: () => {
      if (this.seriesTimer) {
        this.stopSeries();
        pause.textContent = tr("Play");
      } else {
        play();
        pause.textContent = tr("Pause");
      }
    } }, tr("Pause"));
    if (codes.length > 1) play();
    return h("div", {},
      h("div", { class: "qr" }, canvas),
      h("div", { class: "row" }, label, codes.length > 1 ? pause : null),
      h("p", { class: "small dim", id: "qr-info" }, plural(codes.length, "BBQr, {encoding}: {n} code of QR version {version}", "BBQr, {encoding}: {n} codes of QR version {version}",
        { encoding: tr(ENCODINGS[made.encoding]), version: made.version })),
      h("div", { class: "row" },
        select("series-size", tr("Codes, up to"), send.seriesSize, sizes.map((n) => [n, String(n)]), (n) => (send.seriesSize = n)),
        codes.length > 1 ? select("series-speed", tr("Speed"), send.seriesSpeed, SERIES_SPEEDS.map(([v, name]) => [v, tr(name)]), (n) => (send.seriesSpeed = n)) : null),
      h("p", { class: "small dim" }, tr("If the camera misses codes, use more of them (each is simpler) or slow down. A code it misses comes round again.")));
  }

  stopSeries() {
    clearInterval(this.seriesTimer);
    this.seriesTimer = null;
  }

  sendScan() {
    const send = this.send;
    const result = h("div", { id: "scan-result" });
    const pasted = h("textarea", { id: "signed", spellcheck: "false", placeholder: tr("Or paste the signed transaction: hex, Base64 or Base43") });
    const video = h("video", { muted: true, playsinline: true, id: "camera", hidden: true });
    const reader = new SignedReader(send.spend);
    // Camera, paste and file all end here, with the same checks.
    const settle = (read) => {
      let got;
      try {
        got = read();
      } catch (e) {
        if (e instanceof RangeError) throw e;
        send.signed = null;
        mount(result, notice("bad", e.message));
        return;
      }
      if (got.kind === "progress") {
        mount(result, h("label", { for: "series-progress" }, tr("Read {have} of {total} codes. Keep the series in view.", got)),
          h("progress", { id: "series-progress", max: String(got.total), value: String(got.have) }));
        return;
      }
      send.signed = got;
      if (got.kind === "partial") {
        const { signed, total, matches } = send.signed;
        mount(result, notice("warn", matches ? tr("This is a PSBT with {signed} of {total} inputs signed. It needs its other signatures: take it to the signer holding the other keys.", { signed, total })
          : tr("This is a PSBT with {signed} of {total} inputs signed, and it isn't the transaction built here. It needs its other signatures: take it to the signer holding the other keys.", { signed, total })));
        return;
      }
      this.stopCamera();
      this.showSigned(result);
    };
    const accept = (code) => settle(() => reader.add(code.text, code.bytes));
    const file = h("input", { id: "signed-file", type: "file", accept: ".txn,.tx,.hex,.psbt,.txt", onchange: async () => {
      const chosen = file.files[0];
      if (!chosen) return;
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      file.value = ""; // the same file can be chosen again
      settle(() => readFile(bytes, send.spend));
    } });
    const start = h("button", { id: "start-camera", onclick: () => {
      start.disabled = true;
      video.hidden = false;
      this.camera = new Scanner(video, { onCode: accept, onError: (m) => mount(result, notice("bad", m)) });
      this.camera.start();
    } }, tr("Start the camera"));
    if (send.signed?.kind === "tx") this.showSigned(result);
    return h("div", {},
      h("h2", {}, tr("Read the signed transaction")),
      video,
      h("div", { class: "row" }, start),
      h("label", { for: "signed" }, tr("Or paste it")), pasted,
      h("div", { class: "row" }, h("button", { id: "read-pasted", onclick: () => {
        // a series pasted as lines: each line is one code
        for (const line of pasted.value.split(/\s+/).filter(Boolean)) accept({ text: line, bytes: null });
      } }, tr("Read"))),
      h("label", { for: "signed-file" }, tr("Or open a file")), file,
      result,
      h("div", { class: "row" }, h("button", { onclick: () => this.go("show") }, tr("Back"))));
  }

  showSigned(into) {
    const send = this.send;
    const { tx, txid, matches, hex } = send.signed;
    const net = NETWORK_INFO[this.record.network].lib;
    const go = h("button", { id: "broadcast", class: "primary", disabled: !matches }, tr("Broadcast"));
    const message = h("div", { id: "broadcast-result" });
    go.addEventListener("click", async () => {
      go.disabled = true;
      mount(message, h("p", { class: "dim" }, tr("Sending…")));
      try {
        const answered = await this.client.broadcast(hex);
        send.sent = { txid, agrees: answered.toLowerCase() === txid };
        this.go("done");
        await this.refresh();
      } catch (e) {
        if (!(e instanceof EsploraError)) throw e;
        go.disabled = false;
        mount(message, notice("bad", tr("The server refused it, or couldn't be reached: {reason}. It hasn't been retried; broadcasting again is safe.", { reason: e.message })));
      }
    });
    mount(into,
      matches ? notice("good", tr("This is the transaction built here, signed.")) : notice("bad",
        h("strong", {}, tr("This isn't the transaction built here.")),
        h("p", {}, tr("It has other inputs or outputs than the ones you reviewed. Check them below.")),
        h("label", { class: "check" }, h("input", { id: "ack-different", type: "checkbox", onchange: (e) => (go.disabled = !e.target.checked) }), tr("I know what this transaction is, and want to broadcast it."))),
      h("dl", {}, h("dt", {}, tr("Transaction")), h("dd", { class: "mono", id: "signed-txid" }, txid),
        ...tx.outputs.flatMap((o, i) => [h("dt", {}, tr("Output {i}", { i })), h("dd", { class: "mono" }, tr("{amount} to {address}", { amount: btc(o.value), address: scriptToAddress(o.script, net) ?? tr("(no address)") }))])),
      h("div", { class: "row" }, go), message);
  }

  sendDone() {
    const { txid, agrees } = this.send.sent;
    return h("div", {},
      h("h2", {}, tr("Sent")),
      notice("good", tr("The server took the transaction.")),
      agrees ? null : notice("bad", tr("The server answered with a different transaction id. Check the transaction below on another server.")),
      h("p", { class: "mono", id: "sent-txid" }, txid),
      h("div", { class: "row" }, h("button", { id: "send-another", onclick: () => {
        this.send = null;
        this.tab = "overview";
        this.render();
      } }, tr("Done"))));
  }

  // ---- Settings ----

  settingsView() {
    const a = this.account, r = this.record;
    const slip132 = accountSlip132(a);
    const gap = h("input", { id: "gap", type: "number", min: "1", max: "1000", value: String(r.gapLimit) });
    const name = h("input", { id: "rename", type: "text", value: r.label });
    const message = h("div", {});
    const forget = h("div", { class: "row" });
    const askForget = () => mount(forget, h("button", { id: "forget", class: "danger", onclick: () => mount(forget,
      h("span", {}, tr("Forget this account in this browser?")),
      h("button", { id: "forget-yes", class: "danger", onclick: () => {
        this.state.accounts = this.state.accounts.filter((x) => x.id !== r.id);
        this.state.current = this.state.accounts[0]?.id ?? null;
        this.reload();
      } }, tr("Yes, forget it")),
      h("button", { onclick: askForget }, tr("Keep it"))) }, tr("Forget this account")));
    askForget();
    return h("div", {},
      h("div", { class: "panel" }, h("h2", {}, tr("Account")),
        h("label", { for: "rename" }, tr("Name")), name,
        h("label", { for: "gap" }, tr("Gap limit")), gap, message,
        h("div", { class: "row" }, h("button", { id: "save-settings", onclick: () => {
          const n = Number(gap.value);
          if (!Number.isInteger(n) || n < 1 || n > 1000) {
            mount(message, notice("bad", tr("The gap limit is a whole number from 1 to 1000.")));
            return;
          }
          r.gapLimit = n;
          r.label = name.value.trim() || r.label;
          this.reload();
        } }, tr("Save"))),
        h("h3", {}, tr("Public key")),
        h("p", { class: "small dim" }, tr("Anyone holding this can see the whole wallet, though they can't spend.")),
        h("dl", {},
          h("dt", {}, tr("Path")), h("dd", { class: "mono" }, accountPath(a)),
          h("dt", {}, tr("Fingerprint")), h("dd", { class: "mono" }, a.fingerprint || tr("none")),
          h("dt", {}, slip132.name), h("dd", { class: "mono" }, slip132.key),
          h("dt", {}, tr("Descriptor")), h("dd", { class: "mono", id: "descriptor" }, accountDescriptor(a))),
        forget),
      h("div", { class: "panel" }, h("h2", {}, tr("Server")),
        h("p", {}, tr("Now:"), " ", h("span", { class: "mono", id: "current-server" }, this.state.servers[r.network])),
        this.serverChooser()),
      this.pricePanel());
  }

  pricePanel() {
    const p = this.state.price || {};
    const pick = h("select", { id: "price-currency" },
      h("option", { value: "", selected: !p.currency }, tr("Don't show a price")),
      ...CURRENCIES.map((c) => h("option", { value: c, selected: p.currency === c }, c)));
    const url = h("input", { id: "price-url", type: "text", spellcheck: "false" });
    const showUrl = () => {
      url.value = pick.value ? p.urls?.[pick.value] || PRICE_DEFAULTS[pick.value] : "";
      url.disabled = !pick.value;
    };
    pick.addEventListener("change", showUrl);
    showUrl();
    const message = h("div", {});
    return h("div", { class: "panel" }, h("h2", {}, tr("Price")),
      h("p", {}, tr("On mainnet accounts the balance shows what it's worth. Test networks show that their coins have no value, and fetch no price.")),
      h("p", { class: "small dim" }, tr("The page asks the price server for the price and nothing else: no address, key or amount. The server learns your IP address and when you look, as the Esplora server does.")),
      h("label", { for: "price-currency" }, tr("Currency")), pick,
      h("label", { for: "price-url" }, tr("Price server")), url, message,
      h("div", { class: "row" }, h("button", { id: "save-price", onclick: () => {
        const urls = { ...(p.urls || {}) };
        if (pick.value) {
          try {
            urls[pick.value] = parsePriceUrl(url.value);
          } catch (e) {
            if (!(e instanceof PriceError)) throw e;
            mount(message, notice("bad", e.message));
            return;
          }
          if (urls[pick.value] === PRICE_DEFAULTS[pick.value]) delete urls[pick.value];
        }
        this.state.price = { currency: pick.value || null, urls };
        this.reload();
      } }, tr("Save"))));
  }

  stopCamera() {
    if (this.camera) this.camera.stop();
    this.camera = null;
  }
}
