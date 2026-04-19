// Car Market Monitor — vanilla JS dashboard.
// Thin entry point: importy modułów, rejestracja widoków, globalne event listenery.
// Cała logika siedzi w osobnych modułach (core/format/router/views/*/bootstrap/ui/…).

import { state, query, el } from "./core.js";
import { formatBytes, formatRelative } from "./format.js";
import {
  loadDb,
  initTheme,
  initTopbarMenu,
  syncWatchlistStateFromStorage,
  syncSavedFiltersFromStorage,
} from "./bootstrap.js";
import { initGalleryLightbox } from "./gallery-lightbox.js";
import {
  parseHash,
  navigate,
  navigateHash,
  route,
  hashFromUrl,
  saveScrollPosition,
  registerViews,
} from "./router.js";
import { WATCHLIST_STORAGE_KEY } from "./watchlist.js";
import { SAVED_FILTERS_STORAGE_KEY } from "./saved-filters.js";

import { viewHome } from "./views/home.js";
import { viewActivity } from "./views/activity.js";
import { viewListings } from "./views/listings.js";
import { viewWatchlist } from "./views/watchlist.js";
import { viewListingDetail } from "./views/listing-detail.js";
import { viewChanges } from "./views/changes.js";
import { viewRelistings } from "./views/relistings.js";
import { viewRuns } from "./views/runs.js";

registerViews({
  home: viewHome,
  activity: viewActivity,
  listings: viewListings,
  watchlist: viewWatchlist,
  listingDetail: viewListingDetail,
  changes: viewChanges,
  relistings: viewRelistings,
  runs: viewRuns,
});

async function init() {
  initTheme();
  initTopbarMenu();
  syncWatchlistStateFromStorage();
  syncSavedFiltersFromStorage();
  initGalleryLightbox();
  try {
    const loaded = await loadDb();
    state.db = loaded.db;
    state.sizeBytes = loaded.sizeBytes;
    const lastRun = query(state.db, "SELECT MAX(finished_at) AS ts FROM scrape_runs")[0]?.ts;
    document.getElementById("db-status").textContent = `db ${formatBytes(state.sizeBytes)} · last run ${lastRun ? formatRelative(lastRun) : "—"}`;
    route({ scrollMode: "top" });
  } catch (error) {
    document.getElementById("view").innerHTML = "";
    document.getElementById("view").appendChild(
      el("div", { class: "error" }, `Nie udało się załadować bazy: ${error.message}`),
    );
    document.getElementById("db-status").textContent = "load failed";
    console.error(error);
  }
}

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest("a");
  if (!link) return;
  const href = link.getAttribute("href") || "";
  if (!(href === "#" || href.startsWith("#/"))) return;
  event.preventDefault();
  navigateHash(href, { resetScroll: true });
});

window.addEventListener("hashchange", (event) => {
  saveScrollPosition(hashFromUrl(event.oldURL));
  const scrollMode = state.pendingNavigationScrollMode || "restore";
  const preservedScrollTop = state.pendingNavigationScrollTop;
  const scrollTarget = state.pendingNavigationScrollTarget;
  state.pendingNavigationScrollMode = null;
  state.pendingNavigationScrollTop = null;
  state.pendingNavigationScrollTarget = null;
  route({ scrollMode, preservedScrollTop, scrollTarget });
});

window.addEventListener("storage", (event) => {
  const key = event.key;
  if (key != null && key !== WATCHLIST_STORAGE_KEY && key !== SAVED_FILTERS_STORAGE_KEY) return;
  if (key == null || key === WATCHLIST_STORAGE_KEY) syncWatchlistStateFromStorage();
  if (key == null || key === SAVED_FILTERS_STORAGE_KEY) syncSavedFiltersFromStorage();
  const { path } = parseHash();
  if (!state.db) return;
  if (path === "#/watchlist") route();
  else if (path === "#/listings" && (key == null || key === SAVED_FILTERS_STORAGE_KEY)) route();
});

window.addEventListener("DOMContentLoaded", init);
