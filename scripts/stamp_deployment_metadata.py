#!/usr/bin/env python3
"""Stamp immutable build metadata into a staged Hyperion frontend artifact."""

from pathlib import Path
import re
import sys


def stamp(path: Path, build_version: str, deployed_at: str) -> None:
    text = path.read_text(encoding="utf-8")
    text, version_count = re.subn(
        r'(buildVersion:\s*")[^"]+("\s*,)',
        rf"\g<1>{build_version}\g<2>",
        text,
        count=1,
    )
    text, date_count = re.subn(
        r'(deployedAt:\s*")[^"]+("\s*,)',
        rf"\g<1>{deployed_at}\g<2>",
        text,
        count=1,
    )
    if version_count != 1 or date_count != 1:
        raise ValueError("deployment metadata markers were not found exactly once")
    path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: stamp_deployment_metadata.py INDEX VERSION DEPLOYED_AT")
    stamp(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
