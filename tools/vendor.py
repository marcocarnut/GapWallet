#!/usr/bin/env python3
"""
Fetches the libraries GapWallet carries in vendor/, from pinned sources, and
checks them. Every file is byte for byte what its source holds: nothing in
vendor/ is edited by hand. vendor/MANIFEST.json says where each came from,
with its SHA-256.

Sources:
  - zerogap's Bitcoin libraries, from a pinned commit of the zerogap
    repository (ZEROGAP_DIR, default ../lvglzero), as tools/share_libs.py
    shares them between its apps;
  - npm packages, by version and the registry's sha512 integrity.

Usage:
  tools/vendor.py           fetch everything and rewrite the manifest
  tools/vendor.py --check   exit 1 if a file differs from the manifest; also
                            compares with the zerogap commit, if that
                            repository is here
"""
import base64
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZEROGAP = os.environ.get("ZEROGAP_DIR", os.path.join(ROOT, "..", "lvglzero"))
CACHE = os.path.join(ROOT, ".cache")

# Main at this commit. Re-pin after S1 merges: the PSBT library's home
# moves from apps/psbtview/lib to apps/signer/lib/psbt.
ZEROGAP_COMMIT = "99248ea"
PSBT_HOME = "apps/psbtview/lib/"
ZEROGAP_FILES = [("apps/signer/lib/bip32.js", "zerogap/bip32.js"),
                 ("apps/signer/lib/crypto.js", "zerogap/crypto.js")] + [
    (PSBT_HOME + f, "zerogap/psbt/" + f)
    for f in ("basen.js", "bech32.js", "bytes.js", "hashes.js", "psbt.js", "script.js", "transport.js", "tx.js")]

NPM = [
    {"name": "@noble/hashes", "version": "2.4.0", "license": "MIT",
     "integrity": "sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==",
     "files": [("package/" + f, "noble-hashes/" + f)
               for f in ("_md.js", "_u64.js", "hmac.js", "legacy.js", "sha2.js", "utils.js", "LICENSE")]},
    {"name": "@noble/secp256k1", "version": "3.2.0", "license": "MIT",
     "integrity": "sha512-Z3ZAWOTxJ0EuTuZTi7Y69iK7GgrLHh8sgm45lVDhg/b3Nk1TpAiKhick2KkZisHuupeepSkyIydN/J459SdX1w==",
     "files": [("package/index.js", "noble-secp256k1/index.js"), ("package/LICENSE", "noble-secp256k1/LICENSE")]},
    {"name": "qrcode-generator", "version": "2.0.4", "license": "MIT",
     "integrity": "sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==",
     "files": [("package/dist/qrcode.mjs", "qrcode-generator/qrcode.mjs")]},
    {"name": "jsqr", "version": "1.4.0", "license": "Apache-2.0",
     "integrity": "sha512-dxLob7q65Xg2DvstYkRpkYtmKm2sPJ9oFhrhmudT1dZvNFFTlroai3AWSpLey/w5vMcLBXRgOJsbXpdN9HzU/A==",
     "files": [("package/dist/jsQR.js", "jsqr/jsQR.cjs"), ("package/LICENSE", "jsqr/LICENSE")]},
]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git_show(commit, path):
    return subprocess.run(["git", "-C", ZEROGAP, "show", "%s:%s" % (commit, path)],
                          check=True, capture_output=True).stdout


def tarball(pkg):
    base = pkg["name"].split("/")[-1]
    name = "%s-%s.tgz" % (base, pkg["version"])
    cached = os.path.join(CACHE, pkg["name"].replace("/", "-") + "-" + pkg["version"] + ".tgz")
    if os.path.exists(cached):
        blob = open(cached, "rb").read()
    else:
        url = "https://registry.npmjs.org/%s/-/%s" % (pkg["name"], name)
        blob = urllib.request.urlopen(url, timeout=60).read()
    got = "sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode()
    if got != pkg["integrity"]:
        sys.exit("%s: integrity mismatch: %s" % (pkg["name"], got))
    os.makedirs(CACHE, exist_ok=True)
    with open(cached, "wb") as f:
        f.write(blob)
    return blob


def fetch():
    entries = []
    def put(target, data, source):
        path = os.path.join(ROOT, "vendor", target)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        entries.append(dict(file=target, sha256=sha256(data), **source))

    commit = subprocess.run(["git", "-C", ZEROGAP, "rev-parse", ZEROGAP_COMMIT], check=True,
                            capture_output=True, text=True).stdout.strip()
    for path, target in ZEROGAP_FILES:
        put(target, git_show(commit, path), {"from": "zerogap", "commit": commit, "path": path,
                                             "license": "GPL-3.0-or-later"})
    for pkg in NPM:
        with tarfile.open(fileobj=io.BytesIO(tarball(pkg)), mode="r:gz") as tf:
            for path, target in pkg["files"]:
                put(target, tf.extractfile(path).read(),
                    {"from": "npm:%s@%s" % (pkg["name"], pkg["version"]), "integrity": pkg["integrity"],
                     "path": path, "license": pkg["license"]})
    with open(os.path.join(ROOT, "vendor", "MANIFEST.json"), "w") as f:
        json.dump(entries, f, indent=1)
        f.write("\n")
    print("%d files in vendor/" % len(entries))


def check():
    with open(os.path.join(ROOT, "vendor", "MANIFEST.json")) as f:
        entries = json.load(f)
    bad = 0
    have_git = os.path.isdir(os.path.join(ZEROGAP, ".git")) or os.path.isfile(os.path.join(ZEROGAP, ".git"))
    for e in entries:
        data = open(os.path.join(ROOT, "vendor", e["file"]), "rb").read()
        if sha256(data) != e["sha256"]:
            print("differs from the manifest: " + e["file"])
            bad += 1
        if e["from"] == "zerogap" and have_git and git_show(e["commit"], e["path"]) != data:
            print("differs from zerogap %s: %s" % (e["commit"][:7], e["file"]))
            bad += 1
    listed = {e["file"] for e in entries} | {"MANIFEST.json"}
    for folder, _, names in os.walk(os.path.join(ROOT, "vendor")):
        for n in names:
            rel = os.path.relpath(os.path.join(folder, n), os.path.join(ROOT, "vendor"))
            if rel not in listed:
                print("not in the manifest: " + rel)
                bad += 1
    if bad:
        return 1
    print("%d vendored files check out%s" % (len(entries), "" if have_git else " (zerogap repository not here)"))
    return 0


if __name__ == "__main__":
    if "--check" in sys.argv[1:]:
        sys.exit(check())
    fetch()
