(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "skhynix_lighter_virtual_ledger_v1";

  async function api(path, options) {
    const prefixes = ["/skhynix", ""];
    let lastError;
    for (const prefix of prefixes) {
      try {
        const response = await fetch(`${prefix}${path}`, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("API unavailable");
  }

  const lighterEngine = {
    chart: null,
    series: null,
    currentRatio: null,
    entries: [],
    ledger: [],
    initialized: false,

    init() {
      if (this.initialized || !$('tabContentLighter')) return;
      this.initialized = true;
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        this.entries = Array.isArray(saved.entries) ? saved.entries : [];
        this.ledger = Array.isArray(saved.ledger) ? saved.ledger : [];
      } catch (_) {}
      $('lighterRefresh').addEventListener('click', () => this.refresh());
      $('lighterInterval').addEventListener('change', () => this.refreshChart());
      $('lighterRunBacktest').addEventListener('click', () => this.runBacktest());
      $('lighterVirtualEntry').addEventListener('click', () => this.addVirtualEntry());
      $('lighterVirtualExit').addEventListener('click', () => this.exitVirtual());
      $('lighterClearLedger').addEventListener('click', () => {
        this.entries = []; this.ledger = []; this.save(); this.renderLedger();
      });
      $('lighterLiveMode').addEventListener('click', () => {
        $('lighterExecutionMessage').textContent = 'Live orders remain unavailable until an official Lighter signer and account are configured on the server.';
      });
      this.renderLedger();
    },

    onTabActivated() {
      this.init();
      this.ensureChart();
      this.refresh();
      setTimeout(() => this.resize(), 80);
    },

    ensureChart() {
      if (this.chart || !window.LightweightCharts || !$('lighterChart')) return;
      const host = $('lighterChart');
      this.chart = LightweightCharts.createChart(host, {
        width: host.clientWidth, height: host.clientHeight,
        layout: { background: { color: '#ffffff' }, textColor: '#475569' },
        grid: { vertLines: { color: '#f1f5f9' }, horzLines: { color: '#f1f5f9' } },
        rightPriceScale: { borderColor: '#e2e8f0' },
        timeScale: { borderColor: '#e2e8f0', timeVisible: true },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      });
      this.series = this.chart.addLineSeries({ color: '#7c3aed', lineWidth: 2,
        priceFormat: { type: 'custom', formatter: (value) => `${value.toFixed(2)}%` } });
      window.addEventListener('resize', () => this.resize());
    },

    resize() {
      const host = $('lighterChart');
      if (host && this.chart) this.chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
    },

    async refresh() {
      this.init();
      $('lighterStatusText').textContent = 'Syncing';
      try {
        const [status] = await Promise.all([api('/api/lighter/status'), this.refreshChart()]);
        if (!status.success) throw new Error(status.error || 'Lighter unavailable');
        this.currentRatio = Number(status.parity_ratio);
        $('lighterAdrPrice').textContent = `$${Number(status.adr.mid).toFixed(2)}`;
        $('lighterDomesticPrice').textContent = `$${Number(status.domestic.mid).toFixed(3)}`;
        $('lighterAdrBook').textContent = `Bid ${status.adr.bid.toFixed(2)} / Ask ${status.adr.ask.toFixed(2)} · ${status.adr.spread_bps} bps`;
        $('lighterDomesticBook').textContent = `Bid ${status.domestic.bid.toFixed(3)} / Ask ${status.domestic.ask.toFixed(3)} · ${status.domestic.spread_bps} bps`;
        $('lighterParity').textContent = `${this.currentRatio.toFixed(3)}%`;
        $('lighterFees').textContent = `${(status.adr.maker_fee * 100).toFixed(2)}% / ${(status.adr.taker_fee * 100).toFixed(2)}%`;
        $('lighterExecutionMessage').textContent = status.execution_message;
        $('lighterStatusText').textContent = 'Market data live';
        $('lighterStatusDot').classList.add('ok');
        $('lighterLiveMode').disabled = !status.execution_enabled;
        $('lighterLiveMode').textContent = status.execution_enabled ? 'Live' : 'Live Locked';
        this.renderLedger();
      } catch (error) {
        $('lighterStatusText').textContent = 'Unavailable';
        $('lighterStatusDot').classList.remove('ok');
        $('lighterExecutionMessage').textContent = error.message;
      }
    },

    async refreshChart() {
      this.ensureChart();
      const interval = $('lighterInterval').value;
      const data = await api(`/api/lighter/parity?interval=${encodeURIComponent(interval)}&limit=300`);
      if (!data.success || !data.bars.length) throw new Error(data.error || 'No Lighter candles');
      this.series.setData(data.bars.map((bar) => ({ time: bar.time, value: bar.value })));
      this.chart.timeScale().fitContent();
      const first = data.bars[0].value, last = data.bars[data.bars.length - 1].value;
      $('lighterChartInfo').textContent = `${data.bars.length} bars · ${last >= first ? '+' : ''}${(last - first).toFixed(3)} pts`;
      this.currentRatio = Number(last);
    },

    async runBacktest() {
      const button = $('lighterRunBacktest');
      button.disabled = true;
      $('lighterBacktestSummary').textContent = 'Running…';
      try {
        const interval = $('lighterInterval').value;
        const entry = Number($('lighterEntryZ').value || 1.5);
        const exit = Number($('lighterExitZ').value || 0.25);
        const data = await api(`/api/lighter/backtest?interval=${encodeURIComponent(interval)}&limit=500&entry_z=${entry}&exit_z=${exit}`);
        const summary = data.summary;
        $('lighterBacktestSummary').innerHTML = `<strong>${summary.trades}</strong> trades · <strong>${summary.win_rate.toFixed(1)}%</strong> wins · net <strong class="${summary.net_pct >= 0 ? 'lighterMetricUp' : 'lighterMetricDown'}">${summary.net_pct >= 0 ? '+' : ''}${summary.net_pct.toFixed(3)}%</strong><div style="font-size:10px;color:#94a3b8;margin-top:4px;">${data.assumptions}</div>`;
      } catch (error) {
        $('lighterBacktestSummary').textContent = error.message;
      } finally { button.disabled = false; }
    },

    addVirtualEntry() {
      if (!Number.isFinite(this.currentRatio)) return;
      const notional = Math.max(10, Number($('lighterNotional').value || 1000));
      const entry = { time: Date.now(), ratio: this.currentRatio, notional,
        side: this.currentRatio >= 100 ? -1 : 1 };
      this.entries.push(entry);
      this.ledger.unshift({ ...entry, action: entry.side < 0 ? 'SHORT RATIO' : 'LONG RATIO', pnl: null });
      this.save(); this.renderLedger();
    },

    exitVirtual() {
      if (!this.entries.length || !Number.isFinite(this.currentRatio)) return;
      this.entries.forEach((entry) => {
        const pnl = entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio;
        this.ledger.unshift({ time: Date.now(), ratio: this.currentRatio, notional: entry.notional,
          action: 'EXIT', pnl });
      });
      this.entries = [];
      this.save(); this.renderLedger();
    },

    save() { localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: this.entries, ledger: this.ledger.slice(0, 100) })); },

    renderLedger() {
      const openPnl = this.entries.reduce((sum, entry) => sum + (Number.isFinite(this.currentRatio) ? entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio : 0), 0);
      const notional = this.entries.reduce((sum, entry) => sum + entry.notional, 0);
      $('lighterVirtualSummary').innerHTML = this.entries.length ? `${this.entries.length} open tranche(s) · $${notional.toFixed(0)} notional · unrealized <strong class="${openPnl >= 0 ? 'lighterMetricUp' : 'lighterMetricDown'}">${openPnl >= 0 ? '+' : ''}$${openPnl.toFixed(2)}</strong>` : 'No virtual position';
      $('lighterLedger').innerHTML = this.ledger.length ? this.ledger.map((row) => `<tr><td>${new Date(row.time).toLocaleString()}</td><td>${row.action}</td><td>${Number(row.ratio).toFixed(3)}%</td><td>$${Number(row.notional).toFixed(0)}</td><td class="${row.pnl == null || row.pnl >= 0 ? 'lighterMetricUp' : 'lighterMetricDown'}">${row.pnl == null ? '—' : `${row.pnl >= 0 ? '+' : ''}$${row.pnl.toFixed(2)}`}</td></tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No virtual trades</td></tr>';
    }
  };

  window.lighterEngine = lighterEngine;
  document.addEventListener('DOMContentLoaded', () => lighterEngine.init());
})();
