// UI rendering primitives: badges, cards, tables, form fields, modals,
// sparkline, watch-toggle. Bez state (poza getListingWatchRef/isListingWatched
// z bootstrap, które jest obwodowe do watch-toggle).

import { el, clickStartedInInteractiveElement } from "./core.js";
import { formatPrice, formatDate, formatRelative, escapeHtml } from "./format.js";
import {
  getListingWatchRef,
  isListingWatched,
  toggleListingWatched,
} from "./bootstrap.js";

// ---------- badges ----------

export function statusBadge(status) {
  const cls = {
    SUCCESS: "badge-success",
    PARTIAL_SUCCESS: "badge-partial",
    FAILED: "badge-failed",
    RUNNING: "badge-running",
  }[status] || "badge-inactive";
  return el("span", { class: `badge ${cls}` }, status);
}

export function activeBadge(isActive) {
  return Number(isActive) === 1
    ? el("span", { class: "badge badge-active" }, "active")
    : el("span", { class: "badge badge-inactive" }, "missing");
}

// Badge dla typu dopasowania w widokach Relistings i Listing Detail.
export function matchTypeBadge(matchType) {
  const map = {
    vin: "badge-match-vin",
    registration: "badge-match-reg",
    fuzzy: "badge-match-fuzzy",
  };
  const labels = { vin: "VIN", registration: "tablica", fuzzy: "fuzzy" };
  return el("span", { class: `badge ${map[matchType] || "badge-match-fuzzy"}` }, labels[matchType] || matchType);
}

// ---------- cards / tables / chips ----------

export function statCard(label, value) {
  return el("div", { class: "card" },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value),
  );
}

export function row(label, value) {
  return el("tr", {},
    el("th", {}, label),
    el("td", {}, value instanceof Node ? value : String(value ?? "—")),
  );
}

export function detailMetaChip(label, value, options = {}) {
  const classes = ["detail-meta-chip"];
  if (options.mono) classes.push("detail-meta-chip--mono");
  return el(
    "span",
    { class: classes.join(" ") },
    label ? el("span", { class: "detail-meta-label" }, label) : null,
    el("span", { class: "detail-meta-value" }, value),
  );
}

export function listingLink(id, label) {
  return el("a", { href: `#/listing/${id}` }, label);
}

export function formatSellerLocation(listing) {
  const parts = [];
  if (listing?.seller_location_city) parts.push(listing.seller_location_city);
  if (listing?.seller_location_region) parts.push(listing.seller_location_region);
  return parts.join(" · ");
}

export function formatSellerLabel(listing) {
  const parts = [];
  if (listing?.seller_name) parts.push(listing.seller_name);
  const location = formatSellerLocation(listing);
  if (location) parts.push(location);
  return parts.join(" · ") || listing?.seller_uuid || "";
}

// Używane przez widoki listings i watchlist do wyróżnienia wierszy z
// ostatnio edytowanym ogłoszeniem (advert_updated_at/advert_created_at
// w ciągu 24h).
export function latestEditAt(row) {
  const candidates = [row.advert_updated_at, row.advert_created_at]
    .filter((v) => typeof v === "string" && v.trim() !== "");
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

export function isRecentEdit(value, maxAgeMs = 24 * 60 * 60 * 1000) {
  const ts = Date.parse(value || "");
  return Number.isFinite(ts) && Date.now() - ts <= maxAgeMs;
}

export function lastEditCell(row) {
  const value = latestEditAt(row);
  const recent = isRecentEdit(value);
  const cls = recent ? "tabular recent-edit" : "muted tabular";
  return el("td", { class: cls }, formatRelative(value));
}

export function panelTable(title, headers, rows, rowClickHandlers, emptyMsg) {
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

// ---------- form fields ----------

export function field(label, control, extraClass = "") {
  return el("div", { class: extraClass ? `field ${extraClass}` : "field" }, el("label", {}, label), control);
}

// Two-input range field. Renders Min/Max as a single labelled .field with the
// inputs sharing one row separated by an en-dash. Halves the visible field
// count for ranges (Rok, Cena, Przebieg, Moc) which would otherwise consume
// 8 grid cells.
export function rangeField(label, minName, maxName, minValue, maxValue, opts = {}) {
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

export function input(type, name, value, placeholder) {
  const attrs = { type, name };
  if (placeholder) attrs.placeholder = placeholder;
  const node = el("input", attrs);
  if (value != null && value !== "") node.value = value;
  return node;
}

// Labelled checkbox that lays out the same height as other filter fields.
// Renders as: top label ("Pokaż") + horizontal [☐] inline-text row.
export function checkboxField(label, name, inlineText, checked) {
  const cb = el("input", { type: "checkbox", name, value: "1" });
  if (checked) cb.setAttribute("checked", "");
  const rowEl = el("label", { class: "checkbox-row" },
    cb,
    el("span", { class: "checkbox-text" }, inlineText),
  );
  return el("div", { class: "field checkbox-field" },
    el("label", {}, label),
    rowEl,
  );
}

// ---------- string helpers ----------

export function truncate(text, n) {
  if (text == null) return "—";
  const s = String(text);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function formatCountPl(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (n === 1) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function formatEnum(slug) {
  if (slug == null || slug === "") return "—";
  const s = String(slug).replace(/[-_]+/g, " ").trim();
  if (!s) return "—";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatPriceInK(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1000) {
    const k = n / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `${n}`;
}

// ---------- watch toggle ----------

export function syncWatchToggleButton(button, watched, options = {}) {
  const compact = options.compact === true;
  button.classList.toggle("is-active", watched);
  button.setAttribute("aria-pressed", watched ? "true" : "false");
  button.textContent = watched
    ? "Obserwowane"
    : (compact ? "Obserwuj" : "Obserwuj ogłoszenie");
  button.title = watched ? "Kliknij, aby usunąć z obserwowanych" : "Kliknij, aby dodać do obserwowanych";
}

export function createWatchToggleButton(listingLike, options = {}) {
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

// ---------- modals ----------

export function openTextPrompt({
  title,
  label,
  initialValue = "",
  confirmLabel = "Zapisz",
  cancelLabel = "Anuluj",
  placeholder = "",
} = {}) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let settled = false;

    function settle(value) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      document.body.classList.remove("app-modal-open");
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
      resolve(value);
    }

    function onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(null);
      } else if (event.key === "Tab") {
        // Focus trap — cyklujemy między inputem a przyciskami.
        const focusable = [inputEl, cancelBtn, confirmBtn];
        const active = document.activeElement;
        const idx = focusable.indexOf(active);
        if (idx === -1) {
          event.preventDefault();
          inputEl.focus();
          return;
        }
        const nextIdx = event.shiftKey ? (idx - 1 + focusable.length) % focusable.length : (idx + 1) % focusable.length;
        event.preventDefault();
        focusable[nextIdx].focus();
      }
    }

    const titleId = `app-modal-title-${Math.random().toString(36).slice(2, 8)}`;
    const inputEl = el("input", {
      type: "text",
      class: "app-modal-input",
      value: initialValue,
      placeholder,
      autocomplete: "off",
      spellcheck: "false",
    });
    const cancelBtn = el(
      "button",
      { type: "button", class: "secondary", onclick: () => settle(null) },
      cancelLabel,
    );
    const confirmBtn = el("button", { type: "submit" }, confirmLabel);

    const form = el(
      "form",
      {
        class: "app-modal-dialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        onsubmit: (event) => {
          event.preventDefault();
          const value = inputEl.value.trim();
          if (!value) {
            inputEl.focus();
            inputEl.select();
            return;
          }
          settle(value);
        },
      },
      el("div", { class: "app-modal-title", id: titleId }, title || ""),
      label ? el("label", { class: "app-modal-label" }, label) : null,
      inputEl,
      el("div", { class: "app-modal-actions" }, cancelBtn, confirmBtn),
    );

    const overlay = el(
      "div",
      {
        class: "app-modal-backdrop",
        onmousedown: (event) => {
          if (event.target === overlay) settle(null);
        },
      },
      form,
    );

    document.body.appendChild(overlay);
    document.body.classList.add("app-modal-open");
    document.addEventListener("keydown", onKeydown, true);
    inputEl.focus();
    inputEl.select();
  });
}

// Custom confirm dialog w stylu strony — zwraca Promise<boolean>:
// true = potwierdzone, false = anulowane (Esc / Anuluj / backdrop).
export function openConfirmDialog({
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "Anuluj",
  destructive = false,
} = {}) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let settled = false;

    function settle(value) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      document.body.classList.remove("app-modal-open");
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
      resolve(value);
    }

    function onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
      } else if (event.key === "Tab") {
        const focusable = [cancelBtn, confirmBtn];
        const active = document.activeElement;
        const idx = focusable.indexOf(active);
        if (idx === -1) {
          event.preventDefault();
          confirmBtn.focus();
          return;
        }
        const nextIdx = event.shiftKey ? (idx - 1 + focusable.length) % focusable.length : (idx + 1) % focusable.length;
        event.preventDefault();
        focusable[nextIdx].focus();
      } else if (event.key === "Enter") {
        event.preventDefault();
        settle(true);
      }
    }

    const titleId = `app-modal-title-${Math.random().toString(36).slice(2, 8)}`;
    const cancelBtn = el(
      "button",
      { type: "button", class: "secondary", onclick: () => settle(false) },
      cancelLabel,
    );
    const confirmBtn = el(
      "button",
      {
        type: "button",
        class: destructive ? "app-modal-confirm-destructive" : "",
        onclick: () => settle(true),
      },
      confirmLabel,
    );

    const dialog = el(
      "div",
      {
        class: "app-modal-dialog",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
      },
      el("div", { class: "app-modal-title", id: titleId }, title || ""),
      message ? el("div", { class: "app-modal-message" }, message) : null,
      el("div", { class: "app-modal-actions" }, cancelBtn, confirmBtn),
    );

    const overlay = el(
      "div",
      {
        class: "app-modal-backdrop",
        onmousedown: (event) => {
          if (event.target === overlay) settle(false);
        },
      },
      dialog,
    );

    document.body.appendChild(overlay);
    document.body.classList.add("app-modal-open");
    document.addEventListener("keydown", onKeydown, true);
    confirmBtn.focus();
  });
}

// ---------- sparkline ----------

export function renderSparkline(series, width, height, { color = "#2563eb", formatLabel = formatPrice } = {}) {
  // SVG with line + dots + min/max labels + bottom date axis.
  if (series.length < 2) return el("p", { class: "empty" }, "Brak danych.");
  const yMaxLabel = formatLabel(Math.max(...series.map((p) => p.v)));
  const yMinLabel = formatLabel(Math.min(...series.map((p) => p.v)));
  // Left gutter must fit the widest label; otherwise the first point/line
  // sits on top of the text (visible for short series with a high first point).
  const padLeft = Math.max(72, Math.min(width * 0.26, Math.max(yMaxLabel.length, yMinLabel.length) * 8 + 16));
  const padRight = 20;
  const padTop = 16;
  // Bottom padding reserves a band for date ticks under the chart baseline.
  const padBottom = 36;
  const xs = series.map((p) => p.t);
  const ys = series.map((p) => p.v);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const sx = (t) => padLeft + ((t - xMin) / xRange) * (width - padLeft - padRight);
  const sy = (v) => height - padBottom - ((v - yMin) / yRange) * (height - padTop - padBottom);
  const baselineY = height - padBottom;

  // DD.MM short format for the bottom axis - full date is still in tooltip/title.
  const formatAxisDate = (t) => {
    const d = new Date(t);
    return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  // Decide which dot indices get a visible date label. Always show first and
  // last; fill the middle as long as labels stay > minLabelGap apart so they
  // do not overlap visually.
  const minLabelGap = 38;
  const showLabel = new Array(series.length).fill(false);
  if (series.length > 0) {
    showLabel[0] = true;
    showLabel[series.length - 1] = series.length > 1;
    let lastShownX = sx(series[0].t);
    const lastIdxX = sx(series[series.length - 1].t);
    for (let i = 1; i < series.length - 1; i++) {
      const x = sx(series[i].t);
      if (x - lastShownX >= minLabelGap && lastIdxX - x >= minLabelGap) {
        showLabel[i] = true;
        lastShownX = x;
      }
    }
  }

  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ");

  const guides = series.map((p) => {
    const x = sx(p.t).toFixed(1);
    return `<line class="sparkline-guide" x1="${x}" y1="${sy(p.v).toFixed(1)}" x2="${x}" y2="${baselineY.toFixed(1)}" />`;
  }).join("");

  const dateTicks = series.map((p, i) => {
    if (!showLabel[i]) return "";
    const x = sx(p.t).toFixed(1);
    const label = escapeHtml(formatAxisDate(p.t));
    return `
      <line class="sparkline-tick" x1="${x}" y1="${baselineY.toFixed(1)}" x2="${x}" y2="${(baselineY + 4).toFixed(1)}" />
      <text class="sparkline-date" x="${x}" y="${(baselineY + 18).toFixed(1)}" text-anchor="middle">${label}</text>
    `;
  }).join("");

  const dots = series.map((p) => {
    const x = sx(p.t);
    const y = sy(p.v);
    const valueLabel = formatLabel(p.v);
    const dateLabel = formatDate(new Date(p.t).toISOString());
    const tooltipLabel = escapeHtml(valueLabel);
    const titleLabel = escapeHtml(`${valueLabel} · ${dateLabel}`);
    const tooltipWidth = Math.min(width - 16, Math.max(56, valueLabel.length * 7 + 18));
    const tooltipLeft = Math.max(8, Math.min(width - tooltipWidth - 8, x - tooltipWidth / 2));
    const tooltipTop = y > padTop + 32 ? y - 34 : y + 12;
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
      <text x="8" y="${(padTop + 4).toFixed(0)}" font-size="11" fill="#6b7280">${yMaxLabel}</text>
      <text x="8" y="${(baselineY + 4).toFixed(0)}" font-size="11" fill="#6b7280">${yMinLabel}</text>
      ${guides}
      <line class="sparkline-baseline" x1="${padLeft.toFixed(1)}" y1="${baselineY.toFixed(1)}" x2="${(width - padRight).toFixed(1)}" y2="${baselineY.toFixed(1)}" />
      ${dateTicks}
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
    </svg>
  `;
  return el("div", { html: svg, style: "padding: 16px;" });
}
