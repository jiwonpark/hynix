(function () {
  "use strict";

  function namespaceFragment(fragment, prefix, stripHandlers) {
    if (prefix) {
      fragment.querySelectorAll("[id]").forEach((element) => {
        element.id = `${prefix}${element.id}`;
      });
      fragment.querySelectorAll("[for]").forEach((element) => {
        element.setAttribute("for", `${prefix}${element.getAttribute("for")}`);
      });
      fragment.querySelectorAll("[aria-controls]").forEach((element) => {
        element.setAttribute("aria-controls", `${prefix}${element.getAttribute("aria-controls")}`);
      });
    }
    if (stripHandlers) {
      fragment.querySelectorAll("[onclick],[onchange],[oninput]").forEach((element) => {
        ["onclick", "onchange", "oninput"].forEach((attribute) => element.removeAttribute(attribute));
      });
    }
    return fragment;
  }

  function renderTerminal(template, target, options) {
    const fragment = namespaceFragment(
      template.content.cloneNode(true), options.prefix || "", Boolean(options.stripHandlers)
    );
    if (options.venue && options.venue.toLowerCase().includes("lighter")) {
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        walker.currentNode.nodeValue = walker.currentNode.nodeValue
          .replace(/Binance Total Equity/g, "Lighter Account Equity")
          .replace(/Binance Wallet Split/g, "Lighter Collateral Breakdown")
          .replace(/BINANCE FUTURES LIVE ENGINE/g, "LIGHTER DEX LIVE ENGINE")
          .replace(/Syncing with Binance Futures\.\.\./g, "Syncing with Lighter DEX...")
          .replace(/LIVE BINANCE EXECUTION/g, "LIGHTER DEX LIVE ENGINE")
          .replace(/Binance Collateral/g, "Lighter Collateral")
          .replace(/Binance/g, "Lighter")
          .replace(/BINANCE/g, "LIGHTER");
      }
    }
    target.replaceChildren(fragment);
    target.dataset.terminalInstance = options.venue;
  }

  function movingAverage(bars, windowSize) {
    if (!Array.isArray(bars) || windowSize < 1) return [];
    let rolling = 0;
    return bars.map((bar, index) => {
      rolling += Number(bar.value);
      if (index >= windowSize) rolling -= Number(bars[index - windowSize].value);
      if (index < windowSize - 1) return null;
      return { time: bar.time, value: rolling / windowSize };
    }).filter(Boolean);
  }

  function movingAverageDiff(maFast, maSlow) {
    if (!Array.isArray(maFast) || !Array.isArray(maSlow)) return [];
    const slowMap = new Map();
    for (let i = 0; i < maSlow.length; i++) {
      const item = maSlow[i];
      if (item && item.time !== undefined) {
        slowMap.set(item.time, item.value);
      }
    }
    const result = [];
    for (let i = 0; i < maFast.length; i++) {
      const fast = maFast[i];
      if (!fast || fast.time === undefined) continue;
      const slowVal = slowMap.get(fast.time);
      if (slowVal !== undefined && Number.isFinite(fast.value) && Number.isFinite(slowVal)) {
        const diff = fast.value - slowVal;
        result.push({
          time: fast.time,
          value: diff,
          color: diff >= 0 ? "rgba(22, 163, 74, 0.75)" : "rgba(220, 38, 38, 0.75)",
        });
      }
    }
    return result;
  }

  // Only signals that actually produced simulated inventory may link to exits.
  // Other qualifying candles remain standalone condition markers.
  function replaySignalLinks(data) {
    const links = new Map();
    (data.trades || []).forEach((trade, index) => {
      links.set(`${Number(trade.entry_time)}:${Number(trade.side)}`, {
        pairKey: `backtest:${index}`, is_simulated_fill: true,
        exit_price: trade.exit, pnl_pct: trade.pnl_pct,
      });
    });
    (data.open_positions || []).forEach((entry, index) => {
      links.set(`${Number(entry.entry_time)}:${Number(entry.side)}`, {
        pairKey: `backtest:open:${entry.entry_time}:${index}`, is_simulated_fill: true,
        is_open: true, unrealized_pnl_pct: entry.unrealized_pnl_pct,
      });
    });
    return links;
  }

  function alignTime(bars, timestampSeconds) {
    if (!Array.isArray(bars) || !bars.length) return timestampSeconds;
    return bars.reduce((best, bar) => (
      Math.abs(bar.time - timestampSeconds) < Math.abs(best.time - timestampSeconds) ? bar : best
    )).time;
  }

  function getCachedCandles(key) {
    try {
      const raw = localStorage.getItem(`skhynix_candles_${key}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.bars) && parsed.bars.length > 0) return parsed.bars;
    } catch (_) {}
    return null;
  }

  function setCachedCandles(key, bars) {
    try {
      if (!Array.isArray(bars) || !bars.length) return;
      const slice = bars.slice(-500);
      localStorage.setItem(`skhynix_candles_${key}`, JSON.stringify({
        saved_at: Date.now(),
        bars: slice
      }));
    } catch (_) {}
  }

  function renderAll() {
    const trading = document.getElementById("tabContentTrading");
    const lighter = document.getElementById("tabContentLighter");
    const crypto = document.getElementById("tabContentCrypto");
    const lighterCrypto = document.getElementById("tabContentLighterCrypto");
    const template = document.getElementById("tradingTerminalTemplate");
    if (!trading || !lighter || !template) throw new Error("Trading terminal template hosts are missing");

    renderTerminal(template, trading, { venue: "binance", prefix: "", stripHandlers: false });
    renderTerminal(template, lighter, { venue: "lighter", prefix: "lighter_", stripHandlers: true });
    if (crypto) {
      renderTerminal(template, crypto, { venue: "crypto", prefix: "crypto_", stripHandlers: true });
    }
    if (lighterCrypto) {
      renderTerminal(template, lighterCrypto, { venue: "lighterCrypto", prefix: "lighterCrypto_", stripHandlers: true });
    }
  }

  const TerminalCommon = { alignTime, movingAverage, movingAverageDiff, replaySignalLinks, namespaceFragment, renderTerminal, getCachedCandles, setCachedCandles };
  if (typeof window !== "undefined") {
    window.TerminalCommon = TerminalCommon;
    if (typeof document !== "undefined" && document.getElementById("tradingTerminalTemplate")) {
      renderAll();
    }
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = TerminalCommon;
  }
})();
