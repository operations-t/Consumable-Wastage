# Consumable & Wastage Dashboard

GitHub Pages dashboard for outlet, zonal, Regional Leader, division and district-level
consumable and wastage monitoring.

Source data goes in `source-data/`. Push to `main`, and GitHub Actions rebuilds the
normalized dataset, verifies it, and publishes the site.

## Views

| View | What it answers |
|---|---|
| **Overview** | Headline rates against target, daily trend, target position, hierarchy ranking, biggest movers |
| **League Tables** | Full sortable ranking by Zonal, Regional Leader, Division, District or Final Criteria |
| **Exceptions** | Action list ranked by taka over target, exportable as a worklist |
| **Benchmarks** | Target versus weighted actual versus simple outlet average, by criteria |
| **Materials** | Which items actually drive the wastage and consumable value |
| **Outlet Register** | Every outlet, sortable and searchable, click through to a profile |

Click any outlet row, exception or mover to open its profile: daily trend,
position against each target, rank within the selection / zonal / criteria peers,
peer-group comparison, and its own top wasted and consumed items.

### Filters

Every filter is **multi-select and linked**. Each list shows only the values
still reachable under the other active selections, with the outlet count behind
each one — pick two Divisions and the District list narrows to the districts
inside them. Selecting nothing in a field means "all". Choosing several
performance statuses means "any of these". Active choices appear as removable
pills under the filters.

### Reading the trend

Consumable issues post to SAP in batches, so on several days of any given range
almost no consumable value is booked. A raw daily consumable line therefore
swings on posting timing rather than on outlet behaviour, and the dashboard says
so when it detects this. Switch **Basis** to *7-day rolling* or *period to date*
to read the underlying trend. Both are ratios of sums over the window, never
averages of daily percentages. Wastage posts daily and is unaffected.

### Period comparison

**Compare period** measures the selected range against the equal-length window
immediately before it, adding deltas to every KPI, a dashed prior-period line on
the trend, and a biggest-movers panel. It is available only when that prior
window falls inside the loaded data — with a 15-day file, a 7-day selection
compares cleanly and a full-range selection has nothing to compare against.

### Value over target

Percentage gaps do not size a problem; taka does. For each metric where an
outlet is above target, the dashboard computes `(actual − target) × sales base`.
Consumable and wastage are added together; the two wastage measures describe the
same taka, so only the larger of the two is counted. This is what the Exceptions
view ranks on, so the largest financial exposure comes first rather than the
largest percentage on a tiny base.

### Theme

Light and dark are both first-class; dark is the default. The choice is
remembered in the browser and falls back gracefully if storage is blocked.

## Confirmed calculation rules

- **PNP Sales:** `Division = FRESH PRODUCE` in `Sales-Till.xlsx`.
- **Consumable % on Sales:** Net Consumable Value ÷ Overall POS NSI.
- **Wastage % on Sales:** Net Wastage Value ÷ Overall POS NSI.
- **Wastage % on PNP Sales:** Net Wastage Value ÷ FRESH PRODUCE POS NSI.
- **SAP movement value:** Issues less reversals, grouped by Posting Date.
  Issues post as negative amounts and reversals as positive, so the net is the
  negated sum.
- **Hierarchy performance:** Sum of numerator ÷ sum of denominator. Outlet
  percentages are not averaged for the business result.
- **Benchmark outlet average:** Simple average of valid outlet-level percentages
  in the selected criteria group.
- **Highlighting:** Lower is better. If Target is higher than Outlet Average, the
  comparison is green. If Outlet Average is higher than Target, it is red. A
  difference within 0.01 percentage point is amber.

### Weighted actual vs outlet average

These two numbers answer different questions and will not agree:

| Measure | 15-day figure | Meaning |
|---|---|---|
| Weighted Wastage % on PNP Sales | 1.07% | The business result. Large outlets dominate. |
| Simple outlet average | 0.31% | The typical outlet. Small outlets count the same as large ones. |

Use the weighted figure for the business result and the outlet average only for
target-setting comparisons, exactly as the benchmark matrix presents them.

## Material detail

The SAP exports carry `Material`, `Material Description`, quantity and unit on
every movement line. The earlier build read those columns and discarded them.
The build now keeps them, so the dashboard can answer *what* is being wasted,
not only *how much*:

- A shared material catalog plus the top six items per outlet, per movement type.
- The 25 highest-value items overall, in the **Materials** view.

Per-outlet material detail covers the whole loaded period and is not narrowed by
the date filter, which is stated on screen wherever it appears.

## Repository layout

```
.github/workflows/
  deploy-pages.yml     Build, verify and publish on push to main
  validate-data.yml    Same build on pull requests, publishes nothing
scripts/
  build_data.py        Reads the five sources, normalizes and validates
  build_site.py        Copies site/ to dist/ and writes the data payload
  verify_build.py      Post-build gate over dist/ before deployment
  serve.mjs            Local static preview server
site/                  The dashboard source (HTML, CSS, JS) — edit here
source-data/           The five input files — replace these to refresh
dist/                  Build output. Generated, git-ignored, never committed.
```

`dist/` is deliberately not in the repository. The workflow regenerates it on
every push, and a committed copy would silently disagree with what is published.

## Weekly update

Replace the relevant files inside `source-data/` without changing these filenames:

| File | Update frequency | Required source |
|---|---|---|
| `Sales-Till.xlsx` | Weekly | Day-wise sales with Outlet Code, Date, Division and POS NSI on sheet `Comparative` |
| `CONSUMABLE.xls` | Weekly | SAP consumable export; keep the original Unicode (UTF-16) tab-separated export format |
| `WASTAGE.xls` | Weekly | SAP wastage export; keep the original Unicode (UTF-16) tab-separated export format |
| `Zone-Distribution.xlsx` | Monthly/as needed | Outlet hierarchy and location master on sheet `Final_Zone Dis` |
| `Target.txt` | Monthly | Tab-separated benchmark criteria and target percentages |

Exact steps in the GitHub web interface:

1. Open the repository and click into the **`source-data`** folder.
2. Click **Add file → Upload files**.
3. Drag in the replacement files, keeping the filenames identical.
4. Type a short commit message such as `Data refresh 22 Aug 2026`.
5. Make sure **Commit directly to the `main` branch** is selected, then click
   **Commit changes**.
6. Open the **Actions** tab. The run named **Build and deploy dashboard** starts
   within a few seconds.
7. Wait for the green check, then open the Pages URL. Refresh with
   <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> if the page looks stale.

Nothing else needs to change. Do not edit anything in `site/` or `scripts/` for a
routine data refresh.

### If the run fails

The build stops rather than publishing wrong numbers. Open the failed step in the
Actions log; the error names the file and the problem. The usual causes:

| Message | Fix |
|---|---|
| `could not find the SAP column header` | The `.xls` was re-saved as real Excel or CSV. Re-export from SAP and keep the Unicode tab-separated format. |
| `Sales file is missing columns` | The sheet is not named `Comparative`, or a header was renamed. |
| `Zone distribution is missing columns` | The sheet is not named `Final_Zone Dis`, or a header was renamed. |
| `outside the expected 0.01%-50% band` | A `Target.txt` value was entered as a fraction. Use percent, e.g. `0.50%`. |
| `Only NN% of sales belongs to outlets present in the zone master` | New outlet codes are trading. Refresh `Zone-Distribution.xlsx`. |

## What the build checks

`build_data.py` refuses to produce a payload, and `verify_build.py` refuses to let
it deploy, when any of these fail:

- All five source files present, with the expected sheets and column headers.
- SAP column positions resolved **by header name**, not by fixed position, so a
  changed export layout errors instead of reading the wrong column.
- Every benchmark target parses as a percentage inside a plausible band.
- No duplicate outlet codes; every daily row maps to a known outlet.
- Sales, PNP sales, consumable and wastage are all non-zero.
- PNP sales does not exceed overall sales.
- Headline rates land inside a plausible 0–25% band.
- At least 90% of sales belongs to outlets present in the zone master.
- Sales detail rows reconcile against the export's own total row.

Non-blocking issues — unmapped outlets, net reversals, misaligned source periods
— are reported as warnings in the Actions log and in the dashboard's
**Data quality** panel.

## Source validation snapshot

Verified against the files committed on **16 August 2026**. These figures move
with every refresh; the dashboard's **Data quality** panel always shows current values.

- Common data date: **15 August 2026**; all three transactional sources cover 1–15 August.
- `FRESH PRODUCE` is the PNP denominator.
- 999 active outlets in Sales-Till; 989 matched to the August zone master.
- 10 active outlets remain visible as `Unmapped`: `E070`, `E075`, `E080`, `E085`,
  `E086`, `E090`, `E091`, `E092`, `F705`, `F844`. `E080` appears on the
  `again in september` sheet of the zone master, which the build does not read
  because that sheet has no header row. Move those rows into `Final_Zone Dis`
  when they go live.
- `F024` and `F254` carry net consumable reversals; the values are retained and
  identified rather than zeroed.
- `Sales-Till.xlsx` detail rows total 1,539,173,472 against the file's own
  `Total (999)` row of 1,539,172,444 — a 1,028 (0.00007%) gap that exists in the
  export itself. The dashboard uses the detail rows and now reports the gap.

## First GitHub Pages publication

1. Create a repository. Make it **Private** — see Data visibility below.
2. Upload the complete contents of this folder, including the hidden `.github`
   folder, to the `main` branch.
3. Open **Settings → Pages**.
4. Under **Build and deployment → Source**, select **GitHub Actions**.
5. Open the **Actions** tab. If no run has started, select **Build and deploy
   dashboard** and click **Run workflow**.
6. When the run finishes, the Pages URL appears in the workflow summary and under
   Settings → Pages.

## Local preview (optional)

```bash
python -m pip install -r requirements.txt
python scripts/build_site.py
python scripts/verify_build.py
python -m http.server 8000 --directory dist
```

Then open `http://localhost:8000`. `npm run dev` serves the same `dist/` on port
4173 if you prefer Node.

## Data visibility

A GitHub Pages site published from a **public** repository is readable by anyone
with the URL, and the full outlet-level dataset is delivered to the browser.
This repository contains real sales, consumable and wastage figures for every
outlet. Keep the repository private and use GitHub Pages access control, or
publish only to an audience cleared for internal financial data.
