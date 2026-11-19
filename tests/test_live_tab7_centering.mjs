import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function run() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hynix-tab7-verify-"));
  const chromeCandidates = process.platform === "win32"
    ? [
        process.env.CHROME_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : process.platform === "darwin"
      ? [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const chromePath = chromeCandidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!chromePath) throw new Error("Chrome executable not found; set CHROME_PATH");

  const chrome = spawn(chromePath, [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1600,1200",
    "about:blank",
  ]);

  chrome.on("exit", () => { try { fs.rmSync(profile, {recursive: true, force: true}); } catch (_) {} });
  const cleanup = () => { try { chrome.kill(); } catch (_) {} };
  process.on("exit", cleanup);

  let port = null;
  const start = Date.now();
  const portFile = path.join(profile, "DevToolsActivePort");
  while (!port && Date.now() - start < 10000) {
    if (fs.existsSync(portFile)) {
      try {
        const lines = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
        if (lines[0]) {
          port = lines[0].trim();
          break;
        }
      } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) throw new Error("Could not detect Chrome DevTools port");

  const target = await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT" }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.onopen = resolve);

  let id = 1;
  const callbacks = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && callbacks.has(msg.id)) {
      callbacks.get(msg.id)(msg);
      callbacks.delete(msg.id);
    }
  };

  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = id++;
    callbacks.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.result?.exceptionDetails) {
      console.error("Runtime exception:", res.result.exceptionDetails);
    }
    return res.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");

  console.log("Navigating to https://control.jiwonova.com/skhynix/ ...");
  await send("Page.navigate", { url: "https://control.jiwonova.com/skhynix/" });

  // Wait for initial page load
  await new Promise((r) => setTimeout(r, 6000));

  console.log("Clicking #navTabMultiSpan...");
  await evaluate(`
    (() => {
      const btn = document.getElementById("navTabMultiSpan");
      if (btn) btn.click();
    })()
  `);

  // Wait for multi-span data fetch & chart mounting
  await new Promise((r) => setTimeout(r, 6000));

  const multiSpanActive = await evaluate(`
    (() => {
      const ms = window.multiSpanTab;
      return Boolean(ms && ms.charts && Object.keys(ms.charts).length > 0 && ms.candlesData?.['1h']?.length > 0);
    })()
  `);
  console.log("MultiSpan charts ready:", multiSpanActive);

  // Perform click on 1h candle
  const clickInfo = await evaluate(`
    (() => {
      const ms = window.multiSpanTab;
      if (!ms) return { error: 'multiSpanTab not defined' };
      const bars1h = ms.candlesData?.['1h'] || [];
      if (bars1h.length === 0) return { error: 'No 1h bars loaded' };
      
      const pickIdx = Math.max(0, bars1h.length - 15);
      const targetCandle = bars1h[pickIdx];
      ms.handleChartClick('1h', { time: targetCandle.time });
      return { time: targetCandle.time, pickIdx };
    })()
  `);
  console.log("Clicked 1h candle:", clickInfo);

  // Wait for drilldown zoom and animation to settle
  await new Promise((r) => setTimeout(r, 2000));

  const testResults = await evaluate(`
    (() => {
      const ms = window.multiSpanTab;
      const targetCandleTime = ${clickInfo.time};
      const startT = targetCandleTime;
      const endT = startT + 3600;

      const checkSpan = (spanId) => {
        const chart = ms.charts[spanId];
        const bars = ms.candlesData?.[spanId] || [];
        if (!chart) return { spanId, error: 'no chart' };
        if (bars.length === 0) return { spanId, error: 'no bars' };

        const range = chart.timeScale().getVisibleLogicalRange();
        if (!range) return { spanId, error: 'no range' };

        const lStart = ms.getLogicalIndexForTime(spanId, startT);
        const lEnd = ms.getLogicalIndexForTime(spanId, endT);
        const vStart = lStart !== null ? (lStart - 0.5) : 0;
        const vEnd = lEnd !== null ? Math.max(vStart + 1, lEnd - 0.5) : 1;
        const rangeBars = Math.max(1, vEnd - vStart);
        const chartWidth = range.to - range.from;
        const ratio = rangeBars / chartWidth;
        const centerTarget = (vStart + vEnd) / 2;
        const centerLogical = (range.from + range.to) / 2;
        const centerDiff = Math.abs(centerLogical - centerTarget);

        const hl = document.getElementById('msRangeHighlight_' + spanId);
        let hlStyle = null;
        if (hl) {
          hlStyle = {
            display: hl.style.display,
            left: hl.style.left,
            width: hl.style.width
          };
        }

        return {
          spanId,
          range,
          vStart,
          vEnd,
          rangeBars,
          chartWidth,
          ratio,
          centerDiff,
          hlStyle
        };
      };

      return {
        spans: [
          checkSpan('15m'),
          checkSpan('5m'),
          checkSpan('1s')
        ]
      };
    })()
  `);

  console.log("Evaluation Results:", JSON.stringify(testResults, null, 2));

  let failed = false;
  if (!testResults?.spans || testResults.spans.length === 0) {
    console.error("FAILURE: No spans returned in testResults:", testResults);
    failed = true;
  } else {
    for (const span of testResults.spans) {
      if (span.error) {
        console.error(`Error in span ${span.spanId}:`, span.error);
        failed = true;
        continue;
      }
      console.log(`Span [${span.spanId}]: ratio = ${(span.ratio * 100).toFixed(2)}% | center diff = ${span.centerDiff.toFixed(4)} | hl width = ${span.hlStyle?.width} | hl left = ${span.hlStyle?.left}`);
      if (Math.abs(span.ratio - 0.80) > 0.02) {
        console.error(`FAILURE: Span ${span.spanId} ratio ${span.ratio} is not 80%!`);
        failed = true;
      }
      if (span.centerDiff > 0.05) {
        console.error(`FAILURE: Span ${span.spanId} centerDiff ${span.centerDiff} is not centered!`);
        failed = true;
      }
    }
  }

  cleanup();
  if (failed) process.exit(1);
  console.log("\n>>> LIVE VERIFICATION PASSED: All finer charts occupy exactly 80% width and are centered! <<<");
  process.exit(0);
}

run().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
