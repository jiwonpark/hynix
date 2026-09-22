import pathlib
import tempfile
import unittest

from scripts.stamp_deployment_metadata import stamp


ROOT = pathlib.Path(__file__).resolve().parents[1]


class DeploymentMetadataTests(unittest.TestCase):
    def test_metadata_has_one_source_and_no_stale_production_date(self):
        html = (ROOT / "index.html").read_text()
        self.assertEqual(html.count('buildVersion: "v1.7.1+local"'), 1)
        self.assertEqual(html.count('deployedAt: "Development build"'), 1)
        self.assertNotIn("2026-09-09 15:43 KST", html)
        self.assertIn('DEPLOYMENT_META.buildVersion', html)
        self.assertIn('DEPLOYMENT_META.deployedAt', html)

    def test_deploy_script_stamps_and_verifies_the_build(self):
        script = (ROOT / "scripts" / "deploy_frontend.sh").read_text()
        self.assertIn("BUILD_VERSION=", script)
        self.assertIn("DEPLOYED_AT=", script)
        self.assertIn("curl -fsSI", script)
        self.assertIn('grep -Fq "$BUILD_VERSION"', script)

    def test_stamper_updates_only_the_metadata_source(self):
        with tempfile.TemporaryDirectory() as directory:
            staged = pathlib.Path(directory) / "index.html"
            staged.write_text((ROOT / "index.html").read_text())
            stamp(staged, "v1.7.1+abc1234.20260922153000", "2026-09-22 15:30:00 KST")
            html = staged.read_text()
            self.assertEqual(html.count('buildVersion: "v1.7.1+abc1234.20260922153000"'), 1)
            self.assertEqual(html.count('deployedAt: "2026-09-22 15:30:00 KST"'), 1)
            self.assertNotIn('buildVersion: "v1.7.1+local"', html)


if __name__ == "__main__":
    unittest.main()
