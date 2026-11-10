# GapWallet

A watch-only Bitcoin wallet in one HTML file: the online companion of
[GapKeep](https://github.com/marcocarnut/GapKeep)'s signer. GapKeep is "a tiny
bare-metal OS for air-gapped apps" ([gapkeep.org](https://gapkeep.org)); its
signer holds the keys on a Raspberry Pi Zero with no network. GapWallet holds
public keys only. It watches an account, builds the transaction you want to
send as a PSBT, shows it as QR codes for the signer's camera, reads the signed
transaction back from the signer's screen with the webcam, and broadcasts it
through an [Esplora](https://github.com/Blockstream/esplora) server.

```
 GapKeep signer (offline) ── public key, once ──▶ GapWallet ◀──▶ Esplora server
          ▲                                          │
          └──────────── QR codes, both ways ─────────┘
```

The signer shows what is really being spent, from the transaction itself, and
checks that the change comes back to the same wallet. GapWallet can be wrong,
or lied to, and the signer still shows the truth. It works with other PSBT
signers that read Electrum's Base43 codes or BBQr, too.

## Use it

- **Hosted:** [gapwallet.org](https://gapwallet.org/), published from this
  repository by GitHub Pages (`.github/workflows/pages.yml`). The page there
  is `gapwallet.html` from this repository, byte for byte;
  [gapwallet.org/BUILD](https://gapwallet.org/BUILD) gives the commit and the
  SHA-256 of each file, so you can rebuild and compare.
- **A checked copy, locally:** download the zip named in `BUILD`
  (`https://gapwallet.org/gapwallet-<commit>.zip`), check its SHA-256 against
  `BUILD`, unzip, and open `gapwallet/index.html`. It runs from disk
  (`file://`): no local server is needed, and nothing is installed. The camera
  works from disk too (checked in Chromium).
- **From source:** `node tools/build.mjs` writes `gapwallet.html`; open it.

Then:

1. Add an account: GapKeep's descriptor, or a zpub or ypub with its master
   fingerprint. The page shows the first addresses before contacting anything.
2. Choose a server (below). There is no default.
3. Receive: the page offers the next unused address, with its path
   (`m/84'/0'/0'/0/5`). Before you give out an address for a large amount,
   check it on GapKeep (below).
4. Send: fill in the details, review, show the codes to the signer and check
   what it shows, then read the signed transaction back with the webcam (or
   paste it, or open a file) and broadcast. The PSBT can be saved as a file
   too, for signers without a camera.

What the browser keeps (accounts, servers, labels) is in its local storage, for
that page's site only: a copy opened from disk doesn't see what the hosted one
keeps, and the reverse.

## The servers it talks to, and why

The page talks to nothing until you choose a server, and then only to:

| Server | Why | What it learns |
| --- | --- | --- |
| **The Esplora server you choose**, for the account's network | Balances, coins and history of the account's addresses; the previous transactions a PSBT needs; fee estimates; broadcasting. Every request is in `docs/ESPLORA.md`. | Every address of the account, linked together, and so its balance and whole history; each transaction you send, before anyone else; your IP address. |
| **A price server**, only on mainnet and only if you ask for the price | "About 1,234.56 USD" under the balance, so real coins are never mistaken for test coins, which say "TEST ONLY — NO MONETARY VALUE" | Your IP address and when you look: nothing about the wallet. Coinbase's spot price by default; the URL can be changed in Settings. |

The site serving the page learns only that it was loaded: no request goes back
to it. There are no fonts, scripts or images from anywhere else.

**Your own server is the private choice, and it is supported**: type its
address (`https://…`, or `http://…` on your own network) under "Or your own
server". Public servers are one click each: blockstream.info (mainnet and
signet) and mempool.space (mainnet, signet and testnet4). Whichever you choose,
GapWallet doesn't trust it: addresses come from your public key, each coin's
previous transaction is hashed here and must match, and the first request
checks the server is on the right network (its genesis block). A lying server
can hide coins or history, not make you sign something else: the signer shows
what you sign.

### The Content-Security-Policy

The page carries a strict policy in a `<meta>` tag: nothing runs but the one
inline script and style it was built with (by SHA-256), no remote scripts,
styles, fonts, images or frames, no forms. A static policy can't name a server
you will type later, so it works in two steps, as policies add up and each one
must allow a request:

- the built page allows `connect-src https: http:`, the ceiling;
- at start, before any request, the page adds a second policy naming only the
  origin of the server you chose and, for a mainnet account with the price on,
  the price server's: `connect-src https://blockstream.info https://api.coinbase.com`,
  for example. With nothing chosen it is `connect-src 'none'`.

Changing either server saves it and reloads the page, which then allows only
the new one. `tests/page.test.mjs` checks that a request to any other origin
fails.

### Hosting, and what it can't do

gapwallet.org is GapWallet's own origin: nothing else is served there, so no
other page can read or change what the wallet keeps in the browser.

GitHub Pages sends no custom headers, and some protections only exist as
headers. The one that matters here is `frame-ancestors`, which forbids other
sites from showing the page in a frame and laying their own buttons over it
(clickjacking); a `<meta>` policy can't set it. So the page checks for itself:
inside another page's frame it doesn't start, and says so. A frame that turns
scripts off can't run it at all. Pages does serve HTTPS, and the page sends
no referrer (`<meta name="referrer">`).

If you host a copy yourself, send `Content-Security-Policy: frame-ancestors
'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`,
and give it an origin of its own.

### Comparing the hosted page with its source

The build is deterministic: the same commit gives the same bytes, on GitHub's
runner or yours (Node 18 or later, nothing to install).

```sh
git clone https://github.com/marcocarnut/GapWallet && cd GapWallet
git checkout <the commit in https://gapwallet.org/BUILD>
node tools/build.mjs --dist
curl -s https://gapwallet.org/BUILD | diff - dist/BUILD
curl -s https://gapwallet.org/ | sha256sum    # the index.html line of BUILD
```

`BUILD` says "with uncommitted changes: not a release" when built from a
changed tree; the workflow refuses to publish such a build. The site also has
a `CNAME` file, which GitHub Pages wants and `BUILD` doesn't list.

## Checking a receive address on GapKeep

A tampered copy of this page (on a compromised site or GitHub account, or one
swapped on disk)
could show someone else's address as yours, and the signer only sees
addresses when you send. So check a receive address on the air-gapped side
before giving it out for anything large. GapWallet shows each receive
address's full path under it, and `#n` in the list of next addresses.

GapKeep's REPL derives it from your seed, independently of anything this page
said:

```js
btc.words("your twelve words ...").derive("m/84'/0'/0'/0/5").address()
```

Copy the path as GapWallet shows it. For a test network, set
`btc.network = "testnet"` first (signet and testnet4 addresses are the same).
For nested SegWit accounts the path starts with `m/49'`, and `.address()`
follows it. If GapKeep has the account's public key instead of the words,
`btc.xpub("zpub...").derive("0/5").address()` gives the same, but then the
check is only as good as where that key came from: the words are the check.

The address must be the same, character for character. The first addresses
shown when you add an account can be checked the same way.

## Status

- P2WPKH (`wpkh(…)`, zpub, vpub) and P2SH-P2WPKH (`sh(wpkh(…))`, ypub, upub)
  accounts. Legacy and multisig accounts are not supported yet.
- Mainnet, signet and testnet4.
- PSBTs go out as one Electrum Base43 QR code when they fit, or as an animated
  BBQr series; signed transactions come back the same ways (`docs/ESPLORA.md`,
  "QR codes").
- One recipient per transaction.
- English and Brazilian Portuguese, chosen in the upper right corner. Numbers
  are written the language's way (0.5 or 0,5); see "Languages".
- Receive addresses can be marked handed out, with who they went to, and
  transactions can have notes. Both export and import as BIP-329 labels, the
  format Sparrow and Electrum read (`docs/ESPLORA.md`, "Your own records").
- The price's default answer (Coinbase's spot price) is read as their
  documentation describes it; the tests use a stand-in.

## Building and testing

| Path | What |
| --- | --- |
| `gapwallet.html` | The program: built, unminified. |
| `docs/ESPLORA.md` | The requests it makes, how it scans, fees, coins, privacy. Written before the code. |
| `docs/E1.md` | The end-to-end test plan: the simulator, cameras, signet, bitcoind, Electrum. |
| `tests/fixtures/bbqr-real-scan.txt` | A real scan's BBQr codes, from the BBQr project (public domain; provenance in `tests/bbqr.test.mjs`). |
| `src/` | The wallet: `descriptor.js` (imports), `account.js` (addresses), `esplora.js` (the client), `scan.js`, `coinselect.js`, `build.js` (transactions and PSBTs), `signed.js` (what comes back), `qr.js`, `ui.js`. |
| `vendor/` | Libraries, byte for byte, with origins and hashes in `vendor/MANIFEST.json`. Never edited by hand. |
| `tools/build.mjs` | Joins `src/` and `vendor/` into the page; with `--dist`, also the folder to host. No dependencies; the same inputs give the same bytes. |
| `tools/vendor.py` | Fetches `vendor/` from pinned sources; `--check` verifies it. |
| `tools/record_fixtures.mjs` | Records real server answers for the tests. |
| `tests/` | Below. |

```sh
node tools/build.mjs        # writes gapwallet.html
node tools/build.mjs --dist # and dist/, the site: index.html, LICENSE, a zip of both, BUILD
tools/vendor.py --check     # checks vendor/ against its manifest and GapKeep's commit
npm install                 # only for the page tests: puppeteer-core drives Chromium
npm test
```

The tests need the [GapKeep repository](https://github.com/marcocarnut/GapKeep)
next to this one, as `../lvglzero` (or point `GAPKEEP_DIR` at it):
PSBTs built here are signed by the real signer's library, not a second one.
Node 18 or later; `npm test` needs Chromium for the page tests.

- `tests/core.test.mjs`: vectors (BIP-84, BIP-380), imports refused, scanning
  and the gap limit, coin selection, PSBT contents, a server that lies, and the
  real signer: plan, sign, finalize, back to the same txid.
- `tests/fixtures.test.mjs`: the client against recorded mempool.space answers.
- `tests/qr.test.mjs`: codes through the decoder the page uses.
- `tests/page.test.mjs`: the built page in headless Chromium against a stub
  server: the whole path through a fake camera, the Content-Security-Policy
  (a request to another origin must fail), and that nothing is contacted before
  a server is chosen.

## Languages

Text is written in English where it is used, and that English is the key:
`tr("Fee rate (sat/vB, {min} to {max})", { min, max })` (`src/i18n.js`). Each
other language is a table from key to text, `src/lang-pt-BR.js` for the first.
`node tools/i18n-keys.mjs` lists every key, and `tests/i18n.test.mjs` fails if a
key is missing from a table, a table has a key no longer used, or the `{names}`
differ. To add a language, add a table and a line in `LANGUAGES`.

The language only changes how numbers are written, never which amount is meant.
`src/amount.js` reads what's typed so that no mix-up of marks becomes a
different amount: "1.000" or "12,500" could be one or a thousand, so the page
refuses them, in either language, unless the mark is the language's own decimal
mark. A single mark that can't be separating thousands, as in "0.001" or "1,5",
is a decimal point whichever the language, since amounts are often copied from
elsewhere. Below the box the page shows the amount it read, in full.

## Security

- **No private keys.** The private-key functions the GapKeep libraries ask for
  are stubs that throw. A pasted xprv, WIF, seed phrase or codex32 share is
  refused and cleared; nothing is stored.
- **The signer is the boundary.** It shows what is really spent, from the
  transaction itself. Receive addresses are the exception: check them on
  GapKeep (above).
- **The server isn't trusted** (above).
- **The page runs only what it was built with** (above). All text reaches the
  page as text nodes.
- **Reproducible:** the same commit builds the same bytes, and
  [gapwallet.org/BUILD](https://gapwallet.org/BUILD) says which commit the
  hosted page is (above).

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).
Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

GPL-3.0-or-later: see `LICENSE`. Bundled libraries keep their own licences,
all compatible: GapKeep's PSBT and BIP-32 libraries (GPL-3.0-or-later), the noble
libraries and qrcode-generator (MIT), jsQR (Apache-2.0). `vendor/MANIFEST.json`
lists each file; their licence texts are in `vendor/`, and at the end of the
built page.
