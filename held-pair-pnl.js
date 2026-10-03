(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HeldPairPnl = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const usd = value => Number.isFinite(value) ? `${value < 0 ? "−" : "+"}$${Math.abs(value).toFixed(2)}` : "—";

  function snapshot(status) {
    if (!status?.authenticated) return null;
    const adr = status.adr_position, hedge = status.stock_position;
    if (adr?.symbol !== "SKHYUSDT" || !["CSOPSKHYNIX2LUSDT", "SKHYNIXUSDT"].includes(hedge?.symbol)) return null;
    const legs = [adr, hedge].map(p => ({symbol: p.symbol, qty: Number(p.position_amt), entry: Number(p.entry_price), mark: Number(p.mark_price)}));
    if (legs.some(p => !Number.isFinite(p.qty) || p.qty === 0 || !Number.isFinite(p.entry) || !(p.entry > 0) || !Number.isFinite(p.mark) || !(p.mark > 0))) return null;
    const [a, h] = legs;
    return {adr: a, hedge: h, live: a.qty * (a.mark - a.entry) + h.qty * (h.mark - h.entry)};
  }

  function revalue(bars, position) {
    if (!position) return [];
    return bars.map(bar => {
      const adr = Number(bar.adr);
      // Never substitute the domestic contract for a missing CSOP price.
      const hedge = position.hedge.symbol === "CSOPSKHYNIX2LUSDT"
        ? Number(bar.csop) : Number(bar.domestic) * 10;
      if (!Number.isFinite(adr) || !(adr > 0) || !Number.isFinite(hedge) || !(hedge > 0)) return {time: bar.time};
      const adrPnl = position.adr.qty * (adr - position.adr.entry);
      const hedgePnl = position.hedge.qty * (hedge - position.hedge.entry);
      return {time: bar.time, value: adrPnl + hedgePnl, adrPnl, hedgePnl};
    });
  }

  class Readout {
    constructor(host, chart) {
      this.chart = chart;
      const shell = document.createElement("section");
      shell.id = "heldPairPnlPane";
      shell.style.cssText = "padding:8px 12px;background:#fff;";
      shell.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;font-size:12px">
        <strong>PAIRED P&amp;L</strong><strong id="heldPairLivePnl">Waiting for positions…</strong></div>
        <div id="heldPairBasis" style="padding:5px 0;font-size:11px;color:#475569"></div>
        <div style="font-size:11px;color:#64748b">Main chart: ADR / Korean domestic premium (%). Selected-entry net P&amp;L uses paired ADR/ETF fills and costs, on its own dollar scale. Total held-pair figures exclude fees and funding.</div>
        <div style="font-size:11px;color:#475569"><label id="heldPairEntryLabel" style="display:none">Selected entry <select id="heldPairEntrySelect" aria-label="LIFO entry at selected candle"></select></label><span id="heldPairEntryNote"></span></div>
        <div id="heldPairPnlHover" style="min-height:18px;font-size:11px;color:#475569"></div>`;
      host.insertAdjacentElement("beforebegin", shell);
      this.liveLabel = shell.querySelector("#heldPairLivePnl");
      this.basisLabel = shell.querySelector("#heldPairBasis");
      this.hoverLabel = shell.querySelector("#heldPairPnlHover");
      this.points = new Map();
      chart.subscribeCrosshairMove(param => {
        this.hoverTime = param?.time;
        this.renderHover();
      });
    }

    renderHover() {
      const point = this.points.get(this.hoverTime);
      this.hoverLabel.textContent = point && Number.isFinite(point.value)
        ? `ADR ${usd(point.adrPnl)} · Hedge ${usd(point.hedgePnl)} · Pair ${usd(point.value)}` : "";
    }

    update(bars, status, interval = "5m", now = Date.now() / 1000) {
      const position = snapshot(status);
      const points = revalue(bars || [], position);
      const seconds = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}[interval];
      const last = points.at(-1);
      if (position && last && last.time <= now && now < last.time + seconds) {
        last.adrPnl = position.adr.qty * (position.adr.mark - position.adr.entry);
        last.hedgePnl = position.hedge.qty * (position.hedge.mark - position.hedge.entry);
        last.value = position.live;
      }
      this.points = new Map(points.map(point => [point.time, point]));
      this.renderHover();
      this.liveLabel.textContent = position ? `Live mark-price P&L ${usd(position.live)}`
        : status?.authenticated ? "No complete held pair" : "Live positions unavailable";
      this.liveLabel.style.color = position ? (position.live >= 0 ? "#15803d" : "#dc2626") : "#64748b";
      this.basisLabel.textContent = position ? [position.adr, position.hedge].map(p =>
        `${p.qty < 0 ? "Short" : "Long"} ${Math.abs(p.qty)} ${p.symbol} · average entry $${p.entry.toFixed(4)}`).join(" / ") : "";
    }
  }
  return {snapshot, revalue, Readout};
});
