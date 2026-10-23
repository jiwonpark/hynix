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
  "tabContentPairs",
  "tabContentCompound",
  "tabContentStrategyLab",
  "tabContentUpbitScanner",
];

for (const id of tabIds) {
  const tag = html.match(new RegExp(`<div id="${id}"[^>]*>`))?.[0] || "";
  assert.match(tag, /mainTabLoading/, `${id} must be covered during its initial load`);
  assert.match(tag, /data-loading-message="[^"]+"/, `${id} must explain what is loading`);
  assert.match(tag, /aria-busy="true"/, `${id} must expose its initial busy state`);
}

assert.match(html, /\.mainTabLoading > \* \{\s*visibility: hidden !important;/,
  "unverified placeholders must stay hidden behind the loading gate");
assert.match(html, /function beginMainTabLoading\(tab\)/,
  "tab activation must start a readiness check");
assert.match(html, /beginMainTabLoading\(normalized\);/,
  "every navigation path must use the shared loading gate");
assert.match(html, /container\.setAttribute\("aria-busy", ready \? "false" : "true"\)/,
  "the loading gate must publish its resolved state");
assert.match(html, /Still loading live data… The terminal will keep retrying\./,
  "slow tabs must retain an explicit bounded loading message");

console.log("All main tabs have a real-data loading gate");
