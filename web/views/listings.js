import { state, el, query, clickStartedInInteractiveElement } from "../core.js";
import {
  formatPrice,
  formatMileage,
  formatRelative,
} from "../format.js";
import {
  field,
  rangeField,
  input,
  activeBadge,
  formatEnum,
  formatPriceInK,
  formatSellerLabel,
  formatSellerLocation,
  lastEditCell,
  openTextPrompt,
  openConfirmDialog,
} from "../ui.js";
import {
  generateSavedFilterId,
  removeSavedFilter,
  renameSavedFilter,
  upsertSavedFilter,
} from "../saved-filters.js";
import { persistSavedFilterEntries } from "../bootstrap.js";
import { navigate } from "../router.js";

// Generuje krótką etykietę presetu z aktywnych filtrów — użytkownik
// może ją edytować, ale domyślna wartość ma sens i pomaga szybko
// rozpoznać zestaw bez otwierania szczegółów.
function suggestFilterName(params) {
  const parts = [];
  const p = params || {};
  if (p.q) parts.push(`"${String(p.q).trim()}"`);
  if (p.sellerQuery) parts.push(String(p.sellerQuery).trim());
  if (p.minYear && p.maxYear) parts.push(`${p.minYear}-${p.maxYear}`);
  else if (p.minYear) parts.push(`od ${p.minYear}`);
  else if (p.maxYear) parts.push(`do ${p.maxYear}`);
  const minPriceLabel = formatPriceInK(p.minPrice);
  const maxPriceLabel = formatPriceInK(p.maxPrice);
  if (minPriceLabel && maxPriceLabel) parts.push(`${minPriceLabel}-${maxPriceLabel} PLN`);
  else if (maxPriceLabel) parts.push(`do ${maxPriceLabel} PLN`);
  else if (minPriceLabel) parts.push(`od ${minPriceLabel} PLN`);
  if (p.minMileage && p.maxMileage) parts.push(`${p.minMileage}-${p.maxMileage} km`);
  else if (p.maxMileage) parts.push(`do ${p.maxMileage} km`);
  else if (p.minMileage) parts.push(`od ${p.minMileage} km`);
  if (p.minPower && p.maxPower) parts.push(`${p.minPower}-${p.maxPower} KM`);
  else if (p.maxPower) parts.push(`do ${p.maxPower} KM`);
  else if (p.minPower) parts.push(`od ${p.minPower} KM`);
  if (p.fuelType) parts.push(formatEnum(p.fuelType));
  if (p.bodyType) parts.push(formatEnum(p.bodyType));
  if (p.gearbox) parts.push(formatEnum(p.gearbox));
  if (p.country) parts.push(formatEnum(p.country));
  if (p.newUsed) parts.push(formatEnum(p.newUsed));
  if (p.damaged === "1") parts.push("uszkodzony");
  if (p.damaged === "0") parts.push("nieuszkodzony");
  if (p.noAccident === "1") parts.push("bezwypadkowy");
  if (p.serviceRecord === "1") parts.push("z książką");
  if (p.active === "1") parts.push("aktywne");
  if (p.active === "0") parts.push("nieaktywne");
  if (p.source) parts.push(String(p.source));
  if (parts.length === 0) {
    return `Filtr z ${new Date().toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}`;
  }
  const joined = parts.join(", ");
  return joined.length > 80 ? `${joined.slice(0, 77)}…` : joined;
}

export function viewListings(view, params) {
  view.classList.add("view-wide");
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

  const savedFiltersCombo = buildSavedFiltersCombo(params);

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
      savedFiltersCombo,
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

  function buildSavedFiltersCombo(activeParams) {
    const menu = el("div", { class: "saved-filters-menu", hidden: "" });
    const badge = el("span", { class: "saved-filters-count", hidden: "" });
    const toggle = el(
      "button",
      {
        type: "button",
        class: "secondary saved-filters-toggle",
        "aria-haspopup": "true",
        "aria-expanded": "false",
      },
      "Moje filtry",
      badge,
    );
    const combo = el("div", { class: "saved-filters-combo" }, toggle, menu);

    let outsideClickHandler = null;
    let escapeHandler = null;

    function closeMenu() {
      if (menu.hidden) return;
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (outsideClickHandler) {
        document.removeEventListener("mousedown", outsideClickHandler);
        outsideClickHandler = null;
      }
      if (escapeHandler) {
        document.removeEventListener("keydown", escapeHandler);
        escapeHandler = null;
      }
    }

    function openMenu() {
      if (!menu.hidden) return;
      renderMenu();
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      outsideClickHandler = (event) => {
        if (combo.contains(event.target)) return;
        closeMenu();
      };
      escapeHandler = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeMenu();
          toggle.focus();
        }
      };
      document.addEventListener("mousedown", outsideClickHandler);
      document.addEventListener("keydown", escapeHandler);
    }

    toggle.addEventListener("click", () => {
      if (menu.hidden) openMenu();
      else closeMenu();
    });

    function updateBadge() {
      const count = state.savedFilterEntries.length;
      if (count > 0) {
        badge.textContent = String(count);
        badge.hidden = false;
      } else {
        badge.textContent = "";
        badge.hidden = true;
      }
    }

    function currentParamsForSave() {
      // Presety zapisują zaaplikowany stan (URL), a nie niezaaplikowane
      // zmiany w formularzu. Użytkownik musi kliknąć "Filtruj" żeby mieć
      // pewność, że zapisze dokładnie to, co widzi na liście.
      const snapshot = {};
      for (const [key, value] of Object.entries(activeParams || {})) {
        if (key === "page") continue;
        if (value == null) continue;
        const str = String(value).trim();
        if (!str) continue;
        snapshot[key] = str;
      }
      return snapshot;
    }

    function applyPreset(entry) {
      closeMenu();
      navigate("#/listings", entry.params);
    }

    async function handleSaveCurrent() {
      const snapshot = currentParamsForSave();
      const suggested = suggestFilterName(snapshot);
      closeMenu();
      const name = await openTextPrompt({
        title: "Zapisz filtr",
        label: "Nazwa zapisanego filtra",
        initialValue: suggested,
        confirmLabel: "Zapisz",
      });
      if (name === null) return;
      const now = new Date().toISOString();
      const entry = {
        id: generateSavedFilterId(),
        name,
        params: snapshot,
        createdAt: now,
        updatedAt: now,
      };
      const nextEntries = upsertSavedFilter(state.savedFilterEntries, entry);
      persistSavedFilterEntries(nextEntries);
      updateBadge();
    }

    function handleOverwrite(entry) {
      const snapshot = currentParamsForSave();
      const now = new Date().toISOString();
      const nextEntries = upsertSavedFilter(state.savedFilterEntries, {
        ...entry,
        params: snapshot,
        updatedAt: now,
      });
      persistSavedFilterEntries(nextEntries);
      renderMenu();
      updateBadge();
    }

    async function handleRename(entry) {
      closeMenu();
      const name = await openTextPrompt({
        title: "Zmień nazwę filtra",
        label: "Nowa nazwa",
        initialValue: entry.name,
        confirmLabel: "Zapisz",
      });
      if (name === null) return;
      if (name === entry.name) return;
      const nextEntries = renameSavedFilter(state.savedFilterEntries, entry.id, name);
      persistSavedFilterEntries(nextEntries);
    }

    async function handleRemove(entry) {
      closeMenu();
      const ok = await openConfirmDialog({
        title: "Usunąć filtr?",
        message: `Filtr "${entry.name}" zostanie trwale usunięty.`,
        confirmLabel: "Usuń",
        destructive: true,
      });
      if (!ok) return;
      const nextEntries = removeSavedFilter(state.savedFilterEntries, entry.id);
      persistSavedFilterEntries(nextEntries);
      updateBadge();
    }

    function renderMenu() {
      menu.innerHTML = "";
      const entries = state.savedFilterEntries;

      if (entries.length === 0) {
        menu.appendChild(el("div", { class: "saved-filters-empty" }, "Brak zapisanych filtrów"));
      } else {
        const list = el("div", { class: "saved-filters-list" });
        for (const entry of entries) {
          const paramsCount = Object.keys(entry.params).length;
          const applyBtn = el(
            "button",
            {
              type: "button",
              class: "saved-filter-apply",
              title: "Zastosuj filtr",
              onclick: () => applyPreset(entry),
            },
            el("span", { class: "saved-filter-name" }, entry.name),
            el("span", { class: "saved-filter-meta" }, `${paramsCount} ${paramsCount === 1 ? "parametr" : "parametrów"}`),
          );
          const overwriteBtn = el(
            "button",
            {
              type: "button",
              class: "icon-only",
              title: "Nadpisz aktualnymi filtrami",
              "aria-label": "Nadpisz aktualnymi filtrami",
              onclick: () => handleOverwrite(entry),
            },
            "⟳",
          );
          const renameBtn = el(
            "button",
            {
              type: "button",
              class: "icon-only",
              title: "Zmień nazwę",
              "aria-label": "Zmień nazwę",
              onclick: () => handleRename(entry),
            },
            "✎",
          );
          const removeBtn = el(
            "button",
            {
              type: "button",
              class: "icon-only saved-filter-remove",
              title: "Usuń",
              "aria-label": "Usuń",
              onclick: () => handleRemove(entry),
            },
            "×",
          );
          list.appendChild(el("div", { class: "saved-filter-item" }, applyBtn, overwriteBtn, renameBtn, removeBtn));
        }
        menu.appendChild(list);
      }

      const saveBtn = el(
        "button",
        {
          type: "button",
          class: "saved-filters-save",
          onclick: handleSaveCurrent,
        },
        "Zapisz obecne filtry",
      );
      menu.appendChild(el("div", { class: "saved-filters-actions" }, saveBtn));
    }

    updateBadge();
    return combo;
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
    ad_date: "l.advert_original_created_at",
    last_edit: "COALESCE(MAX(l.advert_updated_at, l.advert_created_at), l.advert_updated_at, l.advert_created_at)",
    last_seen: "l.last_seen_at",
  };
  const sortKey = SORT_COLUMNS[params.sort] ? params.sort : "ad_date";
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
            l.advert_original_created_at, l.advert_updated_at, l.advert_created_at,
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
      sortableTh("Data dodania", "ad_date", { numeric: true }),
      sortableTh("Ostatnia edycja", "last_edit", { numeric: true }),
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
      el("td", { class: "muted tabular" }, formatRelative(r.advert_original_created_at)),
      lastEditCell(r),
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
