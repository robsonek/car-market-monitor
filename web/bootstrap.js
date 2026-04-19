// Bootstrap: theme, topbar, watchlist/saved-filters state sync, DB loading,
// batch summarization. Wszystko co odpala się raz na starcie albo siedzi
// w `state` i nie należy do konkretnego widoku.

import { state } from "./core.js";
import { stripHtml } from "./format.js";
import {
  WATCHLIST_STORAGE_KEY,
  parseWatchlist,
  removeWatchlistEntry,
  serializeWatchlist,
  upsertWatchlistEntry,
  watchlistEntryKey,
} from "./watchlist.js";
import {
  SAVED_FILTERS_STORAGE_KEY,
  parseSavedFilters,
  serializeSavedFilters,
} from "./saved-filters.js";

const SQLJS_BASE = "./";
const DB_PATH = "../db/car-market-monitor.sqlite";
const DB_MANIFEST_PATH = `${DB_PATH}.version.json`;

// ---------- DB ----------

export async function loadDb() {
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
  const db = new SQL.Database(new Uint8Array(buf));
  // Rejestrujemy funkcję SQL strip_html, żeby search mógł filtrować po tekście
  // opisu wyprowadzonym z payload_json.description_html. Opis żyje w bazie
  // wyłącznie jako HTML — plain text liczymy w locie. Przy ~2k listingach
  // full-scan z per-row strip_html jest szybszy niż alternatywy i nie wymaga
  // duplikowania tekstu w osobnej kolumnie.
  db.create_function("strip_html", (html) => stripHtml(html || ""));
  return { db, sizeBytes: buf.byteLength };
}

// ---------- theme ----------

export function initTheme() {
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

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    const nextTheme = theme === "dark" ? "light" : "dark";
    btn.textContent = nextTheme === "dark" ? "Dark" : "Light";
    btn.setAttribute("data-theme-current", theme);
    btn.setAttribute("data-theme-next", nextTheme);
    btn.setAttribute(
      "aria-label",
      nextTheme === "dark" ? "Przełącz na tryb ciemny" : "Przełącz na tryb jasny",
    );
    btn.title = nextTheme === "dark" ? "Przełącz na tryb ciemny" : "Przełącz na tryb jasny";
  }
}

// ---------- mobile nav ----------

export function initTopbarMenu() {
  const topbar = document.querySelector(".topbar");
  const toggle = document.getElementById("nav-toggle");
  const nav = document.querySelector(".topbar nav");
  if (!topbar || !toggle || !nav) return;

  const mobileMq = window.matchMedia("(max-width: 720px)");
  const closeMenu = () => {
    topbar.classList.remove("is-menu-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Otwórz menu");
    document.body.classList.remove("topbar-menu-open");
  };
  const openMenu = () => {
    topbar.classList.add("is-menu-open");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Zamknij menu");
    document.body.classList.add("topbar-menu-open");
  };

  state.closeTopbarMenu = closeMenu;

  toggle.addEventListener("click", () => {
    if (topbar.classList.contains("is-menu-open")) closeMenu();
    else openMenu();
  });

  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      closeMenu();
      return;
    }
    if (event.target.closest(".theme-toggle")) closeMenu();
  });

  document.addEventListener("click", (event) => {
    if (!mobileMq.matches || !topbar.classList.contains("is-menu-open")) return;
    if (topbar.contains(event.target)) return;
    closeMenu();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  mobileMq.addEventListener("change", (event) => {
    if (!event.matches) closeMenu();
  });
}

// ---------- watchlist ----------

function loadWatchlistEntriesFromStorage() {
  try {
    return parseWatchlist(localStorage.getItem(WATCHLIST_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function syncWatchlistStateFromStorage() {
  state.watchlistEntries = loadWatchlistEntriesFromStorage();
  updateWatchlistNav();
}

export function persistWatchlistEntries(entries) {
  state.watchlistEntries = entries;
  try {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, serializeWatchlist(entries));
  } catch (error) {
    console.warn("Failed to persist watchlist", error);
  }
  updateWatchlistNav();
}

export function getListingWatchRef(listingLike) {
  const sourceId = String(listingLike?.source_id ?? listingLike?.sourceId ?? "").trim();
  const externalId = String(listingLike?.external_id ?? listingLike?.externalId ?? "").trim();
  if (!sourceId || !externalId) return null;
  return { sourceId, externalId };
}

export function isListingWatched(listingLike) {
  const ref = getListingWatchRef(listingLike);
  if (!ref) return false;
  const key = watchlistEntryKey(ref.sourceId, ref.externalId);
  return state.watchlistEntries.some((entry) => watchlistEntryKey(entry.sourceId, entry.externalId) === key);
}

export function setListingWatched(listingLike, watched) {
  const ref = getListingWatchRef(listingLike);
  if (!ref) return false;
  const nextEntries = watched
    ? upsertWatchlistEntry(state.watchlistEntries, { ...ref, watchedAt: new Date().toISOString() })
    : removeWatchlistEntry(state.watchlistEntries, ref.sourceId, ref.externalId);
  persistWatchlistEntries(nextEntries);
  return watched;
}

export function toggleListingWatched(listingLike) {
  return setListingWatched(listingLike, !isListingWatched(listingLike));
}

export function updateWatchlistNav() {
  const link = document.querySelector("[data-watchlist-link]");
  if (!link) return;
  const count = state.watchlistEntries.length;
  link.textContent = count > 0 ? `Watchlist (${count})` : "Watchlist";
}

// ---------- saved filters ----------

function loadSavedFiltersFromStorage() {
  try {
    return parseSavedFilters(localStorage.getItem(SAVED_FILTERS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function syncSavedFiltersFromStorage() {
  state.savedFilterEntries = loadSavedFiltersFromStorage();
}

export function persistSavedFilterEntries(entries) {
  state.savedFilterEntries = entries;
  try {
    localStorage.setItem(SAVED_FILTERS_STORAGE_KEY, serializeSavedFilters(entries));
  } catch (error) {
    console.warn("Failed to persist saved filters", error);
  }
}

// ---------- batch summary ----------

function computeBatchStatus(runs) {
  const statuses = runs.map((r) => r.status);
  if (statuses.some((status) => status === "RUNNING")) return "RUNNING";
  if (statuses.every((status) => status === "SUCCESS")) return "SUCCESS";
  if (statuses.every((status) => status === "FAILED")) return "FAILED";
  return "PARTIAL_SUCCESS";
}

export function summarizeRunBatch(runs) {
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
