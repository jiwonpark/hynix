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

  class Pane {
    constructor(host, sourceChart, charts) {
      this.sourceChart = sourceChart;
      const shell = document.createElement("section");
      shell.id = "heldPairPnlPane";
      shell.style.cssText = "border-top:1px solid #e2e8f0;padding:10px 0 0;background:#fff;";
      shell.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;padding:0 12px;font-size:12px">
        <strong>HELD PAIR P&amp;L · USD</strong><strong id="heldPairLivePnl">Waiting for positions…</strong></div>
        <div id="heldPairBasis" style="padding:5px 12px;font-size:11px;color:#475569"></div>
        <div style="padding:0 12px 6px;font-size:11px;color:#64748b">Premium above: ADR / Korean domestic price. P&amp;L below: the contracts you hold. Historical line revalues current quantities and average entries at candle prices; it is not past account equity. Fees and funding excluded.</div>
        <div id="heldPairPnlHover" style="padding:0 12px;min-height:18px;font-size:11px;color:#475569"></div>
        <div id="heldPairPnlChart" style="height:180px;width:100%"></div>`;
      host.insertAdjacentElement("afterend", shell);
      this.liveLabel = shell.querySelector("#heldPairLivePnl");
      this.basisLabel = shell.querySelector("#heldPairBasis");
      this.hoverLabel = shell.querySelector("#heldPairPnlHover");
      this.host = shell.querySelector("#heldPairPnlChart");
      this.chart = charts.createChart(this.host, {
        height: 180, layout: {background: {color: "#ffffff"}, textColor: "#475569"},
        grid: {vertLines: {visible: false}, horzLines: {color: "#f1f5f9"}},
        rightPriceScale: {borderVisible: false, scaleMargins: {top: .15, bottom: .15}},
        timeScale: {visible: false, borderVisible: false},
        localization: {priceFormatter: usd},
        crosshair: {mode: charts.CrosshairMode.Normal},
      });
      this.series = this.chart.addLineSeries({color: "#0f766e", lineWidth: 1,
        priceLineVisible: false, lastValueVisible: true,
        priceFormat: {type: "custom", minMove: .01, formatter: usd}});
      this.series.createPriceLine({price: 0, color: "#94a3b8", lineWidth: 1,
        lineStyle: charts.LineStyle.Dashed, axisLabelVisible: true, title: "B/E"});
      this.points = new Map();
      let syncing = false;
      const sync = (target, range) => {
        if (syncing || !range) return;
        syncing = true;
        try { target.timeScale().setVisibleLogicalRange(range); } finally { syncing = false; }
      };
      sourceChart.timeScale().subscribeVisibleLogicalRangeChange(range => sync(this.chart, range));
      this.chart.timeScale().subscribeVisibleLogicalRangeChange(range => sync(sourceChart, range));
      const hover = param => {
        this.hoverTime = param?.time;
        this.renderHover();
      };
      this.renderHover = () => {
        const point = this.points.get(this.hoverTime);
        this.hoverLabel.textContent = point && Number.isFinite(point.value)
          ? `At chart prices · ADR ${usd(point.adrPnl)} · Hedge ${usd(point.hedgePnl)} · Pair ${usd(point.value)}` : "";
      };
      sourceChart.subscribeCrosshairMove(hover);
      this.chart.subscribeCrosshairMove(hover);
      this.resizeObserver = new ResizeObserver(() => {
        if (this.host.clientWidth) this.chart.applyOptions({width: this.host.clientWidth});
      });
      this.resizeObserver.observe(this.host);
    }

    update(bars, status) {
      const position = snapshot(status);
      const basis = position ? JSON.stringify([position.adr.symbol, position.adr.qty, position.adr.entry,
        position.hedge.symbol, position.hedge.qty, position.hedge.entry]) : null;
      if (bars !== this.lastBars || basis !== this.lastBasis) {
        const points = revalue(bars || [], position);
        this.points = new Map(points.map(point => [point.time, point]));
        this.series.setData(points.map(({time, value}) => Number.isFinite(value) ? {time, value} : {time}));
        this.lastBars = bars;
        this.lastBasis = basis;
        this.renderHover();
        const range = this.sourceChart.timeScale().getVisibleLogicalRange();
        if (range && points.length) this.chart.timeScale().setVisibleLogicalRange(range);
      }
      this.liveLabel.textContent = position ? `Live mark-price P&L ${usd(position.live)}`
        : status?.authenticated ? "No complete held pair" : "Live positions unavailable";
      this.liveLabel.style.color = position ? (position.live >= 0 ? "#15803d" : "#dc2626") : "#64748b";
      this.basisLabel.textContent = position ? [position.adr, position.hedge].map(p =>
        `${p.qty < 0 ? "Short" : "Long"} ${Math.abs(p.qty)} ${p.symbol} · average entry $${p.entry.toFixed(4)}`).join(" / ") : "";
    }
  }
  return {snapshot, revalue, Pane};
});
