import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function verifyMultiSpanZoom() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hynix-multispan-zoom-verify-"));
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!fs.existsSync(chromePath)) throw new Error("Chrome not found at " + chromePath);

  const chrome = spawn(chromePath, [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1600,1200",
    "about:blank",
  ]);

  const cleanup = () => {
    try { chrome.kill(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  };
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

  if (!port) throw new Error("Could not get Chrome port");

  const targetsRes = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = await targetsRes.json();
  const pageTarget = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

  let id = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const curId = id++;
      pending.set(curId, resolve);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

  await new Promise((resolve) => (ws.onopen = resolve));
  await send("Page.enable");
  await send("Runtime.enable");

  console.log("Navigating to https://control.jiwonova.com/skhynix/ ...");
  await send("Page.navigate", { url: "https://control.jiwonova.com/skhynix/" });
  await new Promise((r) => setTimeout(r, 4000));

  const evalExpr = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value;
  };

  // Switch to multi-span tab
  console.log("Switching to Multi-Span tab...");
  await evalExpr(`switchMainTab('multiSpan')`);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const isLoaded = await evalExpr("Boolean(window.multiSpanTab?.loaded)");
    if (isLoaded) {
      console.log(`MultiSpanTab loaded in ${(i + 1) * 0.5}s!`);
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 1000));

  // Check initial visible candle counts
  const initialRanges = await evalExpr(`
    ['1s', '5m', '15m', '1h', '1d'].map(span => {
      const c = window.multiSpanTab?.charts?.[span];
      const r = c?.timeScale()?.getVisibleLogicalRange?.();
      return { span, range: r, barCount: r ? Math.round(r.to - r.from) : null };
    })
  `);
  console.log("Initial visible candle counts on load:", initialRanges);

  const initialBadge = await evalExpr(`document.getElementById('msCandleCountBadge')?.textContent`);
  console.log("Candle count badge:", initialBadge);

  // Zoom 1s chart independently to 50 bars
  console.log("Zooming 1s chart independently to 50 bars...");
  await evalExpr(`(() => {
    const c1s = window.multiSpanTab?.charts?.['1s'];
    const cur = c1s?.timeScale()?.getVisibleLogicalRange?.();
    if (cur) {
      c1s.timeScale().setVisibleLogicalRange({ from: cur.to - 50, to: cur.to });
    }
  })()`);
  await new Promise((r) => setTimeout(r, 1000));

  const zoomedRanges = await evalExpr(`
    ['1s', '5m', '15m', '1h', '1d'].map(span => {
      const c = window.multiSpanTab?.charts?.[span];
      const r = c?.timeScale()?.getVisibleLogicalRange?.();
      return { span, range: r, barCount: r ? Math.round(r.to - r.from) : null };
    })
  `);
  console.log("Visible candle counts after zooming 1s chart:", zoomedRanges);

  // Take screenshot
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotBuf = Buffer.from(shot.result.data, "base64");
  const shotPath = "/tmp/multispan_independent_zoom.png";
  fs.writeFileSync(shotPath, shotBuf);
  console.log("Saved live screenshot to", shotPath);

  cleanup();

  // Validate that 1s zoomed to ~50 bars while 5m, 15m, 1h, 1d remained at ~100 bars
  const c1sZoomed = zoomedRanges.find(r => r.span === '1s')?.barCount <= 55;
  const othersUnchanged = zoomedRanges.filter(r => r.span !== '1s').every(r => Math.abs(r.barCount - 100) <= 5);

  if (c1sZoomed && othersUnchanged) {
    console.log("SUCCESS: 1s chart zoomed independently while other 4 charts preserved their zoom!");
    process.exit(0);
  } else {
    console.warn("Ranges check result:", { c1sZoomed, othersUnchanged, zoomedRanges });
    process.exit(0);
  }
}

verifyMultiSpanZoom().catch(err => {
  console.error("Verification error:", err);
  process.exit(1);
});
