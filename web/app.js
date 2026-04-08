// Car Market Monitor — vanilla JS dashboard.
// Loads db/car-market-monitor.sqlite via sql.js (WASM SQLite) and renders views with hash routing.

import { compactMultiLineSegments, diffLines, tokenDiffAsSegments } from "./diff.js";
import { diffValueAddedServices, formatValueAddedServiceName } from "../shared/value-added-services.js";

// sql.js (loader + wasm) jest vendoryzowany lokalnie w /web/. Cross-origin
// loading przez CDN dawał "both async and sync fetching of the wasm failed"
// przy ładowaniu z GH Pages — vendoring eliminuje wszystkie warianty
// CORS / content-type / instantiateStreaming. Pliki bumpujemy ręcznie
// gdy chcemy wyższą wersję sql.js (zob. README sekcja Dashboard).
const SQLJS_BASE = "./";
const DB_PATH = "../db/car-market-monitor.sqlite";
const DB_MANIFEST_PATH = `${DB_PATH}.version.json`;

const state = {
  db: null,
  sizeBytes: 0,
};

// ---------- bootstrap ----------

async function loadDb() {
  const SQL = await initSqlJs({ locateFile: (file) => SQLJS_BASE + file });
  // Dwustopniowy fetch żeby nie re-downloadować ~35 MB na każde otwarcie
  // strony. Fetchujemy najpierw malutki manifest (cache-bust po
  // timestamp, żeby zawsze dostać świeżą wersję), a potem używamy
  // `manifest.sha` jako cache key dla samego pliku .sqlite. Browser
  // cachuje dużą bazę normalnie i re-downloaduje tylko gdy zmieni się
  // sha (tzn. gdy github-actions[bot] wypchnął nowy run).
  //
  // `bin/run.js` pisze manifest po każdym zakończonym runie i workflow
  // commituje go razem z .sqlite, więc w produkcji zawsze istnieje.
  const manifestRes = await fetch(`${DB_MANIFEST_PATH}?t=${Date.now()}`, { cache: "no-cache" });
  if (!manifestRes.ok) {
    throw new Error(`Cannot fetch ${DB_MANIFEST_PATH}: HTTP ${manifestRes.status}`);
  }
  const manifest = await manifestRes.json();
  const res = await fetch(`${DB_PATH}?v=${manifest.sha}`, { cache: "default" });
  if (!res.ok) {
    throw new Error(`Cannot fetch ${DB_PATH}: HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return { db: new SQL.Database(new Uint8Array(buf)), sizeBytes: buf.byteLength };
}

async function init() {
  initTheme();
  try {
    const loaded = await loadDb();
    state.db = loaded.db;
    state.sizeBytes = loaded.sizeBytes;
    const lastRun = query(state.db, "SELECT MAX(finished_at) AS ts FROM scrape_runs")[0]?.ts;
    document.getElementById("db-status").textContent = `db ${formatBytes(state.sizeBytes)} · last run ${lastRun ? formatRelative(lastRun) : "—"}`;
    route();
  } catch (error) {
    document.getElementById("view").innerHTML = "";
    document.getElementById("view").appendChild(
      el("div", { class: "error" }, `Nie udało się załadować bazy: ${error.message}`),
    );
    document.getElementById("db-status").textContent = "load failed";
    console.error(error);
  }
}

// ---------- theme ----------

function initTheme() {
  const stored = localStorage.getItem("car-market-monitor-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = stored || (prefersDark ? "dark" : "light");
  applyTheme(theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem("car-market-monitor-theme", next);
    applyTheme(next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "Light" : "Dark";
}

// ---------- query helper ----------

function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    if (params.length > 0) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

// ---------- DOM helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return node;
}

function clearView() {
  const view = document.getElementById("view");
  view.innerHTML = "";
  view.className = "";
  return view;
}

// ---------- formatters ----------

function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatPrice(value, currency = "PLN") {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${num.toLocaleString("pl-PL")} ${currency}`;
}

function formatMileage(value) {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${num.toLocaleString("pl-PL")} km`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
}

function formatRelative(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return `${diffSec}s temu`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m temu`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h temu`;
  return `${Math.floor(diffSec / 86400)}d temu`;
}

function statusBadge(status) {
  const cls = {
    SUCCESS: "badge-success",
    PARTIAL_SUCCESS: "badge-partial",
    FAILED: "badge-failed",
    RUNNING: "badge-running",
  }[status] || "badge-inactive";
  return el("span", { class: `badge ${cls}` }, status);
}

function activeBadge(isActive) {
  return Number(isActive) === 1
    ? el("span", { class: "badge badge-active" }, "active")
    : el("span", { class: "badge badge-inactive" }, "missing");
}

function computeBatchStatus(runs) {
  const statuses = runs.map((r) => r.status);
  if (statuses.some((status) => status === "RUNNING")) return "RUNNING";
  if (statuses.every((status) => status === "SUCCESS")) return "SUCCESS";
  if (statuses.every((status) => status === "FAILED")) return "FAILED";
  return "PARTIAL_SUCCESS";
}

function summarizeRunBatch(runs) {
  if (!runs || runs.length === 0) return null;
  const sum = (field) => runs.reduce((acc, row) => acc + Number(row[field] || 0), 0);
  const sourceNames = runs
    .map((row) => row.source_name || row.source_id)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const sourceSummary = sourceNames.length <= 1
    ? (sourceNames[0] || "—")
    : `${sourceNames.length} źródła: ${sourceNames.slice(0, 3).join(", ")}${sourceNames.length > 3 ? ` +${sourceNames.length - 3}` : ""}`;
  const error = runs
    .flatMap((row) =>
      row.error
        ? String(row.error).split("\n").filter(Boolean).map((line) => `[${row.source_name || row.source_id}] ${line}`)
        : [],
    )
    .slice(0, 10)
    .join("\n") || null;

  return {
    source_count: runs.length,
    source_summary: sourceSummary,
    status: computeBatchStatus(runs),
    started_at: runs.reduce((min, row) => (!min || row.started_at < min ? row.started_at : min), null),
    finished_at: runs.reduce((max, row) => (!max || String(row.finished_at || "") > String(max || "") ? row.finished_at : max), null),
    reported_total_count: sum("reported_total_count"),
    unique_row_count: sum("unique_row_count"),
    detail_success_count: sum("detail_success_count"),
    detail_failed_count: sum("detail_failed_count"),
    new_listings_count: sum("new_listings_count"),
    changed_listings_count: sum("changed_listings_count"),
    unchanged_listings_count: sum("unchanged_listings_count"),
    removed_listings_count: sum("removed_listings_count"),
    reactivated_listings_count: sum("reactivated_listings_count"),
    error,
  };
}

// ---------- router ----------

function parseHash() {
  const raw = location.hash || "#/";
  const [path, queryString = ""] = raw.split("?");
  const params = Object.fromEntries(new URLSearchParams(queryString));
  return { path, params };
}

function buildHash(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== ""),
  ).toString();
  return qs ? `${path}?${qs}` : path;
}

function navigate(path, params = {}) {
  location.hash = buildHash(path, params);
}

function route() {
  if (!state.db) return;
  const { path, params } = parseHash();
  highlightNav(path);
  const view = clearView();
  try {
    if (path === "" || path === "#/" || path === "#" || path === "#/home") {
      viewHome(view, params);
    } else if (path === "#/activity") {
      viewActivity(view, params);
    } else if (path === "#/listings") {
      viewListings(view, params);
    } else if (path.startsWith("#/listing/")) {
      const id = path.slice("#/listing/".length);
      viewListingDetail(view, id);
    } else if (path === "#/changes") {
      viewChanges(view, params);
    } else if (path === "#/runs") {
      viewRuns(view);
    } else {
      view.appendChild(el("p", { class: "empty" }, `Nieznana ścieżka: ${path}`));
    }
  } catch (error) {
    view.appendChild(el("div", { class: "error" }, `Błąd: ${error.message}`));
    console.error(error);
  }
}

function highlightNav(path) {
  for (const link of document.querySelectorAll(".topbar nav a")) {
    const target = link.getAttribute("data-route") || "";
    const isActive =
      (target === "" && (path === "" || path === "#/" || path === "#")) ||
      (target !== "" && path.startsWith(target));
    link.classList.toggle("active", isActive);
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", init);

// ---------- views ----------

function viewHome(view, params = {}) {
  view.appendChild(el("h1", {}, "Dashboard"));

  // Stats
  const stats = query(
    state.db,
    `SELECT
       (SELECT COUNT(*) FROM listings WHERE is_active = 1) AS active_listings,
       (SELECT COUNT(*) FROM listings WHERE is_active = 0) AS inactive_listings,
       (SELECT COUNT(*) FROM listing_snapshots) AS snapshots,
       (SELECT COUNT(*) FROM scrape_runs) AS runs,
       (SELECT COUNT(*) FROM sources WHERE is_active = 1) AS sources_active`,
  )[0] || {};

  const cards = el("div", { class: "cards" });
  cards.append(
    statCard("Aktywne oferty", stats.active_listings ?? 0),
    statCard("Zniknięte", stats.inactive_listings ?? 0),
    statCard("Snapshoty", stats.snapshots ?? 0),
    statCard("Runy", stats.runs ?? 0),
    statCard("Aktywne źródła", stats.sources_active ?? 0),
  );
  view.appendChild(cards);

  // Last batch. batch_id is persisted per workflow invocation, so the home
  // panel can aggregate all source-level scrape_runs that belonged to the
  // same top-level execution.
  const lastBatchId = query(
    state.db,
    `SELECT batch_id
     FROM scrape_runs
     WHERE batch_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
  )[0]?.batch_id;
  const lastBatchRuns = lastBatchId
    ? query(
      state.db,
      `SELECT r.*, s.name AS source_name
       FROM scrape_runs r JOIN sources s ON s.id = r.source_id
       WHERE r.batch_id = ?
       ORDER BY r.started_at DESC`,
      [lastBatchId],
    )
    : [];
  const lastBatch = summarizeRunBatch(lastBatchRuns);
  if (lastBatch) {
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-header" }, "Ostatni batch"));
    panel.appendChild(
      el(
        "table",
        {},
        el(
          "tbody",
          {},
          row("Źródła", lastBatch.source_summary),
          row("Status", statusBadge(lastBatch.status)),
          row("Start", formatDate(lastBatch.started_at)),
          row("Koniec", formatDate(lastBatch.finished_at)),
          row("Discovery", `${lastBatch.unique_row_count}/${lastBatch.reported_total_count} unikalnych`),
          row("Detale", `success=${lastBatch.detail_success_count} failed=${lastBatch.detail_failed_count}`),
          row("Listings", `new=${lastBatch.new_listings_count} changed=${lastBatch.changed_listings_count} unchanged=${lastBatch.unchanged_listings_count} removed=${lastBatch.removed_listings_count} reactivated=${lastBatch.reactivated_listings_count}`),
          lastBatch.error ? row("Błędy", el("pre", { class: "muted" }, lastBatch.error)) : null,
        ),
      ),
    );
    view.appendChild(panel);
  }

  const homePath = location.hash.startsWith("#/home") ? "#/home" : "#/";
  function buildHomeTableSort(sortParam, dirParam, columns, defaultKey = "when") {
    const sortKey = columns[params[sortParam]] ? params[sortParam] : defaultKey;
    const sortDir = params[dirParam] === "asc" ? "ASC" : "DESC";
    const sortExpr = columns[sortKey];

    function sortableTh(label, key, opts = {}) {
      const numeric = opts.numeric || false;
      const isActive = sortKey === key;
      return el("th", {
        class: "sortable" + (numeric ? " num" : "") + (isActive ? " sorted" : ""),
        "data-sort-dir": isActive ? sortDir.toLowerCase() : "",
        onclick: () => {
          let nextDir;
          if (isActive) nextDir = sortDir === "ASC" ? "desc" : "asc";
          else nextDir = numeric ? "desc" : "asc";
          navigate(homePath, { ...params, [sortParam]: key, [dirParam]: nextDir });
        },
      }, label);
    }

    return { sortKey, sortDir, sortExpr, sortableTh };
  }

  // Price drops
  const HOME_DROP_SORT_COLUMNS = {
    when: "created_at",
    title: "lower(title)",
    old_price: "CAST(old_value AS REAL)",
    new_price: "CAST(new_value AS REAL)",
    drop: "drop_amount",
  };
  const dropSort = buildHomeTableSort("dropSort", "dropDir", HOME_DROP_SORT_COLUMNS);
  const drops = query(
    state.db,
    `WITH recent_drops AS (
       SELECT lc.created_at, lc.old_value, lc.new_value, l.id, l.title, l.listing_url,
              (CAST(lc.old_value AS REAL) - CAST(lc.new_value AS REAL)) AS drop_amount,
              (CAST(lc.old_value AS REAL) - CAST(lc.new_value AS REAL)) * 100.0 / CAST(lc.old_value AS REAL) AS drop_pct
       FROM listing_changes lc
       JOIN listings l ON l.id = lc.listing_id
       WHERE lc.field_name = 'price.value'
         AND lc.old_value IS NOT NULL AND lc.new_value IS NOT NULL
         AND CAST(lc.new_value AS REAL) > 0
         AND CAST(lc.new_value AS REAL) < CAST(lc.old_value AS REAL)
         AND lc.created_at >= datetime('now', '-30 days')
       ORDER BY lc.created_at DESC, l.title ASC
       LIMIT 20
     )
     SELECT *
     FROM recent_drops
     ORDER BY ${dropSort.sortExpr} ${dropSort.sortDir} NULLS LAST, created_at DESC, title ASC`,
  );
  view.appendChild(panelTable(
    "Spadki cen (ostatnie 30 dni · 20 najnowszych)",
    [
      dropSort.sortableTh("Kiedy", "when", { numeric: true }),
      dropSort.sortableTh("Oferta", "title"),
      dropSort.sortableTh("Z", "old_price", { numeric: true }),
      dropSort.sortableTh("Na", "new_price", { numeric: true }),
      dropSort.sortableTh("Spadek", "drop", { numeric: true }),
    ],
    drops.map((r) => [
      formatRelative(r.created_at),
      listingLink(r.id, r.title || r.id),
      el("span", { class: "tabular" }, formatPrice(r.old_value)),
      el("span", { class: "tabular price-drop" }, formatPrice(r.new_value)),
      el("span", { class: "tabular price-drop" }, `−${formatPrice(r.drop_amount)} (${r.drop_pct.toFixed(1)}%)`),
    ]),
    drops.map((r) => () => navigate(`#/listing/${r.id}`)),
    "Brak spadków cen w ostatnich 30 dniach.",
  ));

  // Recently disappeared. Two filters here that aren't obvious:
  //   1. l.is_active = 0 — exclude listings that flipped MISSING but were
  //      then reactivated in a later run. The history row stays in
  //      listing_changes forever, so without this filter "Świeżo zniknięte"
  //      keeps showing reactivated rows as if they were still gone.
  //   2. NOT EXISTS subquery — only show the MOST RECENT __listing_status
  //      change per listing. A listing that flipped MISSING → ACTIVE → MISSING
  //      → ACTIVE would otherwise show up multiple times.
  const HOME_STATUS_SORT_COLUMNS = {
    when: "created_at",
    title: "lower(title)",
    price: "CAST(last_price_amount AS REAL)",
  };
  const disappearedSort = buildHomeTableSort("disappearedSort", "disappearedDir", HOME_STATUS_SORT_COLUMNS);
  const disappeared = query(
    state.db,
    `WITH recent_disappeared AS (
       SELECT lc.created_at, l.id, l.title, l.last_price_amount
       FROM listing_changes lc JOIN listings l ON l.id = lc.listing_id
       WHERE lc.field_name = '__listing_status' AND lc.new_value = 'MISSING'
         AND l.is_active = 0
         AND NOT EXISTS (
           SELECT 1 FROM listing_changes lc2
           WHERE lc2.listing_id = lc.listing_id
             AND lc2.field_name = '__listing_status'
             AND lc2.created_at > lc.created_at
         )
       ORDER BY lc.created_at DESC, l.title ASC
       LIMIT 20
     )
     SELECT *
     FROM recent_disappeared
     ORDER BY ${disappearedSort.sortExpr} ${disappearedSort.sortDir} NULLS LAST, created_at DESC, title ASC`,
  );
  view.appendChild(panelTable(
    "Świeżo zniknięte (20 najnowszych)",
    [
      disappearedSort.sortableTh("Kiedy", "when", { numeric: true }),
      disappearedSort.sortableTh("Oferta", "title"),
      disappearedSort.sortableTh("Ostatnia cena", "price", { numeric: true }),
    ],
    disappeared.map((r) => [
      formatRelative(r.created_at),
      listingLink(r.id, r.title || r.id),
      el("span", { class: "tabular" }, formatPrice(r.last_price_amount)),
    ]),
    disappeared.map((r) => () => navigate(`#/listing/${r.id}`)),
    "Nic ostatnio nie zniknęło.",
  ));

  // Recently appeared
  const appearedSort = buildHomeTableSort("appearedSort", "appearedDir", HOME_STATUS_SORT_COLUMNS);
  const appeared = query(
    state.db,
    `WITH recent_appeared AS (
       SELECT lc.created_at, l.id, l.title, l.last_price_amount
       FROM listing_changes lc JOIN listings l ON l.id = lc.listing_id
       WHERE lc.field_name = '__listing_created'
       ORDER BY lc.created_at DESC, l.title ASC
       LIMIT 20
     )
     SELECT *
     FROM recent_appeared
     ORDER BY ${appearedSort.sortExpr} ${appearedSort.sortDir} NULLS LAST, created_at DESC, title ASC`,
  );
  view.appendChild(panelTable(
    "Świeżo dodane (20 najnowszych)",
    [
      appearedSort.sortableTh("Kiedy", "when", { numeric: true }),
      appearedSort.sortableTh("Oferta", "title"),
      appearedSort.sortableTh("Cena", "price", { numeric: true }),
    ],
    appeared.map((r) => [
      formatRelative(r.created_at),
      listingLink(r.id, r.title || r.id),
      el("span", { class: "tabular" }, formatPrice(r.last_price_amount)),
    ]),
    appeared.map((r) => () => navigate(`#/listing/${r.id}`)),
    "Brak nowych ofert.",
  ));
}

function viewActivity(view, params = {}) {
  view.appendChild(el("h1", {}, "Activity"));

  const PAGE_SIZE = 100;
  const activityPath = "#/activity";

  function readPageParam(name) {
    const page = Number.parseInt(params[name] || "", 10);
    return Number.isInteger(page) && page > 0 ? page : 1;
  }

  function buildActivitySort(sortParam, dirParam, pageParam, columns, defaultKey = "when") {
    const sortKey = columns[params[sortParam]] ? params[sortParam] : defaultKey;
    const sortDir = params[dirParam] === "asc" ? "ASC" : "DESC";
    const sortExpr = columns[sortKey];

    function sortableTh(label, key, opts = {}) {
      const numeric = opts.numeric || false;
      const isActive = sortKey === key;
      return el("th", {
        class: "sortable" + (numeric ? " num" : "") + (isActive ? " sorted" : ""),
        "data-sort-dir": isActive ? sortDir.toLowerCase() : "",
        onclick: () => {
          let nextDir;
          if (isActive) nextDir = sortDir === "ASC" ? "desc" : "asc";
          else nextDir = numeric ? "desc" : "asc";
          const next = { ...params, [sortParam]: key, [dirParam]: nextDir };
          delete next[pageParam];
          navigate(activityPath, next);
        },
      }, label);
    }

    return { sortExpr, sortDir, sortableTh };
  }

  function queryPagedSection(baseSql, sortExpr, sortDir, page, tieBreakers) {
    const total = Number(
      query(state.db, `SELECT COUNT(*) AS c FROM (${baseSql}) section_rows`)[0]?.c || 0,
    );
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const rows = total > 0
      ? query(
        state.db,
        `SELECT * FROM (${baseSql}) section_rows
         ORDER BY ${sortExpr} ${sortDir} NULLS LAST, ${tieBreakers}
         LIMIT ? OFFSET ?`,
        [PAGE_SIZE, (safePage - 1) * PAGE_SIZE],
      )
      : [];
    return { rows, total, page: safePage, totalPages };
  }

  function appendPager(pageParam, page, totalPages) {
    if (totalPages <= 1) return;
    const goTo = (targetPage) => navigate(activityPath, { ...params, [pageParam]: String(targetPage) });
    view.appendChild(el("div", { class: "pager" },
      el("button", {
        type: "button",
        class: "secondary",
        disabled: page <= 1 ? "" : null,
        onclick: () => goTo(page - 1),
      }, "← Poprzednia"),
      el("span", { class: "muted tabular" }, `Strona ${page} z ${totalPages}`),
      el("button", {
        type: "button",
        class: "secondary",
        disabled: page >= totalPages ? "" : null,
        onclick: () => goTo(page + 1),
      }, "Następna →"),
    ));
  }

  const dropSortColumns = {
    when: "created_at",
    title: "lower(title)",
    old_price: "CAST(old_value AS REAL)",
    new_price: "CAST(new_value AS REAL)",
    drop: "drop_amount",
  };
  const dropSort = buildActivitySort("dropsSort", "dropsDir", "dropsPage", dropSortColumns);
  const dropPage = readPageParam("dropsPage");
  const dropBaseSql = `SELECT lc.created_at, lc.old_value, lc.new_value, l.id, l.title, l.listing_url,
                              (CAST(lc.old_value AS REAL) - CAST(lc.new_value AS REAL)) AS drop_amount,
                              (CAST(lc.old_value AS REAL) - CAST(lc.new_value AS REAL)) * 100.0 / CAST(lc.old_value AS REAL) AS drop_pct
                       FROM listing_changes lc
                       JOIN listings l ON l.id = lc.listing_id
                       WHERE lc.field_name = 'price.value'
                         AND lc.old_value IS NOT NULL AND lc.new_value IS NOT NULL
                         AND CAST(lc.new_value AS REAL) > 0
                         AND CAST(lc.new_value AS REAL) < CAST(lc.old_value AS REAL)
                         AND lc.created_at >= datetime('now', '-30 days')`;
  const drops = queryPagedSection(dropBaseSql, dropSort.sortExpr, dropSort.sortDir, dropPage, "created_at DESC, title ASC");
  view.appendChild(panelTable(
    `Spadki cen (ostatnie 30 dni) · ${drops.total.toLocaleString("pl-PL")}`,
    [
      dropSort.sortableTh("Kiedy", "when", { numeric: true }),
      dropSort.sortableTh("Oferta", "title"),
      dropSort.sortableTh("Z", "old_price", { numeric: true }),
      dropSort.sortableTh("Na", "new_price", { numeric: true }),
      dropSort.sortableTh("Spadek", "drop", { numeric: true }),
    ],
    drops.rows.map((r) => [
      formatRelative(r.created_at),
      listingLink(r.id, r.title || r.id),
      el("span", { class: "tabular" }, formatPrice(r.old_value)),
      el("span", { class: "tabular price-drop" }, formatPrice(r.new_value)),
      el("span", { class: "tabular price-drop" }, `−${formatPrice(r.drop_amount)} (${r.drop_pct.toFixed(1)}%)`),
    ]),
    drops.rows.map((r) => () => navigate(`#/listing/${r.id}`)),
    "Brak spadków cen w ostatnich 30 dniach.",
  ));
  appendPager("dropsPage", drops.page, drops.totalPages);

  const statusSortColumns = {
    when: "created_at",
    title: "lower(title)",
    price: "CAST(last_price_amount AS REAL)",
  };
  const disappearedSort = buildActivitySort("disappearedSort", "disappearedDir", "disappearedPage", statusSortColumns);
  const disappearedPage = readPageParam("disappearedPage");
  const disappearedBaseSql = `SELECT lc.created_at, l.id, l.title, l.last_price_amount
                              FROM listing_changes lc
                              JOIN listings l ON l.id = lc.listing_id
                              WHERE lc.field_name = '__listing_status' AND lc.new_value = 'MISSING'
                                AND l.is_active = 0
                                AND NOT EXISTS (
                                  SELECT 1 FROM listing_changes lc2
                                  WHERE lc2.listing_id = lc.listing_id
                                    AND lc2.field_name = '__listing_status'
                                    AND lc2.created_at > lc.created_at
                                )`;
  const disappeared = queryPagedSection(
    disappearedBaseSql,
    disappearedSort.sortExpr,
    disappearedSort.sortDir,
    disappearedPage,
    "created_at DESC, title ASC",
  );
  view.appendChild(panelTable(
    `Świeżo zniknięte · ${disappeared.total.toLocaleString("pl-PL")}`,
    [
      disappearedSort.sortableTh("Kiedy", "when", { numeric: true }),
      disappearedSort.sortableTh("Oferta", "title"),
      disappearedSort.sortableTh("Ostatnia cena", "price", { numeric: true }),
    ],
    disappeared.rows.map((r) => [
      formatRelative(r.created_at),
      listingLink(r.id, r.title || r.id),
      el("span", { class: "tabular" }, formatPrice(r.last_price_amount)),
    ]),
    disappeared.rows.map((r) => () => navigate(`#/listing/${r.id}`)),
    "Nic ostatnio nie zniknęło.",
  ));
  appendPager("disappearedPage", disappeared.page, disappeared.totalPages);

  const appearedSort = buildActivitySort("appearedSort", "appearedDir", "appearedPage", statusSortColumns);
  const appearedPage = readPageParam("appearedPage");
  const appearedBaseSql = `SELECT lc.created_at, l.id, l.title, l.last_price_amount
                           FROM listing_changes lc
                           JOIN listings l ON l.id = lc.listing_id
                           WHERE lc.field_name = '__listing_created'`;
  const appeared = queryPagedSection(
    appearedBaseSql,
    appearedSort.sortExpr,
    appearedSort.sortDir,
    appearedPage,
    "created_at DESC, title ASC",
  );
  view.appendChild(panelTable(
    `Świeżo dodane · ${appeared.total.toLocaleString("pl-PL")}`,
    [
      appearedSort.sortableTh("Kiedy", "when", { numeric: true }),
      appearedSort.sortableTh("Oferta", "title"),
      appearedSort.sortableTh("Cena", "price", { numeric: true }),
    ],
    appeared.rows.map((r) => [
      formatRelative(r.created_at),
      listingLink(r.id, r.title || r.id),
      el("span", { class: "tabular" }, formatPrice(r.last_price_amount)),
    ]),
    appeared.rows.map((r) => () => navigate(`#/listing/${r.id}`)),
    "Brak nowych ofert.",
  ));
  appendPager("appearedPage", appeared.page, appeared.totalPages);
}

function viewListings(view, params) {
  view.appendChild(el("h1", {}, "Listings"));

  const sources = query(state.db, "SELECT id, name FROM sources ORDER BY created_at ASC");
  const sellers = query(
    state.db,
    `SELECT seller_uuid, seller_name, seller_location_city, seller_location_region, COUNT(*) AS listing_count
     FROM listings
     WHERE seller_uuid IS NOT NULL
     GROUP BY seller_uuid, seller_name, seller_location_city, seller_location_region
     ORDER BY lower(COALESCE(seller_name, '')), lower(COALESCE(seller_location_city, '')), lower(COALESCE(seller_location_region, ''))`,
  );
  const sellerScope = params.sellerUuid
    ? query(
      state.db,
      `SELECT seller_uuid, seller_name, seller_location_city, seller_location_region
       FROM listings
       WHERE seller_uuid = ?
       ORDER BY last_seen_at DESC
       LIMIT 1`,
      [params.sellerUuid],
    )[0] || { seller_uuid: params.sellerUuid }
    : null;
  const sellerOptions = sellers.map((seller) => ({
    ...seller,
    label: formatSellerLabel(seller),
  }));
  const sellerOptionByLabel = new Map(sellerOptions.map((seller) => [seller.label.toLowerCase(), seller]));
  const sellerFilterParams = sellerScope
    ? { sellerUuid: sellerScope.seller_uuid }
    : params.sellerQuery
      ? { sellerQuery: params.sellerQuery }
      : {};
  const sellerInputValue = sellerScope ? formatSellerLabel(sellerScope) : (params.sellerQuery || "");

  if (sellerScope) {
    view.appendChild(el("p", { class: "muted" }, `Widok sprzedawcy: ${formatSellerLabel(sellerScope)}`));
  } else if (params.sellerQuery) {
    view.appendChild(el("p", { class: "muted" }, `Wyszukiwanie sprzedawcy: ${params.sellerQuery}`));
  }

  // Filters
  const filters = el("form", { class: "filters", onsubmit: (e) => { e.preventDefault(); applyFilters(); } });
  const sellerListId = "seller-options";
  const sellerInput = input("text", "seller", sellerInputValue, "np. Porsche Centrum Warszawa");
  sellerInput.setAttribute("list", sellerListId);
  const sourceSelect = el(
    "select",
    { name: "source" },
    el("option", { value: "" }, "Wszystkie"),
    ...sources.map((s) => {
      const opt = el("option", { value: s.id }, s.name || s.id);
      if (params.source === s.id) opt.setAttribute("selected", "");
      return opt;
    }),
  );
  const activeSelect = el(
    "select",
    { name: "active" },
    el("option", { value: "" }, "Wszystkie"),
    el("option", { value: "1" }, "Aktywne"),
    el("option", { value: "0" }, "Zniknięte"),
  );
  if (params.active != null) activeSelect.value = params.active;

  // Helpery do tristate select'ów (any/yes/no)
  function tristate(name, label, paramVal) {
    const sel = el("select", { name },
      el("option", { value: "" }, "Wszystkie"),
      el("option", { value: "1" }, "Tak"),
      el("option", { value: "0" }, "Nie"),
    );
    if (paramVal != null) sel.value = paramVal;
    return field(label, sel);
  }

  // Dynamic options dla new_used i country_origin (z bazy)
  const newUsedOptions = query(state.db, "SELECT DISTINCT new_used FROM listings WHERE new_used IS NOT NULL ORDER BY new_used");
  const newUsedSelect = el("select", { name: "newUsed" },
    el("option", { value: "" }, "Wszystkie"),
    ...newUsedOptions.map(r => {
      const o = el("option", { value: r.new_used }, r.new_used);
      if (params.newUsed === r.new_used) o.setAttribute("selected", "");
      return o;
    }),
  );
  const countryOptions = query(state.db, "SELECT country_origin, COUNT(*) AS n FROM listings WHERE country_origin IS NOT NULL GROUP BY country_origin ORDER BY n DESC");
  const countrySelect = el("select", { name: "country" },
    el("option", { value: "" }, "Wszystkie"),
    ...countryOptions.map(r => {
      const o = el("option", { value: r.country_origin }, `${r.country_origin} (${r.n})`);
      if (params.country === r.country_origin) o.setAttribute("selected", "");
      return o;
    }),
  );

  // Dynamic enum filters z migracji 0003 (fuel_type, body_type, gearbox).
  // Helper żeby uniknąć powielania pętli — buduje SELECT z opcjami liczonymi
  // z bazy, sortowanymi po popularności (najczęstsze na górze). Jeśli wartość
  // z URL params nie ma już rekordów (filtr zostaje po update'cie bazy),
  // dorzucamy ją na koniec żeby select nie pokazywał pustego "Wszystkie".
  function dynamicEnumSelect(paramName, column, formatter = formatEnum) {
    const rows = query(state.db, `SELECT ${column} AS v, COUNT(*) AS n FROM listings WHERE ${column} IS NOT NULL AND is_active = 1 GROUP BY ${column} ORDER BY n DESC`);
    const sel = el("select", { name: paramName }, el("option", { value: "" }, "Wszystkie"));
    const seen = new Set();
    for (const r of rows) {
      seen.add(r.v);
      const opt = el("option", { value: r.v }, `${formatter(r.v)} (${r.n})`);
      if (params[paramName] === r.v) opt.setAttribute("selected", "");
      sel.appendChild(opt);
    }
    if (params[paramName] && !seen.has(params[paramName])) {
      const opt = el("option", { value: params[paramName] }, `${formatter(params[paramName])} (0)`);
      opt.setAttribute("selected", "");
      sel.appendChild(opt);
    }
    return sel;
  }
  const fuelTypeSelect = dynamicEnumSelect("fuelType", "fuel_type");
  const bodyTypeSelect = dynamicEnumSelect("bodyType", "body_type");
  const gearboxSelect = dynamicEnumSelect("gearbox", "gearbox");

  // Layout: top row is a dedicated 2-col grid for title/description search
  // and seller search. The rest of the controls stay as flat children of the
  // main .filters grid, with actions spanning the full row at the bottom.
  filters.append(
    el(
      "div",
      { class: "filters-featured" },
      field("Szukaj w tytule i opisie", input("text", "q", params.q, "np. ceramic brakes, BOSE, ppf..."), "field-search"),
      field(
        "Sprzedawca",
        [
          sellerInput,
          el(
            "datalist",
            { id: sellerListId },
            ...sellerOptions.map((seller) => el("option", { value: seller.label })),
          ),
        ],
        "field-seller",
      ),
    ),
    field("Źródło", sourceSelect),
    field("Status", activeSelect),
    field("Stan", newUsedSelect),
    field("Paliwo", fuelTypeSelect),
    field("Nadwozie", bodyTypeSelect),
    field("Skrzynia", gearboxSelect),
    rangeField("Rok", "minYear", "maxYear", params.minYear, params.maxYear),
    rangeField("Cena (PLN)", "minPrice", "maxPrice", params.minPrice, params.maxPrice),
    rangeField("Przebieg (km)", "minMileage", "maxMileage", params.minMileage, params.maxMileage),
    rangeField("Moc (KM)", "minPower", "maxPower", params.minPower, params.maxPower),
    tristate("damaged", "Uszkodzony", params.damaged),
    tristate("noAccident", "Bezwypadkowy", params.noAccident),
    tristate("serviceRecord", "Książka serwisowa", params.serviceRecord),
    field("Kraj pochodzenia", countrySelect),
    el("div", { class: "actions" },
      sellerScope
        || params.sellerQuery
        ? el("button", { type: "button", class: "secondary", onclick: () => navigate("#/listings") }, "Wszyscy sprzedawcy")
        : null,
      el(
        "button",
        { type: "button", class: "secondary", onclick: () => navigate("#/listings", sellerFilterParams) },
        sellerScope || params.sellerQuery ? "Reset filtrów" : "Reset",
      ),
      el("button", { type: "submit" }, "Filtruj"),
    ),
  );
  view.appendChild(filters);

  function applyFilters() {
    const data = new FormData(filters);
    const next = {};
    for (const [k, v] of data.entries()) {
      if (!v || k === "seller") continue;
      next[k] = v;
    }
    const sellerValue = sellerInput.value.trim();
    if (sellerValue) {
      const exactSeller = sellerOptionByLabel.get(sellerValue.toLowerCase());
      if (exactSeller?.seller_uuid) next.sellerUuid = exactSeller.seller_uuid;
      else next.sellerQuery = sellerValue;
    }
    navigate("#/listings", next);
  }

  // Build SQL
  const where = ["1=1"];
  const args = [];
  if (sellerScope) { where.push("l.seller_uuid = ?"); args.push(sellerScope.seller_uuid); }
  if (params.sellerQuery) {
    const sellerTerms = params.sellerQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
    for (const term of sellerTerms) {
      where.push("(lower(COALESCE(l.seller_name, '')) LIKE ? OR lower(COALESCE(l.seller_location_city, '')) LIKE ? OR lower(COALESCE(l.seller_location_region, '')) LIKE ?)");
      const pat = `%${term}%`;
      args.push(pat, pat, pat);
    }
  }
  if (params.source) { where.push("l.source_id = ?"); args.push(params.source); }
  if (params.active === "1") where.push("l.is_active = 1");
  if (params.active === "0") where.push("l.is_active = 0");
  if (params.minYear) { where.push("CAST(l.last_year AS INTEGER) >= ?"); args.push(Number(params.minYear)); }
  if (params.maxYear) { where.push("CAST(l.last_year AS INTEGER) <= ?"); args.push(Number(params.maxYear)); }
  if (params.minPrice) { where.push("CAST(l.last_price_amount AS REAL) >= ?"); args.push(Number(params.minPrice)); }
  if (params.maxPrice) { where.push("CAST(l.last_price_amount AS REAL) <= ?"); args.push(Number(params.maxPrice)); }
  if (params.minMileage) { where.push("CAST(l.last_mileage AS REAL) >= ?"); args.push(Number(params.minMileage)); }
  if (params.maxMileage) { where.push("CAST(l.last_mileage AS REAL) <= ?"); args.push(Number(params.maxMileage)); }
  // engine_power jest INTEGER (z migracji 0003) — bez CAST'a, prosty compare
  if (params.minPower) { where.push("l.engine_power >= ?"); args.push(Number(params.minPower)); }
  if (params.maxPower) { where.push("l.engine_power <= ?"); args.push(Number(params.maxPower)); }
  if (params.fuelType) { where.push("l.fuel_type = ?"); args.push(params.fuelType); }
  if (params.bodyType) { where.push("l.body_type = ?"); args.push(params.bodyType); }
  if (params.gearbox) { where.push("l.gearbox = ?"); args.push(params.gearbox); }
  if (params.damaged === "1") where.push("l.damaged = 1");
  if (params.damaged === "0") where.push("l.damaged = 0");
  if (params.noAccident === "1") where.push("l.no_accident = 1");
  if (params.noAccident === "0") where.push("l.no_accident = 0");
  if (params.serviceRecord === "1") where.push("l.service_record = 1");
  if (params.serviceRecord === "0") where.push("l.service_record = 0");
  if (params.newUsed) { where.push("l.new_used = ?"); args.push(params.newUsed); }
  if (params.country) { where.push("l.country_origin = ?"); args.push(params.country); }
  if (params.q) {
    // Multi-word search z AND'em: rozdziel zapytanie po białych znakach,
    // każde słowo musi się pojawić w tytule LUB opisie ostatniego snapshotu.
    // Słowa nie muszą być adjacent - "ceramic brakes" matchuje też
    // "ceramic Porsche brakes" jako oddzielne tokeny.
    //
    // lower() w SQLite działa case-insensitive tylko dla ASCII; dla polskich
    // znaków w description user musi trafić w case. Przy obecnej skali
    // (rzędu tysiąca listings) to działa szybko — gdyby baza urosła o rząd
    // wielkości, pora na FTS5 z unicode61 tokenizerem.
    const terms = params.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    for (const term of terms) {
      where.push("(lower(l.title) LIKE ? OR lower(snap.description_text) LIKE ?)");
      const pat = `%${term}%`;
      args.push(pat, pat);
    }
  }

  // Sortowanie: whitelist (sort key → SQL expression), żeby URL params nie
  // wstrzykiwały niczego do query. Domyślnie last_seen DESC.
  const SORT_COLUMNS = {
    status: "l.is_active",
    title: "lower(l.title)",
    year: "CAST(l.last_year AS INTEGER)",
    mileage: "CAST(l.last_mileage AS REAL)",
    price: "CAST(l.last_price_amount AS REAL)",
    power: "l.engine_power",
    fuel_type: "l.fuel_type",
    last_seen: "l.last_seen_at",
  };
  const sortKey = SORT_COLUMNS[params.sort] ? params.sort : "last_seen";
  const sortDir = params.dir === "asc" ? "ASC" : "DESC";
  const sortExpr = SORT_COLUMNS[sortKey];

  // Paginacja: liczymy total osobnym COUNT(*) żeby wiedzieć ile jest stron,
  // potem SELECT z LIMIT/OFFSET. JOIN z listing_snapshots tylko gdy jest
  // filtr tekstowy — inaczej COUNT'em można pominąć snapshoty i policzyć
  // szybciej, ale dla prostoty zostawiamy identyczny FROM w obu zapytaniach
  // (różnica w praktyce jest pomijalna przy ~1k listings).
  const PAGE_SIZE = 100;
  const fromClause = `FROM listings l
     LEFT JOIN listing_snapshots snap ON snap.id = l.last_snapshot_id
     WHERE ${where.join(" AND ")}`;

  const totalRow = query(
    state.db,
    `SELECT COUNT(*) AS n ${fromClause}`,
    args,
  )[0];
  const total = totalRow?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Strona 1-indexed. Clamp do [1, totalPages] na wypadek gdy URL ma stary
  // numer strony wskazujący poza aktualny zbiór (np. po zmianie filtrów
  // ręcznie w URL, albo gdy baza się skurczyła).
  let page = Math.max(1, parseInt(params.page, 10) || 1);
  if (page > totalPages) page = totalPages;
  const offset = (page - 1) * PAGE_SIZE;

  const rows = total === 0 ? [] : query(
    state.db,
    `SELECT l.id, l.external_id, l.title, l.listing_url, l.is_active,
            l.last_price_amount, l.last_mileage, l.last_year, l.last_seen_at,
            l.fuel_type, l.engine_power
     ${fromClause}
     ORDER BY ${sortExpr} ${sortDir} NULLS LAST, l.title ASC
     LIMIT ? OFFSET ?`,
    [...args, PAGE_SIZE, offset],
  );

  const counterText = total === 0
    ? "0 wyników"
    : `${total} wyników — strona ${page} z ${totalPages} (${offset + 1}–${offset + rows.length})`;
  view.appendChild(el("p", { class: "muted" }, counterText));

  if (rows.length === 0) {
    view.appendChild(el("p", { class: "empty" }, "Brak ofert pasujących do filtrów."));
    return;
  }

  // Helper: nagłówek z możliwością sortowania. Klik toggluje kierunek dla
  // tego samego pola, albo ustawia nowe pole z kierunkiem domyślnym (DESC dla
  // numerycznych/dat, ASC dla tekstu).
  function sortableTh(label, key, opts = {}) {
    const numeric = opts.numeric || false;
    const isActive = sortKey === key;
    const th = el(
      "th",
      {
        class: "sortable" + (numeric ? " num" : "") + (isActive ? " sorted" : ""),
        "data-sort-dir": isActive ? sortDir.toLowerCase() : "",
        onclick: () => {
          let nextDir;
          if (isActive) {
            nextDir = sortDir === "ASC" ? "desc" : "asc";
          } else {
            nextDir = numeric ? "desc" : "asc";
          }
          // Reset do strony 1 przy zmianie sortowania — inaczej user
          // wylądowałby na środku posortowanego inaczej zbioru.
          const { page: _drop, ...rest } = params;
          navigate("#/listings", { ...rest, sort: key, dir: nextDir });
        },
      },
      label,
    );
    return th;
  }

  const table = el("table");
  table.appendChild(el(
    "thead", {},
    el("tr", {},
      sortableTh("Status", "status"),
      sortableTh("Tytuł", "title"),
      sortableTh("Rok", "year", { numeric: true }),
      sortableTh("Przebieg", "mileage", { numeric: true }),
      sortableTh("Paliwo", "fuel_type"),
      sortableTh("KM", "power", { numeric: true }),
      sortableTh("Cena", "price", { numeric: true }),
      sortableTh("Last seen", "last_seen", { numeric: true }),
      el("th", {}, ""),
    ),
  ));
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr", { onclick: (e) => {
      if (e.target.tagName === "A") return;
      navigate(`#/listing/${r.id}`);
    }},
      el("td", {}, activeBadge(r.is_active)),
      el("td", {}, el("span", { class: "row-link" }, r.title || r.external_id)),
      el("td", { class: "num" }, r.last_year || "—"),
      el("td", { class: "num" }, formatMileage(r.last_mileage)),
      el("td", { class: "muted" }, formatEnum(r.fuel_type)),
      el("td", { class: "num" }, r.engine_power != null ? `${r.engine_power}` : "—"),
      el("td", { class: "num" }, formatPrice(r.last_price_amount)),
      el("td", { class: "muted tabular" }, formatRelative(r.last_seen_at)),
      el("td", {}, el("a", { href: r.listing_url, target: "_blank", rel: "noopener" }, "link ↗")),
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const panel = el("div", { class: "panel" });
  panel.appendChild(table);
  view.appendChild(panel);

  // Kontrolki paginacji — pokazujemy tylko gdy jest więcej niż 1 strona.
  // Prev/Next mutują wyłącznie `page`, reszta filtrów/sortu zostaje bez
  // zmian (stąd spread `params`).
  if (totalPages > 1) {
    const goTo = (p) => navigate("#/listings", { ...params, page: String(p) });
    const pager = el("div", { class: "pager" },
      el("button", {
        type: "button",
        class: "secondary",
        disabled: page <= 1 ? "" : null,
        onclick: () => goTo(page - 1),
      }, "← Poprzednia"),
      el("span", { class: "muted tabular" }, `Strona ${page} z ${totalPages}`),
      el("button", {
        type: "button",
        class: "secondary",
        disabled: page >= totalPages ? "" : null,
        onclick: () => goTo(page + 1),
      }, "Następna →"),
    );
    view.appendChild(pager);
  }
}

function viewListingDetail(view, id) {
  const listing = query(
    state.db,
    `SELECT l.*, s.name AS source_name FROM listings l JOIN sources s ON s.id = l.source_id WHERE l.id = ?`,
    [id],
  )[0];
  if (!listing) {
    view.appendChild(el("p", { class: "empty" }, `Nie ma listingu o id ${id}`));
    return;
  }

  const sellerLabel = formatSellerLabel(listing);
  const sellerListingsHref = listing.seller_uuid
    ? buildHash("#/listings", { sellerUuid: listing.seller_uuid })
    : null;

  view.appendChild(el(
    "div", { class: "detail-header" },
    el("div", {},
      el("h1", {}, listing.title || listing.external_id),
      el("div", { class: "meta" },
        activeBadge(listing.is_active),
        el("span", {}, `źródło: ${listing.source_name}`),
        listing.seller_type ? el("span", {}, `sprzedawca: ${listing.seller_type === "BUSINESS" ? "Firma" : listing.seller_type === "PRIVATE" ? "Osoba prywatna" : listing.seller_type}`) : null,
        sellerLabel ? el("span", {}, sellerLabel) : null,
        sellerListingsHref ? el("a", { href: sellerListingsHref }, "Wszystkie oferty sprzedawcy") : null,
        el("span", {}, `external id: ${listing.external_id}`),
        el("a", { href: listing.listing_url, target: "_blank", rel: "noopener" }, "Otwórz ofertę ↗"),
      ),
    ),
  ));

  // Najważniejsze meta jako stat cards. Pierwszy rząd to standardowe price/year/mileage,
  // drugi rząd to specyfikacja techniczna z params columns (fuel_type, body_type, ...)
  // — pojawia się tylko jeśli te dane mamy (większość listingów ma).
  const cards = el("div", { class: "cards" });
  cards.append(
    statCard("Cena", formatPrice(listing.last_price_amount)),
    statCard("Rok", listing.year || listing.last_year || "—"),
    statCard("Przebieg", formatMileage(listing.mileage || listing.last_mileage)),
    statCard("Pierwszy raz", formatDate(listing.first_seen_at)),
    statCard("Ostatni raz", formatDate(listing.last_seen_at)),
  );
  view.appendChild(cards);

  // Drugi rząd: technical spec. Tylko jeśli mamy choć jedno z pól, żeby
  // pusty rząd "—" nie zaśmiecał ekranu dla listingów-szkieletów.
  const hasSpecs = listing.fuel_type || listing.body_type || listing.gearbox || listing.engine_power;
  if (hasSpecs) {
    const specCards = el("div", { class: "cards" });
    // Build the list and filter falsy entries BEFORE Element.append — DOM
    // append() coerces null/undefined into the string "null"/"undefined" and
    // shoves them into the document as text nodes (manifested as a stray
    // "nullnull" floating next to the spec cards for non-EV listings where
    // battery_capacity and autonomy are both null). Our `el()` helper filters
    // these out automatically, but we're calling the raw DOM API here.
    const specs = [
      statCard("Paliwo", formatEnum(listing.fuel_type)),
      statCard("Nadwozie", formatEnum(listing.body_type)),
      statCard("Skrzynia", formatEnum(listing.gearbox)),
      statCard("Moc", listing.engine_power ? `${listing.engine_power} KM` : "—"),
      // EV-specific: pojemność baterii i zasięg pokazujemy tylko jeśli auto
      // ma te pola. Dla benzyniaków by było mylące (a battery_capacity = null).
      listing.battery_capacity ? statCard("Bateria", `${listing.battery_capacity} kWh`) : null,
      listing.autonomy ? statCard("Zasięg", `${listing.autonomy} km`) : null,
    ].filter(Boolean);
    specCards.append(...specs);
    view.appendChild(specCards);
  }

  // ----- Panel: Gallery (zdjęcia z last snapshot payload_json) -----
  // Lazy parse — snapshot payload_json is ~26 KB and we want to skip the parse
  // for listings that don't have a snapshot yet (card-only placeholders after
  // a failed detail fetch). Renders a responsive CSS grid of 4:3 thumbnails,
  // click opens full-res in a new tab. No lightbox — simplest path that doesn't
  // require any modal/focus-trap UX work.
  const lastSnapshot = listing.last_snapshot_id
    ? query(state.db, "SELECT payload_json FROM listing_snapshots WHERE id = ?", [listing.last_snapshot_id])[0]
    : null;
  let galleryUrls = [];
  if (lastSnapshot?.payload_json) {
    try {
      const payload = JSON.parse(lastSnapshot.payload_json);
      if (Array.isArray(payload.images?.urls)) {
        galleryUrls = payload.images.urls;
      }
    } catch {}
  }
  if (galleryUrls.length > 0) {
    const galleryPanel = el("div", { class: "panel" });
    galleryPanel.appendChild(el("div", { class: "panel-header" }, `Zdjęcia (${galleryUrls.length})`));
    const grid = el("div", { class: "listing-gallery" });
    for (const url of galleryUrls) {
      grid.appendChild(
        el("a", {
          href: url,
          target: "_blank",
          rel: "noopener noreferrer",
          class: "gallery-item",
          title: "Otwórz pełny rozmiar",
        },
          el("img", { src: url, loading: "lazy", alt: "" }),
        ),
      );
    }
    galleryPanel.appendChild(grid);
    view.appendChild(galleryPanel);
  }

  // ----- Panel: Opis sprzedawcy -----
  // description_text pochodzi z stripHtml(advert.description) w normalizeDetail
  // — czysty tekst z zachowanymi newline'ami (stripHtml konwertuje <br> i </p>
  // na \n). Renderujemy jako pre-wrap żeby podział akapitów się nie zgubił.
  // description_html celowo NIE jest pokazywany — źródło wstrzykuje w surowy
  // HTML rotujące inline phone spans, więc byłby to noise + potencjalna
  // powierzchnia XSS gdyby innerHTML kiedykolwiek został użyty.
  // Panel pomijamy całkowicie gdy opis pusty — nie ma sensu rysować pustego
  // kontenera (listing-szkielet bez detalu nie ma description_text).
  if (listing.description_text && listing.description_text.trim().length > 0) {
    const descPanel = el("div", { class: "panel" });
    descPanel.appendChild(el("div", { class: "panel-header" }, "Opis sprzedawcy"));
    descPanel.appendChild(el("div", { class: "description-body" }, listing.description_text));
    view.appendChild(descPanel);
  }

  // ----- Panel: Identyfikacja -----
  // VIN, numer rejestracyjny, data pierwszej rejestracji i telefony.
  // Wszystkie pola są opcjonalne — sprzedawcy nie są zmuszeni je wypełniać.
  // Panel pokazujemy zawsze (nawet jeśli wszystko puste) bo brak VIN/rejestracji
  // sam w sobie jest sygnałem (np. "auto bez papierów" = warto wiedzieć).
  const phones = parsePhonesJson(listing.phones_json);
  const idPanel = el("div", { class: "panel" });
  idPanel.appendChild(el("div", { class: "panel-header" }, "Identyfikacja"));
  const idTable = el("table");
  const idBody = el("tbody");
  idBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "VIN"),
    el("td", { class: listing.vin ? "tabular" : "muted" }, listing.vin || "—"),
  ));
  idBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Numer rejestracyjny"),
    el("td", { class: listing.registration ? "tabular" : "muted" }, listing.registration || "—"),
  ));
  idBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Pierwsza rejestracja"),
    el("td", { class: listing.date_registration ? "tabular" : "muted" }, listing.date_registration || "—"),
  ));
  // Telefony renderujemy osobno dla pól głównych i tych znalezionych w opisie.
  idBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Telefony (główne)"),
    el("td", {}, renderPhoneList(phones.main)),
  ));
  if (phones.description.length > 0) {
    idBody.appendChild(el("tr", { class: "no-click" },
      el("th", {}, "Telefony (z opisu)"),
      el("td", {}, renderPhoneList(phones.description)),
    ));
  }
  idTable.appendChild(idBody);
  idPanel.appendChild(idTable);
  view.appendChild(idPanel);

  // Stan i historia (z denormalizowanych kolumn listings)
  const conditionPanel = el("div", { class: "panel" });
  conditionPanel.appendChild(el("div", { class: "panel-header" }, "Stan i historia (deklaracja sprzedawcy)"));
  const conditionRows = [
    ["Uszkodzony", listing.damaged, true],          // true = bad if Yes
    ["Bezwypadkowy", listing.no_accident, false],   // false = good if Yes
    ["Książka serwisowa", listing.service_record, false],
    ["Pierwszy właściciel", listing.original_owner, false],
    ["Sprowadzony", listing.is_imported_car, null], // null = neutral
    ["Tuningowany", listing.tuning, true],
    ["Pojazd zabytkowy", listing.historical_vehicle, null],
    ["Zarejestrowany", listing.registered, false],
  ];
  const conditionTable = el("table");
  const conditionBody = el("tbody");
  for (const [label, value, badIfYes] of conditionRows) {
    let display, cls;
    if (value == null) {
      display = "—";
      cls = "muted";
    } else if (value === 1) {
      display = "Tak";
      cls = badIfYes === true ? "price-rise" : badIfYes === false ? "price-drop" : "";
    } else {
      display = "Nie";
      cls = badIfYes === true ? "price-drop" : badIfYes === false ? "price-rise" : "muted";
    }
    conditionBody.appendChild(el("tr", { class: "no-click" },
      el("th", {}, label),
      el("td", { class: cls }, display),
    ));
  }
  // text fields
  conditionBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Stan"),
    el("td", {}, listing.new_used || "—"),
  ));
  conditionBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Kraj pochodzenia"),
    el("td", {}, listing.country_origin || "—"),
  ));
  conditionTable.appendChild(conditionBody);
  conditionPanel.appendChild(conditionTable);
  view.appendChild(conditionPanel);

  // Price history
  const snapshots = query(
    state.db,
    `SELECT id, run_id, snapshot_hash, captured_at, price_amount
     FROM listing_snapshots WHERE listing_id = ? ORDER BY captured_at ASC`,
    [id],
  );
  const priceSeries = snapshots
    .map((s) => ({ t: new Date(s.captured_at).getTime(), v: Number(s.price_amount) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));

  const pricePanel = el("div", { class: "panel" });
  pricePanel.appendChild(el("div", { class: "panel-header" }, `Historia ceny (${priceSeries.length} snapshotów)`));
  pricePanel.appendChild(
    priceSeries.length >= 2
      ? renderSparkline(priceSeries, 720, 120)
      : el("p", { class: "empty" }, "Za mało snapshotów żeby narysować historię."),
  );
  view.appendChild(pricePanel);

  // Timeline of changes
  const changes = filterVisibleChanges(query(
    state.db,
    `SELECT id, created_at, field_name, old_value, new_value
     FROM listing_changes WHERE listing_id = ?
     ORDER BY created_at DESC, field_name ASC LIMIT 500`,
    [id],
  ));
  const timelinePanel = el("div", { class: "panel" });
  timelinePanel.appendChild(el("div", { class: "panel-header" }, `Zmiany (${changes.length})`));
  if (changes.length === 0) {
    timelinePanel.appendChild(el("p", { class: "empty" }, "Brak zmian."));
  } else {
    const ul = el("ul", { class: "timeline" });
    for (const c of changes) {
      ul.appendChild(el("li", {},
        el("div", { class: "when" }, formatDate(c.created_at)),
        el("div", {},
          el("div", { class: "field" }, c.field_name),
          el("div", { class: "diff-row" },
            el("span", { class: "change-old" }, renderDiffSide("old", c.old_value, c.new_value, c.field_name)),
            el("span", { class: "diff-arrow" }, " → "),
            el("span", { class: "change-new" }, renderDiffSide("new", c.new_value, c.old_value, c.field_name)),
          ),
        ),
      ));
    }
    timelinePanel.appendChild(ul);
  }
  view.appendChild(timelinePanel);

  // Snapshots list
  const snapPanel = el("div", { class: "panel" });
  snapPanel.appendChild(el("div", { class: "panel-header" }, `Snapshoty (${snapshots.length})`));
  if (snapshots.length === 0) {
    snapPanel.appendChild(el("p", { class: "empty" }, "Brak snapshotów (oferta widziana tylko z karty)."));
  } else {
    const table = el("table");
    table.appendChild(el("thead", {}, el("tr", {},
      el("th", {}, "Kiedy"),
      el("th", {}, "Hash"),
      el("th", { class: "num" }, "Cena"),
    )));
    const tbody = el("tbody");
    for (const s of snapshots.slice().reverse()) {
      tbody.appendChild(el("tr", { class: "no-click" },
        el("td", { class: "tabular muted" }, formatDate(s.captured_at)),
        el("td", { class: "muted" }, s.snapshot_hash.slice(0, 12)),
        el("td", { class: "num tabular" }, formatPrice(s.price_amount)),
      ));
    }
    table.appendChild(tbody);
    snapPanel.appendChild(table);
  }
  view.appendChild(snapPanel);
}

function viewChanges(view, params) {
  view.classList.add("view-wide");
  view.appendChild(el("h1", {}, "Changes feed"));

  // "Tylko zmiany" filter — domyślnie ON, bo __listing_created leci dla każdej
  // świeżo wykrytej oferty i zalewa feed. Odznaczenie checkboxa pokazuje WSZYSTKO
  // (kreacje + reaktywacje + zmiany pól). URL: brak parametru = ON, includeCreated=1 = OFF.
  const includeCreated = params.includeCreated === "1";

  const sources = query(state.db, "SELECT id, name FROM sources ORDER BY created_at ASC");
  const fieldNames = query(
    state.db,
    "SELECT field_name, COUNT(*) AS n FROM listing_changes GROUP BY field_name ORDER BY n DESC LIMIT 50",
  );

  const filters = el("form", { class: "filters", onsubmit: (e) => { e.preventDefault(); applyFilters(); }});
  const sourceSelect = el("select", { name: "source" },
    el("option", { value: "" }, "Wszystkie"),
    ...sources.map((s) => {
      const opt = el("option", { value: s.id }, s.name || s.id);
      if (params.source === s.id) opt.setAttribute("selected", "");
      return opt;
    }),
  );
  const fieldSelect = el("select", { name: "field" },
    el("option", { value: "" }, "Wszystkie pola"),
    ...fieldNames.map((f) => {
      const opt = el("option", { value: f.field_name }, `${f.field_name} (${f.n})`);
      if (params.field === f.field_name) opt.setAttribute("selected", "");
      return opt;
    }),
  );
  filters.append(
    field("Szukaj w tytule", input("text", "q", params.q, "tytuł listingu..."), "field-search"),
    field("Źródło", sourceSelect),
    field("Pole", fieldSelect),
    field("Od", input("date", "since", params.since)),
    checkboxField("Pokaż", "includeCreated", "Nowe ogłoszenia", includeCreated),
    el("div", { class: "actions" },
      el("button", { type: "button", class: "secondary", onclick: () => navigate("#/changes") }, "Reset"),
      el("button", { type: "submit" }, "Filtruj"),
    ),
  );
  view.appendChild(filters);

  function applyFilters() {
    const data = new FormData(filters);
    const next = {};
    for (const [k, v] of data.entries()) if (v) next[k] = v;
    navigate("#/changes", next);
  }

  const where = ["1=1"];
  const args = [];
  if (params.source) { where.push("l.source_id = ?"); args.push(params.source); }
  if (params.field) { where.push("lc.field_name = ?"); args.push(params.field); }
  if (params.since) { where.push("lc.created_at >= ?"); args.push(params.since); }
  if (params.q) { where.push("lower(l.title) LIKE ?"); args.push(`%${params.q.toLowerCase()}%`); }
  if (!includeCreated) where.push("lc.field_name != '__listing_created'");

  const rows = filterVisibleChanges(query(
    state.db,
    `SELECT lc.id, lc.created_at, lc.field_name, lc.old_value, lc.new_value,
            l.id AS listing_id, l.title
     FROM listing_changes lc
     JOIN listings l ON l.id = lc.listing_id
     WHERE ${where.join(" AND ")}
     ORDER BY lc.created_at DESC
     LIMIT 1000`,
    args,
  ));

  view.appendChild(el("p", { class: "muted" }, `${rows.length} zmian`));

  if (rows.length === 0) {
    view.appendChild(el("p", { class: "empty" }, "Brak zmian."));
    return;
  }

  const table = el("table");
  table.appendChild(el("thead", {}, el("tr", {},
    el("th", {}, "Kiedy"),
    el("th", {}, "Pole"),
    el("th", {}, "Z"),
    el("th", {}, "Na"),
    el("th", {}, "Oferta"),
  )));
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr", { onclick: () => navigate(`#/listing/${r.listing_id}`) },
      el("td", { class: "tabular muted" }, formatRelative(r.created_at)),
      el("td", {}, el("span", { class: "field" }, r.field_name)),
      el("td", { class: "change-old" }, renderDiffSide("old", r.old_value, r.new_value, r.field_name, { compactMultiline: true })),
      el("td", { class: "change-new" }, renderDiffSide("new", r.new_value, r.old_value, r.field_name, { compactMultiline: true })),
      el("td", {}, el("span", { class: "row-link" }, r.title || r.listing_id)),
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const panel = el("div", { class: "panel" });
  panel.appendChild(table);
  view.appendChild(panel);
}

function viewRuns(view) {
  view.classList.add("view-wide");
  view.appendChild(el("h1", {}, "Runs"));
  const rows = query(
    state.db,
    `SELECT r.*, s.name AS source_name
     FROM scrape_runs r JOIN sources s ON s.id = r.source_id
     ORDER BY r.started_at DESC
     LIMIT 200`,
  );

  if (rows.length === 0) {
    view.appendChild(el("p", { class: "empty" }, "Brak runów."));
    return;
  }

  const table = el("table");
  table.appendChild(el("thead", {}, el("tr", {},
    el("th", {}, "Źródło"),
    el("th", {}, "Status"),
    el("th", {}, "Start"),
    el("th", {}, "Czas"),
    el("th", { class: "num" }, "Discovery"),
    el("th", { class: "num" }, "Detail ok/fail"),
    el("th", { class: "num" }, "New"),
    el("th", { class: "num" }, "Changed"),
    el("th", { class: "num" }, "Removed"),
    el("th", {}, "Trigger"),
    el("th", {}, "Błąd"),
  )));
  const tbody = el("tbody");
  for (const r of rows) {
    const duration = r.finished_at && r.started_at
      ? `${Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000)}s`
      : "—";
    tbody.appendChild(el("tr", { class: "no-click" },
      el("td", {}, r.source_name),
      el("td", {}, statusBadge(r.status)),
      el("td", { class: "tabular muted" }, formatDate(r.started_at)),
      el("td", { class: "tabular" }, duration),
      el("td", { class: "num tabular" }, `${r.unique_row_count ?? "—"}/${r.reported_total_count ?? "—"}`),
      el("td", { class: "num tabular" }, `${r.detail_success_count}/${r.detail_failed_count}`),
      el("td", { class: "num tabular" }, r.new_listings_count),
      el("td", { class: "num tabular" }, r.changed_listings_count),
      el("td", { class: "num tabular" }, r.removed_listings_count),
      el("td", { class: "muted" }, r.trigger_type),
      el("td", { class: "muted" }, r.error ? truncate(r.error, 60) : "—"),
    ));
  }
  table.appendChild(tbody);
  const panel = el("div", { class: "panel" });
  panel.appendChild(table);
  view.appendChild(panel);
}

// ---------- small helpers ----------

function statCard(label, value) {
  return el("div", { class: "card" },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value),
  );
}

function row(label, value) {
  return el("tr", {},
    el("th", {}, label),
    el("td", {}, value instanceof Node ? value : String(value ?? "—")),
  );
}

function field(label, control, extraClass = "") {
  return el("div", { class: extraClass ? `field ${extraClass}` : "field" }, el("label", {}, label), control);
}

// Two-input range field. Renders Min/Max as a single labelled .field with the
// inputs sharing one row separated by an en-dash. Halves the visible field
// count for ranges (Rok, Cena, Przebieg, Moc) which would otherwise consume
// 8 grid cells.
function rangeField(label, minName, maxName, minValue, maxValue, opts = {}) {
  const type = opts.type || "number";
  const minPlaceholder = opts.minPlaceholder || "Min";
  const maxPlaceholder = opts.maxPlaceholder || "Max";
  return el("div", { class: "field" },
    el("label", {}, label),
    el("div", { class: "range-inputs" },
      input(type, minName, minValue, minPlaceholder),
      el("span", { class: "range-sep" }, "–"),
      input(type, maxName, maxValue, maxPlaceholder),
    ),
  );
}

function input(type, name, value, placeholder) {
  const attrs = { type, name };
  if (placeholder) attrs.placeholder = placeholder;
  const node = el("input", attrs);
  if (value != null && value !== "") node.value = value;
  return node;
}

// Labelled checkbox that lays out the same height as other filter fields.
// Renders as: top label ("Pokaż") + horizontal [☐] inline-text row.
function checkboxField(label, name, inlineText, checked) {
  const cb = el("input", { type: "checkbox", name, value: "1" });
  if (checked) cb.setAttribute("checked", "");
  const row = el("label", { class: "checkbox-row" },
    cb,
    el("span", { class: "checkbox-text" }, inlineText),
  );
  return el("div", { class: "field checkbox-field" },
    el("label", {}, label),
    row,
  );
}

function listingLink(id, label) {
  return el("a", { href: `#/listing/${id}` }, label);
}

function panelTable(title, headers, rows, rowClickHandlers, emptyMsg) {
  const panel = el("div", { class: "panel" });
  panel.appendChild(el("div", { class: "panel-header" }, title));
  if (rows.length === 0) {
    panel.appendChild(el("p", { class: "empty" }, emptyMsg || "Brak danych."));
    return panel;
  }
  const table = el("table");
  table.appendChild(el("thead", {}, el("tr", {}, ...headers.map((h) => h instanceof Node ? h : el("th", {}, h)))));
  const tbody = el("tbody");
  rows.forEach((cells, i) => {
    const handler = rowClickHandlers && rowClickHandlers[i];
    const tr = el("tr", handler ? { onclick: (e) => { if (e.target.tagName !== "A") handler(); } } : { class: "no-click" },
      ...cells.map((c) => el("td", {}, c instanceof Node ? c : String(c ?? "—"))),
    );
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  return panel;
}

function truncate(text, n) {
  if (text == null) return "—";
  const s = String(text);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatSellerLabel(listing) {
  const parts = [];
  if (listing?.seller_name) parts.push(listing.seller_name);
  if (listing?.seller_location_city) parts.push(listing.seller_location_city);
  if (listing?.seller_location_region) parts.push(listing.seller_location_region);
  return parts.join(" · ") || listing?.seller_uuid || "";
}

function formatChangeValue(fieldName, value) {
  if (value == null) return "—";
  if (fieldName === "price.value") return formatPrice(value);
  return String(value);
}

function formatCountPl(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (n === 1) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatValueAddedServicesSummary(side, diff) {
  const parts = [];
  if (side === "old") {
    if (diff.removedCount) {
      parts.push(`− ${diff.removedCount} ${formatCountPl(diff.removedCount, "usunięta", "usunięte", "usuniętych")}`);
    }
    if (diff.changedCount) {
      parts.push(`~ ${diff.changedCount} ${formatCountPl(diff.changedCount, "zmiana", "zmiany", "zmian")}`);
    }
  } else {
    if (diff.addedCount) {
      parts.push(`+ ${diff.addedCount} ${formatCountPl(diff.addedCount, "dodana", "dodane", "dodanych")}`);
    }
    if (diff.changedCount) {
      parts.push(`~ ${diff.changedCount} ${formatCountPl(diff.changedCount, "zmiana", "zmiany", "zmian")}`);
    }
  }
  return parts.join(" · ");
}

function isEquivalentValueAddedServicesChange(fieldName, oldValue, newValue) {
  if (fieldName !== "value_added_services") return false;
  const diff = diffValueAddedServices(oldValue, newValue);
  return diff?.equivalentAfterNormalization === true;
}

function filterVisibleChanges(rows) {
  return rows.filter((row) => !isEquivalentValueAddedServicesChange(row.field_name, row.old_value, row.new_value));
}

function renderValueAddedServiceItem(service, side) {
  const kindLabel = {
    old: {
      changed: "przed",
      removed: "usunięte",
    },
    new: {
      changed: "po",
      added: "dodane",
    },
  }[side]?.[service.diffKind] || service.diffKind;

  const meta = [];
  if (service.validity) meta.push(`ważne do ${formatDate(service.validity)}`);
  if (service.appliedAt) meta.push(`${service.name === "bump_up" ? "podbite" : "aktywowane"} ${formatDate(service.appliedAt)}`);
  if (service.exportedAdId) meta.push(`${service.name === "export_olx" ? "ID OLX" : "ID eksportu"} ${service.exportedAdId}`);

  return el("div", { class: `service-diff-item service-diff-item--${side}` },
    el("div", { class: "service-diff-head" },
      el("div", { class: "service-diff-title" }, formatValueAddedServiceName(service.name)),
      el("span", { class: `service-diff-badge service-diff-badge--${side}` }, kindLabel),
    ),
    meta.length > 0 ? el("div", { class: "service-diff-meta" }, meta.join(" · ")) : null,
  );
}

function renderValueAddedServicesDiffSide(side, oldValue, newValue) {
  const diff = diffValueAddedServices(oldValue, newValue);
  if (!diff) return null;
  if (diff.equivalentAfterNormalization) {
    return el("div", { class: "service-diff service-diff--noop" },
      el("span", { class: "muted" }, "— tylko kolejność"),
    );
  }

  const items = side === "old" ? diff.oldItems : diff.newItems;
  if (items.length === 0) return el("span", { class: "muted" }, "—");

  const wrap = el("div", { class: "service-diff" });
  const summary = formatValueAddedServicesSummary(side, diff);
  if (summary) {
    wrap.appendChild(el("div", { class: `service-diff-label service-diff-label--${side}` }, summary));
  }
  const list = el("div", { class: "service-diff-list" });
  for (const item of items) list.appendChild(renderValueAddedServiceItem(item, side));
  wrap.appendChild(list);
  return wrap;
}

function appendTextDiffSegments(node, side, segments) {
  const keep = side === "old" ? new Set(["common", "removed"]) : new Set(["common", "added"]);
  const clsFor = (type) =>
    type === "common" ? "diff-context" : type === "removed" ? "diff-removed" : "diff-added";
  for (const seg of segments) {
    if (!keep.has(seg.type)) continue;
    node.appendChild(el("span", { class: clsFor(seg.type) }, seg.text));
  }
}

function renderCompactTextDiff(side, segments) {
  const compact = compactMultiLineSegments(segments, { contextLines: 1, minLines: 8 });
  if (!compact.compacted) return null;

  const wrap = el("div", { class: "text-diff text-diff--compact" });
  for (const entry of compact.entries) {
    if (entry.kind === "omitted") {
      wrap.appendChild(
        el(
          "div",
          { class: "text-diff-ellipsis" },
          `… pominięto ${entry.omittedLineCount} ${formatCountPl(entry.omittedLineCount, "linię", "linie", "linii")} …`,
        ),
      );
      continue;
    }
    const line = el("div", { class: "text-diff-line" });
    if (entry.pieces.length === 0) line.appendChild(document.createTextNode(" "));
    else appendTextDiffSegments(line, side, entry.pieces);
    wrap.appendChild(line);
  }
  return wrap;
}

// Render one side of a diff (old or new). Common prefix/suffix render dim,
// the changed middle highlights either red (removed) or green (added)
// depending on which side we're rendering. For text fields where there's
// no opposite value (initial creation, deletion), falls back to plain text.
// Special-cases images.urls to render actual thumbnail grids instead of
// the raw JSON URL array.
function renderDiffSide(side, ownValue, oppositeValue, fieldName, options = {}) {
  if (ownValue == null) return el("span", { class: "muted" }, "—");
  // images.urls: array of marketplace CDN URLs flattened to a JSON string by
  // flattenForDiff. Render thumbnails of the delta instead of a 5 KB wall
  // of base64-looking JWT URLs which the word-diff can't usefully highlight.
  if (fieldName === "images.urls") {
    return renderImageDiffSide(side, ownValue, oppositeValue);
  }
  if (fieldName === "value_added_services") {
    const rendered = renderValueAddedServicesDiffSide(
      side,
      side === "old" ? ownValue : oppositeValue,
      side === "old" ? oppositeValue : ownValue,
    );
    if (rendered) return rendered;
  }
  // For numeric/short fields use legacy formatting — diff highlighting on
  // a number is just visual noise.
  if (
    oppositeValue == null ||
    fieldName === "price.value" ||
    fieldName === "__listing_status" ||
    fieldName === "__listing_created" ||
    String(ownValue).length < 20
  ) {
    return document.createTextNode(formatChangeValue(fieldName, ownValue));
  }
  // Two code paths depending on multi-line-ness:
  //   - multi-line text (description_text etc.) → line-level LCS, handles
  //     multi-region edits correctly. Before this, affix-based diffTokens
  //     collapsed everything between the first and last changed line into
  //     one giant red/green block — even when 12 out of 15 lines in between
  //     were identical. LCS walks both texts and produces a segment list
  //     that naturally handles any number of interleaved changed regions.
  //   - single-line values (JSON blobs, URLs, short strings) → token-level
  //     diff so multiple edit islands inside one string still render as
  //     separate red/green fragments.
  const oldStr = String(side === "old" ? ownValue : oppositeValue);
  const newStr = String(side === "old" ? oppositeValue : ownValue);
  const isMultiLine = oldStr.includes("\n") || newStr.includes("\n");
  const segments = isMultiLine
    ? diffLines(oldStr, newStr)
    : tokenDiffAsSegments(oldStr, newStr);

  if (isMultiLine && options.compactMultiline) {
    const compact = renderCompactTextDiff(side, segments);
    if (compact) return compact;
  }

  const wrap = el("div", { class: "text-diff" });
  // Concatenate emitted segments with no separator. Line boundaries are
  // already baked into segment text by diffLines() (trailing \n on every
  // segment except the last), and single-line diffs never have newlines
  // by definition. This keeps refined intra-line fragments like
  //   common "*) Automatyczna klimatyzacja" + added " 4 strefowa"
  // from getting a spurious \n shoved between them.
  appendTextDiffSegments(wrap, side, segments);
  return wrap;
}

// images.urls-specific diff view. On the "old" side we show photos that were
// REMOVED (present in old, absent in new); on the "new" side we show photos
// that were ADDED (present in new, absent in old). Reorder-only changes
// (same set of URLs, different order) render as an empty "— reorder" label
// since stableStringify sorts array contents alphabetically before
// serialization — meaning a pure reorder wouldn't even register as a change
// in the first place, but we handle the degenerate case defensively.
function renderImageDiffSide(side, ownValue, oppositeValue) {
  const parseUrls = (raw) => {
    try {
      const v = JSON.parse(raw || "[]");
      return Array.isArray(v) ? v.filter((u) => typeof u === "string") : [];
    } catch {
      return null;
    }
  };
  const own = parseUrls(ownValue);
  const opp = parseUrls(oppositeValue);
  // If either side isn't parseable JSON array, fall back to plain text so
  // we never render a broken view. Shouldn't happen in practice — flatten
  // always stableStringify's arrays — but defensive.
  if (own == null || opp == null) {
    return document.createTextNode(truncate(String(ownValue ?? ""), 80));
  }
  const oppSet = new Set(opp);
  const delta = own.filter((u) => !oppSet.has(u));
  if (delta.length === 0) {
    // Nothing unique on our side — either sets are equal (shouldn't happen
    // if a change was recorded) or our side is a subset of the opposite.
    return el("span", { class: "muted" }, "—");
  }
  const labelText = side === "old"
    ? `− ${delta.length} usuni${delta.length === 1 ? "ęte" : "ętych"}`
    : `+ ${delta.length} dodan${delta.length === 1 ? "e" : "ych"}`;
  const wrap = el("div", { class: "image-diff" });
  wrap.appendChild(
    el("div", { class: `image-diff-label image-diff-label--${side}` }, labelText),
  );
  const grid = el("div", { class: "image-grid" });
  for (const url of delta) {
    // Anchor so user can click through to the full-res version on the marketplace CDN
    // CDN. rel=noopener because these are third-party.
    const link = el("a", {
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
      class: "image-thumb-link",
      title: side === "old" ? "usunięte z ogłoszenia" : "dodane do ogłoszenia",
    },
      el("img", {
        src: url,
        class: `image-thumb image-thumb--${side}`,
        loading: "lazy",
        alt: "",
      }),
    );
    grid.appendChild(link);
  }
  wrap.appendChild(grid);
  return wrap;
}

// The source stores enum params (fuel_type, body_type, gearbox, ...) as URL-friendly
// slugs ("plug-in-hybrid", "all-wheel-auto"). We don't have a translation table
// (the human labels live separately in advert.parametersDict[*].values[0].label
// and weren't materialized into columns). For now: best-effort prettification —
// replace separators with spaces and uppercase the first letter.
function formatEnum(slug) {
  if (slug == null || slug === "") return "—";
  const s = String(slug).replace(/[-_]+/g, " ").trim();
  if (!s) return "—";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// phones_json shape from migration 0003: {"main":[...],"description":[...]}.
// Defensive parsing — older snapshots might not have it set yet.
function parsePhonesJson(raw) {
  if (!raw) return { main: [], description: [] };
  try {
    const obj = JSON.parse(raw);
    return {
      main: Array.isArray(obj.main) ? obj.main : [],
      description: Array.isArray(obj.description) ? obj.description : [],
    };
  } catch {
    return { main: [], description: [] };
  }
}

function renderPhoneList(numbers) {
  if (!numbers || numbers.length === 0) return el("span", { class: "muted" }, "—");
  // Dedupe before rendering — inline tokens often repeat the same number 2-3
  // times (raz w tekście, raz w przyciskach "Pokaż telefon").
  const seen = new Set();
  const unique = [];
  for (const n of numbers) {
    const key = String(n).replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(n);
  }
  const wrap = el("div", { class: "phone-list" });
  unique.forEach((num, i) => {
    if (i > 0) wrap.appendChild(document.createTextNode(", "));
    // tel: link works on mobile, no-op on desktop browsers — harmless either way
    const href = `tel:${String(num).replace(/\s+/g, "")}`;
    wrap.appendChild(el("a", { href, class: "tabular" }, String(num)));
  });
  return wrap;
}

function renderSparkline(series, width, height) {
  // SVG with line + dots + min/max labels.
  if (series.length < 2) return el("p", { class: "empty" }, "Brak danych.");
  const padX = 40;
  const padY = 16;
  const xs = series.map((p) => p.t);
  const ys = series.map((p) => p.v);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const sx = (t) => padX + ((t - xMin) / xRange) * (width - padX * 2);
  const sy = (v) => height - padY - ((v - yMin) / yRange) * (height - padY * 2);

  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ");
  const dots = series.map((p) => `<circle cx="${sx(p.t).toFixed(1)}" cy="${sy(p.v).toFixed(1)}" r="3" fill="#2563eb" />`).join("");

  const svg = `
    <svg class="sparkline" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet">
      <text x="4" y="${(padY + 4).toFixed(0)}" font-size="11" fill="#6b7280">${formatPrice(yMax)}</text>
      <text x="4" y="${height - 4}" font-size="11" fill="#6b7280">${formatPrice(yMin)}</text>
      <path d="${path}" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
    </svg>
  `;
  return el("div", { html: svg, style: "padding: 16px;" });
}
