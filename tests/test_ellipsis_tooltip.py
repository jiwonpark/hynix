import os
import re
import subprocess
import unittest

class TestEllipsisTooltip(unittest.TestCase):
    def setUp(self):
        self.html_path = os.path.join(os.path.dirname(__file__), "..", "index.html")
        self.assertTrue(os.path.exists(self.html_path), f"index.html not found at {self.html_path}")
        with open(self.html_path, "r", encoding="utf-8") as f:
            self.html_content = f.read()

    def test_dom_element_and_css_exist(self):
        self.assertIn("id=\"ellipsisHoverTooltip\"", self.html_content)
        self.assertIn("class=\"ellipsisTooltip\"", self.html_content)
        self.assertIn("role=\"tooltip\"", self.html_content)

        self.assertIn(".ellipsisTooltip {", self.html_content)
        self.assertIn("position: fixed;", self.html_content)
        self.assertIn("z-index: 1000000;", self.html_content)
        self.assertIn("pointer-events: none;", self.html_content)
        self.assertIn(".ellipsisTooltip.visible", self.html_content)
        self.assertIn(".ellipsisTooltip .tipTitle", self.html_content)
        self.assertIn(".ellipsisTooltip .tipDesc", self.html_content)

    def test_manager_methods_and_logic_in_node(self):
        node_test = """
const vm = require("vm");
const fs = require("fs");

const html = fs.readFileSync("index.html", "utf8");

const scriptMatch = html.match(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi);
const lastScript = scriptMatch[scriptMatch.length - 1].replace(/<\\/?script[^>]*>/gi, "");

class MockElement {
  constructor(tag, id = "", className = "", innerText = "", title = "") {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.id = id;
    this.className = className;
    this.innerText = innerText;
    this.textContent = innerText;
    this._attrs = { title };
    this.dataset = {};
    this.style = {};
    this.clientWidth = 100;
    this.scrollWidth = 100;
    this.clientHeight = 20;
    this.scrollHeight = 20;
    this.parentElement = null;
    this.childElementCount = 0;
    this.classList = {
      contains: (cls) => this.className.split(" ").includes(cls),
      add: (cls) => { if (!this.classList.contains(cls)) this.className += " " + cls; },
      remove: (cls) => { this.className = this.className.replace(cls, "").trim(); }
    };
  }
  getAttribute(k) { return this._attrs[k] || null; }
  setAttribute(k, v) { this._attrs[k] = v; }
  hasAttribute(k) { return k in this._attrs && this._attrs[k] !== null; }
  removeAttribute(k) { delete this._attrs[k]; }
  closest(selector) {
    if (selector.startsWith("#") && this.id === selector.slice(1)) return this;
    if (selector.startsWith(".") && this.classList.contains(selector.slice(1))) return this;
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }
  getBoundingClientRect() {
    return { width: 120, height: 40, top: 0, left: 0, bottom: 40, right: 120 };
  }
}

const mockDoc = {
  body: new MockElement("body"),
  documentElement: new MockElement("html"),
  getElementById: (id) => (id === "ellipsisHoverTooltip" ? tooltipEl : null),
  createElement: (tag) => new MockElement(tag),
  addEventListener: () => {}
};
const tooltipEl = new MockElement("div", "ellipsisHoverTooltip", "ellipsisTooltip");
mockDoc.body.appendChild = () => {};

global.window = {
  addEventListener: () => {},
  innerWidth: 1920,
  innerHeight: 1080,
  getComputedStyle: (el) => ({
    textOverflow: el.style.textOverflow || "clip",
    overflow: el.style.overflow || "visible",
    overflowX: el.style.overflowX || "visible",
    whiteSpace: el.style.whiteSpace || "normal"
  })
};
global.document = mockDoc;
global.$ = (id) => mockDoc.getElementById(id);

try {
  new vm.Script(lastScript, { filename: "index.html.js" });
} catch(e) {
  console.error("COMPILE_ERROR:", e.message);
  process.exit(1);
}

const managerDefMatch = lastScript.match(/const ellipsisTooltipManager = \\{([\\s\\S]*?)\\n\\s*\\};/);
if (!managerDefMatch) {
  console.error("ellipsisTooltipManager definition not found");
  process.exit(1);
}

const manager = eval("({" + managerDefMatch[1] + "})");
manager.tooltipEl = tooltipEl;

// Test 1: Literal ellipsis detection
const elLiteral = new MockElement("span", "", "", "4. 5m Bullish MA Stack...");
if (!manager.isElementTruncated(elLiteral)) {
  console.error("FAIL: literal ellipsis not detected");
  process.exit(1);
}

// Test 2: Input / fieldTip exclusion
const elInput = new MockElement("input", "", "", "some long text...");
if (manager.isElementTruncated(elInput)) {
  console.error("FAIL: input should be excluded");
  process.exit(1);
}
const elTip = new MockElement("span", "", "fieldTip", "tooltip label...");
if (manager.isElementTruncated(elTip)) {
  console.error("FAIL: fieldTip should be excluded");
  process.exit(1);
}

// Test 3: CSS textOverflow ellipsis with clipping
const elClipped = new MockElement("div", "", "condLabel", "4. 5m Bullish MA Stack (Price > MA7 > MA24 > MA60)");
elClipped.style.textOverflow = "ellipsis";
elClipped.style.overflow = "hidden";
elClipped.scrollWidth = 250;
elClipped.clientWidth = 150;
if (!manager.isElementTruncated(elClipped)) {
  console.error("FAIL: CSS clipped element not detected");
  process.exit(1);
}

// Test 4: Full text data extraction
const data = manager.getFullTextData(elClipped);
if (!data || data.text !== "4. 5m Bullish MA Stack (Price > MA7 > MA24 > MA60)") {
  console.error("FAIL: getFullTextData did not extract full text: " + JSON.stringify(data));
  process.exit(1);
}

// Test 5: Dataset fullText override
const elData = new MockElement("span", "", "", "Short...");
elData.dataset.fullText = "Detailed Complete Arbitrage Position Spec";
const data2 = manager.getFullTextData(elData);
if (!data2 || data2.text !== "Detailed Complete Arbitrage Position Spec") {
  console.error("FAIL: dataset.fullText not prioritized");
  process.exit(1);
}

// Test 6: Title stashing and restoring on show/hide
elClipped.setAttribute("title", "Hover Explanation");
manager.show(elClipped, { clientX: 100, clientY: 100 });
if (elClipped.hasAttribute("title")) {
  console.error("FAIL: title attribute was not temporarily stashed");
  process.exit(1);
}
if (!tooltipEl.classList.contains("visible")) {
  console.error("FAIL: tooltipEl not marked visible");
  process.exit(1);
}
manager.hide();
if (elClipped.getAttribute("title") !== "Hover Explanation") {
  console.error("FAIL: title attribute was not restored on hide");
  process.exit(1);
}

console.log("ELLIPSIS_TOOLTIP_TESTS_PASSED");
"""
        res = subprocess.run(
            ["node", "-e", node_test],
            capture_output=True,
            text=True
        )
        if res.returncode != 0:
            self.fail(f"Ellipsis tooltip tests failed:\n{res.stderr}\n{res.stdout}")
        self.assertIn("ELLIPSIS_TOOLTIP_TESTS_PASSED", res.stdout)

if __name__ == "__main__":
    unittest.main()
