const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const lighter = fs.readFileSync(path.join(root, "lighter-tab.js"), "utf8");
const crypto = fs.readFileSync(path.join(root, "crypto-tab.js"), "utf8");
const lighterCrypto = fs.readFileSync(path.join(root, "lighter-crypto-tab.js"), "utf8");
const common = fs.readFileSync(path.join(root, "terminal-common.js"), "utf8");
const executionChart = fs.readFileSync(path.join(root, "strategy-execution-chart.js"), "utf8");

assert.match(executionChart, /EXIT\$\{groupedCount > 1 \? ` ×\$\{groupedCount\}` : ""\}/,
  "the shared chart must retain grouped exit detail for hover and legacy consumers");
assert.match(executionChart, /const dimAlpha = isPaper \? "0\.72" : "0\.90"/,
  "Tabs 2–5 must share legible actual and replay marker contrast");
assert.match(index, /compactHoverOnly: true/,
  "Tab 2 alone must opt into compact arrows with hover-only labels");
assert.match(executionChart, /size: this\.compactHoverOnly \? 1/,
  "Tab 2 compact mode must use the smaller native arrow size");
for (const [name, source] of [["Tab 3", lighter], ["Tab 4", crypto], ["Tab 5", lighterCrypto]]) {
  assert.match(source, /return isEntry \? "▶" : "◀"/,
    `${name} must retain entry and exit triangle markers`);
  assert.match(source, /polygon points="0\.5,0\.5 7\.5,4 0\.5,7\.5"/,
    `${name} entry marker must render as a right-facing triangle`);
  assert.match(source, /polygon points="7\.5,0\.5 0\.5,4 7\.5,7\.5"/,
    `${name} exit marker must render as a left-facing triangle`);
  assert.match(source, /Triangles and diagonal connectors should show ONLY on hover/,
    `${name} must retain paired PnL triangles on hover or selection`);
}

assert.match(lighterCrypto, /Target entry campaign pieces per minute/,
  "Tab 5 must identify its rate control as signal-triggered execution slicing");
assert.match(lighterCrypto, /One valid signal starts paced live-only entry pieces/,
  "Tab 5 must disclose that replay signals are independent of live child-order timing");
assert.match(lighterCrypto, /bot\?\.entry_campaign/,
  "Tab 5 must render the persisted live entry campaign status");

assert.match(common, /Auto-entry direction:/, "single-leg tabs must use direction wording, not spread wording");
assert.match(common, /Two-way \(Long \+ Short\)/, "single-leg direction control must expose two-way trading clearly");
assert.match(common, /Authenticated bot configuration returned by the latest status response/, "direction status must disclose its live source");
for (const [name, source, prefix] of [["Tab 4", crypto, "crypto_"], ["Tab 5", lighterCrypto, "lighterCrypto_"]]) {
  assert.ok(source.includes(`bindSingleLegDirectionControl("${prefix}"`), `${name} must bind the shared direction control`);
  assert.ok(source.includes(`syncSingleLegDirectionControl("${prefix}"`), `${name} must restore direction from bot status`);
  assert.match(source, /singleLegPositionReference\(/,
    `${name} must derive its idle chart direction from the signed open exchange position`);
  assert.match(source, /await chartRefresh;\s*this\.renderCurrentPositionReferenceLines\(\);/,
    `${name} must reapply the live position reference after asynchronous chart loading`);
}

assert.match(index, /function switchMainTab\(tab\)/, "all terminals must use the common tab switcher");
assert.doesNotMatch(
  index.match(/function switchMainTab\(tab\)[\s\S]*?window\.switchMainTab = switchMainTab;/)?.[0] || "",
  /\.scrollIntoView\(/,
  "terminal switching must not move the document while centering horizontal navigation"
);
assert.match(index, /window\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\)/,
  "entering another terminal must start at the top");
assert.match(index, /function renderMainTabProgress\(container, config\)/,
  "trading tabs must expose component-level progressive loading");
assert.doesNotMatch(index, /mainTabLoading > \* \{[\s\S]*?visibility: hidden/,
  "loaded terminal sections must remain visible while other components load");

assert.match(common, /function setTerminalLoading\(prefix = ""\)/,
  "Tabs 2–5 must share one neutral live-data loading contract");
assert.match(common, /function setTerminalAccountLoading\(prefix = "", message = "Loading authenticated account…"\)/,
  "account retries must have a shared loading state that does not clear an already-loaded chart");
assert.match(common, /class="terminalLoadingDots" role="status" aria-label="Loading"/,
  "loading fields must render an accessible animated placeholder rather than a fake value");
assert.match(index, /@keyframes terminalLoadingDot/,
  "the shared loading placeholder must visibly animate");
assert.match(common, /"valAccountEquity", "valAvailMargin", "valUnrealizedPnl", "valActivePairs"/,
  "the shared loading contract must clear every account summary field");
assert.match(common, /root\?\.querySelectorAll\("\.condValue"\)/,
  "the shared loading contract must clear strategy-condition values");
assert.match(common, /element\.querySelector\("\[id\]"\) \|\| element/,
  "loading must preserve nested condition value nodes used by later live renders");
assert.match(common, /element\.innerHTML = terminalLoadingMarkup/,
  "condition badges must animate rather than show PASS or WAIT before data arrives");
assert.ok(index.includes('TerminalCommon.setTerminalLoading("")'),
  "Tab 2 must apply the shared loading state after rendering stored UI state");
assert.doesNotMatch(index, /id="valActivePairs"[^>]*>0 Open \(Flat\)</,
  "Tab 2 must not present a fake flat account while positions are loading");
assert.match(index, /this\.state\.accountSyncPending\) \$\("countPositions"\)\.innerHTML = window\.TerminalCommon\?\.terminalLoadingMarkup/,
  "Tab 2 must keep the positions counter animated until account sync completes");
assert.doesNotMatch(index, /id="valCrit(?:ScaleInThreshold|Ma24|CurrentSpread|OutTargetSpread|LatestInSpread|TpCurrentSpread)"[^>]*>139\./,
  "Tab 2 must not ship example market values in live criteria fields");

for (const [name, source] of [["Tab 3", lighter], ["Tab 4", crypto], ["Tab 5", lighterCrypto]]) {
  assert.match(source, /StrategyExecutionChartController\.linkTimeScales\(/,
    `${name} must use the shared time-scale linker`);
  assert.match(source, /this\.chartSync\?\.sync\(\)/,
    `${name} must resynchronize linked panes after resize or activation`);
  assert.match(source, /entryDirection: options\.isLong === true \? "long" : options\.isLong === false \? "short" : null/,
    `${name} reference labels must use the same explicit direction as its profit ladder`);
  assert.doesNotMatch(source, /Fallback to current ratio/,
    `${name} must not fabricate a short ladder when only an undirected current price is known`);
  assert.match(source, /currentRatio: null/,
    `${name} must not initialize a synthetic live market price`);
  assert.match(source, /accountDataReady: false/,
    `${name} must distinguish an authenticated account snapshot from an empty loading response`);
  assert.match(source, /status\.success !== false && status\.authenticated === true/,
    `${name} must only render zero positions after an authenticated status response`);
  assert.match(source, /TerminalCommon\.setTerminalAccountLoading\(/,
    `${name} must keep account fields neutral when authenticated data is unavailable`);
  assert.match(source, /this\._userSelectedInterval = true/,
    `${name} must remember a user-selected viewing interval`);
  assert.match(source, /classList\.toggle\("active", candidate === value\)/,
    `${name} must highlight a selected viewing interval before its candle request completes`);
  assert.match(source, /if \(!this\._userSelectedInterval\) this\.interval = liveInterval/,
    `${name} bot status refresh must not reset a user-selected viewing interval`);
}
assert.ok(lighter.includes('TerminalCommon.setTerminalLoading("lighter_")'),
  "Tab 3 must apply the shared loading state after its virtual-state render");
assert.ok(crypto.includes('TerminalCommon.setTerminalLoading("crypto_")'),
  "Tab 4 must apply the shared loading state after its virtual-state render");
assert.ok(lighterCrypto.includes('TerminalCommon.setTerminalLoading("lighterCrypto_")'),
  "Tab 5 must apply the shared loading state after its virtual-state render");
assert.doesNotMatch(lighter, /setText\("valAvailMargin", "\$8,240\.00"\)/,
  "Tab 3 must not display invented free margin while syncing");

assert.match(index, /entryDirection: "short"/, "Tab 2 paired-profit ladder must be identified as short spread");

assert.match(lighter, /adrPoints\.push\([\s\S]*?\{ time: bar\.time \}\)/,
  "Tab 3 ADR data must preserve missing timestamps as whitespace");
assert.match(lighter, /stockPoints\.push\([\s\S]*?\{ time: bar\.time \}\)/,
  "Tab 3 domestic data must preserve missing timestamps as whitespace");
assert.match(lighter, /this\.setAssetChartData\(this\.bars\)/,
  "Tab 3 must realign the price pane after history is prepended");

console.log("Cross-tab terminal interaction invariants passed");
