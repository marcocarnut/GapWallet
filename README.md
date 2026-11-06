# GapWallet

The online half of [zerogap](../lvglzero): a watch-only Bitcoin wallet in one
HTML file. It holds public keys only. It watches an account, builds PSBTs for
the offline signer, shows them as QR codes, reads the signed transaction back
with the webcam, and broadcasts it through an
[Esplora](https://github.com/Blockstream/esplora) server (mempool.space, or
your own).

```
 signer (offline) ──── public key ────▶ GapWallet ◀──▶ Esplora server
      ▲                                    │
      └───────── QR codes, both ways ──────┘
```

**To use it:** open `gapwallet.html`, from disk or any web server. There is
nothing to install.

1. Add an account: a descriptor, or a zpub or ypub with its master fingerprint. The
   page shows the first addresses before contacting anything: compare them
   with your signer.
2. Choose a server. There is no default, because the server learns every
   address you ask about (Settings says exactly what each party learns).
3. Send: fill in the details, review, read the code with the signer, then read
   the signed transaction back with the webcam, or paste it, and broadcast.

## Status

Milestones W1 and W2, and the first part of W3, of the plan in zerogap's
`docs/plans/BITCOIN.md`.

- P2WPKH (`wpkh(…)`, zpub, vpub) and P2SH-P2WPKH (`sh(wpkh(…))`, ypub, upub)
  accounts. Legacy and multisig are the rest of W3.
- Mainnet, signet and testnet4.
- PSBTs go out as one Electrum Base43 QR code when they fit, or as an animated
  BBQr series; signed transactions come back the same ways (`docs/ESPLORA.md`,
  "QR codes"). zerogap's signer reads series after S2.
- One recipient per transaction.

## How it's put together

| Path | What |
| --- | --- |
| `gapwallet.html` | The program: built, unminified. |
| `docs/ESPLORA.md` | W0: the requests it makes, how it scans, fees, coins, privacy. Written before the code. |
| `tests/fixtures/bbqr-real-scan.txt` | A real scan's BBQr codes, from the BBQr project (public domain; provenance in `tests/bbqr.test.mjs`). |
| `src/` | The wallet: `descriptor.js` (imports), `account.js` (addresses), `esplora.js` (the client), `scan.js`, `coinselect.js`, `build.js` (transactions and PSBTs), `signed.js` (what comes back), `qr.js`, `ui.js`. |
| `vendor/` | Libraries, byte for byte, with origins and hashes in `vendor/MANIFEST.json`. Never edited by hand. |
| `tools/build.mjs` | Joins `src/` and `vendor/` into the page. No dependencies; the same inputs give the same bytes. |
| `tools/vendor.py` | Fetches `vendor/` from pinned sources; `--check` verifies it. |
| `tools/record_fixtures.mjs` | Records real server answers for the tests. |
| `tests/` | Below. |

```sh
node tools/build.mjs        # writes gapwallet.html
tools/vendor.py --check     # checks vendor/ against its manifest and zerogap's commit
npm install                 # only for the page tests: puppeteer-core drives Chromium
npm test
```

The tests need the zerogap repository next to this one (or `ZEROGAP_DIR`):
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

## Security

- **No private keys.** The private-key functions the zerogap libraries ask for
  are stubs that throw. A pasted xprv, WIF, seed phrase or codex32 share is
  refused and cleared; nothing is stored.
- **The signer is the boundary.** It shows what is really spent, from the
  transaction itself. GapWallet can be wrong, or lied to, and the signer still
  shows the truth.
- **The server isn't trusted.** Addresses come from local derivation. A coin's
  previous transaction is hashed here and must match what the server claims.
  The first request checks the server's genesis block.
- **The page runs only what it was built with.** A Content-Security-Policy
  allows the one inline script and style by hash, no remote anything, and
  connections only to the server you chose. All text reaches the page as text
  nodes.

## Licence

GPL-3.0-or-later: see `LICENSE`. Bundled libraries keep their own licences,
all compatible: zerogap's PSBT and BIP-32 libraries (GPL-3.0-or-later), the noble
libraries and qrcode-generator (MIT), jsQR (Apache-2.0). `vendor/MANIFEST.json`
lists each file; their licence texts are in `vendor/`.
