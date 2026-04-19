import { state, el, query } from "../core.js";
import { formatPrice, formatMileage, formatRelative } from "../format.js";
import { field, input, listingLink, truncate, matchTypeBadge } from "../ui.js";
import { navigate } from "../router.js";

export function viewRelistings(view, params = {}) {
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
