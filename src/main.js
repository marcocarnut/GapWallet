// The page starts here.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { installCrypto } from "./crypto.js";
import { parseServer } from "./esplora.js";
import { load } from "./store.js";
import { App } from "./ui.js";

// Narrows the build's connect-src to the one server this page was started
// with (docs/ESPLORA.md, "Content-Security-Policy"). Before any request;
// a policy added can't be taken back, so changing server reloads the page.
function narrowPolicy(server) {
  let origin = "'none'";
  if (server) {
    try {
      origin = parseServer(server).origin;
    } catch { /* stays 'none' */ }
  }
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = `connect-src ${origin}`;
  document.head.append(meta);
}

const state = load();
const record = state.accounts.find((a) => a.id === state.current) || state.accounts[0] || null;
narrowPolicy(record ? state.servers[record.network] : null);
installCrypto();
new App(document.getElementById("app"), state, record).start();
