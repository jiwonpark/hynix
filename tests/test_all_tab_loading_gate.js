const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const tabIds = [
  "tabContentBacktest",
  "tabContentTrading",
  "tabContentLighter",
  "tabContentCrypto",
  "tabContentLighterCrypto",
  "tabContentLighterMicro",
  "tabContentPairs",
  "tabContentCompound",
  "tabContentStrategyLab",
  "tabContentUpbitScanner",
  "tabContentMultiSpan",
];

for (const id of tabIds) {
  const tag = html.match(new RegExp(`<div id="${id}"[^>]*>`))?.[0] || "";
  assert.match(tag, /mainTabLoading/, `${id} must be covered during its initial load`);
  assert.match(tag, /data-loading-message="[^"]+"/, `${id} must explain what is loading`);
  assert.match(tag, /aria-busy="true"/, `${id} must expose its initial busy state`);
}

assert.doesNotMatch(html, /\.mainTabLoading > \* \{[\s\S]*?visibility: hidden !important;/,
  "loaded sections must remain usable while another component is still pending");
assert.match(html, /\[id\^="tabContent"\]\.mainTabLoading > \.mainTabProgress \{ display: flex; \}/,
  "pending tabs must show component-level progressive loading evidence");
assert.match(html, /function beginMainTabLoading\(tab\)/,
  "tab activation must start a readiness check");
assert.match(html, /beginMainTabLoading\(normalized\);/,
  "every navigation path must use the shared loading gate");
assert.match(html, /container\.setAttribute\("aria-busy", ready \? "false" : "true"\)/,
  "the loading gate must publish its resolved state");
assert.match(html, /Still waiting for the remaining live data\. Loaded sections stay usable; retries continue automatically\./,
  "slow tabs must disclose that loaded components remain usable while retries continue");
assert.match(html, /container\._mainTabLoadingTimer = timer;/,
  "slow tabs must keep watching for late data instead of becoming permanently blocked");

console.log("All main tabs have a real-data loading gate");
