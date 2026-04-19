// Hash-based router z wbudowaną pamięcią scroll state.
//
// Widoki rejestrowane są z app.js przez registerViews({...}) — router sam
// nie importuje widoków, żeby uniknąć cyklicznych zależności
// (widoki używają navigate() z router.js).

import { state, el, clearView } from "./core.js";
import { closeGalleryLightbox } from "./gallery-lightbox.js";

// ---------- view registry ----------

const viewRegistry = {
  home: null,
  activity: null,
  listings: null,
  watchlist: null,
  listingDetail: null,
  changes: null,
  relistings: null,
  runs: null,
};

export function registerViews(views) {
  Object.assign(viewRegistry, views);
}

// ---------- hash helpers ----------

export function parseHash() {
  const raw = location.hash || "#/";
  const [path, queryString = ""] = raw.split("?");
  const params = Object.fromEntries(new URLSearchParams(queryString));
  return { path, params };
}

export function buildHash(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== ""),
  ).toString();
  return qs ? `${path}?${qs}` : path;
}

export function currentHash() {
  return location.hash || "#/";
}

export function hashFromUrl(url) {
  if (!url) return currentHash();
  try {
    return new URL(url, location.href).hash || "#/";
  } catch {
    const value = String(url);
    const hashIndex = value.indexOf("#");
    return hashIndex >= 0 ? value.slice(hashIndex) || "#/" : "#/";
  }
}

// ---------- scroll ----------

function currentScrollTop() {
  if (document.scrollingElement) return document.scrollingElement.scrollTop;
  if (Number.isFinite(window.scrollY)) return window.scrollY;
  return document.documentElement.scrollTop || document.body.scrollTop || 0;
}

export function saveScrollPosition(hash = currentHash()) {
  state.scrollPositions.set(hash || "#/", currentScrollTop());
}

function scrollPageTo(top = 0) {
  const y = Math.max(0, Number(top) || 0);
  if (typeof window.scrollTo === "function") {
    window.scrollTo({ top: y, left: 0, behavior: "auto" });
  }
  if (document.scrollingElement) document.scrollingElement.scrollTop = y;
  document.documentElement.scrollTop = y;
  document.body.scrollTop = y;
}

function scrollPageToTop() {
  scrollPageTo(0);
}

function scrollPageToSelector(selector) {
  if (!selector) {
    scrollPageToTop();
    return;
  }
  const target = document.querySelector(selector);
  if (!target) {
    scrollPageToTop();
    return;
  }
  const topbarHeight = document.querySelector(".topbar")?.getBoundingClientRect().height || 0;
  const targetTop = currentScrollTop() + target.getBoundingClientRect().top - topbarHeight - 12;
  scrollPageTo(targetTop);
}

function restoreScrollPosition(hash = currentHash()) {
  scrollPageTo(state.scrollPositions.get(hash || "#/") || 0);
}

function applyRouteScroll(scrollMode = "none", hash = currentHash(), preservedScrollTop = null, scrollTarget = null) {
  if (scrollMode === "none") return;
  const run = () => {
    if (scrollMode === "restore") restoreScrollPosition(hash);
    else if (scrollMode === "preserve") scrollPageTo(preservedScrollTop);
    else if (scrollMode === "target") scrollPageToSelector(scrollTarget);
    else scrollPageToTop();
  };
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(run);
  } else {
    run();
  }
}

// ---------- navigation ----------

export function navigateHash(targetHash, { resetScroll = true, scrollMode = null, scrollTarget = null } = {}) {
  const [path, queryString = ""] = String(targetHash || "#/").split("?");
  navigate(path || "#/", Object.fromEntries(new URLSearchParams(queryString)), { resetScroll, scrollMode, scrollTarget });
}

export function navigate(path, params = {}, { resetScroll = true, scrollMode = null, scrollTarget = null } = {}) {
  const nextHash = buildHash(path, params);
  const prevHash = currentHash();
  const resolvedScrollMode = scrollMode || (resetScroll ? "top" : "restore");
  if (nextHash === prevHash) {
    if (resolvedScrollMode !== "none") {
      route({
        scrollMode: resolvedScrollMode,
        preservedScrollTop: resolvedScrollMode === "preserve" ? currentScrollTop() : null,
        scrollTarget,
      });
    }
    return;
  }
  saveScrollPosition(prevHash);
  state.pendingNavigationScrollMode = resolvedScrollMode;
  state.pendingNavigationScrollTop = resolvedScrollMode === "preserve" ? currentScrollTop() : null;
  state.pendingNavigationScrollTarget = resolvedScrollMode === "target" ? scrollTarget : null;
  location.hash = nextHash;
}

export function route({ scrollMode = "none", preservedScrollTop = null, scrollTarget = null } = {}) {
  if (!state.db) return;
  closeGalleryLightbox({ restoreFocus: false });
  if (typeof state.closeTopbarMenu === "function") state.closeTopbarMenu();
  const { path, params } = parseHash();
  highlightNav(path);
  const view = clearView();
  try {
    if (path === "" || path === "#/" || path === "#" || path === "#/home") {
      viewRegistry.home?.(view, params);
    } else if (path === "#/activity") {
      viewRegistry.activity?.(view, params);
    } else if (path === "#/listings") {
      viewRegistry.listings?.(view, params);
    } else if (path === "#/watchlist") {
      viewRegistry.watchlist?.(view);
    } else if (path.startsWith("#/listing/")) {
      const id = path.slice("#/listing/".length);
      viewRegistry.listingDetail?.(view, id);
    } else if (path === "#/changes") {
      viewRegistry.changes?.(view, params);
    } else if (path === "#/relistings") {
      viewRegistry.relistings?.(view, params);
    } else if (path === "#/runs") {
      viewRegistry.runs?.(view);
    } else {
      view.appendChild(el("p", { class: "empty" }, `Nieznana ścieżka: ${path}`));
    }
  } catch (error) {
    view.appendChild(el("div", { class: "error" }, `Błąd: ${error.message}`));
    console.error(error);
  }
  applyRouteScroll(scrollMode, currentHash(), preservedScrollTop, scrollTarget);
}

export function highlightNav(path) {
  for (const link of document.querySelectorAll(".topbar nav a")) {
    const target = link.getAttribute("data-route") || "";
    const isActive =
      (target === "" && (path === "" || path === "#/" || path === "#")) ||
      (target !== "" && path.startsWith(target));
    link.classList.toggle("active", isActive);
  }
}
