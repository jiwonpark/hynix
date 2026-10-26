const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const lighter = fs.readFileSync(path.join(root, "lighter-tab.js"), "utf8");
const crypto = fs.readFileSync(path.join(root, "crypto-tab.js"), "utf8");
const lighterCrypto = fs.readFileSync(path.join(root, "lighter-crypto-tab.js"), "utf8");

assert.match(index, /function switchMainTab\(tab\)/, "all terminals must use the common tab switcher");
assert.doesNotMatch(
  index.match(/function switchMainTab\(tab\)[\s\S]*?window\.switchMainTab = switchMainTab;/)?.[0] || "",
  /\.scrollIntoView\(/,
  "terminal switching must not move the document while centering horizontal navigation"
);
assert.match(index, /window\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\)/,
  "entering another terminal must start at the top");

for (const [name, source] of [["Tab 3", lighter], ["Tab 4", crypto], ["Tab 5", lighterCrypto]]) {
  assert.match(source, /StrategyExecutionChartController\.linkTimeScales\(/,
    `${name} must use the shared time-scale linker`);
  assert.match(source, /this\.chartSync\?\.sync\(\)/,
    `${name} must resynchronize linked panes after resize or activation`);
}

assert.match(lighter, /adrPoints\.push\([\s\S]*?\{ time: bar\.time \}\)/,
  "Tab 3 ADR data must preserve missing timestamps as whitespace");
assert.match(lighter, /stockPoints\.push\([\s\S]*?\{ time: bar\.time \}\)/,
  "Tab 3 domestic data must preserve missing timestamps as whitespace");
assert.match(lighter, /this\.setAssetChartData\(this\.bars\)/,
  "Tab 3 must realign the price pane after history is prepended");

console.log("Cross-tab terminal interaction invariants passed");
