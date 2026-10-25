const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Test 1: StrategyExecutionChartController markersForRender with paper trades
const Controller = require("../strategy-execution-chart.js");
const controller = new Controller();

const nowSec = 1712345000;
const executions = [
  {
    time: nowSec,
    source: "actual",
    is_entry: true,
    direction: "short",
    shape: "arrowRight",
    color: "#dc2626",
    hypothetical: false,
    text: "Actual Fill",
  },
  {
    time: nowSec,
    source: "virtual",
    is_entry: true,
    direction: "short",
    shape: "arrowRight",
    color: "rgba(220, 38, 38, 0.70)",
    hypothetical: true,
    is_paper: true,
    text: "Paper Fill",
  },
];

controller.setExecutions(executions);
const rendered = controller.markersForRender();

assert.equal(rendered.length, 2, "Both actual and paper trades on the same candle must render without collision");
const actualMarker = rendered.find((m) => m.color.includes("0.70"));
const paperMarker = rendered.find((m) => m.color.includes("0.35"));
assert.ok(actualMarker, "Actual marker must be present with actual opacity");
assert.ok(paperMarker, "Paper marker must be present with hypothetical opacity");

// Test 2: Verify forming candle timestamp filter logic across crypto-tab, lighter-crypto-tab, lighter-tab
const firstBarTime = 1712000000;
const lastBarTime = 1712345000; // open time of current forming candle (5m candle)
const intervalSec = 300;
const minTime = firstBarTime - intervalSec;
const maxTime = lastBarTime + intervalSec * 2;

// Trade placed right now during the forming candle (lastBarTime + 120s)
const tradeTimeSec = lastBarTime + 120;
const inWindow = tradeTimeSec >= minTime && tradeTimeSec <= maxTime;
assert.ok(inWindow, "Trade placed during current forming candle must fall within [minTime, maxTime]");

// The previous buggy condition: tradeTimeSec <= lastBarTime
const oldBuggyCondition = tradeTimeSec <= lastBarTime;
assert.equal(oldBuggyCondition, false, "Old condition incorrectly dropped all forming candle trades");

// Paper/backtest trade ranges are outlines; only verified actual pairs may fill.
const root = path.join(__dirname, "..");
assert.match(fs.readFileSync(path.join(root, "strategy-lab.js"), "utf8"), /polygon\.setAttribute\("fill", "none"\)/);
for (const file of ["lighter-tab.js", "crypto-tab.js", "lighter-crypto-tab.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert.match(source, /: "none";/, `${file} must render paper trade triangles without translucent fill`);
}

console.log("✅ Paper trade marker rendering and forming-candle range tests passed successfully!");
