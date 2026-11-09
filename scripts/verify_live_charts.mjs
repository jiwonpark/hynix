import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function run() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hynix-chart-verify-"));
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

  const cleanup = () => {
    try { chrome.kill(); } catch (_) {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  let wsUrl = null;
  let port = null;
  const handleChunk = (chunk) => {
    const text = chunk.toString();
    const m = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]+)/);
    if (m && !wsUrl) {
      wsUrl = m[1];
      port = m[2];
    }
  };
  chrome.stderr.on("data", handleChunk);
  chrome.stdout.on("data", handleChunk);

  const start = Date.now();
  const portFile = path.join(profile, "DevToolsActivePort");
  while ((!port || !wsUrl) && Date.now() - start < 10000) {
    if (fs.existsSync(portFile)) {
      try {
        const lines = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
        if (lines[0] && lines[1]) {
          port = lines[0].trim();
          wsUrl = `ws://127.0.0.1:${port}${lines[1].trim()}`;
          break;
        }
      } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!wsUrl || !port) {
    cleanup();
    throw new Error("Could not get Chrome DevTools WebSocket URL");
  }

  const target = await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT" }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.onopen = resolve);

  const runtimeExceptions = [];
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
      runtimeExceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
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

  // Reproduce a returning user whose chart and enclosing terminal were collapsed.
  await send("Page.addScriptToEvaluateOnNewDocument", {source: `
    localStorage.setItem("skhynix_active_tab", "lighterCrypto");
    localStorage.setItem("hynix_collapse_lighterCrypto_shortTermExecutionSection", "1");
    localStorage.setItem("hynix_collapse_lighterCrypto_secExecutionTerminal", "1");
  `});
  console.log("Navigating to https://control.jiwonova.com/skhynix/ ...");
  await send("Page.navigate", { url: process.env.HYPERION_VERIFY_URL || "https://control.jiwonova.com/skhynix/" });

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
    { name: "backtest", navId: "navTabBacktest", hostId: "chartSvg", engine: "window", series: "spreadSeries?.value", chart: "spreadChart", data: "spreadSeries?.value?.data?.()" },
    { name: "trading", navId: "navTabTrading", hostId: "shortTermSpreadChartHost", engine: "window.tradingEngine", series: "shortTermSeries", chart: "shortTermChart", data: "shortTermHistory?.bars" },
    { name: "lighter", navId: "navTabLighter", hostId: "lighter_shortTermSpreadChartHost", engine: "window.lighterEngine", series: "series", chart: "chart", data: "bars" },
    { name: "crypto", navId: "navTabCrypto", hostId: "crypto_shortTermSpreadChartHost", engine: "window.cryptoEngine", series: "series", chart: "chart", data: "bars" },
    { name: "lighterCrypto", navId: "navTabLighterCrypto", hostId: "lighterCrypto_shortTermSpreadChartHost", engine: "window.lighterCryptoEngine", series: "series", chart: "chart", data: "bars" },
  ];

  const failures = [];

  try {
    const requestedTabs = process.env.HYPERION_VERIFY_TABS?.split(",");
    for (const t of tabs.filter(t => !requestedTabs || requestedTabs.includes(t.name))) {
      console.log(`\n=================== SWITCHING TO TAB: ${t.name.toUpperCase()} ===================`);
      await evaluate(`switchMainTab("${t.name}")`);
      let diag = null;
      let firstChartMs = null;
      let firstAccountMs = null;
      const pollStart = Date.now();
      const pollTimeoutMs = t.name === "lighterCrypto" ? 60000 : 45000;

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
            accountReady: Number.isFinite(engine?.liveVenue?.collateral) && engine?.liveVenue?.authenticated === true,
            accountSourceTime: engine?.liveVenue?.server_time_ms || null,
            accountError: engine?.liveVenue?.error || null,
            collapsedAncestors: host ? Array.from(document.querySelectorAll(".is-collapsed")).filter(node => node.contains(host)).map(node => node.id) : [],
            lastCandleTime: bars.at(-1)?.time || null,
            chartSource: document.getElementById("${t.name === "lighterCrypto" ? "lighterCrypto_" : t.name === "crypto" ? "crypto_" : t.name === "lighter" ? "lighter_" : ""}lblShortTermChartSync")?.textContent,
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

        if (isHealthy && firstChartMs === null) firstChartMs = Date.now() - pollStart;
        if (diag?.accountReady && firstAccountMs === null) firstAccountMs = Date.now() - pollStart;
        if (isHealthy && (t.name !== "lighterCrypto" || diag.accountReady)) break;
        await new Promise((r) => setTimeout(r, 600));
      }

      console.log("Cold-profile loading timings:", {tab: t.name, chartMs: firstChartMs, accountMs: firstAccountMs});
      console.log("Tab Diagnostic:", JSON.stringify(diag, null, 2));
      await evaluate(`document.getElementById("${t.hostId}")?.scrollIntoView({block: "center"})`);
      await new Promise(r => setTimeout(r, 200));
      await captureScreenshot(`/tmp/live_${t.name}.png`);

      if (process.env.HYPERION_VERIFY_INTERACTION === "1" && t.name !== "backtest" && diag?.seriesVisible) {
        const state = () => evaluate(`(() => {
          const e=${t.engine},c=e.shortTermChart||e.chart,s=e.shortTermSeries||e.series,h=document.getElementById('${t.hostId}');
          const b=e.shortTermHistory?.bars||e.bars||[],r=h.getBoundingClientRect(),v=b.at(-1)?.value;
          return {range:c.timeScale().getVisibleLogicalRange(),count:s.data().length,x:r.left+r.width*.6,y:r.top+r.height*.6,axisX:r.right-20,
            pointerTarget:document.elementFromPoint(r.left+r.width*.6,r.top+r.height*.6)?.outerHTML?.slice(0,200),handleScroll:c.options().handleScroll,
            priceSpan:s.priceToCoordinate(v*1.001)-s.priceToCoordinate(v),
            guides:Object.fromEntries(Object.entries(e.shortTermMaExtremumHoverSeries||e.maExtremumHoverSeries||{}).map(([k,g])=>[k,g.data()])),
            follower:e.assetChart?.timeScale().getVisibleLogicalRange()||e.shortTermAssetChart?.timeScale().getVisibleLogicalRange()};
        })()`);
        const before=await state();
        await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:before.x,y:before.y});
        await new Promise(r=>setTimeout(r,150));
        const hovered=await state();
        if(Math.abs(hovered.range.from-before.range.from)>.01 || Math.abs(hovered.range.to-before.range.to)>.01 || hovered.count!==before.count)
          failures.push(`${t.name}: hovering changed price data or time range`);
        if(!Object.keys(hovered.guides).length)failures.push(`${t.name}: pivot renderer was not attached`);
        await captureScreenshot(`/tmp/pivot_hover_${t.name}.png`);
        await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:before.x,y:before.y,deltaX:0,deltaY:-120});
        await new Promise(r=>setTimeout(r,180));
        const zoomed=await state();
        if(Math.abs((zoomed.range.to-zoomed.range.from)-(before.range.to-before.range.from))<.01)failures.push(`${t.name}: wheel zoom did not work`);
        await send('Input.dispatchMouseEvent',{type:'mousePressed',x:before.x,y:before.y,button:'left',buttons:1,clickCount:1});
        for (let distance=10;distance<=80;distance+=10) {
          await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:before.x-distance,y:before.y,buttons:1});
          await new Promise(r=>setTimeout(r,40));
        }
        await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:before.x-80,y:before.y,button:'left',buttons:0,clickCount:1});
        await new Promise(r=>setTimeout(r,150));
        const dragged=await state();
        if(Math.abs(dragged.range.from-zoomed.range.from)<.01)failures.push(`${t.name}: drag pan did not work`);
        if(dragged.follower && (Math.abs(dragged.follower.from-dragged.range.from)>.05 || Math.abs(dragged.follower.to-dragged.range.to)>.05))
          failures.push(`${t.name}: linked pane lost time-range sync`);
        await send('Input.dispatchMouseEvent',{type:'mousePressed',x:before.axisX,y:before.y,button:'left',buttons:1,clickCount:1});
        await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:before.axisX,y:before.y+60,button:'left',buttons:1});
        await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:before.axisX,y:before.y+60,button:'left',buttons:0,clickCount:1});
        await new Promise(r=>setTimeout(r,150));
        const scaled=await state();
        if(Math.abs(scaled.priceSpan-dragged.priceSpan)<.01)failures.push(`${t.name}: price-axis scaling did not work`);
        await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:before.x,y:before.y});
        await new Promise(r=>setTimeout(r,150));
        await captureScreenshot(`/tmp/pivot_scaled_${t.name}.png`);
        await evaluate(`(()=>{const e=${t.engine},c=e.shortTermChart||e.chart;c.priceScale('right').applyOptions({autoScale:true});c.timeScale().setVisibleLogicalRange(${JSON.stringify(before.range)});})()`);
        await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:10});
        await new Promise(r=>setTimeout(r,100));
        const left=await state();
        if(Object.values(left.guides).some(g=>g.length))failures.push(`${t.name}: pivot guides remain after pointer leaves chart`);
        console.log('INTERACTION',JSON.stringify({tab:t.name,rangeBefore:before.range,rangeAfterHover:hovered.range,guideCounts:Object.fromEntries(Object.entries(hovered.guides).map(([k,v])=>[k,v.length])),zoomed:zoomed.range,dragged:dragged.range,linked:dragged.follower,priceSpanBefore:dragged.priceSpan,priceSpanAfter:scaled.priceSpan,cleared:Object.values(left.guides).every(g=>!g.length)}));
      }
      if (t.name === "lighterCrypto" && !diag?.accountReady) failures.push("Tab lighterCrypto: real account data did not load");
      if (!diag?.hostExists) {
        failures.push(`Tab ${t.name}: host ${t.hostId} not found`);
      } else if (t.svg ? !diag.svgVisible : !diag.seriesVisible || !diag.canvases.some(c => c.hasContent === true)) {
        failures.push(`Tab ${t.name}: price series is missing or outside the visible chart (bars: ${diag.bars})`);
      } else {
        console.log(`>>> TAB ${t.name.toUpperCase()} CHART VERIFIED HEALTHY (bars: ${diag.bars}) <<<`);
      }
    }

    if (runtimeExceptions.length) failures.push(...runtimeExceptions.map(e => `Browser exception: ${e}`));
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
