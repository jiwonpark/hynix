const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const elements = new Map();
class DOMElement {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.childNodes = [];
    this.attributes = new Map();
    this._classList = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => this._classList.add(x)),
      remove: (...c) => c.forEach((x) => this._classList.delete(x)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (this._classList.has(c)) { this._classList.delete(c); return false; }
          this._classList.add(c); return true;
        }
        if (force) { this._classList.add(c); return true; }
        this._classList.delete(c); return false;
      },
      contains: (c) => this._classList.has(c),
    };
  }
  get id() { return this._id || ""; }
  set id(val) {
    if (this._id) elements.delete(this._id);
    this._id = val;
    if (val) elements.set(val, this);
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  appendChild(child) {
    this.children.push(child);
    this.childNodes.push(child);
    child.parentNode = this;
    if (child.id) elements.set(child.id, child);
    return child;
  }
  prepend(child) {
    this.children.unshift(child);
    this.childNodes.unshift(child);
    child.parentNode = this;
    if (child.id) elements.set(child.id, child);
    return child;
  }
  insertBefore(newNode, refNode) {
    const idx = this.children.indexOf(refNode);
    if (idx >= 0) {
      this.children.splice(idx, 0, newNode);
      this.childNodes.splice(idx, 0, newNode);
    } else {
      this.children.push(newNode);
      this.childNodes.push(newNode);
    }
    newNode.parentNode = this;
    if (newNode.id) elements.set(newNode.id, newNode);
    return newNode;
  }
  replaceChildren(...newChildren) {
    this.children = [...newChildren];
    this.childNodes = [...newChildren];
    for (const c of newChildren) {
      if (c) {
        c.parentNode = this;
        if (c.id) elements.set(c.id, c);
      }
    }
  }
  querySelector(sel) {
    if (sel.startsWith("#")) return elements.get(sel.slice(1)) || null;
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      for (const el of elements.values()) {
        if (el.classList.contains(cls)) return el;
      }
    }
    return null;
  }
  querySelectorAll(sel) {
    if (sel === "[id]") {
      const res = [];
      const walk = (node) => {
        if (node.id) res.push(node);
        (node.children || []).forEach(walk);
      };
      (this.children || []).forEach(walk);
      return res;
    }
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      const res = [];
      for (const el of elements.values()) {
        if (el.classList.contains(cls)) return el;
      }
      return res;
    }
    return [];
  }
  addEventListener() {}
  removeEventListener() {}
  get clientWidth() { return 1000; }
  get clientHeight() { return 420; }
  get innerHTML() { return this._html || ""; }
  set innerHTML(html) {
    this._html = html;
    const matches = html.matchAll(/id=["\x27]([^"\x27]+)["\x27]/g);
    for (const m of matches) {
      const el = new DOMElement("div", m[1]);
      this.appendChild(el);
      elements.set(m[1], el);
    }
  }
}

const htmlContent = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const tMatch = htmlContent.match(/<template id="tradingTerminalTemplate">([\s\S]*?)<\/template>/);
assert.ok(tMatch, "tradingTerminalTemplate must exist");
const templateHtml = tMatch[1];
const templateNode = new DOMElement("template", "tradingTerminalTemplate");
templateNode.content = {
  cloneNode() {
    const clone = new DOMElement("div");
    clone.innerHTML = templateHtml;
    return clone;
  },
};
elements.set("tradingTerminalTemplate", templateNode);
elements.set("tabContentTrading", new DOMElement("div", "tabContentTrading"));
elements.set("tabContentLighter", new DOMElement("div", "tabContentLighter"));
elements.set("tabContentCrypto", new DOMElement("div", "tabContentCrypto"));
elements.set("tabContentLighterCrypto", new DOMElement("div", "tabContentLighterCrypto"));

const ctx = {
  window: {},
  document: {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => new DOMElement(tag),
    createElementNS: (ns, tag) => new DOMElement(tag),
    createDocumentFragment: () => new DOMElement("fragment"),
    createTreeWalker: () => ({ nextNode() { return false; } }),
    readyState: "complete",
    addEventListener() {},
  },
  NodeFilter: { SHOW_TEXT: 4 },
  localStorage: { getItem: () => null, setItem: () => null },
  fetch: async (url) => {
    const bars = [];
    const now = Math.floor(Date.now() / 1000);
    for (let i = 100; i >= 0; i--) {
      bars.push({ time: now - i * 300, value: 65000 + Math.sin(i / 10) * 100 });
    }
    return { ok: true, json: async () => ({ success: true, bars, markers: [], trades: [], summary: {} }) };
  },
  console,
  setTimeout: (fn) => setTimeout(fn, 1),
  requestAnimationFrame: (fn) => setTimeout(fn, 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  URLSearchParams, AbortSignal, clearTimeout,
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.addEventListener = () => {};
ctx.removeEventListener = () => {};
ctx.matchMedia = () => ({ matches: false });
vm.createContext(ctx);

vm.runInContext(fs.readFileSync(path.join(__dirname, "../strategy-execution-chart.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../terminal-common.js"), "utf8"), ctx);

let chartsCreated = 0;
ctx.window.LightweightCharts = {
  createChart: (host, opts) => {
    chartsCreated++;
    return {
      applyOptions: () => {},
      timeScale: () => ({
        width: () => 1000,
        applyOptions() {},
        subscribeVisibleLogicalRangeChange() {},
        timeToCoordinate() { return 100; },
        setVisibleLogicalRange() {},
        getVisibleLogicalRange() { return { from: 0, to: 100 }; },
      }),
      addAreaSeries: () => ({
        setData() {}, applyOptions() {}, priceToCoordinate() { return 200; },
        createPriceLine() {}, removePriceLine() {}, setMarkers() {},
      }),
      addLineSeries: () => ({ setData() {}, applyOptions() {}, setMarkers() {} }),
      addHistogramSeries: () => ({ setData() {}, applyOptions() {}, setMarkers() {} }),
      priceScale: () => ({ applyOptions() {} }),
      subscribeClick() {},
      subscribeCrosshairMove() {},
    };
  },
  CrosshairMode: { Normal: 1 },
  LineStyle: { Solid: 0, Dashed: 2 },
};

vm.runInContext(fs.readFileSync(path.join(__dirname, "../crypto-tab.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../lighter-crypto-tab.js"), "utf8"), ctx);

(async () => {
  await ctx.window.cryptoEngine.onTabActivated();
  assert.ok(ctx.window.cryptoEngine.chart, "cryptoEngine chart must be initialized");
  assert.ok(ctx.window.cryptoEngine.executionChartFrame, "cryptoEngine executionChartFrame must exist");

  await ctx.window.lighterCryptoEngine.onTabActivated();
  assert.ok(ctx.window.lighterCryptoEngine.chart, "lighterCryptoEngine chart must be initialized");
  assert.ok(ctx.window.lighterCryptoEngine.executionChartFrame, "lighterCryptoEngine executionChartFrame must exist");

  console.log("✅ Tabs 4 and 5 mount simulation passed!");
  process.exit(0);
})().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
