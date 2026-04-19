import { state, el, query } from "../core.js";
import { formatPrice, formatMileage, formatRelative, formatDate, describePriceChange } from "../format.js";
import { statCard, row, statusBadge, listingLink, panelTable } from "../ui.js";
import { summarizeRunBatch } from "../bootstrap.js";
import { navigate } from "../router.js";

export function viewHome(view, params = {}) {
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

  // Mileage changes. Wartości w listing_changes.{old,new}_value to stringi
  // typu "67 700 km"; odcinamy " km" + spacje i castujemy do INTEGER, żeby
  // móc liczyć deltę i sortować numerycznie.
  const homeMileageNumericExpr = (col) => `CAST(REPLACE(REPLACE(${col}, ' km', ''), ' ', '') AS INTEGER)`;
  const HOME_MILEAGE_CHANGE_SORT_COLUMNS = {
    when: "created_at",
    title: "lower(title)",
    year: "year",
    old_mileage: homeMileageNumericExpr("old_value"),
    new_mileage: homeMileageNumericExpr("new_value"),
    change: "mileage_change_amount",
  };
  const mileageChangeSort = buildHomeTableSort("mileageSort", "mileageDir", HOME_MILEAGE_CHANGE_SORT_COLUMNS);
  const mileageChanges = query(
    state.db,
    `WITH recent_mileage_changes AS (
       SELECT lc.created_at, lc.old_value, lc.new_value, l.id, l.title, l.year,
              ${homeMileageNumericExpr("lc.old_value")} AS old_mileage_num,
              ${homeMileageNumericExpr("lc.new_value")} AS new_mileage_num,
              (${homeMileageNumericExpr("lc.new_value")} - ${homeMileageNumericExpr("lc.old_value")}) AS mileage_change_amount
       FROM listing_changes lc
       JOIN listings l ON l.id = lc.listing_id
       WHERE lc.field_name = 'details.mileage.value'
         AND lc.old_value IS NOT NULL AND lc.new_value IS NOT NULL
         AND ${homeMileageNumericExpr("lc.old_value")} > 0
         AND ${homeMileageNumericExpr("lc.new_value")} > 0
         AND ${homeMileageNumericExpr("lc.new_value")} <> ${homeMileageNumericExpr("lc.old_value")}
         AND lc.created_at >= datetime('now', '-30 days')
       ORDER BY lc.created_at DESC, l.title ASC
       LIMIT 20
     )
     SELECT *
     FROM recent_mileage_changes
     ORDER BY ${mileageChangeSort.sortExpr} ${mileageChangeSort.sortDir} NULLS LAST, created_at DESC, title ASC`,
  );
  view.appendChild(panelTable(
    "Zmiany przebiegu (ostatnie 30 dni · 20 najnowszych)",
    [
      mileageChangeSort.sortableTh("Kiedy", "when", { numeric: true }),
      mileageChangeSort.sortableTh("Oferta", "title"),
      mileageChangeSort.sortableTh("Rok", "year", { numeric: true }),
      mileageChangeSort.sortableTh("Z", "old_mileage", { numeric: true }),
      mileageChangeSort.sortableTh("Na", "new_mileage", { numeric: true }),
      mileageChangeSort.sortableTh("Zmiana", "change", { numeric: true }),
    ],
    mileageChanges.map((r) => {
      const delta = Number(r.mileage_change_amount);
      const hasDelta = Number.isFinite(delta);
      const rollbackClass = hasDelta && delta < 0 ? " mileage-rollback" : "";
      const deltaLabel = hasDelta
        ? `${delta > 0 ? "+" : ""}${delta.toLocaleString("pl-PL")} km`
        : "—";
      return [
        formatRelative(r.created_at),
        listingLink(r.id, r.title || r.id),
        el("span", { class: "tabular" }, r.year ?? "-"),
        el("span", { class: "tabular" }, formatMileage(r.old_mileage_num)),
        el("span", { class: `tabular${rollbackClass}` }, formatMileage(r.new_mileage_num)),
        el("span", { class: `tabular${rollbackClass}` }, deltaLabel),
      ];
    }),
    mileageChanges.map((r) => () => navigate(`#/listing/${r.id}`)),
    "Brak zmian przebiegu w ostatnich 30 dniach.",
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
