# Project audit — 16 August 2026

Audit of the dashboard's calculation logic, build pipeline and GitHub configuration,
and a record of what was changed. Every figure below was re-derived independently
from the raw source files before any change was made.

## Verdict

The **calculations were already correct**. An independent re-implementation
reading the sources by column name reproduced every headline figure and all 999
outlet totals to the cent:

| Measure | Independent re-derivation | Dashboard | Delta |
|---|---:|---:|---:|
| Overall POS NSI | 1,539,173,472.00 | 1,539,173,472.00 | 0.00 |
| PNP Sales (FRESH PRODUCE) | 248,286,991.00 | 248,286,991.00 | 0.00 |
| Net consumable | 9,515,298.43 | 9,515,298.43 | 0.00 |
| Net wastage | 2,649,859.77 | 2,649,859.77 | 0.00 |
| Consumable % on Sales | 0.6182% | 0.6182% | — |
| Wastage % on Sales | 0.1722% | 0.1722% | — |
| Wastage % on PNP Sales | 1.0673% | 1.0673% | — |

Mismatched outlets: **0 of 999** on every measure. The SAP sign convention
(issues negative, reversals positive, net = negated sum) checks out against the
movement types: consumable Z21 9,783,700.86 less Z22 268,402.43; wastage 551
2,659,717.48 less 552 9,857.71.

The problems were in **resilience and publishing**, not arithmetic. One of them
stopped the site from ever deploying.

## Findings

### 1 · Blocking — the deploy workflow referenced an action version that does not exist

`deploy-pages.yml` pinned `actions/checkout@v7`. The latest published major is
**v6**. Every run would have failed at the first step with
`Unable to resolve action actions/checkout@v7`, so the site could never publish.

Fixed: `checkout@v6`. `deploy-pages` also moved `v4 → v5` (Node 24).
`setup-python@v6`, `configure-pages@v6` and `upload-pages-artifact@v5` were
already current and were left alone.

### 2 · High — SAP columns were read by fixed position, so a layout change fails silently

`read_sap_text_export` addressed columns by hardcoded index (`row[2]`, `row[3]`,
`row[16]`). Those indices happened to be right, but nothing verified them — and
the two exports already prove the layout is not fixed: the header sits on row 17
in `CONSUMABLE.xls` and row 20 in `WASTAGE.xls`, and the quantity column is
labelled `Quantity in UnE` in one and `Qty in UnE` in the other.

Demonstrated on a copy of `CONSUMABLE.xls` with two column pairs swapped:

| Reader | Net consumable produced |
|---|---:|
| Fixed indices (previous behaviour) | **0.00** — every row silently dropped |
| Header-name mapping (now) | 9,515,298.43 — correct |

A published 0.00% consumable rate would have looked like a good month.

Fixed: the header row is located by its labels (with alias tolerance), columns
resolve by name, and a missing or unrecognisable header raises a build error
naming the file and the expected labels.

### 3 · High — a data-quality check that could never fail

The **Data quality** panel rendered a hardcoded green "Passed · Source periods
align" card regardless of the dates it printed underneath. If the wastage export
stopped five days before sales, the panel still said the periods aligned, while
every rate quietly divided a short movement period by a long sales period.

Fixed: `build_period_alignment` computes the real overlap. The card now turns
amber, names the lagging source and states the common period to filter to.
Verified by truncating the wastage export to 10 August: the build warns, the
Actions log warns, and the panel reports it.

### 4 · Medium — target percentages could be misread by 100×

`parse_percent` used `number / 100 if number > 1 else number`. A bare `0.5` in
`Target.txt` (a column headed "Consumable % On Sales") was read as **50%**, not
0.5%. `Target.txt` is a monthly manual edit, which is exactly where this slips in.

Fixed: the column defines the unit, so `0.50%` and `0.50` both mean 0.50 percent.
Any target resolving outside 0.01%–50% aborts the build with the offending line
and criteria named. Missing or renamed target columns are also caught up front.

### 5 · Medium — build output was committed to the repository

`dist/` was tracked in git while the workflow also regenerated it on every push.
Two consequences: a 2.1 MB JSON diff on every refresh, and a committed copy that
can silently disagree with what is actually published. It also invited edits to
`dist/assets/app.js`, which the next build would discard.

Fixed: `dist/` is git-ignored and excluded from the package. `site/` is the only
source of truth for the front end.

### 6 · Medium — no `.gitattributes` for UTF-16 source files

`CONSUMABLE.xls` and `WASTAGE.xls` are UTF-16LE text with a `.xls` extension.
Git's binary detection usually catches them, but it is a heuristic; a Windows
clone-and-recommit could rewrite line endings and corrupt the encoding.

Fixed: `.gitattributes` marks the spreadsheet extensions binary and pins
`Target.txt` to LF.

### 7 · Low — deployment concurrency could cancel a live publish

`cancel-in-progress: true` on the `pages` group cancels a deployment that is
already publishing. Fixed to `false` so runs queue instead.

### 8 · Low — workflow permissions broader than needed

`pages: write` and `id-token: write` were granted at workflow level, so the build
job held deploy credentials it never uses. Fixed: workflow defaults to
`contents: read`; only the deploy job widens.

### 9 · Low — CSV export contradicted its own headers

Columns headed `Consumable %` contained the 0–1 ratio (`0.0062`), so Excel showed
0.0062 under a heading that says percent. Fixed: percentage columns export
percentage points (`0.6182`), and the export now carries `Period From` /
`Period To` so a saved file states its own scope.

### 10 · Low — the ranking target marker had a tooltip that never appeared

The target tick rendered `<span class="bar-target"><title>…</title></span>`.
`<title>` inside an HTML span is `display:none`, so the tooltip never showed.
Fixed to a `title` attribute.

### 11 · Low — assorted

- A missing favicon produced a console 404 on every load. An inline SVG icon is
  now embedded; the page loads with zero console errors and zero failed requests.
- `sortValue` had an unreachable `-Infinity` branch (`typeof null` is never
  `"number"`). Sorting worked by accident because the `""` fallback string-sorts
  below every number. Rewritten to handle missing rates explicitly: the 33
  outlets with no PNP sales now stay at the bottom in both directions. Verified
  monotonic across all 999 rows on five numeric columns, both directions.
- Setting the From date after the To date silently emptied the dashboard. It now
  says so.
- `negativeNetWastageOutlets`, `mappedWithoutActivity` and `targetMappedOutlets`
  were computed but never displayed. Wastage reversals now appear alongside
  consumable reversals.
- `read_sales` indexed rows directly where `read_zone_distribution` used a
  bounds-checked accessor. Made consistent.
- `build_site.py` will no longer `rmtree` a directory that does not look like a
  previous build.
- The internal dataset was indexable by search engines. `noindex, nofollow` added.

## Data observations (no code change)

These are properties of the source files. They are reported, not corrected.

- **`Sales-Till.xlsx` does not reconcile to its own total row.** Detail rows sum
  to 1,539,173,472; the `Total (999)` footer says 1,539,172,444 — a **1,028**
  gap (0.00007%). The dashboard uses the detail rows, which is correct. The
  build now reports the difference instead of discarding the footer silently.
- **Ten active outlets are unmapped**: `E070`, `E075`, `E080`, `E085`, `E086`,
  `E090`, `E091`, `E092`, `F705`, `F844` — 0.09% of sales. `E080` and `F824`
  already sit on the `again in september` sheet of the zone master, which the
  build does not read because that sheet has no header row. Move those rows into
  `Final_Zone Dis` when they go live.
- **`F024` and `F254` carry net consumable reversals.** Retained and flagged, as
  intended.
- **887 of 989 mapped outlets are `Non-PNP` yet sell FRESH PRODUCE**, so they
  carry a Wastage % on PNP Sales figure against the flat 1.00% target. This
  follows the confirmed rule (PNP Sales = Division FRESH PRODUCE) and was left
  unchanged — worth a business decision on whether the 1.00% target is meant to
  apply to Non-PNP outlets.
- **Weighted 1.07% vs simple outlet average 0.31%** on Wastage % on PNP Sales.
  Both are correct and answer different questions; small outlets with tiny PNP
  denominators pull the simple average down (`F847`: ৳12,955 PNP sales, 23.90%).
  Quote the weighted figure as the business result.

## What now blocks a bad publish

`build_data.py` refuses to emit a payload, and `verify_build.py` refuses to let it
deploy, when: a source file, sheet or column header is missing; the SAP header
cannot be located; a benchmark target is outside 0.01%–50%; outlet codes are
duplicated; a daily row references an unknown outlet; any of sales, PNP sales,
consumable or wastage is zero; PNP sales exceeds overall sales; a headline rate
falls outside 0–25%; under 90% of sales maps to the zone master; or the sales
detail diverges from the export's own total by more than 0.1%.

Unmapped outlets, net reversals, period misalignment and small reconciliation
gaps are reported as warnings — visible in the Actions log and the dashboard —
without blocking the refresh.

## Rebuild (front end v2)

After the audit the front end was rebuilt. The data pipeline's arithmetic is
unchanged — `outlets`, `daily`, `targets`, `asOf` and `dateRange` remain
byte-identical to the original payload — and the schema moved to version 3 by
adding fields, not changing any.

What was added: light/dark themes; linked multi-select filters; League Tables;
an Exceptions worklist ranked by taka over target; period-over-period comparison
with biggest movers; per-outlet drill-down; and material detail from columns the
old build discarded.

Three defects were found and fixed during the rebuild's own testing:

- **Closed drawers and modals still swallowed clicks.** `.drawer { display: flex }`
  outranks the user-agent `[hidden]` rule, so a closed drawer stayed laid out and
  intercepted every click across the right half of the viewport. Fixed with an
  explicit `[hidden] { display: none !important }` above the components.
- **Multi-select closed after one pick.** Ticking an option re-renders the list,
  which detaches the clicked node; by the time the outside-click handler ran in
  the bubble phase, `closest("#filterStack")` no longer matched and every panel
  closed. Moved that handler to the capture phase.
- **Sparkline paths could start with `L`.** The SVG command letter was chosen
  from the array index rather than emission order, so an outlet whose first day
  had no denominator produced an invalid path. Fixed to track emission order.

Filter panels also expand inline rather than floating: in a narrow scrolling rail
an overlay panel covers the next filter and swallows the click meant for it.

### A data characteristic worth knowing

Consumable issues post to SAP in batches. Across 1–15 August, six of fifteen days
carry almost no consumable value — 10 August books ৳0 while 11 August books
৳16.1 Lac — so the raw daily consumable rate swings between 0.00% and 1.79% on
posting timing rather than on outlet behaviour. Wastage posts daily and is
smooth (0.81%–1.54%).

The dashboard now detects this and says so on the chart, and offers 7-day rolling
and period-to-date bases. Both are ratios of sums over the window, never averages
of daily percentages.

## Verification performed

- Independent re-derivation of every metric from the raw files (0 mismatches).
- Byte-comparison of the rebuilt payload against the original: `outlets`,
  `daily`, `targets`, `asOf` and `dateRange` all identical. **No number changed.**
- Six negative tests against deliberately broken inputs; each blocked with a
  named, actionable error, and the period-misalignment case correctly warned
  rather than blocked.
- Headless Chromium run: 0 console errors, 0 failed requests, all filters, tabs,
  charts, modals, pagination, CSV export and both sort directions on five numeric
  columns exercised across all 999 rows.
- Cold build from the packaged zip in a clean checkout.
- Rebuild re-tested headless in both themes: linked multi-select narrowing
  (2 divisions -> 610 outlets, district list correctly reduced to 24), multi-status
  OR, reset, all six views, period comparison, outlet drawer, all three trend
  bases, and every export. Zero console errors, zero failed requests.
