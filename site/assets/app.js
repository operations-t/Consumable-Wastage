"use strict";

/* ==========================================================================
   Shwapno Consumable & Wastage Control
   All figures are derived from dist/data/dashboard-data.json in the browser.
   Aggregate rule everywhere: sum(numerator) / sum(denominator).
   Outlet percentages are never averaged for a business result.
   ========================================================================== */

const METRICS = {
  consumableRate: {
    label: "Consumable % on Sales",
    short: "Consumable %",
    numerator: "consumable",
    denominator: "sales",
    target: "consumableTarget",
    valueLabel: "Consumable Value",
  },
  wastageSalesRate: {
    label: "Wastage % on Sales",
    short: "Wastage on Sales %",
    numerator: "wastage",
    denominator: "sales",
    target: "wastageSalesTarget",
    valueLabel: "Wastage Value",
  },
  wastagePnpRate: {
    label: "Wastage % on PNP Sales",
    short: "Wastage on PNP %",
    numerator: "wastage",
    denominator: "pnpSales",
    target: "wastagePnpTarget",
    valueLabel: "Wastage Value",
  },
};
const METRIC_KEYS = Object.keys(METRICS);

const STATUS_TOLERANCE = 0.0001; // 0.01 percentage point
const PAGE_SIZE = 50;
const THEME_KEY = "shwapno-theme";
// 1 = original, 2 = + period alignment & reconciliation, 3 = + materials & calendar.
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3]);

const state = {
  data: null,
  view: null,
  compare: false,
  tab: "overview",
  tablePage: 1,
  tableSort: { key: "wastagePnpRate", direction: "desc" },
  tableSearch: "",
  leagueSort: { key: "metric", direction: "desc" },
  openOutlet: null,
  lastFocus: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* -------------------------------------------------------------- formatting */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function isNumber(value) {
  return value != null && Number.isFinite(value);
}

function formatPercent(value, digits = 2) {
  return isNumber(value) ? `${(value * 100).toFixed(digits)}%` : "—";
}

function formatPoints(value, digits = 2) {
  if (!isNumber(value)) return "—";
  const points = value * 100;
  return `${points > 0 ? "+" : points < 0 ? "−" : ""}${Math.abs(points).toFixed(digits)} pp`;
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value || 0);
}

function formatMoneyExact(value) {
  const number = safeNumber(value);
  return `${number < 0 ? "−" : ""}৳${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.abs(number))}`;
}

// Bangladesh convention: 1 Lac = 100,000 and 1 Cr = 10,000,000.
function formatBDT(value) {
  const number = safeNumber(value);
  const sign = number < 0 ? "−" : "";
  const absolute = Math.abs(number);
  if (absolute >= 10_000_000) return `${sign}৳${(absolute / 10_000_000).toFixed(2)} Cr`;
  if (absolute >= 100_000) return `${sign}৳${(absolute / 100_000).toFixed(2)} Lac`;
  if (absolute >= 1_000) return `${sign}৳${(absolute / 1_000).toFixed(1)} K`;
  return `${sign}৳${absolute.toFixed(0)}`;
}

function formatQuantity(value, unit) {
  if (!isNumber(value) || value === 0) return "";
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatShortDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(
    new Date(`${value}T00:00:00`)
  );
}

function formatDay(value) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(`${value}T00:00:00`));
}

function shiftDate(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

/* ------------------------------------------------------------ status logic */

function compareStatus(actual, target, numerator = 0) {
  if (!isNumber(actual) || !isNumber(target)) return { key: "neutral", label: "No target" };
  if (numerator < 0) return { key: "info", label: "Net reversal" };
  const variance = actual - target;
  if (Math.abs(variance) <= STATUS_TOLERANCE) return { key: "near", label: "At target" };
  return variance < 0 ? { key: "good", label: "Within target" } : { key: "bad", label: "Above target" };
}

function chip(status, label = status.label) {
  return `<span class="chip chip-${status.key}">${escapeHtml(label)}</span>`;
}

function averageVsTarget(average, target) {
  if (!isNumber(average) || !isNumber(target)) return { key: "neutral", label: "Not comparable" };
  if (Math.abs(average - target) <= STATUS_TOLERANCE) return { key: "near", label: "Average at target" };
  return average < target
    ? { key: "good", label: "Target > Outlet Avg" }
    : { key: "bad", label: "Outlet Avg > Target" };
}

/* --------------------------------------------------------------- filtering */

/* Every filter is multi-select and every filter is linked: the options shown
   for one field are only the values still reachable under all the other active
   selections, each with the number of outlets behind it. Selecting nothing in a
   field means "all", which is why an empty set never excludes anything. */

const DIMENSION_FILTERS = [
  { field: "regionalLeader", label: "Regional Leader", all: "All Regional Leaders", searchable: true },
  { field: "zone", label: "Zonal", all: "All Zonals", searchable: true },
  { field: "division", label: "Division", all: "All Divisions", searchable: true },
  { field: "district", label: "District", all: "All Districts", searchable: true },
  { field: "format", label: "Outlet Format", all: "All Formats", searchable: false },
  { field: "criteria", label: "Final Criteria", all: "All Criteria", searchable: true },
  { field: "pnpStatus", label: "PNP Status", all: "All", searchable: false },
  { field: "ownership", label: "Ownership", all: "All", searchable: false },
];

const STATUS_OPTIONS = [
  { value: "above-any", label: "Above any target" },
  { value: "within-all", label: "Within all targets" },
  { value: "unmapped", label: "Unmapped outlets" },
  { value: "reversal", label: "Net reversal outlets" },
];

// field -> Set of selected values. Status is kept alongside but is applied
// after aggregation, so it does not drive the linked option lists.
const selections = new Map(DIMENSION_FILTERS.map((item) => [item.field, new Set()]));
selections.set("status", new Set());

function readFilters() {
  const filters = {
    dateFrom: $("#dateFrom").value,
    dateTo: $("#dateTo").value,
    outletSearch: $("#outletSearch").value.trim().toLocaleLowerCase(),
    status: selections.get("status"),
  };
  DIMENSION_FILTERS.forEach((item) => {
    filters[item.field] = selections.get(item.field);
  });
  return filters;
}

function matchesSearch(outlet, query) {
  if (!query) return true;
  return `${outlet.code} ${outlet.name}`.toLocaleLowerCase().includes(query);
}

// `skipField` powers the linked lists: to work out what Zonal values are still
// reachable, match on every field except Zonal itself.
function metadataMatches(outlet, filters, skipField = null) {
  for (const item of DIMENSION_FILTERS) {
    if (item.field === skipField) continue;
    const chosen = filters[item.field];
    if (chosen && chosen.size && !chosen.has(outlet[item.field])) return false;
  }
  return matchesSearch(outlet, filters.outletSearch);
}

function optionsFor(field, filters) {
  const counts = new Map();
  for (const outlet of state.data.outlets) {
    if (!metadataMatches(outlet, filters, field)) continue;
    const value = outlet[field];
    if (value == null || !String(value).trim()) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  // A value already chosen stays listed even if other filters now exclude it,
  // so a selection can always be undone.
  for (const value of selections.get(field)) {
    if (!counts.has(value)) counts.set(value, 0);
  }
  return [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function selectionLabel(field, config) {
  const chosen = selections.get(field);
  if (!chosen.size) return config.all;
  if (chosen.size === 1) return [...chosen][0];
  return `${chosen.size} selected`;
}

function buildFilterControls() {
  const stack = $("#filterStack");
  stack.innerHTML = [
    ...DIMENSION_FILTERS.map(
      (item) => `<div class="ms" data-field="${item.field}">
        <div class="ms-label"><span>${escapeHtml(item.label)}</span><b data-badge hidden></b></div>
        <button class="ms-button" type="button" aria-expanded="false" aria-haspopup="listbox">
          <span class="ms-value">${escapeHtml(item.all)}</span><span class="ms-caret" aria-hidden="true">▾</span>
        </button>
        <div class="ms-panel" hidden>
          ${item.searchable ? '<input class="ms-search" type="search" placeholder="Search…" autocomplete="off">' : ""}
          <div class="ms-tools">
            <button type="button" data-select-all>Select all</button>
            <button type="button" data-clear>Clear</button>
            <span class="ms-count" data-count></span>
          </div>
          <div class="ms-options" role="listbox" aria-multiselectable="true"></div>
        </div>
      </div>`
    ),
    `<div class="ms" data-field="status">
      <div class="ms-label"><span>Performance status</span><b data-badge hidden></b></div>
      <button class="ms-button" type="button" aria-expanded="false" aria-haspopup="listbox">
        <span class="ms-value">All outlets</span><span class="ms-caret" aria-hidden="true">▾</span>
      </button>
      <div class="ms-panel" hidden>
        <div class="ms-tools"><button type="button" data-clear>Clear</button><span class="ms-count" data-count></span></div>
        <div class="ms-options" role="listbox" aria-multiselectable="true"></div>
      </div>
    </div>`,
  ].join("");
}

function renderFilterOptions(root) {
  const field = root.dataset.field;
  const config = DIMENSION_FILTERS.find((item) => item.field === field);
  const chosen = selections.get(field);
  const container = $(".ms-options", root);
  const query = ($(".ms-search", root)?.value || "").trim().toLocaleLowerCase();
  // Ticking a box re-renders this list, so keep the reader where they were.
  const scrollTop = container.scrollTop;

  let entries;
  if (field === "status") {
    entries = STATUS_OPTIONS.map((option) => [option.value, null, option.label]);
  } else {
    entries = optionsFor(field, readFilters())
      .filter(([value]) => !query || String(value).toLocaleLowerCase().includes(query))
      .map(([value, count]) => [value, count, value]);
  }

  container.innerHTML = entries.length
    ? entries
        .map(
          ([value, count, label]) => `<button class="ms-option" type="button" role="option"
            aria-selected="${chosen.has(value)}" data-value="${escapeHtml(value)}">
            <span class="ms-box" aria-hidden="true">✓</span>
            <span class="ms-option-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
            ${count == null ? "" : `<span class="ms-option-count">${formatInteger(count)}</span>`}
          </button>`
        )
        .join("")
    : '<div class="ms-empty">Nothing matches the other filters.</div>';
  container.scrollTop = scrollTop;

  const countLabel = $("[data-count]", root);
  if (countLabel) countLabel.textContent = chosen.size ? `${chosen.size} selected` : `${entries.length} available`;

  const badge = $("[data-badge]", root);
  badge.hidden = !chosen.size;
  badge.textContent = chosen.size ? `${chosen.size}` : "";
  $(".ms-value", root).textContent =
    field === "status"
      ? chosen.size === 0
        ? "All outlets"
        : chosen.size === 1
          ? STATUS_OPTIONS.find((option) => option.value === [...chosen][0])?.label || "1 selected"
          : `${chosen.size} selected`
      : selectionLabel(field, config);
  root.classList.toggle("is-active", chosen.size > 0);
}

function refreshAllFilterControls() {
  $$("#filterStack .ms").forEach((root) => renderFilterOptions(root));
  renderActiveFilterPills();
}

function renderActiveFilterPills() {
  const container = $("#activeFilterSummary");
  const pills = [];
  for (const item of [...DIMENSION_FILTERS, { field: "status", label: "Status" }]) {
    for (const value of selections.get(item.field)) {
      const label =
        item.field === "status"
          ? STATUS_OPTIONS.find((option) => option.value === value)?.label || value
          : value;
      pills.push(
        `<span class="filter-pill">${escapeHtml(label)}<button type="button" data-remove-field="${escapeHtml(item.field)}" data-remove-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(label)}">×</button></span>`
      );
    }
  }
  container.hidden = pills.length === 0;
  container.innerHTML = pills.join("");
}

function closeFilterPanels(except = null) {
  $$("#filterStack .ms").forEach((root) => {
    if (root === except) return;
    $(".ms-panel", root).hidden = true;
    $(".ms-button", root).setAttribute("aria-expanded", "false");
  });
}

function attachFilterEvents() {
  const stack = $("#filterStack");

  stack.addEventListener("click", (event) => {
    const root = event.target.closest(".ms");
    if (!root) return;
    const field = root.dataset.field;

    if (event.target.closest(".ms-button")) {
      const panel = $(".ms-panel", root);
      const willOpen = panel.hidden;
      closeFilterPanels(root);
      panel.hidden = !willOpen;
      $(".ms-button", root).setAttribute("aria-expanded", String(willOpen));
      if (willOpen) {
        renderFilterOptions(root);
        $(".ms-search", root)?.focus();
      }
      return;
    }

    const option = event.target.closest(".ms-option");
    if (option) {
      const chosen = selections.get(field);
      const value = option.dataset.value;
      if (chosen.has(value)) chosen.delete(value);
      else chosen.add(value);
      state.tablePage = 1;
      refreshAllFilterControls();
      renderAll();
      return;
    }

    if (event.target.closest("[data-select-all]")) {
      const chosen = selections.get(field);
      const query = ($(".ms-search", root)?.value || "").trim().toLocaleLowerCase();
      optionsFor(field, readFilters())
        .filter(([value]) => !query || String(value).toLocaleLowerCase().includes(query))
        .forEach(([value]) => chosen.add(value));
      state.tablePage = 1;
      refreshAllFilterControls();
      renderAll();
      return;
    }

    if (event.target.closest("[data-clear]")) {
      selections.get(field).clear();
      state.tablePage = 1;
      refreshAllFilterControls();
      renderAll();
    }
  });

  stack.addEventListener("input", (event) => {
    if (event.target.classList.contains("ms-search")) {
      renderFilterOptions(event.target.closest(".ms"));
    }
  });

  $("#activeFilterSummary").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-field]");
    if (!button) return;
    selections.get(button.dataset.removeField).delete(button.dataset.removeValue);
    state.tablePage = 1;
    refreshAllFilterControls();
    renderAll();
  });

  // Capture phase: ticking an option re-renders the list, which detaches the
  // clicked node. By the bubble phase `closest()` would no longer find the
  // stack and every panel would close after a single pick.
  document.addEventListener(
    "click",
    (event) => {
      if (!event.target.closest("#filterStack")) closeFilterPanels();
    },
    true
  );
}

function emptyBucket() {
  return { sales: 0, pnpSales: 0, consumable: 0, wastage: 0 };
}

function addRow(bucket, row) {
  bucket.sales += safeNumber(row.sales);
  bucket.pnpSales += safeNumber(row.pnpSales);
  bucket.consumable += safeNumber(row.consumable);
  bucket.wastage += safeNumber(row.wastage);
}

function aggregateByOutlet(codes, from, to) {
  const buckets = new Map();
  codes.forEach((code) => buckets.set(code, emptyBucket()));
  for (const row of state.data.daily) {
    if (!buckets.has(row.code)) continue;
    if (from && row.date < from) continue;
    if (to && row.date > to) continue;
    addRow(buckets.get(row.code), row);
  }
  return buckets;
}

function decorate(outlet, bucket) {
  const metric = { ...outlet, ...(bucket || emptyBucket()) };
  for (const [key, definition] of Object.entries(METRICS)) {
    metric[key] = ratio(metric[definition.numerator], metric[definition.denominator]);
  }
  metric.statuses = {};
  for (const [key, definition] of Object.entries(METRICS)) {
    metric.statuses[key] = compareStatus(metric[key], metric[definition.target], metric[definition.numerator]);
  }
  metric.aboveAny = Object.values(metric.statuses).some((status) => status.key === "bad");
  metric.hasComparableTarget = Object.values(metric.statuses).some((status) => status.key !== "neutral");
  metric.withinAll = metric.hasComparableTarget && !metric.aboveAny;
  // Taka over target. This is what makes the exception list financially ranked.
  metric.excess = {};
  metric.excessTotal = 0;
  for (const [key, definition] of Object.entries(METRICS)) {
    const target = metric[definition.target];
    const base = metric[definition.denominator];
    const actual = metric[key];
    const over = isNumber(actual) && isNumber(target) && base > 0 && actual > target ? (actual - target) * base : 0;
    metric.excess[key] = over;
  }
  // Consumable and wastage are separate spends; wastage/sales and wastage/PNP
  // measure the same taka twice, so only the larger of the two is counted.
  metric.excessTotal =
    metric.excess.consumableRate + Math.max(metric.excess.wastageSalesRate, metric.excess.wastagePnpRate);
  return metric;
}

const STATUS_TESTS = {
  "above-any": (row) => row.aboveAny,
  "within-all": (row) => row.withinAll,
  unmapped: (row) => !row.mapped,
  reversal: (row) => row.consumable < 0 || row.wastage < 0,
};

// Several statuses selected means "any of these", not "all of these".
function applyStatusFilter(metrics, statusFilter) {
  if (!statusFilter || !statusFilter.size) return metrics;
  const tests = [...statusFilter].map((key) => STATUS_TESTS[key]).filter(Boolean);
  if (!tests.length) return metrics;
  return metrics.filter((row) => tests.some((test) => test(row)));
}

function weightedTarget(metrics, metricKey) {
  const definition = METRICS[metricKey];
  let weighted = 0;
  let denominator = 0;
  for (const row of metrics) {
    const base = safeNumber(row[definition.denominator]);
    const target = row[definition.target];
    if (base > 0 && isNumber(target)) {
      weighted += base * target;
      denominator += base;
    }
  }
  return denominator > 0 ? weighted / denominator : null;
}

function outletAverage(metrics, metricKey) {
  const values = metrics.map((row) => row[metricKey]).filter(isNumber);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function summarize(metrics) {
  const summary = metrics.reduce(
    (result, row) => {
      addRow(result, row);
      result.aboveAny += Number(row.aboveAny);
      result.mapped += Number(row.mapped);
      result.excessTotal += row.excessTotal || 0;
      return result;
    },
    { ...emptyBucket(), aboveAny: 0, mapped: 0, excessTotal: 0 }
  );
  summary.outlets = metrics.length;
  summary.targets = {};
  summary.averages = {};
  summary.statuses = {};
  for (const [key, definition] of Object.entries(METRICS)) {
    summary[key] = ratio(summary[definition.numerator], summary[definition.denominator]);
    summary.targets[key] = weightedTarget(metrics, key);
    summary.averages[key] = outletAverage(metrics, key);
    summary.statuses[key] = compareStatus(summary[key], summary.targets[key], summary[definition.numerator]);
  }
  return summary;
}

/* --------------------------------------------------------- period compare */

// The sources hold one continuous window, so the comparison period is the
// equal-length window immediately before the selection. If it does not fit
// inside the loaded data the comparison is reported unavailable rather than
// silently truncated to a shorter, non-comparable window.
function resolvePriorPeriod(from, to) {
  if (!from || !to || from > to) return null;
  const length = daysBetween(from, to);
  const priorTo = shiftDate(from, -1);
  const priorFrom = shiftDate(priorTo, -(length - 1));
  if (priorFrom < state.data.dateRange.min) return null;
  return { from: priorFrom, to: priorTo, days: length };
}

function buildViewModel() {
  const filters = readFilters();
  const invertedRange = Boolean(filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo);

  const candidates = state.data.outlets.filter((outlet) => metadataMatches(outlet, filters));
  const codes = candidates.map((outlet) => outlet.code);
  const buckets = invertedRange ? new Map() : aggregateByOutlet(codes, filters.dateFrom, filters.dateTo);

  let metrics = candidates.map((outlet) => decorate(outlet, buckets.get(outlet.code)));
  metrics = applyStatusFilter(metrics, filters.status);
  const finalCodes = new Set(metrics.map((row) => row.code));

  const dailyMap = new Map();
  if (!invertedRange) {
    for (const row of state.data.daily) {
      if (!finalCodes.has(row.code)) continue;
      if (filters.dateFrom && row.date < filters.dateFrom) continue;
      if (filters.dateTo && row.date > filters.dateTo) continue;
      if (!dailyMap.has(row.date)) dailyMap.set(row.date, { date: row.date, ...emptyBucket() });
      addRow(dailyMap.get(row.date), row);
    }
  }
  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  daily.forEach((day) => {
    for (const [key, definition] of Object.entries(METRICS)) {
      day[key] = ratio(day[definition.numerator], day[definition.denominator]);
    }
  });

  const view = {
    filters,
    invertedRange,
    metrics,
    daily,
    summary: summarize(metrics),
    prior: null,
    priorAvailable: false,
  };

  const priorPeriod = invertedRange ? null : resolvePriorPeriod(filters.dateFrom, filters.dateTo);
  view.priorPeriod = priorPeriod;
  view.priorAvailable = Boolean(priorPeriod);

  if (state.compare && priorPeriod) {
    const priorBuckets = aggregateByOutlet(Array.from(finalCodes), priorPeriod.from, priorPeriod.to);
    const priorMetrics = metrics.map((row) =>
      decorate(state.data.outlets.find((outlet) => outlet.code === row.code) || row, priorBuckets.get(row.code))
    );
    const priorByCode = new Map(priorMetrics.map((row) => [row.code, row]));
    metrics.forEach((row) => {
      row.prior = priorByCode.get(row.code) || null;
    });

    const priorDaily = new Map();
    for (const row of state.data.daily) {
      if (!finalCodes.has(row.code)) continue;
      if (row.date < priorPeriod.from || row.date > priorPeriod.to) continue;
      if (!priorDaily.has(row.date)) priorDaily.set(row.date, { date: row.date, ...emptyBucket() });
      addRow(priorDaily.get(row.date), row);
    }
    const priorSeries = Array.from(priorDaily.values()).sort((a, b) => a.date.localeCompare(b.date));
    priorSeries.forEach((day) => {
      for (const [key, definition] of Object.entries(METRICS)) {
        day[key] = ratio(day[definition.numerator], day[definition.denominator]);
      }
    });

    view.prior = { ...priorPeriod, summary: summarize(priorMetrics), daily: priorSeries };
  } else {
    metrics.forEach((row) => {
      row.prior = null;
    });
  }

  return view;
}

/* --------------------------------------------------------------- controls */

function initializeFilters() {
  buildFilterControls();
  const { min, max } = state.data.dateRange;
  ["#dateFrom", "#dateTo"].forEach((selector) => {
    $(selector).min = min;
    $(selector).max = max;
  });
  $("#dateFrom").value = min;
  $("#dateTo").value = max;
}

function applyQuickPeriod(value) {
  const { min, max } = state.data.dateRange;
  if (value === "all") {
    $("#dateFrom").value = min;
    $("#dateTo").value = max;
    return;
  }
  if (value === "mtd") {
    const start = `${max.slice(0, 7)}-01`;
    $("#dateFrom").value = start < min ? min : start;
    $("#dateTo").value = max;
    return;
  }
  const days = Number(value);
  const from = shiftDate(max, -(days - 1));
  $("#dateFrom").value = from < min ? min : from;
  $("#dateTo").value = max;
}

/* ------------------------------------------------------------------- KPIs */

function deltaMarkup(current, prior, { invert = false } = {}) {
  if (!isNumber(current) || !isNumber(prior)) return "";
  const change = current - prior;
  if (Math.abs(change) <= STATUS_TOLERANCE / 10) {
    return `<span class="delta delta-flat">■ no change</span>`;
  }
  const worse = invert ? change < 0 : change > 0;
  const arrow = change > 0 ? "▲" : "▼";
  return `<span class="delta ${worse ? "delta-up" : "delta-down"}">${arrow} ${escapeHtml(formatPoints(change))}</span>`;
}

function valueDeltaMarkup(current, prior) {
  if (!isNumber(current) || !isNumber(prior) || prior === 0) return "";
  const change = (current - prior) / Math.abs(prior);
  const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "■";
  const tone = change > 0 ? "delta-up" : change < 0 ? "delta-down" : "delta-flat";
  return `<span class="delta ${tone}">${arrow} ${(Math.abs(change) * 100).toFixed(1)}%</span>`;
}

function kpiCard({ label, value, sub, footLeft, footRight, accent }) {
  return `<article class="kpi" style="--accent:${accent}">
    <div class="kpi-top"><span class="kpi-label">${escapeHtml(label)}</span></div>
    <div class="kpi-value">${escapeHtml(value)}</div>
    <div class="kpi-sub">${sub}</div>
    <div class="kpi-foot"><span>${footLeft}</span><span>${footRight}</span></div>
  </article>`;
}

function renderKpis(view) {
  const { summary } = view;
  const prior = view.prior?.summary || null;

  const cards = [
    kpiCard({
      label: "Overall POS NSI",
      value: formatBDT(summary.sales),
      sub: `PNP Sales <strong>${escapeHtml(formatBDT(summary.pnpSales))}</strong>`,
      footLeft: `${formatInteger(summary.outlets)} outlets`,
      footRight: prior ? valueDeltaMarkup(summary.sales, prior.sales) : "",
      accent: "var(--series-2)",
    }),
    kpiCard({
      label: "Consumable % on Sales",
      value: formatPercent(summary.consumableRate),
      sub: `${chip(summary.statuses.consumableRate)} Target ${escapeHtml(formatPercent(summary.targets.consumableRate))}`,
      footLeft: `Value ${escapeHtml(formatBDT(summary.consumable))}`,
      footRight: prior
        ? deltaMarkup(summary.consumableRate, prior.consumableRate)
        : chip(averageVsTarget(summary.averages.consumableRate, summary.targets.consumableRate),
               `Avg ${formatPercent(summary.averages.consumableRate)}`),
      accent: "var(--series-1)",
    }),
    kpiCard({
      label: "Wastage % on Sales",
      value: formatPercent(summary.wastageSalesRate),
      sub: `${chip(summary.statuses.wastageSalesRate)} Target ${escapeHtml(formatPercent(summary.targets.wastageSalesTarget ?? summary.targets.wastageSalesRate))}`,
      footLeft: `Value ${escapeHtml(formatBDT(summary.wastage))}`,
      footRight: prior
        ? deltaMarkup(summary.wastageSalesRate, prior.wastageSalesRate)
        : chip(averageVsTarget(summary.averages.wastageSalesRate, summary.targets.wastageSalesRate),
               `Avg ${formatPercent(summary.averages.wastageSalesRate)}`),
      accent: "var(--series-3)",
    }),
    kpiCard({
      label: "Wastage % on PNP Sales",
      value: formatPercent(summary.wastagePnpRate),
      sub: `${chip(summary.statuses.wastagePnpRate)} Target ${escapeHtml(formatPercent(summary.targets.wastagePnpRate))}`,
      footLeft: "FRESH PRODUCE base",
      footRight: prior
        ? deltaMarkup(summary.wastagePnpRate, prior.wastagePnpRate)
        : chip(averageVsTarget(summary.averages.wastagePnpRate, summary.targets.wastagePnpRate),
               `Avg ${formatPercent(summary.averages.wastagePnpRate)}`),
      accent: "var(--series-2)",
    }),
    kpiCard({
      label: "Value over target",
      value: formatBDT(summary.excessTotal),
      sub: `<strong>${formatInteger(summary.aboveAny)}</strong> outlets above at least one target`,
      footLeft: `${formatInteger(summary.outlets - summary.mapped)} unmapped`,
      footRight: prior ? valueDeltaMarkup(summary.excessTotal, prior.excessTotal) : "",
      accent: summary.aboveAny ? "var(--bad)" : "var(--good)",
    }),
  ];
  $("#kpiGrid").innerHTML = cards.join("");
}

/* ------------------------------------------------------------------ chart */

function linePath(points) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

/* SAP consumable issues post in batches, so a raw daily consumable rate swings
   between 0% and 2% on posting timing rather than on behaviour. Smoothing is a
   ratio of sums over the window — never an average of daily percentages. */
function smoothSeries(rows, mode) {
  if (mode === "daily" || !rows.length) return rows;
  const window = mode === "rolling7" ? 7 : rows.length;
  return rows.map((row, index) => {
    const start = mode === "cumulative" ? 0 : Math.max(0, index - window + 1);
    const slice = rows.slice(start, index + 1);
    const totals = slice.reduce((sum, item) => {
      addRow(sum, item);
      return sum;
    }, emptyBucket());
    const smoothed = { date: row.date, ...totals };
    for (const [key, definition] of Object.entries(METRICS)) {
      smoothed[key] = ratio(totals[definition.numerator], totals[definition.denominator]);
    }
    return smoothed;
  });
}

// Flags a series whose value lands on only a few of the days in the window.
function lumpiness(rows, field) {
  const values = rows.map((row) => Math.max(0, row[field]));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || rows.length < 4) return null;
  const quiet = values.filter((value) => value < total * 0.02).length;
  return quiet >= Math.max(2, Math.round(rows.length * 0.2)) ? { quiet, days: rows.length } : null;
}

function renderTrendNote(view, mode) {
  const note = $("#trendNote");
  const batch = lumpiness(view.daily, "consumable");
  if (!batch || mode !== "daily") {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  note.textContent = `Consumable issues post in batches: ${batch.quiet} of ${batch.days} days in this range carry almost no consumable value, so the daily consumable line swings on posting timing rather than on outlet behaviour. Switch the basis to 7-day rolling or period to date to read the trend. Wastage posts daily and is unaffected.`;
}

function renderTrend(view) {
  const container = $("#trendChart");
  if (!view.daily.length || !view.summary.sales) {
    container.innerHTML = '<div class="empty-state">No daily data for the selected scope.</div>';
    $("#trendNote").hidden = true;
    return;
  }
  const mode = $("#trendSmoothing").value;
  renderTrendNote(view, mode);

  const width = 900;
  const height = 300;
  const margin = { top: 16, right: 20, bottom: 34, left: 54 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const series = [
    { key: "consumableRate", className: "series-1", dot: "series-dot-1", colour: "var(--series-1)" },
    { key: "wastagePnpRate", className: "series-2", dot: "series-dot-2", colour: "var(--series-2)" },
  ];
  const plotted = smoothSeries(view.daily, mode);
  const priorSeries = state.compare && view.prior ? smoothSeries(view.prior.daily, mode) : [];

  const values = [
    ...plotted.flatMap((day) => series.map((item) => day[item.key])),
    ...priorSeries.flatMap((day) => series.map((item) => day[item.key])),
    view.summary.targets.consumableRate,
    view.summary.targets.wastagePnpRate,
  ].filter(isNumber);
  const maxValue = Math.max(0.001, ...values) * 1.18;

  const count = Math.max(plotted.length, priorSeries.length);
  const x = (index) => margin.left + (count === 1 ? plotW / 2 : (index / (count - 1)) * plotW);
  const y = (value) => margin.top + plotH - (Math.max(0, value || 0) / maxValue) * plotH;

  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, index) => {
    const value = (maxValue / ticks) * index;
    const position = y(value);
    return `<line class="chart-grid-line" x1="${margin.left}" y1="${position}" x2="${width - margin.right}" y2="${position}"/>
      <text class="axis-label" x="${margin.left - 8}" y="${position + 3.5}" text-anchor="end">${formatPercent(value, 1)}</text>`;
  }).join("");

  const step = Math.max(1, Math.ceil(plotted.length / 9));
  const xLabels = plotted
    .map((day, index) => {
      const show = index === 0 || index === plotted.length - 1 || index % step === 0;
      return show
        ? `<text class="axis-label" x="${x(index)}" y="${height - 11}" text-anchor="middle">${escapeHtml(formatDay(day.date))}</text>`
        : "";
    })
    .join("");

  const targets = series
    .map((item) => {
      const target = view.summary.targets[item.key];
      return isNumber(target)
        ? `<line class="target-line" x1="${margin.left}" y1="${y(target)}" x2="${width - margin.right}" y2="${y(target)}" stroke="${item.colour}"><title>Target ${formatPercent(target)}</title></line>`
        : "";
    })
    .join("");

  const priorPaths = priorSeries.length
    ? series
        .map((item) => {
          const points = priorSeries
            .map((day, index) => ({ x: x(index), y: y(day[item.key]), day }))
            .filter((point) => isNumber(point.day[item.key]));
          return points.length > 1 ? `<path class="series-prior" d="${linePath(points)}"/>` : "";
        })
        .join("")
    : "";

  const paths = series
    .map((item) => {
      const points = plotted
        .map((day, index) => ({ x: x(index), y: y(day[item.key]), day }))
        .filter((point) => isNumber(point.day[item.key]));
      if (!points.length) return "";
      const line = points.length > 1 ? `<path class="series-line ${item.className}" d="${linePath(points)}"/>` : "";
      const dots = points
        .map(
          (point) =>
            `<circle class="${item.dot}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.2"><title>${escapeHtml(formatShortDate(point.day.date))} · ${escapeHtml(METRICS[item.key].short)} ${escapeHtml(formatPercent(point.day[item.key]))}</title></circle>`
        )
        .join("");
      return line + dots;
    })
    .join("");

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily consumable and wastage percentage trend">
    ${grid}${xLabels}${targets}${priorPaths}${paths}
  </svg>`;

  $("#priorLegend").hidden = !priorPaths;
  const basisLabel =
    mode === "rolling7" ? "7-day rolling" : mode === "cumulative" ? "period to date" : "daily";
  $("#trendSubtitle").textContent =
    state.compare && view.prior
      ? `${basisLabel} · solid ${formatShortDate(view.filters.dateFrom)}–${formatShortDate(view.filters.dateTo)}, dashed ${formatShortDate(view.prior.from)}–${formatShortDate(view.prior.to)}`
      : `Consumable on overall sales and wastage on PNP sales · ${basisLabel}`;
}

/* ------------------------------------------------------------------ donut */

function renderStatusDonut(view) {
  const metricKey = $("#statusMetric").value;
  const counts = view.metrics.reduce(
    (result, row) => {
      const key = row.statuses[metricKey].key;
      result[key] = (result[key] || 0) + 1;
      return result;
    },
    { good: 0, near: 0, bad: 0, neutral: 0, info: 0 }
  );
  counts.good += counts.info;
  counts.info = 0;
  const total = Math.max(1, Object.values(counts).reduce((sum, value) => sum + value, 0));
  const goodStop = (counts.good / total) * 100;
  const nearStop = goodStop + (counts.near / total) * 100;
  const badStop = nearStop + (counts.bad / total) * 100;

  $("#statusDonut").innerHTML = `
    <div class="donut" style="background:conic-gradient(var(--good) 0 ${goodStop}%, var(--warn) ${goodStop}% ${nearStop}%, var(--bad) ${nearStop}% ${badStop}%, var(--surface-3) ${badStop}% 100%)">
      <div class="donut-center"><strong>${formatInteger(counts.good + counts.near + counts.bad)}</strong><span>Comparable</span></div>
    </div>
    <div class="donut-legend">
      <div><strong style="color:var(--good)">${formatInteger(counts.good)}</strong><span>Within</span></div>
      <div><strong style="color:var(--warn)">${formatInteger(counts.near)}</strong><span>At target</span></div>
      <div><strong style="color:var(--bad)">${formatInteger(counts.bad)}</strong><span>Above</span></div>
      <div><strong>${formatInteger(counts.neutral)}</strong><span>No target</span></div>
    </div>`;
}

/* ------------------------------------------------------------- group logic */

function groupMetrics(metrics, dimension) {
  const groups = new Map();
  for (const row of metrics) {
    const key = dimension === "outlet" ? row.code : row[dimension] || "Unmapped";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Array.from(groups, ([key, rows]) => ({
    key,
    label: dimension === "outlet" ? `${rows[0].code} · ${rows[0].name}` : key,
    rows,
    ...summarize(rows),
  }));
}

function renderRanking(view) {
  const dimension = $("#rankingDimension").value;
  const metricKey = $("#rankingMetric").value;
  const definition = METRICS[metricKey];
  const groups = groupMetrics(view.metrics, dimension)
    .filter((group) => isNumber(group[metricKey]))
    .sort((a, b) => b[metricKey] - a[metricKey])
    .slice(0, 12);

  const container = $("#rankingChart");
  if (!groups.length) {
    container.innerHTML = '<div class="empty-state">No comparable groups for this metric.</div>';
    return;
  }
  const maxValue =
    Math.max(...groups.flatMap((group) => [group[metricKey] || 0, group.targets[metricKey] || 0]), 0.0001) * 1.08;

  container.innerHTML = groups
    .map((group) => {
      const actual = group[metricKey];
      const target = group.targets[metricKey];
      const status = compareStatus(actual, target, group[definition.numerator]);
      const width = Math.min(100, Math.max(0, (actual / maxValue) * 100));
      const targetPosition = isNumber(target) ? Math.min(100, Math.max(0, (target / maxValue) * 100)) : null;
      const colour = status.key === "bad" ? "var(--bad)" : status.key === "near" ? "var(--warn)" : "var(--good)";
      return `<div class="rank-row">
        <div class="rank-name"><strong title="${escapeHtml(group.label)}">${escapeHtml(group.label)}</strong><span>${formatInteger(group.outlets)} outlet${group.outlets === 1 ? "" : "s"} · ${escapeHtml(formatBDT(group.sales))}</span></div>
        <div class="bar-track" aria-label="${escapeHtml(definition.label)} ${escapeHtml(formatPercent(actual))}, target ${escapeHtml(formatPercent(target))}">
          <div class="bar-fill" style="width:${width}%;--bar-color:${colour}"></div>
          ${targetPosition == null ? "" : `<span class="bar-target" style="left:${targetPosition}%" title="Target ${escapeHtml(formatPercent(target))}"></span>`}
        </div>
        <div class="rank-value">${escapeHtml(formatPercent(actual))}</div>
        ${chip(status)}
      </div>`;
    })
    .join("");
}

/* ----------------------------------------------------------------- movers */

function renderMovers(view) {
  const panel = $("#moversPanel");
  if (!state.compare || !view.prior) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const metricKey = $("#moversMetric").value;

  const moved = view.metrics
    .filter((row) => row.prior && isNumber(row[metricKey]) && isNumber(row.prior[metricKey]))
    .map((row) => ({ row, change: row[metricKey] - row.prior[metricKey] }))
    .filter((item) => Math.abs(item.change) > STATUS_TOLERANCE);

  const worse = [...moved].sort((a, b) => b.change - a.change).slice(0, 6);
  const better = [...moved].sort((a, b) => a.change - b.change).slice(0, 6);

  const list = (items, tone) =>
    items.length
      ? items
          .map(
            ({ row, change }) => `<div class="material-row is-clickable" data-outlet="${escapeHtml(row.code)}" role="button" tabindex="0">
              <div>
                <div class="material-name">${escapeHtml(row.code)} · ${escapeHtml(row.name)}</div>
                <div class="material-qty">${escapeHtml(formatPercent(row.prior[metricKey]))} → ${escapeHtml(formatPercent(row[metricKey]))}</div>
              </div>
              <div class="material-value"><span class="delta ${tone}">${change > 0 ? "▲" : "▼"} ${escapeHtml(formatPoints(Math.abs(change)).replace("+", ""))}</span></div>
            </div>`
          )
          .join("")
      : '<div class="empty-state">No material movement.</div>';

  $("#moversWorse").innerHTML = list(worse, "delta-up");
  $("#moversBetter").innerHTML = list(better, "delta-down");
  $("#moversSubtitle").textContent = `${METRICS[metricKey].label} versus ${formatShortDate(view.prior.from)}–${formatShortDate(view.prior.to)}.`;
}

/* ----------------------------------------------------------- league table */

function leagueRows(view) {
  const dimension = $("#leagueDimension").value;
  const metricKey = $("#leagueMetric").value;
  const groups = groupMetrics(view.metrics, dimension).filter((group) => group.outlets > 0);
  const { key, direction } = state.leagueSort;
  const multiplier = direction === "asc" ? 1 : -1;

  const value = (group) => {
    if (key === "metric") return group[metricKey];
    if (key === "variance") {
      const target = group.targets[metricKey];
      return isNumber(group[metricKey]) && isNumber(target) ? group[metricKey] - target : null;
    }
    if (key === "label") return group.label;
    return group[key];
  };

  return {
    dimension,
    metricKey,
    groups: groups.sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (key === "label") return String(av).localeCompare(String(bv)) * multiplier;
      const aMissing = !isNumber(av);
      const bMissing = !isNumber(bv);
      if (aMissing && bMissing) return String(a.label).localeCompare(String(b.label));
      if (aMissing) return 1;
      if (bMissing) return -1;
      return av === bv ? String(a.label).localeCompare(String(b.label)) : (av - bv) * multiplier;
    }),
  };
}

function leagueHeader(label, key, numeric = false) {
  const active = state.leagueSort.key === key;
  const arrow = state.leagueSort.direction === "asc" ? " ↑" : " ↓";
  return `<th class="${numeric ? "numeric" : ""}"><button class="sort-button ${active ? "is-active" : ""}" data-league-sort="${key}" data-arrow="${arrow}">${escapeHtml(label)}</button></th>`;
}

function renderLeague(view) {
  const { dimension, metricKey, groups } = leagueRows(view);
  const definition = METRICS[metricKey];
  const labels = {
    zone: "Zonal",
    regionalLeader: "Regional Leader",
    division: "Division",
    district: "District",
    criteria: "Final Criteria",
  };
  $("#leagueSubtitle").textContent = `${definition.label} by ${labels[dimension]}. Weighted performance; lower is better.`;

  const container = $("#leagueTable");
  if (!groups.length) {
    container.innerHTML = '<div class="empty-state">No groups match the current filters.</div>';
    return;
  }

  container.innerHTML = `<table><thead><tr>
    <th class="numeric">#</th>
    ${leagueHeader(labels[dimension], "label")}
    ${leagueHeader("Outlets", "outlets", true)}
    ${leagueHeader("Sales Base", definition.denominator, true)}
    ${leagueHeader(definition.valueLabel, definition.numerator, true)}
    <th class="numeric">Target</th>
    ${leagueHeader("Weighted Actual", "metric", true)}
    ${leagueHeader("Variance", "variance", true)}
    ${leagueHeader("Value Over Target", "excessTotal", true)}
    <th>Status</th>
  </tr></thead><tbody>${groups
    .map((group, index) => {
      const actual = group[metricKey];
      const target = group.targets[metricKey];
      const status = compareStatus(actual, target, group[definition.numerator]);
      const variance = isNumber(actual) && isNumber(target) ? actual - target : null;
      return `<tr>
        <td class="numeric" style="color:var(--ink-3)">${index + 1}</td>
        <td><span class="cell-primary">${escapeHtml(group.label)}</span></td>
        <td class="numeric">${formatInteger(group.outlets)}</td>
        <td class="numeric">${escapeHtml(formatBDT(group[definition.denominator]))}</td>
        <td class="numeric">${escapeHtml(formatBDT(group[definition.numerator]))}</td>
        <td class="numeric">${escapeHtml(formatPercent(target))}</td>
        <td class="numeric"><strong>${escapeHtml(formatPercent(actual))}</strong></td>
        <td class="numeric" style="color:${variance != null && variance > 0 ? "var(--bad)" : "var(--good)"}">${escapeHtml(formatPoints(variance))}</td>
        <td class="numeric">${escapeHtml(formatBDT(group.excessTotal))}</td>
        <td>${chip(status)}</td>
      </tr>`;
    })
    .join("")}</tbody></table>`;
}

/* -------------------------------------------------------------- exceptions */

function exceptionItems(view) {
  const metricKey = $("#exceptionMetric").value;
  const items = view.metrics
    .map((row) => {
      if (metricKey === "all") {
        const worst = METRIC_KEYS.filter((key) => row.excess[key] > 0).sort((a, b) => row.excess[b] - row.excess[a])[0];
        return { row, value: row.excessTotal, metricKey: worst || null };
      }
      return { row, value: row.excess[metricKey], metricKey };
    })
    .filter((item) => item.value > 0 && item.metricKey);
  return items.sort((a, b) => b.value - a.value);
}

function renderExceptions(view) {
  const items = exceptionItems(view);
  $("#exceptionCount").textContent = items.length ? formatInteger(items.length) : "";

  const totalExposure = items.reduce((sum, item) => sum + item.value, 0);
  const consumableExposure = view.metrics.reduce((sum, row) => sum + row.excess.consumableRate, 0);
  const wastageExposure = view.metrics.reduce(
    (sum, row) => sum + Math.max(row.excess.wastageSalesRate, row.excess.wastagePnpRate),
    0
  );

  $("#exceptionSummary").innerHTML = [
    kpiCard({
      label: "Total value over target",
      value: formatBDT(totalExposure),
      sub: `Across <strong>${formatInteger(items.length)}</strong> outlets in the current selection`,
      footLeft: "Excess ÷ target basis",
      footRight: "",
      accent: "var(--bad)",
    }),
    kpiCard({
      label: "Consumable exposure",
      value: formatBDT(consumableExposure),
      sub: "Spend above the consumable target",
      footLeft: `${formatInteger(view.metrics.filter((row) => row.excess.consumableRate > 0).length)} outlets`,
      footRight: "",
      accent: "var(--series-1)",
    }),
    kpiCard({
      label: "Wastage exposure",
      value: formatBDT(wastageExposure),
      sub: "Higher of the sales and PNP wastage gaps",
      footLeft: `${formatInteger(view.metrics.filter((row) => Math.max(row.excess.wastageSalesRate, row.excess.wastagePnpRate) > 0).length)} outlets`,
      footRight: "",
      accent: "var(--series-3)",
    }),
  ].join("");

  const container = $("#exceptionList");
  if (!items.length) {
    container.innerHTML = '<div class="empty-state">No outlet in this selection is above its applicable target.</div>';
    return;
  }
  container.innerHTML = items
    .slice(0, 100)
    .map(({ row, value, metricKey }, index) => {
      const definition = METRICS[metricKey];
      const target = row[definition.target];
      return `<div class="exception-row is-clickable" data-outlet="${escapeHtml(row.code)}" role="button" tabindex="0">
        <div class="exception-rank">${index + 1}</div>
        <div class="exception-main">
          <strong>${escapeHtml(row.code)} · ${escapeHtml(row.name)}</strong>
          <div class="exception-meta">${escapeHtml(row.zone)} · ${escapeHtml(row.regionalLeader)} · ${escapeHtml(definition.short)} ${escapeHtml(formatPercent(row[metricKey]))} vs target ${escapeHtml(formatPercent(target))} (${escapeHtml(formatPoints(row[metricKey] - target))})</div>
        </div>
        <div class="exception-value"><strong>${escapeHtml(formatBDT(value))}</strong><span>over target</span></div>
      </div>`;
    })
    .join("");
}

/* -------------------------------------------------------------- benchmarks */

function renderBenchmarks(view) {
  const metricKey = $("#benchmarkMetric").value;
  const definition = METRICS[metricKey];
  const groups = groupMetrics(view.metrics, "criteria").sort((a, b) => a.label.localeCompare(b.label));

  const table = $("#benchmarkTable");
  table.innerHTML = groups.length
    ? `<table><thead><tr>
        <th>Final Criteria</th><th class="numeric">Outlets</th><th class="numeric">Sales Base</th>
        <th class="numeric">Target</th><th class="numeric">Weighted Actual</th><th class="numeric">Outlet Average</th>
        <th class="numeric">Avg vs Target</th><th>Highlight</th>
      </tr></thead><tbody>${groups
        .map((group) => {
          const target = group.targets[metricKey];
          const actual = group[metricKey];
          const average = group.averages[metricKey];
          return `<tr>
            <td><span class="cell-primary">${escapeHtml(group.label)}</span></td>
            <td class="numeric">${formatInteger(group.outlets)}</td>
            <td class="numeric">${escapeHtml(formatBDT(group[definition.denominator]))}</td>
            <td class="numeric"><strong>${escapeHtml(formatPercent(target))}</strong></td>
            <td class="numeric"><div class="rate-pair"><strong>${escapeHtml(formatPercent(actual))}</strong>${chip(compareStatus(actual, target, group[definition.numerator]))}</div></td>
            <td class="numeric"><strong>${escapeHtml(formatPercent(average))}</strong></td>
            <td class="numeric">${escapeHtml(formatPoints(isNumber(average) && isNumber(target) ? average - target : null))}</td>
            <td>${chip(averageVsTarget(average, target))}</td>
          </tr>`;
        })
        .join("")}</tbody></table>`
    : '<div class="empty-state">No benchmark criteria for the selected scope.</div>';

  $("#benchmarkCards").innerHTML = METRIC_KEYS.map((key) => {
    const item = METRICS[key];
    return `<article class="panel"><div class="panel-body">
      <span class="eyebrow">Selected scope</span>
      <h3 style="font-size:15px;margin:4px 0 12px">${escapeHtml(item.label)}</h3>
      <div class="stat-grid">
        <div class="stat"><span>Weighted target</span><strong>${escapeHtml(formatPercent(view.summary.targets[key]))}</strong></div>
        <div class="stat"><span>Weighted actual</span><strong>${escapeHtml(formatPercent(view.summary[key]))}</strong></div>
        <div class="stat"><span>Outlet average</span><strong>${escapeHtml(formatPercent(view.summary.averages[key]))}</strong></div>
      </div>
      <div style="margin-top:12px">${chip(averageVsTarget(view.summary.averages[key], view.summary.targets[key]))}</div>
    </div></article>`;
  }).join("");
}

/* --------------------------------------------------------------- materials */

function materialRows(rows, accent) {
  if (!rows || !rows.length) return '<div class="empty-state">No material detail recorded.</div>';
  const catalog = state.data.materialCatalog || [];
  const max = Math.max(...rows.map(([, value]) => value), 1);
  return rows
    .map(([id, value, quantity]) => {
      const entry = catalog[id] || ["", "Unknown material", ""];
      return `<div class="material-row" style="--accent:${accent}">
        <div>
          <div class="material-name" title="${escapeHtml(entry[1])}">${escapeHtml(entry[1])}</div>
          <div class="material-qty">${escapeHtml(entry[0])}${quantity ? ` · ${escapeHtml(formatQuantity(quantity, entry[2]))}` : ""}</div>
        </div>
        <div class="material-value">${escapeHtml(formatBDT(value))}</div>
        <div class="material-bar"><i style="width:${Math.max(2, (value / max) * 100).toFixed(1)}%"></i></div>
      </div>`;
    })
    .join("");
}

function renderMaterials() {
  const leaders = state.data.materialLeaders || {};
  $("#materialsWastage").innerHTML = materialRows(leaders.wastage, "var(--series-3)");
  $("#materialsConsumable").innerHTML = materialRows(leaders.consumable, "var(--series-1)");
}

/* ---------------------------------------------------------- outlet table */

const NUMERIC_SORT_KEYS = new Set([
  "sales", "pnpSales", "consumable", "wastage", "excessTotal",
  "consumableRate", "wastageSalesRate", "wastagePnpRate",
]);

function filteredTableMetrics(view) {
  const query = state.tableSearch.trim().toLocaleLowerCase();
  if (!query) return [...view.metrics];
  return view.metrics.filter((row) =>
    `${row.code} ${row.name} ${row.zone} ${row.regionalLeader} ${row.division} ${row.district} ${row.criteria}`
      .toLocaleLowerCase()
      .includes(query)
  );
}

function sortMetrics(metrics) {
  const { key, direction } = state.tableSort;
  const multiplier = direction === "asc" ? 1 : -1;
  const numeric = NUMERIC_SORT_KEYS.has(key);
  return metrics.sort((a, b) => {
    const av = key === "outlet" ? `${a.code} ${a.name}` : a[key];
    const bv = key === "outlet" ? `${b.code} ${b.name}` : b[key];
    if (numeric) {
      // Outlets with no denominator have no rate. Keep them at the bottom in
      // both directions rather than letting them interleave with real values.
      const aMissing = !isNumber(av);
      const bMissing = !isNumber(bv);
      if (aMissing && bMissing) return a.code.localeCompare(b.code);
      if (aMissing) return 1;
      if (bMissing) return -1;
      return av === bv ? a.code.localeCompare(b.code) : (av - bv) * multiplier;
    }
    const result = String(av ?? "").localeCompare(String(bv ?? "")) * multiplier;
    return result !== 0 ? result : a.code.localeCompare(b.code);
  });
}

function sortHeader(label, key, numeric = false) {
  const active = state.tableSort.key === key;
  const arrow = state.tableSort.direction === "asc" ? " ↑" : " ↓";
  return `<th class="${numeric ? "numeric" : ""}"><button class="sort-button ${active ? "is-active" : ""}" data-sort="${key}" data-arrow="${arrow}">${escapeHtml(label)}</button></th>`;
}

function rateCell(row, metricKey) {
  const definition = METRICS[metricKey];
  return `<div class="rate-pair"><strong>${escapeHtml(formatPercent(row[metricKey]))}</strong>${chip(row.statuses[metricKey])}</div>
    <span class="cell-secondary">Target ${escapeHtml(formatPercent(row[definition.target]))}</span>`;
}

function renderOutletTable(view) {
  const allRows = sortMetrics(filteredTableMetrics(view));
  const pages = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE));
  state.tablePage = Math.min(Math.max(1, state.tablePage), pages);
  const start = (state.tablePage - 1) * PAGE_SIZE;
  const rows = allRows.slice(start, start + PAGE_SIZE);

  $("#outletTableSubtitle").textContent = `${formatInteger(allRows.length)} outlets after dashboard and table filters · click a row for the outlet profile`;

  const container = $("#outletTable");
  container.innerHTML = rows.length
    ? `<table><thead><tr>
        ${sortHeader("Outlet", "outlet")}${sortHeader("Regional Leader", "regionalLeader")}${sortHeader("Zonal", "zone")}
        ${sortHeader("Division", "division")}${sortHeader("District", "district")}<th>Final Criteria</th>
        ${sortHeader("Overall Sales", "sales", true)}${sortHeader("PNP Sales", "pnpSales", true)}
        ${sortHeader("Consumable", "consumable", true)}${sortHeader("Consumable %", "consumableRate", true)}
        ${sortHeader("Wastage", "wastage", true)}${sortHeader("Wastage/Sales", "wastageSalesRate", true)}
        ${sortHeader("Wastage/PNP", "wastagePnpRate", true)}${sortHeader("Over Target", "excessTotal", true)}
      </tr></thead><tbody>${rows
        .map(
          (row) => `<tr class="is-clickable" data-outlet="${escapeHtml(row.code)}" tabindex="0">
            <td><span class="cell-primary">${escapeHtml(row.code)}</span><span class="cell-secondary">${escapeHtml(row.name)}</span></td>
            <td>${escapeHtml(row.regionalLeader)}</td><td>${escapeHtml(row.zone)}</td>
            <td>${escapeHtml(row.division)}</td><td>${escapeHtml(row.district)}</td>
            <td><span class="cell-secondary">${escapeHtml(row.criteria)}</span></td>
            <td class="numeric">${escapeHtml(formatMoneyExact(row.sales))}</td>
            <td class="numeric">${escapeHtml(formatMoneyExact(row.pnpSales))}</td>
            <td class="numeric">${escapeHtml(formatMoneyExact(row.consumable))}</td>
            <td class="numeric">${rateCell(row, "consumableRate")}</td>
            <td class="numeric">${escapeHtml(formatMoneyExact(row.wastage))}</td>
            <td class="numeric">${rateCell(row, "wastageSalesRate")}</td>
            <td class="numeric">${rateCell(row, "wastagePnpRate")}</td>
            <td class="numeric" style="color:${row.excessTotal > 0 ? "var(--bad)" : "var(--ink-3)"}">${escapeHtml(row.excessTotal > 0 ? formatBDT(row.excessTotal) : "—")}</td>
          </tr>`
        )
        .join("")}</tbody></table>`
    : '<div class="empty-state">No outlets match the selected filters.</div>';

  $("#paginationSummary").textContent = allRows.length
    ? `Showing ${formatInteger(start + 1)}–${formatInteger(Math.min(start + PAGE_SIZE, allRows.length))} of ${formatInteger(allRows.length)}`
    : "No matching outlets";
  $("#pageNumber").textContent = `Page ${state.tablePage} of ${pages}`;
  $("#previousPage").disabled = state.tablePage <= 1;
  $("#nextPage").disabled = state.tablePage >= pages;
}

/* ------------------------------------------------------------ outlet drawer */

function outletDailySeries(code, from, to) {
  const rows = [];
  for (const row of state.data.daily) {
    if (row.code !== code) continue;
    if (from && row.date < from) continue;
    if (to && row.date > to) continue;
    rows.push(row);
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function sparkline(rows, metricKey, colour) {
  const definition = METRICS[metricKey];
  const points = rows.map((row) => ratio(row[definition.numerator], row[definition.denominator]));
  const usable = points.filter(isNumber);
  if (usable.length < 2) return '<div class="empty-state" style="padding:14px">Not enough days to chart.</div>';
  const width = 480;
  const height = 96;
  const max = Math.max(...usable) * 1.15 || 0.001;
  const step = points.length === 1 ? 0 : width / (points.length - 1);
  // The command letter follows emission order, not array position: a day with
  // no denominator is skipped, so index 0 is not always the first drawn point.
  let started = false;
  const path = points
    .map((value, index) => {
      if (!isNumber(value)) return "";
      const command = started ? "L" : "M";
      started = true;
      return `${command}${(index * step).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(definition.label)} daily trend" style="width:100%;height:96px">
    <path d="${path}" fill="none" stroke="${colour}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function rankOf(code, metricKey, pool) {
  const ranked = pool.filter((row) => isNumber(row[metricKey])).sort((a, b) => b[metricKey] - a[metricKey]);
  const position = ranked.findIndex((row) => row.code === code);
  return position < 0 ? null : { position: position + 1, total: ranked.length };
}

function openOutlet(code) {
  const view = state.view;
  const row = view.metrics.find((item) => item.code === code) || null;
  if (!row) return;

  state.openOutlet = code;
  state.lastFocus = document.activeElement;

  $("#drawerTitle").textContent = `${row.code} · ${row.name}`;
  $("#drawerSubtitle").textContent = `${row.criteria} · ${row.zone} · ${row.regionalLeader} · ${row.district}, ${row.division}`;

  const series = outletDailySeries(code, view.filters.dateFrom, view.filters.dateTo);
  const peers = view.metrics.filter((item) => item.criteria === row.criteria);
  const zonePeers = view.metrics.filter((item) => item.zone === row.zone);

  const statBlocks = METRIC_KEYS.map((key) => {
    const definition = METRICS[key];
    const target = row[definition.target];
    const status = row.statuses[key];
    const priorValue = row.prior ? row.prior[key] : null;
    return `<div class="stat">
      <span>${escapeHtml(definition.short)}</span>
      <strong style="color:${status.key === "bad" ? "var(--bad)" : status.key === "good" ? "var(--good)" : "var(--ink)"}">${escapeHtml(formatPercent(row[key]))}</strong>
      <small>Target ${escapeHtml(formatPercent(target))}${isNumber(row[key]) && isNumber(target) ? ` · ${escapeHtml(formatPoints(row[key] - target))}` : ""}</small>
      ${state.compare && isNumber(priorValue) ? `<small>${deltaMarkup(row[key], priorValue)} vs prior</small>` : ""}
    </div>`;
  }).join("");

  const ranks = METRIC_KEYS.map((key) => {
    const overall = rankOf(code, key, view.metrics);
    const inZone = rankOf(code, key, zonePeers);
    const inCriteria = rankOf(code, key, peers);
    const cell = (rank) => (rank ? `${rank.position} of ${rank.total}` : "—");
    return `<tr>
      <td>${escapeHtml(METRICS[key].short)}</td>
      <td class="numeric">${escapeHtml(cell(overall))}</td>
      <td class="numeric">${escapeHtml(cell(inZone))}</td>
      <td class="numeric">${escapeHtml(cell(inCriteria))}</td>
    </tr>`;
  }).join("");

  const peerSummary = summarize(peers);
  const materials = (state.data.outletMaterials || {})[code] || {};

  $("#drawerBody").innerHTML = `
    <div class="stat-grid">
      <div class="stat"><span>Overall sales</span><strong>${escapeHtml(formatBDT(row.sales))}</strong><small>PNP ${escapeHtml(formatBDT(row.pnpSales))}</small></div>
      <div class="stat"><span>Consumable</span><strong>${escapeHtml(formatBDT(row.consumable))}</strong></div>
      <div class="stat"><span>Wastage</span><strong>${escapeHtml(formatBDT(row.wastage))}</strong></div>
      <div class="stat"><span>Value over target</span><strong style="color:${row.excessTotal > 0 ? "var(--bad)" : "var(--good)"}">${escapeHtml(row.excessTotal > 0 ? formatBDT(row.excessTotal) : "None")}</strong></div>
    </div>

    <div><div class="section-title">Against target</div><div class="stat-grid">${statBlocks}</div></div>

    <div>
      <div class="section-title">Consumable % — daily</div>
      ${sparkline(series, "consumableRate", "var(--series-1)")}
      <div class="section-title" style="margin-top:12px">Wastage on PNP % — daily</div>
      ${sparkline(series, "wastagePnpRate", "var(--series-2)")}
    </div>

    <div>
      <div class="section-title">Rank (worst first)</div>
      <table><thead><tr><th>Metric</th><th class="numeric">Selection</th><th class="numeric">Zonal</th><th class="numeric">Criteria peers</th></tr></thead><tbody>${ranks}</tbody></table>
    </div>

    <div>
      <div class="section-title">Versus ${escapeHtml(row.criteria)} peers (${formatInteger(peers.length)} outlets)</div>
      <table><tbody>
        ${METRIC_KEYS.map((key) => `<tr>
          <td>${escapeHtml(METRICS[key].short)}</td>
          <td class="numeric"><strong>${escapeHtml(formatPercent(row[key]))}</strong></td>
          <td class="numeric" style="color:var(--ink-3)">peer group ${escapeHtml(formatPercent(peerSummary[key]))}</td>
          <td class="numeric">${escapeHtml(formatPoints(isNumber(row[key]) && isNumber(peerSummary[key]) ? row[key] - peerSummary[key] : null))}</td>
        </tr>`).join("")}
      </tbody></table>
    </div>

    <div>
      <div class="section-title">Top wasted items (full loaded period)</div>
      ${materialRows(materials.wastage, "var(--series-3)")}
    </div>
    <div>
      <div class="section-title">Top consumable items (full loaded period)</div>
      ${materialRows(materials.consumable, "var(--series-1)")}
    </div>`;

  $("#scrim").hidden = false;
  $("#outletDrawer").hidden = false;
  document.body.style.overflow = "hidden";
  $("#outletDrawer .drawer-close").focus();
}

/* ------------------------------------------------------------------ modals */

function finding(severity, heading, body) {
  return `<div class="finding" style="--severity:var(--${severity})"><div class="finding-bar"></div><div><h3>${escapeHtml(heading)}</h3><p>${body}</p></div></div>`;
}

function periodAlignmentFinding(quality) {
  const spans = `Sales ${escapeHtml(formatShortDate(quality.sales.dateMin))}–${escapeHtml(formatShortDate(quality.sales.dateMax))}; Consumable ${escapeHtml(formatShortDate(quality.consumable.dateMin))}–${escapeHtml(formatShortDate(quality.consumable.dateMax))}; Wastage ${escapeHtml(formatShortDate(quality.wastage.dateMin))}–${escapeHtml(formatShortDate(quality.wastage.dateMax))}.`;
  // Older payloads carry no alignment block, so derive it rather than
  // asserting a pass the data was never checked against.
  const alignment = quality.periodAlignment || {
    aligned:
      new Set([quality.sales.dateMin, quality.consumable.dateMin, quality.wastage.dateMin]).size === 1 &&
      new Set([quality.sales.dateMax, quality.consumable.dateMax, quality.wastage.dateMax]).size === 1,
    commonStart: [quality.sales.dateMin, quality.consumable.dateMin, quality.wastage.dateMin].sort().at(-1),
    commonEnd: [quality.sales.dateMax, quality.consumable.dateMax, quality.wastage.dateMax].sort().at(0),
    laggingSources: [],
  };
  if (alignment.aligned) {
    return finding("good", "Passed · Source periods align", `${spans} Every rate uses the same number of operating days.`);
  }
  const lagging = (alignment.laggingSources || []).length
    ? `<code>${escapeHtml(alignment.laggingSources.join(", "))}</code> ends before sales. `
    : "";
  return finding(
    "warn",
    "Medium · Source periods do not align",
    `${spans} ${lagging}Rates across the full range divide a short movement period by a longer sales period, which understates them. Filter to ${escapeHtml(formatShortDate(alignment.commonStart))}–${escapeHtml(formatShortDate(alignment.commonEnd))} for a like-for-like view.`
  );
}

function renderDataQualityModal() {
  const quality = state.data.dataQuality;
  const unmapped = quality.unmappedActiveOutlets || [];
  const consumableReversals = quality.negativeNetConsumableOutlets || [];
  const wastageReversals = quality.negativeNetWastageOutlets || [];
  const duplicates = quality.zone.duplicateCodes || [];
  const reconciliation = quality.sales.reconciliation;
  const reversals = [...new Set([...consumableReversals, ...wastageReversals])];

  const findings = [
    finding(
      unmapped.length ? "warn" : "good",
      unmapped.length ? "Medium · Active outlets missing from the zone master" : "Passed · All active outlets are mapped",
      unmapped.length
        ? `<code>${escapeHtml(unmapped.join(", "))}</code>. They stay visible as “Unmapped” and are excluded only from target-weighted calculations.`
        : "Every active outlet joined to the hierarchy master."
    ),
    finding(
      reversals.length ? "info" : "good",
      reversals.length ? "Low · Net movement reversals" : "Passed · No net reversal outlets",
      reversals.length
        ? `Consumable: ${consumableReversals.length ? `<code>${escapeHtml(consumableReversals.join(", "))}</code>` : "none"}. Wastage: ${wastageReversals.length ? `<code>${escapeHtml(wastageReversals.join(", "))}</code>` : "none"}. Retained as net movement and flagged rather than zeroed.`
        : "Net movement values are non-negative for all outlets."
    ),
    finding(
      duplicates.length ? "bad" : "good",
      duplicates.length ? "High · Duplicate outlet codes in zone master" : "Passed · Zone master codes are unique",
      duplicates.length
        ? `<code>${escapeHtml(duplicates.join(", "))}</code>`
        : `${formatInteger(quality.zone.rows)} mapped outlets, no duplicated code.`
    ),
    periodAlignmentFinding(quality),
  ];

  if (reconciliation && reconciliation.reportedTotal != null) {
    findings.push(
      finding(
        reconciliation.matches ? "good" : "info",
        reconciliation.matches ? "Passed · Sales reconciles to the source total" : "Low · Sales detail differs from the source total row",
        reconciliation.matches
          ? `Detail rows sum to ${escapeHtml(formatMoneyExact(reconciliation.detailTotal))}, matching the export's total row.`
          : `Detail rows sum to ${escapeHtml(formatMoneyExact(reconciliation.detailTotal))} against a total row of ${escapeHtml(formatMoneyExact(reconciliation.reportedTotal))} — ${escapeHtml(formatMoneyExact(reconciliation.difference))} apart (${escapeHtml(formatPercent(reconciliation.differenceRatio, 5))}). The dashboard uses the detail rows.`
      )
    );
  }

  $("#dataQualityContent").innerHTML = `
    <div class="quality-grid">
      <div class="stat"><span>Active outlets</span><strong>${formatInteger(quality.activeOutlets)}</strong></div>
      <div class="stat"><span>Mapped active</span><strong>${formatInteger(quality.mappedActiveOutlets)}</strong></div>
      <div class="stat"><span>Sales with target</span><strong>${escapeHtml(quality.targetSalesCoverage == null ? "—" : formatPercent(quality.targetSalesCoverage, 1))}</strong></div>
    </div>
    ${findings.join("")}
    <ul class="source-list">${state.data.sourceFiles
      .map((source) => `<li><strong>${escapeHtml(source.name)}</strong><span>${formatInteger(source.rows)} rows${source.dateMax ? ` · through ${escapeHtml(formatShortDate(source.dateMax))}` : ""}</span></li>`)
      .join("")}</ul>`;
}

function renderMethodologyModal() {
  const definitions = state.data.metricDefinitions;
  const items = [
    ["PNP Sales", definitions.pnpSales],
    ["Consumable % on Sales", definitions.consumableRate],
    ["Wastage % on Sales", definitions.wastageSalesRate],
    ["Wastage % on PNP Sales", definitions.wastagePnpRate],
    ["SAP Net Value", definitions.sapNetValue],
    ["Hierarchy performance", definitions.aggregateRate],
    ["Benchmark outlet average", definitions.outletAverage],
    ["Target highlighting", "Lower is better. Outlet Average below Target is green and shown as Target > Outlet Avg; above target is red. Within 0.01 percentage point is amber."],
    ["Value over target", "For each metric where the outlet is above target: (actual − target) × the metric's sales base. Consumable and wastage are added; the two wastage measures describe the same taka, so only the larger is counted."],
    ["Period comparison", "The equal-length window immediately before the selected range. Shown only when that window falls inside the loaded data."],
    ["Material detail", "Net value by material from the SAP exports, covering the whole loaded period. Not affected by the date filter."],
  ];
  $("#methodologyContent").innerHTML = `<div class="definition">${items
    .map(([title, body]) => `<div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span></div>`)
    .join("")}</div>`;
}

/* --------------------------------------------------------------- overlays */

function closeOverlays() {
  $("#scrim").hidden = true;
  $("#outletDrawer").hidden = true;
  $$(".modal").forEach((modal) => {
    modal.hidden = true;
  });
  document.body.style.overflow = "";
  state.openOutlet = null;
  if (state.lastFocus && document.contains(state.lastFocus)) state.lastFocus.focus();
  state.lastFocus = null;
}

function openModal(modal) {
  state.lastFocus = document.activeElement;
  $("#scrim").hidden = false;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  modal.querySelector("[data-close]")?.focus();
}

/* ------------------------------------------------------------------ export */

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Columns headed "%" carry percentage points, not the 0-1 ratio the payload
// stores, so a spreadsheet shows what the heading promises.
function csvPercent(value) {
  return isNumber(value) ? (value * 100).toFixed(4) : "";
}

function downloadCsv(filename, headers, rows) {
  const lines = [headers.join(","), ...rows.map((row) => row.map(csvEscape).join(","))];
  const blob = new Blob(["﻿", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function periodStamp() {
  const view = state.view;
  return {
    from: view.filters.dateFrom || state.data.dateRange.min,
    to: view.filters.dateTo || state.data.dateRange.max,
  };
}

function exportOutlets() {
  const rows = sortMetrics(filteredTableMetrics(state.view));
  const { from, to } = periodStamp();
  downloadCsv(
    `Consumable-Wastage-Outlets-${to}.csv`,
    ["Outlet Code", "Outlet Name", "Regional Leader", "Zonal", "Division", "District", "Format", "PNP Status",
     "Ownership", "Final Criteria", "Overall Sales", "PNP Sales (FRESH PRODUCE)", "Consumable Value", "Consumable %",
     "Consumable Target %", "Wastage Value", "Wastage % on Sales", "Wastage Sales Target %", "Wastage % on PNP Sales",
     "Wastage PNP Target %", "Value Over Target", "Period From", "Period To"],
    rows.map((row) => [
      row.code, row.name, row.regionalLeader, row.zone, row.division, row.district, row.format, row.pnpStatus,
      row.ownership, row.criteria, row.sales, row.pnpSales, row.consumable, csvPercent(row.consumableRate),
      csvPercent(row.consumableTarget), row.wastage, csvPercent(row.wastageSalesRate), csvPercent(row.wastageSalesTarget),
      csvPercent(row.wastagePnpRate), csvPercent(row.wastagePnpTarget), Math.round(row.excessTotal), from, to,
    ])
  );
}

function exportLeague() {
  const { dimension, metricKey, groups } = leagueRows(state.view);
  const definition = METRICS[metricKey];
  const { from, to } = periodStamp();
  downloadCsv(
    `Consumable-Wastage-League-${dimension}-${to}.csv`,
    ["Rank", "Group", "Outlets", "Sales Base", definition.valueLabel, "Target %", "Weighted Actual %",
     "Variance pp", "Value Over Target", "Period From", "Period To"],
    groups.map((group, index) => [
      index + 1, group.label, group.outlets, Math.round(group[definition.denominator]),
      Math.round(group[definition.numerator]), csvPercent(group.targets[metricKey]), csvPercent(group[metricKey]),
      isNumber(group[metricKey]) && isNumber(group.targets[metricKey])
        ? ((group[metricKey] - group.targets[metricKey]) * 100).toFixed(4) : "",
      Math.round(group.excessTotal), from, to,
    ])
  );
}

function exportExceptions() {
  const items = exceptionItems(state.view);
  const { from, to } = periodStamp();
  downloadCsv(
    `Consumable-Wastage-Worklist-${to}.csv`,
    ["Priority", "Outlet Code", "Outlet Name", "Regional Leader", "Zonal", "District", "Final Criteria",
     "Driver Metric", "Actual %", "Target %", "Variance pp", "Value Over Target", "Period From", "Period To"],
    items.map(({ row, value, metricKey }, index) => [
      index + 1, row.code, row.name, row.regionalLeader, row.zone, row.district, row.criteria,
      METRICS[metricKey].label, csvPercent(row[metricKey]), csvPercent(row[METRICS[metricKey].target]),
      isNumber(row[metricKey]) && isNumber(row[METRICS[metricKey].target])
        ? ((row[metricKey] - row[METRICS[metricKey].target]) * 100).toFixed(4) : "",
      Math.round(value), from, to,
    ])
  );
}

/* ------------------------------------------------------------------ render */

function renderScope(view) {
  const from = formatShortDate(view.filters.dateFrom);
  const to = formatShortDate(view.filters.dateTo);
  $("#scopeSummary").textContent = view.invertedRange
    ? `No data: the From date (${from}) is after the To date (${to}).`
    : `${formatInteger(view.summary.outlets)} outlets · ${from} to ${to} · ${daysBetween(view.filters.dateFrom, view.filters.dateTo)} days`;
  $("#selectedOutletCount").textContent = formatInteger(view.summary.outlets);
  $("#selectedSales").textContent = formatBDT(view.summary.sales);

  const compareButton = $("#compareToggle");
  compareButton.disabled = !view.priorAvailable;
  compareButton.setAttribute("aria-pressed", String(state.compare && Boolean(view.prior)));
  $("#compareLabel").textContent = view.prior
    ? `${formatShortDate(view.prior.from)} – ${formatShortDate(view.prior.to)}`
    : view.priorAvailable
      ? "Off"
      : "No prior period";
}

function renderAll() {
  state.view = buildViewModel();
  renderScope(state.view);
  renderKpis(state.view);
  renderTrend(state.view);
  renderStatusDonut(state.view);
  renderRanking(state.view);
  renderMovers(state.view);
  renderLeague(state.view);
  renderExceptions(state.view);
  renderBenchmarks(state.view);
  renderOutletTable(state.view);
}

function openView(name) {
  state.tab = name;
  $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === name));
  $$(".view").forEach((section) => section.classList.toggle("is-active", section.id === `view-${name}`));
  $("#rail").classList.remove("is-open");
  $("#railToggle").setAttribute("aria-expanded", "false");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#themeGlyph").textContent = theme === "dark" ? "☀" : "☾";
  $("#themeToggle").setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    /* storage blocked; the theme still applies for this session */
  }
}

function resetFilters() {
  selections.forEach((set) => set.clear());
  $("#outletSearch").value = "";
  $("#tableSearch").value = "";
  $("#quickPeriod").value = "all";
  state.tableSearch = "";
  state.tablePage = 1;
  applyQuickPeriod("all");
  refreshAllFilterControls();
  renderAll();
}

function attachEvents() {
  attachFilterEvents();
  ["#dateFrom", "#dateTo"].forEach((selector) =>
    $(selector).addEventListener("change", () => {
      state.tablePage = 1;
      renderAll();
    })
  );
  $("#quickPeriod").addEventListener("change", (event) => {
    applyQuickPeriod(event.target.value);
    state.tablePage = 1;
    renderAll();
  });
  $("#outletSearch").addEventListener("input", () => {
    state.tablePage = 1;
    refreshAllFilterControls();
    renderAll();
  });
  $("#resetFilters").addEventListener("click", resetFilters);

  $("#compareToggle").addEventListener("click", () => {
    state.compare = !state.compare;
    renderAll();
  });
  $("#themeToggle").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  $("#trendSmoothing").addEventListener("change", () => renderTrend(state.view));
  $("#statusMetric").addEventListener("change", () => renderStatusDonut(state.view));
  $("#rankingDimension").addEventListener("change", () => renderRanking(state.view));
  $("#rankingMetric").addEventListener("change", () => renderRanking(state.view));
  $("#moversMetric").addEventListener("change", () => renderMovers(state.view));
  $("#leagueDimension").addEventListener("change", () => renderLeague(state.view));
  $("#leagueMetric").addEventListener("change", () => renderLeague(state.view));
  $("#exceptionMetric").addEventListener("change", () => renderExceptions(state.view));
  $("#benchmarkMetric").addEventListener("change", () => renderBenchmarks(state.view));

  $("#tableSearch").addEventListener("input", (event) => {
    state.tableSearch = event.target.value;
    state.tablePage = 1;
    renderOutletTable(state.view);
  });
  $("#previousPage").addEventListener("click", () => {
    state.tablePage -= 1;
    renderOutletTable(state.view);
  });
  $("#nextPage").addEventListener("click", () => {
    state.tablePage += 1;
    renderOutletTable(state.view);
  });

  $("#outletTable").addEventListener("click", (event) => {
    const sortButton = event.target.closest("[data-sort]");
    if (sortButton) {
      const key = sortButton.dataset.sort;
      if (state.tableSort.key === key) {
        state.tableSort.direction = state.tableSort.direction === "asc" ? "desc" : "asc";
      } else {
        state.tableSort = {
          key,
          direction: ["outlet", "regionalLeader", "zone", "division", "district"].includes(key) ? "asc" : "desc",
        };
      }
      state.tablePage = 1;
      renderOutletTable(state.view);
      return;
    }
    const row = event.target.closest("[data-outlet]");
    if (row) openOutlet(row.dataset.outlet);
  });

  $("#leagueTable").addEventListener("click", (event) => {
    const button = event.target.closest("[data-league-sort]");
    if (!button) return;
    const key = button.dataset.leagueSort;
    if (state.leagueSort.key === key) {
      state.leagueSort.direction = state.leagueSort.direction === "asc" ? "desc" : "asc";
    } else {
      state.leagueSort = { key, direction: key === "label" ? "asc" : "desc" };
    }
    renderLeague(state.view);
  });

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-outlet]");
    if (target && !target.closest("#outletTable")) openOutlet(target.dataset.outlet);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeOverlays();
    if ((event.key === "Enter" || event.key === " ") && document.activeElement?.dataset?.outlet) {
      event.preventDefault();
      openOutlet(document.activeElement.dataset.outlet);
    }
  });

  $("#exportCsv").addEventListener("click", exportOutlets);
  $("#exportLeague").addEventListener("click", exportLeague);
  $("#exportExceptions").addEventListener("click", exportExceptions);

  $$(".nav-item").forEach((button) => button.addEventListener("click", () => openView(button.dataset.view)));
  $("#dataQualityButton").addEventListener("click", () => openModal($("#dataQualityModal")));
  $("#methodologyButton").addEventListener("click", () => openModal($("#methodologyModal")));
  $("#scrim").addEventListener("click", closeOverlays);
  $$("[data-close]").forEach((button) => button.addEventListener("click", closeOverlays));

  const rail = $("#rail");
  $("#railToggle").addEventListener("click", () => {
    const open = rail.classList.toggle("is-open");
    $("#railToggle").setAttribute("aria-expanded", String(open));
  });
  $("#railClose").addEventListener("click", () => {
    rail.classList.remove("is-open");
    $("#railToggle").setAttribute("aria-expanded", "false");
  });
}

function showFatal(error) {
  $("#loadingScreen").innerHTML = `<div class="loading-mark">!</div><div><strong>Dashboard could not load</strong><span>${escapeHtml(error.message || error)}</span></div>`;
  console.error(error);
}

async function initialize() {
  try {
    const response = await fetch("data/dashboard-data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Data file returned ${response.status}`);
    state.data = await response.json();
    if (!SUPPORTED_SCHEMA_VERSIONS.has(state.data.schemaVersion) || !Array.isArray(state.data.outlets) || !Array.isArray(state.data.daily)) {
      throw new Error(`Dashboard data schema ${state.data.schemaVersion} is not supported by this build.`);
    }
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    initializeFilters();
    attachEvents();
    refreshAllFilterControls();
    $("#asOfDate").textContent = formatShortDate(state.data.asOf);
    renderDataQualityModal();
    renderMethodologyModal();
    renderMaterials();
    renderAll();
    requestAnimationFrame(() => $("#loadingScreen").classList.add("is-hidden"));
  } catch (error) {
    showFatal(error);
  }
}

initialize();
