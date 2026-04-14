// Car Market Monitor — vanilla JS dashboard.
// Loads db/car-market-monitor.sqlite via sql.js (WASM SQLite) and renders views with hash routing.

import { compactMultiLineSegments, diffLines, tokenDiffAsSegments } from "./diff.js";
import {
  WATCHLIST_STORAGE_KEY,
  parseWatchlist,
  removeWatchlistEntry,
  serializeWatchlist,
  upsertWatchlistEntry,
  watchlistEntryKey,
} from "./watchlist.js";
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
  watchlistEntries: [],
  galleryLightbox: null,
  closeTopbarMenu: null,
  scrollPositions: new Map(),
  pendingNavigationScrollMode: null,
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
  const db = new SQL.Database(new Uint8Array(buf));
  // Rejestrujemy funkcję SQL strip_html, żeby search mógł filtrować po tekście
  // opisu wyprowadzonym z payload_json.description_html. Opis żyje w bazie
  // wyłącznie jako HTML — plain text liczymy w locie. Przy ~2k listingach
  // full-scan z per-row strip_html jest szybszy niż alternatywy i nie wymaga
  // duplikowania tekstu w osobnej kolumnie.
  db.create_function("strip_html", (html) => stripHtml(html || ""));
  return { db, sizeBytes: buf.byteLength };
}

// Node-side stripHtml żyje w src/lib/utils.js. Tu trzymamy lustrzaną kopię —
// same reguły transformacji, bo używamy jej zarówno w sanitize-po-renderze,
// jak i w SQL LIKE filtrowaniu search'a. Gdybyśmy kiedyś chcieli to wydzielić,
// zrobiłoby się to w osobnym ESM module współdzielonym z Node.
const HTML_NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeHtmlEntities(text) {
  if (!text) return "";
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => HTML_NAMED_ENTITIES[name] ?? `&${name};`)
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
      const n = Number.parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    });
}
function stripHtml(html) {
  if (!html) return "";
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function init() {
  initTheme();
  initTopbarMenu();
  syncWatchlistStateFromStorage();
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

function initTopbarMenu() {
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

function syncWatchlistStateFromStorage() {
  state.watchlistEntries = loadWatchlistEntriesFromStorage();
  updateWatchlistNav();
}

function persistWatchlistEntries(entries) {
  state.watchlistEntries = entries;
  try {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, serializeWatchlist(entries));
  } catch (error) {
    console.warn("Failed to persist watchlist", error);
  }
  updateWatchlistNav();
}

function getListingWatchRef(listingLike) {
  const sourceId = String(listingLike?.source_id ?? listingLike?.sourceId ?? "").trim();
  const externalId = String(listingLike?.external_id ?? listingLike?.externalId ?? "").trim();
  if (!sourceId || !externalId) return null;
  return { sourceId, externalId };
}

function isListingWatched(listingLike) {
  const ref = getListingWatchRef(listingLike);
  if (!ref) return false;
  const key = watchlistEntryKey(ref.sourceId, ref.externalId);
  return state.watchlistEntries.some((entry) => watchlistEntryKey(entry.sourceId, entry.externalId) === key);
}

function setListingWatched(listingLike, watched) {
  const ref = getListingWatchRef(listingLike);
  if (!ref) return false;
  const nextEntries = watched
    ? upsertWatchlistEntry(state.watchlistEntries, { ...ref, watchedAt: new Date().toISOString() })
    : removeWatchlistEntry(state.watchlistEntries, ref.sourceId, ref.externalId);
  persistWatchlistEntries(nextEntries);
  return watched;
}

function toggleListingWatched(listingLike) {
  return setListingWatched(listingLike, !isListingWatched(listingLike));
}

function updateWatchlistNav() {
  const link = document.querySelector("[data-watchlist-link]");
  if (!link) return;
  const count = state.watchlistEntries.length;
  link.textContent = count > 0 ? `Watchlist (${count})` : "Watchlist";
}

function syncWatchToggleButton(button, watched, options = {}) {
  const compact = options.compact === true;
  button.classList.toggle("is-active", watched);
  button.setAttribute("aria-pressed", watched ? "true" : "false");
  button.textContent = watched
    ? "Obserwowane"
    : (compact ? "Obserwuj" : "Obserwuj ogłoszenie");
  button.title = watched ? "Kliknij, aby usunąć z obserwowanych" : "Kliknij, aby dodać do obserwowanych";
}

function createWatchToggleButton(listingLike, options = {}) {
  const ref = getListingWatchRef(listingLike);
  if (!ref) return null;
  const compact = options.compact === true;
  const button = el("button", {
    type: "button",
    class: `secondary watch-toggle${compact ? " watch-toggle-compact" : ""}`,
  });
  syncWatchToggleButton(button, isListingWatched(listingLike), { compact });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const watched = toggleListingWatched(ref);
    syncWatchToggleButton(button, watched, { compact });
    if (typeof options.onChange === "function") options.onChange(watched);
  });
  return button;
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

const DESCRIPTION_ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "div", "em", "i", "li", "ol", "p", "span", "strong", "u", "ul",
]);

const DESCRIPTION_DROP_TAGS = new Set([
  "iframe", "math", "noscript", "object", "script", "style", "svg", "template",
]);

function clearView() {
  const view = document.getElementById("view");
  view.innerHTML = "";
  view.className = "";
  return view;
}

function clickStartedInInteractiveElement(event) {
  return event.target instanceof Element && Boolean(event.target.closest("a, button"));
}

function normalizeGalleryIndex(index, length) {
  if (length <= 0) return 0;
  const value = Number(index);
  if (!Number.isFinite(value)) return 0;
  return ((Math.trunc(value) % length) + length) % length;
}

function renderGalleryLightbox() {
  const lightbox = state.galleryLightbox;
  if (!lightbox) return;
  const total = lightbox.urls.length;
  if (total === 0) {
    closeGalleryLightbox({ restoreFocus: false });
    return;
  }

  lightbox.index = normalizeGalleryIndex(lightbox.index, total);
  const currentUrl = lightbox.urls[lightbox.index];
  lightbox.counter.textContent = `${lightbox.index + 1} / ${total}`;
  lightbox.image.src = currentUrl;
  lightbox.image.alt = `Zdjęcie ${lightbox.index + 1} z ${total}`;
  const singleImage = total === 1;
  lightbox.prevButton.disabled = singleImage;
  lightbox.nextButton.disabled = singleImage;
  lightbox.strip.innerHTML = "";

  for (const [index, url] of lightbox.urls.entries()) {
    const thumbButton = el(
      "button",
      {
        type: "button",
        class: `gallery-lightbox-thumb${index === lightbox.index ? " is-active" : ""}`,
        "aria-label": `Pokaż zdjęcie ${index + 1}`,
        "aria-current": index === lightbox.index ? "true" : null,
        onclick: () => showGalleryLightboxImage(index),
      },
      el("img", { src: url, loading: "lazy", alt: "" }),
    );
    lightbox.strip.appendChild(thumbButton);
  }

  const activeThumb = lightbox.strip.querySelector(".gallery-lightbox-thumb.is-active");
  if (activeThumb) activeThumb.scrollIntoView({ block: "nearest", inline: "center" });
}

function showGalleryLightboxImage(index) {
  const lightbox = state.galleryLightbox;
  if (!lightbox || lightbox.urls.length === 0) return;
  lightbox.index = normalizeGalleryIndex(index, lightbox.urls.length);
  renderGalleryLightbox();
}

function shiftGalleryLightbox(delta) {
  const lightbox = state.galleryLightbox;
  if (!lightbox || lightbox.urls.length <= 1) return;
  lightbox.index = normalizeGalleryIndex(lightbox.index + delta, lightbox.urls.length);
  renderGalleryLightbox();
}

function openGalleryLightbox(urls, index = 0, trigger = null) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  const lightbox = initGalleryLightbox();
  lightbox.urls = urls.slice();
  lightbox.index = normalizeGalleryIndex(index, lightbox.urls.length);
  lightbox.lastFocused =
    trigger instanceof HTMLElement
      ? trigger
      : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  renderGalleryLightbox();
  lightbox.overlay.hidden = false;
  lightbox.overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("gallery-lightbox-open");
  lightbox.closeButton.focus();
}

function closeGalleryLightbox(options = {}) {
  const lightbox = state.galleryLightbox;
  if (!lightbox || lightbox.overlay.hidden) return;
  lightbox.overlay.hidden = true;
  lightbox.overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("gallery-lightbox-open");
  const lastFocused = lightbox.lastFocused;
  lightbox.lastFocused = null;
  if (options.restoreFocus !== false && lastFocused && document.contains(lastFocused)) {
    lastFocused.focus();
  }
}

function handleGalleryLightboxKeydown(event) {
  const lightbox = state.galleryLightbox;
  if (!lightbox || lightbox.overlay.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeGalleryLightbox();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    shiftGalleryLightbox(-1);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    shiftGalleryLightbox(1);
  }
}

function initGalleryLightbox() {
  if (state.galleryLightbox) return state.galleryLightbox;

  const counter = el("div", { class: "gallery-lightbox-counter", "aria-live": "polite" });
  const closeButton = el(
    "button",
    {
      type: "button",
      class: "gallery-lightbox-close",
      "aria-label": "Zamknij galerię",
      onclick: () => closeGalleryLightbox(),
    },
    "✕",
  );
  const image = el("img", { class: "gallery-lightbox-image", alt: "" });
  const prevButton = el(
    "button",
    {
      type: "button",
      class: "gallery-lightbox-nav gallery-lightbox-nav-prev",
      "aria-label": "Poprzednie zdjęcie",
      onclick: () => shiftGalleryLightbox(-1),
    },
    "‹",
  );
  const nextButton = el(
    "button",
    {
      type: "button",
      class: "gallery-lightbox-nav gallery-lightbox-nav-next",
      "aria-label": "Następne zdjęcie",
      onclick: () => shiftGalleryLightbox(1),
    },
    "›",
  );
  const strip = el("div", {
    class: "gallery-lightbox-strip",
    "aria-label": "Miniatury galerii",
  });
  const dialog = el(
    "div",
    {
      class: "gallery-lightbox-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Galeria zdjęć",
      onclick: (event) => event.stopPropagation(),
    },
    el(
      "div",
      { class: "gallery-lightbox-topbar" },
      counter,
      closeButton,
    ),
    el(
      "div",
      { class: "gallery-lightbox-stage" },
      prevButton,
      el("div", { class: "gallery-lightbox-frame" }, image),
      nextButton,
    ),
    strip,
  );
  const overlay = el("div", {
    class: "gallery-lightbox",
    hidden: "hidden",
    "aria-hidden": "true",
    onclick: (event) => {
      if (event.target === overlay) closeGalleryLightbox();
    },
  }, dialog);

  document.addEventListener("keydown", handleGalleryLightboxKeydown);
  document.body.appendChild(overlay);

  state.galleryLightbox = {
    overlay,
    counter,
    closeButton,
    image,
    prevButton,
    nextButton,
    strip,
    urls: [],
    index: 0,
    lastFocused: null,
  };
  return state.galleryLightbox;
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

function formatSignedPriceDelta(value, currency = "PLN") {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const prefix = num > 0 ? "+" : num < 0 ? "-" : "";
  return `${prefix}${formatPrice(Math.abs(num), currency)}`;
}

function formatSignedPercentDelta(value) {
  if (value == null || value === "") return "";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const prefix = num > 0 ? "+" : num < 0 ? "-" : "";
  return `${prefix}${Math.abs(num).toFixed(1)}%`;
}

function describePriceChange(oldValue, newValue) {
  const oldNum = Number(oldValue);
  const newNum = Number(newValue);
  if (!Number.isFinite(oldNum) || !Number.isFinite(newNum)) {
    return { className: "", label: "—" };
  }
  const amount = newNum - oldNum;
  const pct = oldNum > 0 ? (amount * 100.0) / oldNum : null;
  return {
    className: amount > 0 ? "price-rise" : amount < 0 ? "price-drop" : "",
    label: pct == null
      ? formatSignedPriceDelta(amount)
      : `${formatSignedPriceDelta(amount)} (${formatSignedPercentDelta(pct)})`,
  };
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

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function isValidVin(vin) {
  if (!vin || vin.length !== 17) return false;
  if (/[^A-Za-z0-9]/.test(vin)) return false;
  if (/[IOQioq]/.test(vin)) return false;
  const upper = vin.toUpperCase();
  if (new Set(upper).size === 1) return false;
  if (/^[0-9]+$/.test(upper)) return false;
  if (/^[A-Z]+$/.test(upper)) return false;
  return true;
}

function isValidRegistration(reg) {
  if (!reg || reg.length < 4) return false;
  const norm = reg.replace(/\s+/g, "").toUpperCase();
  if (norm.length < 4 || norm.length > 8) return false;
  if (/[^A-Z0-9]/.test(norm)) return false;
  if (new Set(norm).size === 1) return false;
  if (/^[A-Z]+$/.test(norm)) return false;
  if (/^[0-9]+$/.test(norm)) return false;
  return true;
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

function currentHash() {
  return location.hash || "#/";
}

function hashFromUrl(url) {
  if (!url) return currentHash();
  try {
    return new URL(url, location.href).hash || "#/";
  } catch {
    const value = String(url);
    const hashIndex = value.indexOf("#");
    return hashIndex >= 0 ? value.slice(hashIndex) || "#/" : "#/";
  }
}

function currentScrollTop() {
  if (document.scrollingElement) return document.scrollingElement.scrollTop;
  if (Number.isFinite(window.scrollY)) return window.scrollY;
  return document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function saveScrollPosition(hash = currentHash()) {
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

function restoreScrollPosition(hash = currentHash()) {
  scrollPageTo(state.scrollPositions.get(hash || "#/") || 0);
}

function applyRouteScroll(scrollMode = "none", hash = currentHash()) {
  if (scrollMode === "none") return;
  const run = () => {
    if (scrollMode === "restore") restoreScrollPosition(hash);
    else scrollPageToTop();
  };
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(run);
  } else {
    run();
  }
}

function navigateHash(targetHash, { resetScroll = true } = {}) {
  const [path, queryString = ""] = String(targetHash || "#/").split("?");
  navigate(path || "#/", Object.fromEntries(new URLSearchParams(queryString)), { resetScroll });
}

function navigate(path, params = {}, { resetScroll = true } = {}) {
  const nextHash = buildHash(path, params);
  const prevHash = currentHash();
  if (nextHash === prevHash) {
    if (resetScroll) route({ scrollMode: "top" });
    return;
  }
  saveScrollPosition(prevHash);
  state.pendingNavigationScrollMode = resetScroll ? "top" : "restore";
  location.hash = nextHash;
}

function route({ scrollMode = "none" } = {}) {
  if (!state.db) return;
  closeGalleryLightbox({ restoreFocus: false });
  if (typeof state.closeTopbarMenu === "function") state.closeTopbarMenu();
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
    } else if (path === "#/watchlist") {
      viewWatchlist(view);
    } else if (path.startsWith("#/listing/")) {
      const id = path.slice("#/listing/".length);
      viewListingDetail(view, id);
    } else if (path === "#/changes") {
      viewChanges(view, params);
    } else if (path === "#/relistings") {
      viewRelistings(view, params);
    } else if (path === "#/runs") {
      viewRuns(view);
    } else {
      view.appendChild(el("p", { class: "empty" }, `Nieznana ścieżka: ${path}`));
    }
  } catch (error) {
    view.appendChild(el("div", { class: "error" }, `Błąd: ${error.message}`));
    console.error(error);
  }
  applyRouteScroll(scrollMode, currentHash());
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
  state.pendingNavigationScrollMode = null;
  route({ scrollMode });
});
window.addEventListener("storage", (event) => {
  if (event.key != null && event.key !== WATCHLIST_STORAGE_KEY) return;
  syncWatchlistStateFromStorage();
  const { path } = parseHash();
  if (state.db && path === "#/watchlist") route();
});
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

  // Price changes
  const HOME_PRICE_CHANGE_SORT_COLUMNS = {
    when: "created_at",
    title: "lower(title)",
    year: "year",
    old_price: "CAST(old_value AS REAL)",
    new_price: "CAST(new_value AS REAL)",
    change: "price_change_amount",
  };
  const priceChangeSort = buildHomeTableSort("dropSort", "dropDir", HOME_PRICE_CHANGE_SORT_COLUMNS);
  const priceChanges = query(
    state.db,
    `WITH recent_price_changes AS (
       SELECT lc.created_at, lc.old_value, lc.new_value, l.id, l.title, l.listing_url, l.year,
              (CAST(lc.new_value AS REAL) - CAST(lc.old_value AS REAL)) AS price_change_amount
       FROM listing_changes lc
       JOIN listings l ON l.id = lc.listing_id
       WHERE lc.field_name = 'price.value'
         AND lc.old_value IS NOT NULL AND lc.new_value IS NOT NULL
         AND CAST(lc.old_value AS REAL) > 0
         AND CAST(lc.new_value AS REAL) > 0
         AND CAST(lc.new_value AS REAL) <> CAST(lc.old_value AS REAL)
         AND lc.created_at >= datetime('now', '-30 days')
       ORDER BY lc.created_at DESC, l.title ASC
       LIMIT 20
     )
     SELECT *
     FROM recent_price_changes
     ORDER BY ${priceChangeSort.sortExpr} ${priceChangeSort.sortDir} NULLS LAST, created_at DESC, title ASC`,
  );
  view.appendChild(panelTable(
    "Zmiany cen (ostatnie 30 dni · 20 najnowszych)",
    [
      priceChangeSort.sortableTh("Kiedy", "when", { numeric: true }),
      priceChangeSort.sortableTh("Oferta", "title"),
      priceChangeSort.sortableTh("Rok", "year", { numeric: true }),
      priceChangeSort.sortableTh("Z", "old_price", { numeric: true }),
      priceChangeSort.sortableTh("Na", "new_price", { numeric: true }),
      priceChangeSort.sortableTh("Zmiana", "change", { numeric: true }),
    ],
    priceChanges.map((r) => {
      const change = describePriceChange(r.old_value, r.new_value);
      const changeClass = change.className ? ` ${change.className}` : "";
      return [
        formatRelative(r.created_at),
        listingLink(r.id, r.title || r.id),
        el("span", { class: "tabular" }, r.year ?? "-"),
        el("span", { class: "tabular" }, formatPrice(r.old_value)),
        el("span", { class: `tabular${changeClass}` }, formatPrice(r.new_value)),
        el("span", { class: `tabular${changeClass}` }, change.label),
      ];
    }),
    priceChanges.map((r) => () => navigate(`#/listing/${r.id}`)),
    "Brak zmian cen w ostatnich 30 dniach.",
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
    year: "year",
    price: "CAST(last_price_amount AS REAL)",
  };
  const disappearedSort = buildHomeTableSort("disappearedSort", "disappearedDir", HOME_STATUS_SORT_COLUMNS);
  const disappeared = query(
    state.db,
    `WITH recent_disappeared AS (
       SELECT lc.created_at, l.id, l.title, l.last_price_amount, l.year
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
      disappearedSort.sortableTh("Rok", "year", { numeric: true }),
      disappearedSort.sortableTh("Ostatnia cena", "price", { numeric: true }),
    ],
    disappeared.map((r) => [
      formatRelative(r.created_at),
      listingLink(r.id, r.title || r.id),
      el("span", { class: "tabular" }, r.year ?? "-"),
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
       SELECT lc.created_at, l.id, l.title, l.last_price_amount, l.year
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
      appearedSort.sortableTh("Rok", "year", { numeric: true }),
      appearedSort.sortableTh("Cena", "price", { numeric: true }),
    ],
    appeared.map((r) => [
      formatRelative(r.created_at),
      listingLink(r.id, r.title || r.id),
      el("span", { class: "tabular" }, r.year ?? "-"),
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

  const priceChangeSortColumns = {
    when: "created_at",
    title: "lower(title)",
    year: "year",
    old_price: "CAST(old_value AS REAL)",
    new_price: "CAST(new_value AS REAL)",
    change: "price_change_amount",
  };
  const priceChangeSort = buildActivitySort("dropsSort", "dropsDir", "dropsPage", priceChangeSortColumns);
  const priceChangePage = readPageParam("dropsPage");
  const priceChangeBaseSql = `SELECT lc.created_at, lc.old_value, lc.new_value, l.id, l.title, l.listing_url, l.year,
                                     (CAST(lc.new_value AS REAL) - CAST(lc.old_value AS REAL)) AS price_change_amount
                              FROM listing_changes lc
                              JOIN listings l ON l.id = lc.listing_id
                              WHERE lc.field_name = 'price.value'
                                AND lc.old_value IS NOT NULL AND lc.new_value IS NOT NULL
                                AND CAST(lc.old_value AS REAL) > 0
                                AND CAST(lc.new_value AS REAL) > 0
                                AND CAST(lc.new_value AS REAL) <> CAST(lc.old_value AS REAL)
                                AND lc.created_at >= datetime('now', '-30 days')`;
  const priceChanges = queryPagedSection(
    priceChangeBaseSql,
    priceChangeSort.sortExpr,
    priceChangeSort.sortDir,
    priceChangePage,
    "created_at DESC, title ASC",
  );
  view.appendChild(panelTable(
    `Zmiany cen (ostatnie 30 dni) · ${priceChanges.total.toLocaleString("pl-PL")}`,
    [
      priceChangeSort.sortableTh("Kiedy", "when", { numeric: true }),
      priceChangeSort.sortableTh("Oferta", "title"),
      priceChangeSort.sortableTh("Rok", "year", { numeric: true }),
      priceChangeSort.sortableTh("Z", "old_price", { numeric: true }),
      priceChangeSort.sortableTh("Na", "new_price", { numeric: true }),
      priceChangeSort.sortableTh("Zmiana", "change", { numeric: true }),
    ],
    priceChanges.rows.map((r) => {
      const change = describePriceChange(r.old_value, r.new_value);
      const changeClass = change.className ? ` ${change.className}` : "";
      return [
        formatRelative(r.created_at),
        listingLink(r.id, r.title || r.id),
        el("span", { class: "tabular" }, r.year ?? "-"),
        el("span", { class: "tabular" }, formatPrice(r.old_value)),
        el("span", { class: `tabular${changeClass}` }, formatPrice(r.new_value)),
        el("span", { class: `tabular${changeClass}` }, change.label),
      ];
    }),
    priceChanges.rows.map((r) => () => navigate(`#/listing/${r.id}`)),
    "Brak zmian cen w ostatnich 30 dniach.",
  ));
  appendPager("dropsPage", priceChanges.page, priceChanges.totalPages);

  const statusSortColumns = {
    when: "created_at",
    title: "lower(title)",
    year: "year",
    price: "CAST(last_price_amount AS REAL)",
  };
  const disappearedSort = buildActivitySort("disappearedSort", "disappearedDir", "disappearedPage", statusSortColumns);
  const disappearedPage = readPageParam("disappearedPage");
  const disappearedBaseSql = `SELECT lc.created_at, l.id, l.title, l.last_price_amount, l.year
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
      disappearedSort.sortableTh("Rok", "year", { numeric: true }),
      disappearedSort.sortableTh("Ostatnia cena", "price", { numeric: true }),
    ],
    disappeared.rows.map((r) => [
      formatRelative(r.created_at),
      listingLink(r.id, r.title || r.id),
      el("span", { class: "tabular" }, r.year ?? "-"),
      el("span", { class: "tabular" }, formatPrice(r.last_price_amount)),
    ]),
    disappeared.rows.map((r) => () => navigate(`#/listing/${r.id}`)),
    "Nic ostatnio nie zniknęło.",
  ));
  appendPager("disappearedPage", disappeared.page, disappeared.totalPages);

  const appearedSort = buildActivitySort("appearedSort", "appearedDir", "appearedPage", statusSortColumns);
  const appearedPage = readPageParam("appearedPage");
  const appearedBaseSql = `SELECT lc.created_at, l.id, l.title, l.last_price_amount, l.year
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
      appearedSort.sortableTh("Rok", "year", { numeric: true }),
      appearedSort.sortableTh("Cena", "price", { numeric: true }),
    ],
    appeared.rows.map((r) => [
      formatRelative(r.created_at),
      listingLink(r.id, r.title || r.id),
      el("span", { class: "tabular" }, r.year ?? "-"),
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
  // Scope filtra sprzedawcy może być pojedynczym UUID-em (klasyczna ścieżka
  // z kliknięcia "Zobacz oferty sprzedawcy") albo listą UUID-ów oddzielonych
  // przecinkami (gdy ten sam brand — np. "Porsche Centrum Kraków" —
  // występuje w danych pod kilkoma seller_uuid, co w otomoto zdarza się
  // np. dla oddzielnych osób prawnych pod tym samym szyldem). Internal
  // reprezentacja to zawsze tablica — ścieżka jedno-UUID jest po prostu
  // specialcase'em z length===1.
  const sellerUuidList = params.sellerUuids
    ? params.sellerUuids.split(",").map((s) => s.trim()).filter(Boolean)
    : (params.sellerUuid ? [params.sellerUuid] : []);
  const sellerScope = sellerUuidList.length > 0
    ? {
        seller_uuids: sellerUuidList,
        // Etykietę bierzemy z dowolnego listingu w scopie — wszystkie wiersze
        // w tej samej grupie (name + city + region) dzielą te same wartości
        // tekstowe, więc wystarczy pierwsza pasująca.
        ...(query(
          state.db,
          `SELECT seller_uuid, seller_name, seller_location_city, seller_location_region
           FROM listings
           WHERE seller_uuid IN (${sellerUuidList.map(() => "?").join(",")})
           ORDER BY last_seen_at DESC
           LIMIT 1`,
          sellerUuidList,
        )[0] || { seller_uuid: sellerUuidList[0] }),
      }
    : null;
  const sellerOptions = sellers.map((seller) => ({
    ...seller,
    label: formatSellerLabel(seller),
    locationLabel: formatSellerLocation(seller),
    searchText: [
      seller.seller_name,
      seller.seller_location_city,
      seller.seller_location_region,
    ].filter(Boolean).join(" ").toLowerCase(),
  }));
  const sellerOptionGroups = Array.from(
    sellerOptions.reduce((map, seller) => {
      const key = seller.label.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.listing_count += Number(seller.listing_count || 0);
        existing.seller_uuids.push(seller.seller_uuid);
      } else {
        map.set(key, {
          ...seller,
          listing_count: Number(seller.listing_count || 0),
          seller_uuids: seller.seller_uuid ? [seller.seller_uuid] : [],
        });
      }
      return map;
    }, new Map()).values(),
  );
  const sellerOptionByLabel = new Map(sellerOptionGroups.map((seller) => [seller.label.toLowerCase(), seller]));
  const sellerFilterParams = sellerScope
    ? (sellerScope.seller_uuids.length === 1
        ? { sellerUuid: sellerScope.seller_uuids[0] }
        : { sellerUuids: sellerScope.seller_uuids.join(",") })
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
  const sellerInput = input("text", "seller", sellerInputValue, "np. Porsche Centrum Warszawa");
  sellerInput.setAttribute("autocomplete", "off");
  sellerInput.setAttribute("spellcheck", "false");
  const sellerMenu = el("div", { class: "seller-combo-menu", hidden: "" });
  const sellerToggle = el("button", {
    type: "button",
    class: "seller-combo-toggle",
    tabindex: "-1",
    "aria-label": "Pokaż listę sprzedawców",
    onmousedown: (e) => e.preventDefault(),
    onclick: () => {
      if (sellerMenu.hidden) {
        openSellerMenu();
        sellerInput.focus();
      } else {
        closeSellerMenu();
      }
    },
  });
  const sellerCombo = el("div", { class: "seller-combo" }, sellerInput, sellerToggle, sellerMenu);
  let sellerVisibleOptions = [];
  let sellerActiveIndex = -1;
  let sellerHasKeyboardSelection = false;

  function getSellerMenuOptions() {
    // Tokenizer dropdowna musi traktować `·` jako separator, nie jako literał.
    // formatSellerLabel produkuje "Nazwa · Miasto · Region", więc jak tylko
    // user wybierze coś z listy albo wejdzie na stronę z aktywnym scopem,
    // input ma w sobie ten znak. Bez splitu po `·` następne otwarcie menu
    // pokazywało "Brak pasujących sprzedawców" — bo searchText (joined
    // spacjami) nigdy nie zawiera `·`, więc term `·` falsyfikował całe
    // dopasowanie. Zachowujemy tokeny jedno-literowe, żeby dalej działało
    // szybkie filtrowanie po prefiksie typu "P".
    const terms = sellerInput.value.toLowerCase().split(/[\s·]+/).map((t) => t.trim()).filter(Boolean);
    const limit = terms.length > 0 ? 12 : 8;
    return sellerOptionGroups
      .map((seller) => {
        if (terms.length === 0) return { seller, score: 0 };
        let score = 0;
        const nameText = (seller.seller_name || "").toLowerCase();
        for (const term of terms) {
          const idx = seller.searchText.indexOf(term);
          if (idx === -1) return null;
          const nameIdx = nameText.indexOf(term);
          score += nameIdx === -1 ? idx + 100 : nameIdx;
        }
        return { seller, score };
      })
      .filter(Boolean)
      .sort((a, b) =>
        a.score - b.score ||
        Number(b.seller.listing_count || 0) - Number(a.seller.listing_count || 0) ||
        a.seller.label.localeCompare(b.seller.label, "pl"),
      )
      .slice(0, limit)
      .map((row) => row.seller);
  }

  function scrollActiveSellerOptionIntoView() {
    const active = sellerMenu.querySelector(`[data-seller-index="${sellerActiveIndex}"]`);
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function renderSellerMenu() {
    sellerVisibleOptions = getSellerMenuOptions();
    sellerMenu.innerHTML = "";
    sellerCombo.classList.toggle("is-open", !sellerMenu.hidden);

    if (sellerVisibleOptions.length === 0) {
      sellerActiveIndex = -1;
      sellerMenu.appendChild(el("div", { class: "seller-combo-empty" }, "Brak pasujących sprzedawców."));
      return;
    }

    if (sellerActiveIndex < 0 || sellerActiveIndex >= sellerVisibleOptions.length) {
      sellerActiveIndex = 0;
    }

    sellerVisibleOptions.forEach((seller, index) => {
      sellerMenu.appendChild(
        el(
          "button",
          {
            type: "button",
            class: `seller-combo-option${index === sellerActiveIndex ? " is-active" : ""}`,
            "data-seller-index": String(index),
            onmousedown: (e) => e.preventDefault(),
            onclick: () => {
              sellerInput.value = seller.label;
              closeSellerMenu();
              sellerInput.focus();
            },
          },
          el(
            "span",
            { class: "seller-combo-option-text" },
            el("span", { class: "seller-combo-option-name" }, seller.seller_name || seller.label),
            seller.locationLabel && seller.seller_name
              ? el("span", { class: "seller-combo-option-meta" }, seller.locationLabel)
              : null,
          ),
          el("span", { class: "seller-combo-option-count", title: `${seller.listing_count} ofert` }, seller.listing_count),
        ),
      );
    });
  }

  function openSellerMenu() {
    sellerMenu.hidden = false;
    sellerHasKeyboardSelection = false;
    renderSellerMenu();
  }

  function closeSellerMenu() {
    sellerMenu.hidden = true;
    sellerMenu.innerHTML = "";
    sellerActiveIndex = -1;
    sellerHasKeyboardSelection = false;
    sellerCombo.classList.remove("is-open");
  }

  sellerInput.addEventListener("focus", openSellerMenu);
  sellerInput.addEventListener("click", openSellerMenu);
  sellerInput.addEventListener("input", openSellerMenu);
  sellerInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (sellerMenu.hidden) openSellerMenu();
      else if (sellerVisibleOptions.length > 0) {
        sellerHasKeyboardSelection = true;
        sellerActiveIndex = Math.min(sellerActiveIndex + 1, sellerVisibleOptions.length - 1);
        renderSellerMenu();
        scrollActiveSellerOptionIntoView();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (sellerMenu.hidden) openSellerMenu();
      else if (sellerVisibleOptions.length > 0) {
        sellerHasKeyboardSelection = true;
        sellerActiveIndex = Math.max(sellerActiveIndex - 1, 0);
        renderSellerMenu();
        scrollActiveSellerOptionIntoView();
      }
      return;
    }
    if (e.key === "Enter" && sellerHasKeyboardSelection && !sellerMenu.hidden && sellerVisibleOptions[sellerActiveIndex]) {
      e.preventDefault();
      sellerInput.value = sellerVisibleOptions[sellerActiveIndex].label;
      closeSellerMenu();
      return;
    }
    if (e.key === "Escape") closeSellerMenu();
  });
  sellerInput.addEventListener("blur", () => {
    window.requestAnimationFrame(() => {
      if (!sellerCombo.contains(document.activeElement)) closeSellerMenu();
    });
  });

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
      field("Sprzedawca", sellerCombo, "field-seller"),
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
      // Exact-label match: używamy stabilnego UUID filtra zamiast
      // tekstowego LIKE'a. Jeśli ten sam brand ma kilka seller_uuid
      // (zdarza się, np. różne osoby prawne pod jednym szyldem), pakujemy
      // wszystkie w przecinkową listę — SQL niżej robi z tego `IN (...)`.
      if (exactSeller?.seller_uuids?.length === 1) {
        next.sellerUuid = exactSeller.seller_uuids[0];
      } else if (exactSeller?.seller_uuids?.length > 1) {
        next.sellerUuids = exactSeller.seller_uuids.join(",");
      } else {
        // Brak exact matcha → free-text fallback. NIE zapisujemy tutaj
        // formatted labela (który zawiera " · " separator zabijający
        // tekstową tokenizację w SQL), tylko surowe wpisanie użytkownika.
        next.sellerQuery = sellerValue;
      }
    }
    navigate("#/listings", next);
  }

  // Build SQL
  const where = ["1=1"];
  const args = [];
  if (sellerScope) {
    if (sellerScope.seller_uuids.length === 1) {
      where.push("l.seller_uuid = ?");
      args.push(sellerScope.seller_uuids[0]);
    } else {
      const placeholders = sellerScope.seller_uuids.map(() => "?").join(",");
      where.push(`l.seller_uuid IN (${placeholders})`);
      args.push(...sellerScope.seller_uuids);
    }
  }
  if (params.sellerQuery) {
    // Tokenizer: whitespace split + odfiltrowanie separatorów etykietowych
    // typu `·`, które formatSellerLabel wkleja między imię/miasto/region.
    // Bez tego filtra "Porsche Centrum Kraków · Kraków" produkuje token `·`
    // który nie matchuje niczego i zeruje cały wynik. Jednocyfrowe tokeny
    // też odcinamy — za mało specyficzne, żeby pomagały w wyszukiwaniu.
    const sellerTerms = params.sellerQuery
      .toLowerCase()
      .split(/[\s·]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
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
      // Opis żyje tylko jako HTML w payload_json.description_html. strip_html
      // jest customowym SQL functionem rejestrowanym na db w loadDb() i
      // wywołuje stripHtml z JS per wiersz. Przy obecnej skali (~1k listings)
      // full-scan z per-row decode + strip jest nadal pod 50 ms. Jeśli baza
      // urośnie o rząd wielkości, pora na FTS5.
      where.push("(lower(l.title) LIKE ? OR lower(strip_html(json_extract(snap.payload_json, '$.description_html'))) LIKE ?)");
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
      if (clickStartedInInteractiveElement(e)) return;
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

function viewWatchlist(view) {
  view.appendChild(el("h1", {}, "Watchlist"));

  const entries = state.watchlistEntries;
  if (entries.length === 0) {
    view.appendChild(el("p", { class: "empty" }, "Nie obserwujesz jeszcze żadnych ogłoszeń."));
    return;
  }

  const watchedAtByKey = new Map(
    entries.map((entry) => [watchlistEntryKey(entry.sourceId, entry.externalId), entry.watchedAt]),
  );
  const whereClause = entries
    .map(() => "(l.source_id = ? AND l.external_id = ?)")
    .join(" OR ");
  const args = entries.flatMap((entry) => [entry.sourceId, entry.externalId]);
  const rows = query(
    state.db,
    `SELECT l.id, l.source_id, l.external_id, l.title, l.listing_url, l.is_active,
            l.last_price_amount, l.last_mileage, l.last_year, l.last_seen_at,
            l.fuel_type, l.engine_power
     FROM listings l
     WHERE ${whereClause}`,
    args,
  );

  rows.sort((a, b) => {
    const aTs = Date.parse(watchedAtByKey.get(watchlistEntryKey(a.source_id, a.external_id)) || "") || 0;
    const bTs = Date.parse(watchedAtByKey.get(watchlistEntryKey(b.source_id, b.external_id)) || "") || 0;
    return bTs - aTs || String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || "")) || String(a.title || "").localeCompare(String(b.title || ""), "pl");
  });

  const missingCount = Math.max(0, entries.length - rows.length);
  const summary = [`${rows.length} obserwowanych ogłoszeń`];
  if (missingCount > 0) summary.push(`${missingCount} poza aktualną bazą`);
  view.appendChild(el("p", { class: "muted" }, summary.join(" · ")));

  if (rows.length === 0) {
    view.appendChild(el("p", { class: "empty" }, "Obserwowane wpisy istnieją w pamięci przeglądarki, ale nie ma ich w aktualnej bazie."));
    return;
  }

  const table = el("table");
  table.appendChild(el(
    "thead", {},
    el("tr", {},
      el("th", {}, "Obserwowane od"),
      el("th", {}, "Status"),
      el("th", {}, "Tytuł"),
      el("th", { class: "num" }, "Rok"),
      el("th", { class: "num" }, "Przebieg"),
      el("th", {}, "Paliwo"),
      el("th", { class: "num" }, "KM"),
      el("th", { class: "num" }, "Cena"),
      el("th", {}, "Last seen"),
      el("th", {}, ""),
      el("th", {}, ""),
    ),
  ));
  const tbody = el("tbody");
  for (const row of rows) {
    const watchedAt = watchedAtByKey.get(watchlistEntryKey(row.source_id, row.external_id));
    const removeBtn = el("button", {
      type: "button",
      class: "watchlist-remove-link",
      title: "Usuń z obserwowanych",
      onclick: (event) => {
        event.stopPropagation();
        setListingWatched(row, false);
        route();
      },
    }, "Usuń");
    tbody.appendChild(el("tr", {
      onclick: (event) => {
        if (event.target.closest("a, button")) return;
        navigate(`#/listing/${row.id}`);
      },
    },
    el("td", { class: "tabular muted" }, formatDate(watchedAt)),
    el("td", {}, activeBadge(row.is_active)),
    el("td", {}, el("span", { class: "row-link" }, row.title || row.external_id)),
    el("td", { class: "num" }, row.last_year || "—"),
    el("td", { class: "num" }, formatMileage(row.last_mileage)),
    el("td", { class: "muted" }, formatEnum(row.fuel_type)),
    el("td", { class: "num" }, row.engine_power != null ? `${row.engine_power}` : "—"),
    el("td", { class: "num" }, formatPrice(row.last_price_amount)),
    el("td", { class: "muted tabular" }, formatRelative(row.last_seen_at)),
    el("td", {}, removeBtn),
    el("td", {}, el("a", { href: row.listing_url, target: "_blank", rel: "noopener" }, "link ↗")),
    ));
  }
  table.appendChild(tbody);
  const panel = el("div", { class: "panel" });
  panel.appendChild(table);
  view.appendChild(panel);
}

function viewListingDetail(view, id) {
  const isCompactDetail = window.matchMedia("(max-width: 720px)").matches;
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
  const sellerTypeLabel = listing.seller_type
    ? (listing.seller_type === "BUSINESS" ? "Firma" : listing.seller_type === "PRIVATE" ? "Osoba prywatna" : listing.seller_type)
    : null;
  const sellerListingsHref = listing.seller_uuid
    ? buildHash("#/listings", { sellerUuid: listing.seller_uuid })
    : null;
  const detailWatchToggle = createWatchToggleButton(listing);
  if (detailWatchToggle) detailWatchToggle.classList.add("detail-action-button");

  view.appendChild(el(
    "div", { class: "detail-header" },
    el("div", { class: "detail-title-row" },
      el("div", { class: "detail-title-block" },
        el("div", { class: "detail-eyebrow" }, "Oferta", activeBadge(listing.is_active)),
        el("h1", {}, listing.title || listing.external_id),
      ),
      el("div", { class: "detail-title-actions" },
        detailWatchToggle,
        el("a", { href: listing.listing_url, target: "_blank", rel: "noopener", class: "detail-action-link" }, "Otwórz ofertę ↗"),
        sellerListingsHref ? el("a", { href: sellerListingsHref, class: "detail-inline-link" }, "Wszystkie oferty sprzedawcy") : null,
      ),
    ),
    el("div", { class: "meta" },
      detailMetaChip("Źródło", listing.source_name),
      sellerTypeLabel ? detailMetaChip("Sprzedawca", sellerTypeLabel) : null,
      sellerLabel ? detailMetaChip("Konto", sellerLabel) : null,
      detailMetaChip("External id", listing.external_id, { mono: true }),
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
  // klik otwiera lightbox wewnątrz aplikacji zamiast wysyłać usera do nowej
  // karty z CDN-em marketplace'u.
  const lastSnapshot = listing.last_snapshot_id
    ? query(state.db, "SELECT payload_json FROM listing_snapshots WHERE id = ?", [listing.last_snapshot_id])[0]
    : null;
  let snapshotPayload = null;
  let galleryUrls = [];
  if (lastSnapshot?.payload_json) {
    try {
      snapshotPayload = JSON.parse(lastSnapshot.payload_json);
      if (Array.isArray(snapshotPayload.images?.urls)) {
        galleryUrls = snapshotPayload.images.urls;
      }
    } catch {}
  }
  if (galleryUrls.length > 0) {
    const thumbUrls = galleryUrls.map((u) => u + ";s=268x0;q=80");
    const fullUrls = galleryUrls.map((u) => u + ";s=3412x0;q=100");
    const galleryPanel = el("div", { class: "panel" });
    galleryPanel.appendChild(el("div", { class: "panel-header" }, `Zdjęcia (${galleryUrls.length})`));
    const grid = el("div", { class: "listing-gallery" });
    const collapsibleGallery = isCompactDetail && galleryUrls.length > 6;
    if (collapsibleGallery) grid.classList.add("is-collapsed");
    for (const [index, url] of thumbUrls.entries()) {
      const thumbButton = el(
        "button",
        {
          type: "button",
          class: "gallery-item",
          title: `Otwórz galerię (${index + 1} / ${galleryUrls.length})`,
          "aria-label": `Otwórz galerię, zdjęcie ${index + 1} z ${galleryUrls.length}`,
          onclick: () => openGalleryLightbox(fullUrls, index, thumbButton),
        },
        el("img", { src: url, loading: "lazy", alt: "" }),
      );
      grid.appendChild(thumbButton);
    }
    galleryPanel.appendChild(grid);
    if (collapsibleGallery) {
      const toggle = el("button", {
        type: "button",
        class: "secondary detail-section-toggle",
        onclick: () => {
          const collapsed = grid.classList.toggle("is-collapsed");
          toggle.textContent = collapsed
            ? `Pokaż wszystkie zdjęcia (${galleryUrls.length})`
            : "Zwiń zdjęcia";
        },
      }, `Pokaż wszystkie zdjęcia (${galleryUrls.length})`);
      galleryPanel.appendChild(el("div", { class: "panel-actions" }, toggle));
    }
    view.appendChild(galleryPanel);
  }

  const phones = parsePhonesJson(listing.phones_json);

  // ----- Panel: Opis sprzedawcy -----
  // Opis żyje wyłącznie jako znormalizowany HTML w payload_json.description_html.
  // Phone tokeny są już rozwiązane przy ingest'cie (marketplace-source.js), więc
  // frontend nie musi nic podmieniać — tylko przepuszcza przez lokalny
  // sanitizer jako drugą linię obrony (XSS-hardening na wypadek kompromitacji
  // bazy albo buga w ingest'cie).
  const richDescription = renderDescriptionHtml(snapshotPayload?.description_html);
  if (richDescription) {
    const descPanel = el("div", { class: "panel" });
    descPanel.appendChild(el("div", { class: "panel-header" }, "Opis sprzedawcy"));
    const descBody = el("div", { class: "description-body" }, richDescription);
    const collapsibleDescription = isCompactDetail && (descBody.textContent || "").trim().length > 420;
    if (collapsibleDescription) descBody.classList.add("is-collapsed");
    descPanel.appendChild(descBody);
    if (collapsibleDescription) {
      const toggle = el("button", {
        type: "button",
        class: "secondary detail-section-toggle",
        onclick: () => {
          const collapsed = descBody.classList.toggle("is-collapsed");
          toggle.textContent = collapsed ? "Pokaż pełny opis" : "Zwiń opis";
        },
      }, "Pokaż pełny opis");
      descPanel.appendChild(el("div", { class: "panel-actions" }, toggle));
    }
    view.appendChild(descPanel);
  }

  // ----- Panel: Identyfikacja -----
  // VIN, numer rejestracyjny, data pierwszej rejestracji i telefony.
  // Wszystkie pola są opcjonalne — sprzedawcy nie są zmuszeni je wypełniać.
  // Panel pokazujemy zawsze (nawet jeśli wszystko puste) bo brak VIN/rejestracji
  // sam w sobie jest sygnałem (np. "auto bez papierów" = warto wiedzieć).
  const idPanel = el("div", { class: "panel" });
  idPanel.appendChild(el("div", { class: "panel-header" }, "Identyfikacja"));
  const idTable = el("table");
  const idBody = el("tbody");
  const vinValid = listing.vin && isValidVin(listing.vin);
  const vinDisplay = !listing.vin
    ? el("span", { class: "muted" }, "—")
    : vinValid
      ? document.createTextNode(listing.vin)
      : el("span", {},
          document.createTextNode(listing.vin + " "),
          el("span", { class: "badge badge-failed", style: "font-size:11px;" }, "nieprawidlowy"),
        );
  idBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "VIN"),
    el("td", { class: listing.vin ? "tabular" : "muted" }, vinDisplay),
  ));
  const regValid = listing.registration && isValidRegistration(listing.registration);
  const regDisplay = !listing.registration
    ? el("span", { class: "muted" }, "—")
    : regValid
      ? document.createTextNode(listing.registration)
      : el("span", {},
          document.createTextNode(listing.registration + " "),
          el("span", { class: "badge badge-failed", style: "font-size:11px;" }, "nieprawidlowy"),
        );
  idBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Numer rejestracyjny"),
    el("td", { class: listing.registration ? "tabular" : "muted" }, regDisplay),
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

  // ----- Panel: Wznowienia (relistings) -----
  const relistingRows = query(
    state.db,
    `SELECT r.match_type,
       CASE WHEN r.old_listing_id = ? THEN 'relisted_as' ELSE 'relisting_of' END AS direction,
       CASE WHEN r.old_listing_id = ? THEN r.new_listing_id ELSE r.old_listing_id END AS related_id,
       CASE WHEN r.old_listing_id = ? THEN new.title ELSE old.title END AS related_title,
       CASE WHEN r.old_listing_id = ? THEN new.last_price_amount ELSE old.last_price_amount END AS related_price,
       CASE WHEN r.old_listing_id = ? THEN new.last_mileage ELSE old.last_mileage END AS related_mileage,
       CASE WHEN r.old_listing_id = ? THEN new.is_active ELSE old.is_active END AS related_active,
       r.detected_at
     FROM listing_relistings r
     JOIN listings old ON old.id = r.old_listing_id
     JOIN listings new ON new.id = r.new_listing_id
     WHERE r.old_listing_id = ? OR r.new_listing_id = ?`,
    [id, id, id, id, id, id, id, id],
  );
  if (relistingRows.length > 0) {
    // Add badge to eyebrow
    const eyebrow = view.querySelector(".detail-eyebrow");
    if (eyebrow) {
      eyebrow.appendChild(el("span", { class: "badge badge-relisting" }, "wznowione"));
    }

    const relistPanel = el("div", { class: "panel" });
    relistPanel.appendChild(el("div", { class: "panel-header" },
      "Wznowienia ",
      el("a", { href: buildHash("#/relistings", { q: listing.vin || listing.registration || "" }), class: "muted", style: "font-weight:normal;font-size:13px;" }, "zobacz wszystkie"),
    ));
    const relistTable = el("table");
    relistTable.appendChild(el("thead", {}, el("tr", {},
      el("th", {}, "Kierunek"),
      el("th", {}, "Typ"),
      el("th", {}, "Powiazane ogloszenie"),
      el("th", { class: "num" }, "Cena"),
      el("th", { class: "num" }, "Przebieg"),
      el("th", {}, "Status"),
      el("th", {}, "Wykryto"),
    )));
    const relistBody = el("tbody");
    for (const rr of relistingRows) {
      const dirLabel = rr.direction === "relisted_as" ? "wznowione jako ->" : "<- wznowienie z";
      relistBody.appendChild(el("tr", {
        onclick: (event) => {
          if (clickStartedInInteractiveElement(event)) return;
          navigate(`#/listing/${rr.related_id}`);
        },
      },
        el("td", { class: "muted" }, dirLabel),
        el("td", {}, matchTypeBadge(rr.match_type)),
        el("td", {}, listingLink(rr.related_id, truncate(rr.related_title, 50))),
        el("td", { class: "num tabular" }, formatPrice(rr.related_price)),
        el("td", { class: "num tabular" }, formatMileage(rr.related_mileage)),
        el("td", {}, activeBadge(rr.related_active)),
        el("td", { class: "tabular muted" }, formatRelative(rr.detected_at)),
      ));
    }
    relistTable.appendChild(relistBody);
    relistPanel.appendChild(relistTable);
    view.appendChild(relistPanel);
  }

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
    `SELECT id, run_id, snapshot_hash, captured_at, price_amount, mileage
     FROM listing_snapshots WHERE listing_id = ? ORDER BY captured_at ASC`,
    [id],
  );
  const priceSeries = snapshots
    .map((s) => ({ t: new Date(s.captured_at).getTime(), v: Number(s.price_amount) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  const mileageSeries = snapshots
    .map((s) => ({ t: new Date(s.captured_at).getTime(), v: Number(s.mileage) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0);

  if (!isCompactDetail || priceSeries.length >= 2) {
    const pricePanel = el("div", { class: "panel" });
    pricePanel.appendChild(el("div", { class: "panel-header" }, `Historia ceny (${priceSeries.length} snapshotów)`));
    pricePanel.appendChild(
      priceSeries.length >= 2
        ? renderSparkline(priceSeries, 720, 120)
        : el("p", { class: "empty" }, "Za mało snapshotów żeby narysować historię."),
    );
    view.appendChild(pricePanel);
  }

  if (!isCompactDetail || mileageSeries.length >= 2) {
    const mileagePanel = el("div", { class: "panel" });
    mileagePanel.appendChild(el("div", { class: "panel-header" }, `Historia przebiegu (${mileageSeries.length} snapshotów)`));
    mileagePanel.appendChild(
      mileageSeries.length >= 2
        ? renderSparkline(mileageSeries, 720, 120, { color: "#10b981", formatLabel: formatMileage })
        : el("p", { class: "empty" }, "Za mało snapshotów żeby narysować historię."),
    );
    view.appendChild(mileagePanel);
  }

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

  // Desktop: table
  const table = el("table", { class: "changes-table" });
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
  const tablePanel = el("div", { class: "panel changes-desktop" });
  tablePanel.appendChild(table);
  view.appendChild(tablePanel);

  // Mobile: cards
  const cards = el("div", { class: "changes-cards" });
  for (const r of rows) {
    const card = el("div", { class: "change-card", onclick: () => navigate(`#/listing/${r.listing_id}`) },
      el("div", { class: "change-card-header" },
        el("span", { class: "change-card-title" }, r.title || r.listing_id),
        el("span", { class: "change-card-time muted" }, formatRelative(r.created_at)),
      ),
      el("div", { class: "change-card-body" },
        el("span", { class: "field" }, r.field_name),
        el("span", { class: "change-card-diff" },
          el("span", { class: "change-old" }, renderDiffSide("old", r.old_value, r.new_value, r.field_name, { compactMultiline: true })),
          el("span", { class: "change-card-arrow" }, "→"),
          el("span", { class: "change-new" }, renderDiffSide("new", r.new_value, r.old_value, r.field_name, { compactMultiline: true })),
        ),
      ),
    );
    cards.appendChild(card);
  }
  view.appendChild(cards);
}

// ---------- relistings ----------

function matchTypeBadge(matchType) {
  const map = {
    vin: "badge-match-vin",
    registration: "badge-match-reg",
    fuzzy: "badge-match-fuzzy",
  };
  const labels = { vin: "VIN", registration: "tablica", fuzzy: "fuzzy" };
  return el("span", { class: `badge ${map[matchType] || "badge-match-fuzzy"}` }, labels[matchType] || matchType);
}

function viewRelistings(view, params = {}) {
  view.classList.add("view-wide");
  const relistingsPath = "#/relistings";
  const PAGE_SIZE = 100;

  // -- count --
  const totalCount = Number(
    query(state.db, `SELECT count(*) AS c FROM listing_relistings`)[0]?.c || 0,
  );
  view.appendChild(el("h1", {},
    "Wznowione ogloszenia ",
    el("span", { class: "muted" }, `(${totalCount})`),
  ));

  // -- filters --
  const matchTypeFilter = params.matchType || "";
  const searchFilter = params.q || "";

  const form = el("form", { class: "filters", onsubmit: (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const next = {};
    const mt = fd.get("matchType");
    if (mt) next.matchType = mt;
    const q = fd.get("q")?.trim();
    if (q) next.q = q;
    navigate(relistingsPath, next);
  } });

  const matchSelect = el("select", { name: "matchType" },
    el("option", { value: "" }, "Wszystkie typy"),
    el("option", { value: "vin" }, "VIN"),
    el("option", { value: "registration" }, "Tablica"),
    el("option", { value: "fuzzy" }, "Fuzzy"),
  );
  if (matchTypeFilter) matchSelect.value = matchTypeFilter;
  form.appendChild(field("Typ dopasowania", matchSelect));
  form.appendChild(field("Szukaj", input("text", "q", searchFilter, "Tytul, VIN, tablica..."), "field-search"));
  form.appendChild(el("div", { class: "actions" },
    el("button", { type: "submit" }, "Filtruj"),
    el("button", { type: "button", class: "secondary", onclick: () => navigate(relistingsPath) }, "Resetuj"),
  ));
  view.appendChild(form);

  // -- sort --
  const sortColumns = {
    detected: "r.detected_at",
    old_title: "lower(old.title)",
    new_title: "lower(new.title)",
    old_price: "CAST(old.last_price_amount AS REAL)",
    new_price: "CAST(new.last_price_amount AS REAL)",
    price_delta: "CAST(new.last_price_amount AS REAL) - CAST(old.last_price_amount AS REAL)",
    mileage_delta: "CAST(new.last_mileage AS INTEGER) - CAST(old.last_mileage AS INTEGER)",
  };
  const sortKey = sortColumns[params.sort] ? params.sort : "detected";
  const sortDir = params.dir === "asc" ? "ASC" : "DESC";
  const sortExpr = sortColumns[sortKey];

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
        const next = { ...params, sort: key, dir: nextDir };
        delete next.page;
        navigate(relistingsPath, next);
      },
    }, label);
  }

  // -- query --
  let whereClauses = [];
  let whereParams = [];
  if (matchTypeFilter) {
    whereClauses.push("r.match_type = ?");
    whereParams.push(matchTypeFilter);
  }
  if (searchFilter) {
    whereClauses.push(
      "(lower(old.title) LIKE ? OR lower(new.title) LIKE ? OR lower(old.vin) LIKE ? OR lower(new.vin) LIKE ? OR lower(old.registration) LIKE ? OR lower(new.registration) LIKE ?)",
    );
    const like = `%${searchFilter.toLowerCase()}%`;
    whereParams.push(like, like, like, like, like, like);
  }
  const whereStr = whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

  const baseSql = `
    SELECT r.id AS relisting_id, r.match_type, r.match_details, r.detected_at,
      old.id AS old_id, old.title AS old_title,
      old.last_price_amount AS old_price, old.price_currency AS old_currency,
      old.last_mileage AS old_mileage, old.last_seen_at AS old_last_seen,
      old.is_active AS old_is_active,
      new.id AS new_id, new.title AS new_title,
      new.last_price_amount AS new_price, new.price_currency AS new_currency,
      new.last_mileage AS new_mileage, new.first_seen_at AS new_first_seen,
      new.is_active AS new_is_active
    FROM listing_relistings r
    JOIN listings old ON old.id = r.old_listing_id
    JOIN listings new ON new.id = r.new_listing_id
    ${whereStr}`;

  const total = Number(
    query(state.db, `SELECT COUNT(*) AS c FROM (${baseSql}) t`, whereParams)[0]?.c || 0,
  );
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(
    Math.max(1, Number.parseInt(params.page || "", 10) || 1),
    totalPages,
  );

  const rows = total > 0
    ? query(
      state.db,
      `${baseSql} ORDER BY ${sortExpr} ${sortDir} NULLS LAST, r.detected_at DESC LIMIT ? OFFSET ?`,
      [...whereParams, PAGE_SIZE, (page - 1) * PAGE_SIZE],
    )
    : [];

  if (rows.length === 0) {
    view.appendChild(el("p", { class: "empty" }, "Brak wykrytych wznowien."));
    return;
  }

  // -- table --
  const table = el("table");
  table.appendChild(el("thead", {}, el("tr", {},
    el("th", {}, "Typ"),
    sortableTh("Stare ogloszenie", "old_title"),
    sortableTh("Cena (stara)", "old_price", { numeric: true }),
    el("th", { class: "num" }, "Przebieg (stary)"),
    el("th", {}, "Ostatnio widziane"),
    el("th", {}, ""),
    sortableTh("Nowe ogloszenie", "new_title"),
    sortableTh("Cena (nowa)", "new_price", { numeric: true }),
    el("th", { class: "num" }, "Przebieg (nowy)"),
    el("th", {}, "Pierwsze widziane"),
    sortableTh("Delta ceny", "price_delta", { numeric: true }),
    sortableTh("Delta przebiegu", "mileage_delta", { numeric: true }),
    sortableTh("Wykryto", "detected", { numeric: true }),
  )));

  const tbody = el("tbody");
  for (const r of rows) {
    const oldPrice = Number(r.old_price);
    const newPrice = Number(r.new_price);
    const priceDelta = Number.isFinite(oldPrice) && Number.isFinite(newPrice) ? newPrice - oldPrice : null;

    const oldMileage = Number(r.old_mileage);
    const newMileage = Number(r.new_mileage);
    const mileageDelta = Number.isFinite(oldMileage) && Number.isFinite(newMileage) ? newMileage - oldMileage : null;

    const priceClass = priceDelta != null ? (priceDelta > 0 ? "price-up" : priceDelta < 0 ? "price-down" : "") : "";
    const mileageClass = mileageDelta != null && mileageDelta < 0 ? "mileage-rollback" : "";

    const priceDeltaLabel = priceDelta != null
      ? `${priceDelta > 0 ? "+" : ""}${formatPrice(priceDelta, r.new_currency || "PLN")}`
      : "-";
    const mileageDeltaLabel = mileageDelta != null
      ? `${mileageDelta > 0 ? "+" : ""}${mileageDelta.toLocaleString("pl-PL")} km`
      : "-";

    tbody.appendChild(el("tr", {},
      el("td", {}, matchTypeBadge(r.match_type)),
      el("td", {}, listingLink(r.old_id, truncate(r.old_title, 40))),
      el("td", { class: "num tabular" }, formatPrice(r.old_price, r.old_currency)),
      el("td", { class: "num tabular" }, formatMileage(r.old_mileage)),
      el("td", { class: "tabular muted" }, formatRelative(r.old_last_seen)),
      el("td", { class: "muted" }, "->"),
      el("td", {}, listingLink(r.new_id, truncate(r.new_title, 40))),
      el("td", { class: "num tabular" }, formatPrice(r.new_price, r.new_currency)),
      el("td", { class: "num tabular" }, formatMileage(r.new_mileage)),
      el("td", { class: "tabular muted" }, formatRelative(r.new_first_seen)),
      el("td", { class: `num tabular ${priceClass}` }, priceDeltaLabel),
      el("td", { class: `num tabular ${mileageClass}` }, mileageDeltaLabel),
      el("td", { class: "tabular muted" }, formatRelative(r.detected_at)),
    ));
  }
  table.appendChild(tbody);
  const panel = el("div", { class: "panel" });
  panel.appendChild(table);
  view.appendChild(panel);

  // -- pager --
  if (totalPages > 1) {
    const goTo = (p) => navigate(relistingsPath, { ...params, page: String(p) });
    view.appendChild(el("div", { class: "pager" },
      el("button", {
        type: "button", class: "secondary",
        disabled: page <= 1 ? "" : null,
        onclick: () => goTo(page - 1),
      }, "< Poprzednia"),
      el("span", { class: "muted tabular" }, `Strona ${page} z ${totalPages}`),
      el("button", {
        type: "button", class: "secondary",
        disabled: page >= totalPages ? "" : null,
        onclick: () => goTo(page + 1),
      }, "Nastepna >"),
    ));
  }
}

// ---------- runs ----------

function viewRuns(view) {
  view.classList.add("view-wide");
  view.appendChild(el("h1", {}, "Runs"));
  const rows = query(
    state.db,
     `SELECT r.*, s.name AS source_name
      FROM scrape_runs r JOIN sources s ON s.id = r.source_id
      ORDER BY r.started_at DESC
      LIMIT 50`,
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

function detailMetaChip(label, value, options = {}) {
  const classes = ["detail-meta-chip"];
  if (options.mono) classes.push("detail-meta-chip--mono");
  return el(
    "span",
    { class: classes.join(" ") },
    label ? el("span", { class: "detail-meta-label" }, label) : null,
    el("span", { class: "detail-meta-value" }, value),
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
    const tr = el("tr", handler ? { onclick: (event) => { if (!clickStartedInInteractiveElement(event)) handler(); } } : { class: "no-click" },
      ...cells.map((c) => el("td", {}, c instanceof Node ? c : String(c ?? "-"))),
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

function formatSellerLocation(listing) {
  const parts = [];
  if (listing?.seller_location_city) parts.push(listing.seller_location_city);
  if (listing?.seller_location_region) parts.push(listing.seller_location_region);
  return parts.join(" · ");
}

function formatSellerLabel(listing) {
  const parts = [];
  if (listing?.seller_name) parts.push(listing.seller_name);
  const location = formatSellerLocation(listing);
  if (location) parts.push(location);
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
      parts.push(`- ${diff.removedCount} ${formatCountPl(diff.removedCount, "usunięta", "usunięte", "usuniętych")}`);
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
    ? `- ${delta.length} usuni${delta.length === 1 ? "ęte" : "ętych"}`
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

// Defense-in-depth sanitizer: ingest już wyprodukował czysty HTML (patrz
// src/lib/description-html.js), ale nie ufamy ślepo temu co siedzi w bazie.
// DOMParser parsuje w trybie "text/html", który NIE wykonuje skryptów —
// bezpieczne do walk'owania. Po sanitizacji emitujemy DocumentFragment.
function renderDescriptionHtml(rawHtml) {
  if (!rawHtml || typeof rawHtml !== "string") return null;
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  const container = document.createElement("div");
  for (const child of Array.from(doc.body.childNodes)) {
    appendDescriptionNode(container, sanitizeDescriptionNode(child));
  }
  if (!container.textContent?.trim() && container.children.length === 0) {
    return null;
  }
  const fragment = document.createDocumentFragment();
  while (container.firstChild) fragment.appendChild(container.firstChild);
  return fragment;
}

function sanitizeDescriptionNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent || "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const tag = node.tagName.toLowerCase();

  if (DESCRIPTION_DROP_TAGS.has(tag)) {
    return null;
  }

  if (!DESCRIPTION_ALLOWED_TAGS.has(tag)) {
    const fragment = document.createDocumentFragment();
    for (const child of Array.from(node.childNodes)) {
      appendDescriptionNode(fragment, sanitizeDescriptionNode(child));
    }
    return fragment;
  }

  if (tag === "br") {
    return document.createElement("br");
  }

  const safeHref = tag === "a" ? sanitizeDescriptionHref(node.getAttribute("href")) : null;
  const clean = document.createElement(tag === "a" && !safeHref ? "span" : tag);
  if (tag === "a" && safeHref) {
    clean.setAttribute("href", safeHref);
    if (/^https?:/i.test(safeHref)) {
      clean.setAttribute("target", "_blank");
      clean.setAttribute("rel", "noopener noreferrer");
    }
  }
  // Zachowujemy `data-kind="phone"` tylko dla <a> tagów — to marker, który
  // ingest stawia na rozwiązanych numerach telefonów, żeby CSS mógł im dać
  // delikatny bold. Reszta atrybutów z bazy jest wycinana po cichu.
  if (tag === "a" && node.getAttribute("data-kind") === "phone") {
    clean.setAttribute("data-kind", "phone");
  }
  for (const child of Array.from(node.childNodes)) {
    appendDescriptionNode(clean, sanitizeDescriptionNode(child));
  }
  if ((tag === "p" || tag === "div") && !clean.textContent?.replace(/\u00a0/g, " ").trim()) {
    return null;
  }
  return clean;
}

function appendDescriptionNode(parent, child) {
  if (!child) return;
  parent.appendChild(child);
}

function sanitizeDescriptionHref(href) {
  if (!href || typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!/^(https?:|mailto:|tel:)/i.test(trimmed)) return null;
  return trimmed;
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

function renderSparkline(series, width, height, { color = "#2563eb", formatLabel = formatPrice } = {}) {
  // SVG with line + dots + min/max labels.
  if (series.length < 2) return el("p", { class: "empty" }, "Brak danych.");
  const yMaxLabel = formatLabel(Math.max(...series.map((p) => p.v)));
  const yMinLabel = formatLabel(Math.min(...series.map((p) => p.v)));
  // Left gutter must fit the widest label; otherwise the first point/line
  // sits on top of the text (visible for short series with a high first point).
  const padLeft = Math.max(72, Math.min(width * 0.26, Math.max(yMaxLabel.length, yMinLabel.length) * 8 + 16));
  const padRight = 20;
  const padY = 16;
  const xs = series.map((p) => p.t);
  const ys = series.map((p) => p.v);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const sx = (t) => padLeft + ((t - xMin) / xRange) * (width - padLeft - padRight);
  const sy = (v) => height - padY - ((v - yMin) / yRange) * (height - padY * 2);

  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ");
  const dots = series.map((p) => {
    const x = sx(p.t);
    const y = sy(p.v);
    const valueLabel = formatLabel(p.v);
    const dateLabel = formatDate(new Date(p.t).toISOString());
    const tooltipLabel = escapeHtml(valueLabel);
    const titleLabel = escapeHtml(`${valueLabel} · ${dateLabel}`);
    const tooltipWidth = Math.min(width - 16, Math.max(56, valueLabel.length * 7 + 18));
    const tooltipLeft = Math.max(8, Math.min(width - tooltipWidth - 8, x - tooltipWidth / 2));
    const tooltipTop = y > padY + 32 ? y - 34 : y + 12;
    return `
      <g class="sparkline-point" tabindex="0">
        <title>${titleLabel}</title>
        <circle class="sparkline-point-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" />
        <circle class="sparkline-point-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${color}" />
        <g class="sparkline-tooltip" transform="translate(${tooltipLeft.toFixed(1)} ${tooltipTop.toFixed(1)})">
          <rect class="sparkline-tooltip-box" width="${tooltipWidth.toFixed(1)}" height="24" rx="12" ry="12" />
          <text class="sparkline-tooltip-text" x="${(tooltipWidth / 2).toFixed(1)}" y="12" text-anchor="middle" dominant-baseline="middle">${tooltipLabel}</text>
        </g>
      </g>
    `;
  }).join("");

  const svg = `
    <svg class="sparkline" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet">
      <text x="8" y="${(padY + 4).toFixed(0)}" font-size="11" fill="#6b7280">${yMaxLabel}</text>
      <text x="8" y="${height - 4}" font-size="11" fill="#6b7280">${yMinLabel}</text>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
    </svg>
  `;
  return el("div", { html: svg, style: "padding: 16px;" });
}
