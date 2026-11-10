# Security

GapWallet builds the transactions people sign with real money, and shows the
addresses they are paid to, so a security problem in it matters more than most
bugs. Thank you for reporting one.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: on
[github.com/marcocarnut/GapWallet](https://github.com/marcocarnut/GapWallet),
the **Security** tab, then **Report a vulnerability**. Please never report
a vulnerability in a public issue, pull request or discussion.

Say what is affected (the commit, or the `BUILD` of the hosted page), what an
attacker needs (a server you chose, a file you import, a QR code shown to the
camera, a page on the same site...), and how to reproduce it, if you can.

You will get a first reply within 7 days.

A problem in the signer itself goes to
[GapKeep](https://github.com/marcocarnut/GapKeep/security).

## In scope

- Anything that could make a person send to an address or an amount other
  than the one they meant without the signer showing it, or that shows a
  receive address that isn't theirs.
- Anything that sends the page's data (addresses, labels, history) anywhere
  but the servers the person chose, or runs code the page wasn't built with:
  the Content-Security-Policy, the QR and file readers, BIP-329 imports.
- A server, file or QR code that crashes the page or makes it show something
  false (a balance, a fee, "this is the transaction built here").
- The build and the site: anything that makes `gapwallet.html` or
  gapwallet.org differ from what its commit builds (`tools/build.mjs`,
  `tools/vendor.py`, `.github/workflows/pages.yml`).

## Not a vulnerability

- **What a server learns.** The Esplora server you choose sees every address
  of the account, and the price server your IP address: that is how they work,
  and the page says so before you choose. Use your own server for privacy.
- **A server hiding coins or history.** A watch-only wallet sees what its
  server tells it. What the server can't do is change what you sign: the
  signer shows that.
- **A tampered page.** Whoever controls the site or the file can change the
  wallet; that is why the build is reproducible, why `BUILD` gives its hashes,
  and why receive addresses should be checked on GapKeep (README, "Checking a
  receive address on GapKeep").
- Missing HTTP headers on gapwallet.org: GitHub Pages sends none of its own
  choosing. The page refuses to run in a frame instead (README, "Hosting").
- Someone with access to your unlocked computer and browser.
