#!/usr/bin/env python3
"""Build the complete static GitHub Pages site into dist/."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

# Allow `python scripts/build_site.py` from the repository root and
# `python -m scripts.build_site` to both resolve the sibling module.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_data import write_dashboard_data  # noqa: E402


def prepare_output(site: Path, output: Path) -> None:
    if not site.is_dir():
        raise SystemExit(f"Site template directory not found: {site}")
    resolved = output.resolve()
    # Guard against `--output /` or `--output .` wiping something real.
    if resolved == Path(resolved.anchor) or resolved == Path.cwd().resolve():
        raise SystemExit(f"Refusing to rebuild into {resolved}; choose a dedicated output directory.")
    if resolved.exists():
        if not (resolved / "index.html").exists() and any(resolved.iterdir()):
            raise SystemExit(
                f"Refusing to delete {resolved}: it is not empty and does not look like a "
                f"previous build (no index.html)."
            )
        shutil.rmtree(resolved)
    shutil.copytree(site, resolved)
    (resolved / ".nojekyll").write_text("", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("source-data"))
    parser.add_argument("--site", type=Path, default=Path("site"))
    parser.add_argument("--output", type=Path, default=Path("dist"))
    args = parser.parse_args()

    prepare_output(args.site, args.output)
    payload = write_dashboard_data(args.input, args.output / "data" / "dashboard-data.json")

    quality = payload.get("dataQuality", {})
    alignment = quality.get("periodAlignment", {})
    print(
        f"Built {args.output} with {len(payload['outlets']):,} outlets, "
        f"{len(payload['daily']):,} outlet-day rows, as of {payload['asOf']}."
    )
    if alignment and not alignment.get("aligned", True):
        print(
            f"  WARNING: source periods differ. Common period "
            f"{alignment.get('commonStart')} to {alignment.get('commonEnd')}; "
            f"lagging: {', '.join(alignment.get('laggingSources') or []) or 'n/a'}."
        )


if __name__ == "__main__":
    main()
