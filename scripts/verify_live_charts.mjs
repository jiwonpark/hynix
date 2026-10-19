import { spawn } from "node:child_process";
import fs from "node:fs";

async function run() {
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new",
    "--remote-debugging-port=9222",
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1600,1200",
    "about:blank",
  ]);

  let wsUrl = null;
  chrome.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    const m = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:9222\/[^\s]+)/);
    if (m && !wsUrl) wsUrl = m[1];
  });

  const start = Date.now();
  while (!wsUrl && Date.now() - start < 10000) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!wsUrl) {
    chrome.kill();
    throw new Error("Could not get Chrome DevTools WebSocket URL");
  }

  const target = await fetch("http://127.0.0.1:9222/json/new", { method: "PUT" }).then((r) => r.json());
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
    { name: "backtest", navId: "navTabBacktest", hostId: "chartSvg", getBars: "(window.dailyData?.length || 1)" },
    { name: "trading", navId: "navTabTrading", hostId: "shortTermSpreadChartHost", getBars: "window.tradingEngine?.shortTermHistory?.bars?.length" },
    { name: "lighter", navId: "navTabLighter", hostId: "lighter_shortTermSpreadChartHost", getBars: "window.lighterEngine?.bars?.length" },
    { name: "crypto", navId: "navTabCrypto", hostId: "crypto_shortTermSpreadChartHost", getBars: "window.cryptoEngine?.bars?.length" },
    { name: "lighterCrypto", navId: "navTabLighterCrypto", hostId: "lighterCrypto_shortTermSpreadChartHost", getBars: "window.lighterCryptoEngine?.bars?.length" },
  ];

  const failures = [];

  for (const t of tabs) {
    console.log(`\n=================== SWITCHING TO TAB: ${t.name.toUpperCase()} ===================`);
    await evaluate(`switchMainTab("${t.name}")`);
    await new Promise((r) => setTimeout(r, 6000));

    const diag = await evaluate(`(() => {
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
      return {
        tab: "${t.name}",
        activeTabDisplay: document.getElementById("tabContent" + "${t.name.charAt(0).toUpperCase() + t.name.slice(1)}")?.style.display,
        hostExists: !!host,
        hostWidth: host?.clientWidth,
        hostHeight: host?.clientHeight,
        canvasCount: canvases.length,
        canvases: canvasDetails,
        bars: ${t.getBars || "null"}
      };
    })()`);

    console.log("Tab Diagnostic:", JSON.stringify(diag, null, 2));
    await captureScreenshot(`/tmp/live_${t.name}.png`);

    if (!diag.hostExists) {
      failures.push(`Tab ${t.name}: host ${t.hostId} not found`);
    } else if (diag.canvasCount === 0) {
      failures.push(`Tab ${t.name}: 0 canvases rendered in ${t.hostId}`);
    } else if (!diag.canvases.some(c => c.hasContent === true)) {
      failures.push(`Tab ${t.name}: all canvases empty`);
    } else if (typeof diag.bars === "number" && diag.bars <= 0) {
      failures.push(`Tab ${t.name}: bars count is ${diag.bars}`);
    } else {
      console.log(`>>> TAB ${t.name.toUpperCase()} CHART VERIFIED HEALTHY (bars: ${diag.bars}) <<<`);
    }
  }

  if (failures.length > 0) {
    console.error("\n❌ CHART VERIFICATION FAILED FOR:", failures);
    throw new Error(`Chart verification failed: ${failures.join("; ")}`);
  }


  ws.close();
  chrome.kill();
  console.log("\n=== ALL TABS DIAGNOSED ===");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
