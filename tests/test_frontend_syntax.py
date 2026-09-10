import os
import re
import subprocess
import unittest

class TestFrontendSyntax(unittest.TestCase):
    def test_index_html_scripts_compile_cleanly(self):
        html_path = os.path.join(os.path.dirname(__file__), "..", "index.html")
        self.assertTrue(os.path.exists(html_path), f"index.html not found at {html_path}")

        with open(html_path, "r", encoding="utf-8") as f:
            html_content = f.read()

        pattern = re.compile(r"<script\b[^>]*>(.*?)</script>", re.DOTALL | re.IGNORECASE)
        scripts = pattern.findall(html_content)
        inline_scripts = [s.strip() for s in scripts if s.strip()]
        self.assertGreater(len(inline_scripts), 0)

        node_code = """
const vm = require("vm");
const scripts = JSON.parse(process.argv[1]);
scripts.forEach((code, idx) => {
  try {
    new vm.Script(code, { filename: `inline_script_${idx}.js` });
  } catch (err) {
    console.error(`SYNTAX_ERROR in script ${idx}:`, err.message);
    process.exit(1);
  }
});
console.log("ALL_SCRIPTS_VALID");
"""
        import json
        res = subprocess.run(
            ["node", "-e", node_code, json.dumps(inline_scripts)],
            capture_output=True,
            text=True
        )
        if res.returncode != 0:
            self.fail(f"Syntax validation failed in index.html:\n{res.stderr}")
        self.assertIn("ALL_SCRIPTS_VALID", res.stdout)

if __name__ == "__main__":
    unittest.main()
