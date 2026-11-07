// The page starts here.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { installCrypto } from "./crypto.js";
import { parseServer } from "./esplora.js";
import { load } from "./store.js";
import { App, priceUrlFor } from "./ui.js";
import { parsePriceUrl } from "./price.js";
import { setLanguage, startLanguage, language } from "./i18n.js";

// Narrows the build's connect-src to the one server this page was started
// with (docs/ESPLORA.md, "Content-Security-Policy"). Before any request;
// a policy added can't be taken back, so changing server reloads the page.
// The price server, if one is chosen and the account is on mainnet, is the only other.
function narrowPolicy(server, priceUrl) {
  const origins = [];
  try {
    if (server) origins.push(parseServer(server).origin);
  } catch { /* not added */ }
  try {
    if (priceUrl) origins.push(new URL(parsePriceUrl(priceUrl)).origin);
  } catch { /* not added */ }
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = `connect-src ${origins.length ? [...new Set(origins)].join(" ") : "'none'"}`;
  document.head.append(meta);
}

const state = load();
setLanguage(startLanguage(state.language, navigator.languages || [navigator.language]));
document.documentElement.lang = language();
const record = state.accounts.find((a) => a.id === state.current) || state.accounts[0] || null;
narrowPolicy(record ? state.servers[record.network] : null, record ? priceUrlFor(state, record.network) : null);
installCrypto();
new App(document.getElementById("app"), state, record).start();
