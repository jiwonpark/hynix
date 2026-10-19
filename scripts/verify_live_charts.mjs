import { spawn } from "node:child_process";
import fs from "node:fs";

async function run() {
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1600,1200",
    "about:blank",
  ]);

  const cleanup = () => {
    try { chrome.kill(); } catch (_) {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  let wsUrl = null;
  let port = null;
  chrome.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    const m = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]+)/);
    if (m && !wsUrl) {
      wsUrl = m[1];
      port = m[2];
    }
  });

  const start = Date.now();
  while (!wsUrl && Date.now() - start < 10000) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!wsUrl || !port) {
    cleanup();
    throw new Error("Could not get Chrome DevTools WebSocket URL");
  }

  const target = await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT" }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.onopen = resolve);

  let idCounter = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const args = msg.params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a)).join(" ");
      console.log(`[BROWSER CONSOLE ${msg.params.type}] ${args}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      console.error("[BROWSER EXCEPTION]", msg.params.exceptionDetails.text, msg.params.exceptionDetails.exception?.description);
    }
    if (msg.method === "Network.responseReceived") {
      const { url, status, statusText } = msg.params.response;
      if (url.includes("/api/")) {
        console.log(`[BROWSER NETWORK] ${status} ${statusText} -> ${url}`);
      }
    }
    if (msg.method === "Network.requestWillBeSent") {
      const { url, method } = msg.params.request;
      if (url.includes("/api/")) console.log("[BROWSER REQUEST]", method, url, msg.params.requestId);
    }
    if (msg.method === "Network.loadingFailed") {
      console.error("[BROWSER NETWORK FAILED]", msg.params.errorText, msg.params.requestId);
    }
  };

  function send(method, params = {}) {
    const id = idCounter++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  console.log("Navigating to https://control.jiwonova.com/skhynix/ ...");
  await send("Page.navigate", { url: "https://control.jiwonova.com/skhynix/" });

  await new Promise((r) => setTimeout(r, 5000));

  async function evaluate(expression) {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.result?.value;
  }

  async function captureScreenshot(filepath) {
    const res = await send("Page.captureScreenshot", { format: "png" });
    if (res.result?.data) {
      fs.writeFileSync(filepath, Buffer.from(res.result.data, "base64"));
      console.log(`Saved screenshot to ${filepath}`);
    }
  }

  const tabs = [
    { name: "backtest", navId: "navTabBacktest", hostId: "chartSvg", svg: true },
    { name: "trading", navId: "navTabTrading", hostId: "shortTermSpreadChartHost", engine: "window.tradingEngine", series: "shortTermSeries", chart: "shortTermChart", data: "shortTermHistory?.bars" },
    { name: "lighter", navId: "navTabLighter", hostId: "lighter_shortTermSpreadChartHost", engine: "window.lighterEngine", series: "series", chart: "chart", data: "bars" },
    { name: "crypto", navId: "navTabCrypto", hostId: "crypto_shortTermSpreadChartHost", engine: "window.cryptoEngine", series: "series", chart: "chart", data: "bars" },
    { name: "lighterCrypto", navId: "navTabLighterCrypto", hostId: "lighterCrypto_shortTermSpreadChartHost", engine: "window.lighterCryptoEngine", series: "series", chart: "chart", data: "bars" },
  ];

  const failures = [];

  try {
    for (const t of tabs) {
      console.log(`\n=================== SWITCHING TO TAB: ${t.name.toUpperCase()} ===================`);
      await evaluate(`switchMainTab("${t.name}")`);
      let diag = null;
      const pollStart = Date.now();
      const pollTimeoutMs = 45000;

      while (Date.now() - pollStart < pollTimeoutMs) {
        diag = await evaluate(`(() => {
          const host = document.getElementById("${t.hostId}");
          const canvases = host ? host.querySelectorAll("canvas") : [];
          const canvasDetails = Array.from(canvases).map(c => ({
            width: c.width,
            height: c.height,
            hasContent: (() => {
              try {
                const ctx = c.getContext("2d");
                if (!ctx) return false;
                const imgData = ctx.getImageData(0, 0, Math.min(c.width, 200), Math.min(c.height, 200));
                return imgData.data.some((p, i) => i % 4 === 3 && p > 0);
              } catch(e) { return "error: " + e.message; }
            })()
          }));
          const engine = ${t.engine || "null"};
          const bars = engine?.${t.data || "bars"} || [];
          const series = engine?.${t.series || "series"};
          const chart = engine?.${t.chart || "chart"};
          const range = chart?.timeScale().getVisibleLogicalRange();
          const index = Math.max(0, Math.min(bars.length - 1, Math.floor(((range?.from || 0) + (range?.to || 0)) / 2)));
          const point = series?.dataByIndex?.(index);
          const price = Number(point?.value ?? point?.close);
          const x = point ? chart?.timeScale().timeToCoordinate(point.time) : null;
          const y = Number.isFinite(price) ? series?.priceToCoordinate(price) : null;
          const seriesVisible = bars.length > 1 && Number.isFinite(x) && Number.isFinite(y)
            && x >= 0 && x <= host?.clientWidth && y >= 0 && y <= host?.clientHeight;
          const svgVisible = ${!!t.svg} && !!host?.querySelector('path[d]')
            && (host?.querySelectorAll('text').length || 0) > 1;
          return {
            seriesVisible, svgVisible, price: Number.isFinite(price) ? price : null, x, y,
            tab: "${t.name}",
            activeTabDisplay: document.getElementById("tabContent" + "${t.name.charAt(0).toUpperCase() + t.name.slice(1)}")?.style.display,
            hostExists: !!host,
            hostWidth: host?.clientWidth,
            hostHeight: host?.clientHeight,
            canvasCount: canvases.length,
            canvases: canvasDetails,
            bars: bars.length
          };
        })()`);

        const isHealthy = diag && diag.hostExists && diag.hostWidth > 0 && diag.hostHeight > 0 &&
          (t.svg ? diag.svgVisible : diag.seriesVisible && diag.canvases.some(c => c.hasContent === true));

        if (isHealthy) {
          break;
        }
        await new Promise((r) => setTimeout(r, 600));
      }

      console.log("Tab Diagnostic:", JSON.stringify(diag, null, 2));
      await evaluate(`document.getElementById("${t.hostId}")?.scrollIntoView({block: "center"})`);
      await new Promise(r => setTimeout(r, 200));
      await captureScreenshot(`/tmp/live_${t.name}.png`);

      if (!diag.hostExists) {
        failures.push(`Tab ${t.name}: host ${t.hostId} not found`);
      } else if (t.svg ? !diag.svgVisible : !diag.seriesVisible || !diag.canvases.some(c => c.hasContent === true)) {
        failures.push(`Tab ${t.name}: price series is missing or outside the visible chart (bars: ${diag.bars})`);      } else {
        console.log(`>>> TAB ${t.name.toUpperCase()} CHART VERIFIED HEALTHY (bars: ${diag.bars}) <<<`);
      }
    }

    if (failures.length > 0) {
      console.error("\n❌ CHART VERIFICATION FAILED FOR:", failures);
      throw new Error(`Chart verification failed: ${failures.join("; ")}`);
    }

    console.log("\n=== ALL TABS DIAGNOSED ===");
  } finally {
    try { ws.close(); } catch (_) {}
    cleanup();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
