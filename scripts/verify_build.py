#!/usr/bin/env python3
"""Post-build gate for dist/.

build_data.py validates the numbers while it assembles them. This script checks
the artifact that is actually about to be published: every file the page
requests exists, the payload parses, and the headline figures re-derive from the
daily rows. It exits non-zero so the GitHub Actions run fails before deploying a
broken site.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

REQUIRED_FILES = (
    "index.html",
    "assets/app.js",
    "assets/styles.css",
    "data/dashboard-data.json",
    ".nojekyll",
)
# Keep in step with SUPPORTED_SCHEMA_VERSIONS in site/assets/app.js.
# 1 = original, 2 = + period alignment and reconciliation, 3 = + materials and calendar.
SUPPORTED_SCHEMA_VERSIONS = {1, 2, 3}


class VerificationError(Exception):
    """A check that must block deployment."""


def check_files(dist: Path) -> None:
    missing = [name for name in REQUIRED_FILES if not (dist / name).exists()]
    if missing:
        raise VerificationError(f"dist/ is missing: {', '.join(missing)}")


def load_payload(dist: Path) -> dict[str, Any]:
    path = dist / "data" / "dashboard-data.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise VerificationError(f"dashboard-data.json is not valid JSON: {error}") from error
    if payload.get("schemaVersion") not in SUPPORTED_SCHEMA_VERSIONS:
        raise VerificationError(
            f"schemaVersion {payload.get('schemaVersion')!r} is not supported by the dashboard."
        )
    return payload


def check_totals(payload: dict[str, Any]) -> dict[str, float]:
    daily = payload["daily"]
    totals = defaultdict(float)
    for row in daily:
        for key in ("sales", "pnpSales", "consumable", "wastage"):
            totals[key] += row[key]

    if totals["sales"] <= 0:
        raise VerificationError("Total sales in the published payload is not positive.")
    if totals["pnpSales"] <= 0:
        raise VerificationError("Total PNP sales is not positive; check the FRESH PRODUCE rule.")
    if totals["pnpSales"] > totals["sales"]:
        raise VerificationError("PNP sales exceeds overall sales, which is impossible.")

    codes = {outlet["code"] for outlet in payload["outlets"]}
    orphans = sorted({row["code"] for row in daily} - codes)
    if orphans:
        raise VerificationError(f"Daily rows reference unknown outlets: {', '.join(orphans[:10])}")

    consumable_rate = totals["consumable"] / totals["sales"]
    wastage_rate = totals["wastage"] / totals["sales"]
    for name, rate in (("Consumable % on Sales", consumable_rate), ("Wastage % on Sales", wastage_rate)):
        if not 0 <= rate < 0.25:
            raise VerificationError(
                f"{name} computed as {rate:.2%}, outside the plausible 0-25% band. "
                f"This usually means a source file was exported in the wrong unit or period."
            )
    return dict(totals)


def collect_warnings(payload: dict[str, Any]) -> list[str]:
    quality = payload.get("dataQuality", {})
    warnings: list[str] = []

    alignment = quality.get("periodAlignment") or {}
    if alignment and not alignment.get("aligned", True):
        lagging = ", ".join(alignment.get("laggingSources") or []) or "one or more sources"
        warnings.append(
            f"Source periods do not align ({lagging} ends before sales). "
            f"Rates over the full range will be understated; common period is "
            f"{alignment.get('commonStart')} to {alignment.get('commonEnd')}."
        )

    unmapped = quality.get("unmappedActiveOutlets") or []
    if unmapped:
        warnings.append(
            f"{len(unmapped)} active outlet(s) are missing from the zone master: {', '.join(unmapped)}."
        )

    duplicates = (quality.get("zone") or {}).get("duplicateCodes") or []
    if duplicates:
        warnings.append(f"Zone master has duplicate outlet codes: {', '.join(duplicates)}.")

    for label, key in (("consumable", "negativeNetConsumableOutlets"), ("wastage", "negativeNetWastageOutlets")):
        outlets = quality.get(key) or []
        if outlets:
            warnings.append(f"Net {label} reversal at: {', '.join(outlets)}.")

    reconciliation = (quality.get("sales") or {}).get("reconciliation") or {}
    if reconciliation.get("matches") is False:
        warnings.append(
            f"Sales detail rows total {reconciliation['detailTotal']:,.2f} against the file's own "
            f"total row of {reconciliation['reportedTotal']:,.2f} "
            f"(difference {reconciliation['difference']:,.2f})."
        )

    coverage = quality.get("targetSalesCoverage")
    if coverage is not None and coverage < 0.995:
        warnings.append(f"Only {coverage:.2%} of sales maps to a benchmark target.")

    return warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=Path("dist"))
    parser.add_argument("--summary", action="store_true", help="Print the data-quality summary only.")
    args = parser.parse_args()

    try:
        check_files(args.dist)
        payload = load_payload(args.dist)
        totals = check_totals(payload)
    except VerificationError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1

    quality = payload.get("dataQuality", {})
    print(f"Verified {args.dist}/")
    print(f"  as of              {payload.get('asOf')}")
    print(f"  period             {payload['dateRange']['min']} to {payload['dateRange']['max']}")
    print(f"  outlets            {len(payload['outlets']):,} ({quality.get('mappedActiveOutlets', 0):,} mapped)")
    print(f"  outlet-day rows    {len(payload['daily']):,}")
    print(f"  overall POS NSI    {totals['sales']:,.2f}")
    print(f"  PNP sales          {totals['pnpSales']:,.2f}")
    print(f"  consumable % sales {totals['consumable'] / totals['sales']:.4%}")
    print(f"  wastage % sales    {totals['wastage'] / totals['sales']:.4%}")
    print(f"  wastage % PNP      {totals['wastage'] / totals['pnpSales']:.4%}")

    warnings = collect_warnings(payload)
    if warnings:
        print(f"\n{len(warnings)} data-quality warning(s):")
        for warning in warnings:
            print(f"  - {warning}")
            if not args.summary:
                print(f"::warning::{warning}")
    else:
        print("\nNo data-quality warnings.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
