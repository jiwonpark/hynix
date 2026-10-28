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

  function revealChartSection(section) {
    // Chart visibility is a viewing preference, never an execution permission.
    for (let node = section; node; node = node.parentElement) {
      if (!node.classList?.contains("collapsible-section")) continue;
      node.classList.remove("is-collapsed");
      const button = node.querySelector(":scope > .collapsible-header .section-collapse-btn");
      if (button) {
        button.disabled = false;
        button.setAttribute("aria-expanded", "true");
      }
      if (node.id) {
        try { localStorage.setItem(`hynix_collapse_${node.id}`, "0"); } catch (_) {}
      }
    }
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

  function exponentialMovingAverage(bars, period) {
    if (!Array.isArray(bars) || period < 1 || bars.length < period) return [];
    const values = bars.map((bar) => Number(bar?.value));
    if (values.some((value) => !Number.isFinite(value))) return [];
    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    const result = [{ time: bars[period - 1].time, value: ema }];
    for (let index = period; index < bars.length; index += 1) {
      ema = (values[index] - ema) * multiplier + ema;
      result.push({ time: bars[index].time, value: ema });
    }
    return result;
  }

  function macd(bars, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (!Array.isArray(bars) || fastPeriod < 1 || slowPeriod <= fastPeriod || signalPeriod < 1) {
      return { macd: [], signal: [], histogram: [] };
    }
    const fast = exponentialMovingAverage(bars, fastPeriod);
    const slow = exponentialMovingAverage(bars, slowPeriod);
    const fastByTime = new Map(fast.map((point) => [point.time, point.value]));
    const macdLine = slow.flatMap((point) => {
      const fastValue = fastByTime.get(point.time);
      return Number.isFinite(fastValue)
        ? [{ time: point.time, value: fastValue - point.value }]
        : [];
    });
    const signalLine = exponentialMovingAverage(macdLine, signalPeriod);
    const signalByTime = new Map(signalLine.map((point) => [point.time, point.value]));
    const histogram = macdLine.flatMap((point) => {
      const signalValue = signalByTime.get(point.time);
      if (!Number.isFinite(signalValue)) return [];
      const value = point.value - signalValue;
      return [{
        time: point.time,
        value,
        color: value >= 0 ? "rgba(22, 163, 74, 0.75)" : "rgba(220, 38, 38, 0.75)",
      }];
    });
    return { macd: macdLine, signal: signalLine, histogram };
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

  function singleLegPositionReference(positions, options = {}) {
    const symbol = String(options.symbol || "");
    const marketId = options.marketId == null ? null : String(options.marketId);
    const position = (Array.isArray(positions) ? positions : []).find((candidate) => {
      const matchesSymbol = symbol && String(candidate?.symbol || "") === symbol;
      const matchesMarket = marketId !== null && String(candidate?.market_id ?? "") === marketId;
      if (!matchesSymbol && !matchesMarket) return false;
      const raw = Number(candidate?.position_amt ?? candidate?.position ?? candidate?.size ?? 0);
      return Number.isFinite(raw) && Math.abs(raw) > 1e-12;
    });
    if (!position) return null;
    const raw = Number(position.position_amt ?? position.position ?? position.size ?? 0);
    const sign = Number(position.sign);
    const signedQty = Number.isFinite(sign) && sign !== 0
      ? Math.sign(sign) * Math.abs(raw) : raw;
    const entry = Number(position.avg_entry_price ?? position.entry_price ?? position.price ?? 0);
    if (!Number.isFinite(signedQty) || signedQty === 0 || !(entry > 0)) return null;
    return {
      position,
      signedQty,
      entry,
      direction: signedQty < 0 ? "short" : "long",
      isLong: signedQty > 0,
    };
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

  function bindSingleLegDirectionControl(prefix, onChange) {
    const select = document.getElementById(`${prefix}selLighterSpreadDirectionMode`);
    if (!select) return null;
    const label = select.parentElement?.querySelector("span");
    if (label) label.textContent = "Auto-entry direction:";
    select.title = "Saved live-bot condition for future automatic entries; exits and manual orders remain available";
    const current = ["two_way", "long_only", "short_only"].includes(select.dataset.serverValue)
      ? select.dataset.serverValue : "two_way";
    select.innerHTML = '<option value="two_way">Two-way (Long + Short)</option><option value="long_only">Long only</option><option value="short_only">Short only</option>';
    select.value = current;
    let status = document.getElementById(`${prefix}entryDirectionStatus`);
    if (!status) {
      status = document.createElement("span");
      status.id = `${prefix}entryDirectionStatus`;
      status.style.cssText = "font-size:9px;font-weight:800;color:#64748b;background:#f1f5f9;padding:2px 5px;border-radius:4px";
      status.textContent = "LIVE BOT · LOADING";
      select.parentElement?.appendChild(status);
    }
    if (!select.dataset.singleLegDirectionBound) {
      select.dataset.singleLegDirectionBound = "true";
      select.addEventListener("change", async () => {
        const requested = select.value;
        select.disabled = true;
        status.textContent = "LIVE BOT · SAVING…";
        const saved = await onChange(requested);
        select.disabled = false;
        if (saved === false) {
          select.value = select.dataset.serverValue || "two_way";
          status.textContent = "LIVE BOT · SAVE FAILED";
        }
      });
    }
    return select;
  }

  function syncSingleLegDirectionControl(prefix, mode) {
    const select = document.getElementById(`${prefix}selLighterSpreadDirectionMode`);
    const normalized = ["two_way", "long_only", "short_only"].includes(mode) ? mode : "two_way";
    if (!select) return;
    select.dataset.serverValue = normalized;
    if (document.activeElement !== select) select.value = normalized;
    const label = {two_way: "TWO-WAY", long_only: "LONG ONLY", short_only: "SHORT ONLY"}[normalized];
    const status = document.getElementById(`${prefix}entryDirectionStatus`);
    if (status) {
      const time = new Date().toLocaleTimeString("en-GB", {timeZone: "Asia/Seoul", hour12: false});
      status.textContent = `LIVE BOT · ${label} · ${time} KST`;
      status.title = "Authenticated bot configuration returned by the latest status response";
    }
  }

  const TerminalCommon = { revealChartSection, alignTime, movingAverage, movingAverageDiff, exponentialMovingAverage, macd, replaySignalLinks, namespaceFragment, renderTerminal, getCachedCandles, setCachedCandles, singleLegPositionReference, bindSingleLegDirectionControl, syncSingleLegDirectionControl };
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
