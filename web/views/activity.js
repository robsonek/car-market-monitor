import { state, el, query } from "../core.js";
import { formatPrice, formatMileage, formatRelative, describePriceChange } from "../format.js";
import { listingLink, panelTable } from "../ui.js";
import { summarizeChangedFields } from "../changes-render.js";
import { navigate } from "../router.js";

export function viewActivity(view, params = {}) {
  view.appendChild(el("h1", {}, "Activity"));

  const PAGE_SIZE = 50;
  const activityPath = "#/activity";
  const ACTIVITY_WINDOW_DAYS = 7;
  const activityWindowExpr = `-${ACTIVITY_WINDOW_DAYS} days`;
  const activityWindowLabel = `ostatnie ${ACTIVITY_WINDOW_DAYS} dni`;

  function readPageParam(name) {
    const page = Number.parseInt(params[name] || "", 10);
    return Number.isInteger(page) && page > 0 ? page : 1;
  }

  function buildActivitySort(sortParam, dirParam, pageParam, sectionKey, columns, defaultKey = "when") {
    const sortKey = columns[params[sortParam]] ? params[sortParam] : defaultKey;
    const sortDir = params[dirParam] === "asc" ? "ASC" : "DESC";
    const sortExpr = columns[sortKey];
    const scrollTarget = `[data-activity-section="${sectionKey}"]`;

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
          navigate(activityPath, next, { scrollMode: "target", scrollTarget });
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

  function appendPager(panel, pageParam, page, totalPages, sectionKey) {
    if (totalPages <= 1) return;
    const scrollTarget = `[data-activity-section="${sectionKey}"]`;
    const goTo = (targetPage) => navigate(
      activityPath,
      { ...params, [pageParam]: String(targetPage) },
      { scrollMode: "target", scrollTarget },
    );
    panel.appendChild(el("div", { class: "pager panel-pager" },
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

  // Base SQL dla każdej sekcji - zdefiniowane z góry, żeby móc policzyć
  // total wszystkich zakładek (liczniki) bez uruchamiania zapytań wierszowych
  // dla nieaktywnych sekcji.
  //
  // Wartości przebiegu w listing_changes.{old,new}_value to stringi "67 700 km";
  // żeby sortować/porównywać numerycznie, odcinamy " km" i spacje, potem CAST.
  const mileageNumericExpr = (col) => `CAST(REPLACE(REPLACE(${col}, ' km', ''), ' ', '') AS INTEGER)`;

  const recentlyChangedBaseSql = `WITH latest_listing_changes AS (
                                    SELECT lc.listing_id, MAX(lc.created_at) AS created_at
                                    FROM listing_changes lc
                                    WHERE lc.field_name NOT IN ('__listing_created', '__listing_status')
                                      AND lc.created_at >= datetime('now', '${activityWindowExpr}')
                                    GROUP BY lc.listing_id
                                  )
                                  SELECT lc.created_at, l.id, l.title, l.last_price_amount, l.year,
                                         COUNT(*) AS change_count,
                                         COUNT(DISTINCT lc.field_name) AS field_count,
                                         GROUP_CONCAT(DISTINCT lc.field_name) AS changed_fields
                                  FROM latest_listing_changes latest
                                  JOIN listing_changes lc
                                    ON lc.listing_id = latest.listing_id
                                   AND lc.created_at = latest.created_at
                                  JOIN listings l ON l.id = lc.listing_id
                                  WHERE lc.field_name NOT IN ('__listing_created', '__listing_status')
                                  GROUP BY lc.created_at, l.id, l.title, l.last_price_amount, l.year`;

  const priceChangeBaseSql = `SELECT lc.created_at, lc.old_value, lc.new_value, l.id, l.title, l.listing_url, l.year,
                                     (CAST(lc.new_value AS REAL) - CAST(lc.old_value AS REAL)) AS price_change_amount
                              FROM listing_changes lc
                              JOIN listings l ON l.id = lc.listing_id
                              WHERE lc.field_name = 'price.value'
                                AND lc.old_value IS NOT NULL AND lc.new_value IS NOT NULL
                                AND CAST(lc.old_value AS REAL) > 0
                                AND CAST(lc.new_value AS REAL) > 0
                                AND CAST(lc.new_value AS REAL) <> CAST(lc.old_value AS REAL)
                                AND lc.created_at >= datetime('now', '${activityWindowExpr}')`;

  const mileageChangeBaseSql = `SELECT lc.created_at, lc.old_value, lc.new_value, l.id, l.title, l.year,
                                       ${mileageNumericExpr("lc.old_value")} AS old_mileage_num,
                                       ${mileageNumericExpr("lc.new_value")} AS new_mileage_num,
                                       (${mileageNumericExpr("lc.new_value")} - ${mileageNumericExpr("lc.old_value")}) AS mileage_change_amount
                                FROM listing_changes lc
                                JOIN listings l ON l.id = lc.listing_id
                                WHERE lc.field_name = 'details.mileage.value'
                                  AND lc.old_value IS NOT NULL AND lc.new_value IS NOT NULL
                                  AND ${mileageNumericExpr("lc.old_value")} > 0
                                  AND ${mileageNumericExpr("lc.new_value")} > 0
                                  AND ${mileageNumericExpr("lc.new_value")} <> ${mileageNumericExpr("lc.old_value")}
                                  AND lc.created_at >= datetime('now', '${activityWindowExpr}')`;

  const disappearedBaseSql = `SELECT lc.created_at, l.id, l.title, l.last_price_amount, l.year
                              FROM listing_changes lc
                              JOIN listings l ON l.id = lc.listing_id
                              WHERE lc.field_name = '__listing_status' AND lc.new_value = 'MISSING'
                                AND lc.created_at >= datetime('now', '${activityWindowExpr}')
                                AND l.is_active = 0
                                AND NOT EXISTS (
                                  SELECT 1 FROM listing_changes lc2
                                  WHERE lc2.listing_id = lc.listing_id
                                    AND lc2.field_name = '__listing_status'
                                    AND lc2.created_at > lc.created_at
                                )`;

  const appearedBaseSql = `SELECT lc.created_at, l.id, l.title, l.last_price_amount, l.year
                           FROM listing_changes lc
                           JOIN listings l ON l.id = lc.listing_id
                           WHERE lc.field_name = '__listing_created'
                             AND lc.created_at >= datetime('now', '${activityWindowExpr}')`;

  function countSection(baseSql) {
    return Number(query(state.db, `SELECT COUNT(*) AS c FROM (${baseSql}) section_rows`)[0]?.c || 0);
  }

  const TABS = [
    { key: "changed", label: "Ostatnio zmienione", baseSql: recentlyChangedBaseSql },
    { key: "drops", label: "Zmiany cen", baseSql: priceChangeBaseSql },
    { key: "mileage", label: "Zmiany przebiegu", baseSql: mileageChangeBaseSql },
    { key: "disappeared", label: "Świeżo zniknięte", baseSql: disappearedBaseSql },
    { key: "appeared", label: "Świeżo dodane", baseSql: appearedBaseSql },
  ];
  const activeTab = TABS.some((t) => t.key === params.tab) ? params.tab : "changed";
  const counts = Object.fromEntries(TABS.map((t) => [t.key, countSection(t.baseSql)]));

  const tabBar = el("div", { class: "activity-tabs", role: "tablist" });
  TABS.forEach((t) => {
    const isActive = t.key === activeTab;
    tabBar.appendChild(el(
      "button",
      {
        type: "button",
        role: "tab",
        "aria-selected": isActive ? "true" : "false",
        class: "activity-tab" + (isActive ? " active" : ""),
        onclick: () => navigate(activityPath, { ...params, tab: t.key }),
      },
      el("span", { class: "activity-tab-label" }, t.label),
      el("span", { class: "activity-tab-count tabular" }, counts[t.key].toLocaleString("pl-PL")),
    ));
  });
  view.appendChild(tabBar);

  if (activeTab === "changed") {
    const recentlyChangedSortColumns = {
      when: "created_at",
      title: "lower(title)",
      year: "year",
      price: "CAST(last_price_amount AS REAL)",
      changes: "CAST(field_count AS INTEGER)",
    };
    const recentlyChangedSort = buildActivitySort(
      "changedSort",
      "changedDir",
      "changedPage",
      "changed",
      recentlyChangedSortColumns,
    );
    const recentlyChangedPage = readPageParam("changedPage");
    const recentlyChanged = queryPagedSection(
      recentlyChangedBaseSql,
      recentlyChangedSort.sortExpr,
      recentlyChangedSort.sortDir,
      recentlyChangedPage,
      "created_at DESC, title ASC",
    );
    const recentlyChangedPanel = panelTable(
      `Ostatnio zmienione (${activityWindowLabel}) · ${recentlyChanged.total.toLocaleString("pl-PL")}`,
      [
        recentlyChangedSort.sortableTh("Kiedy", "when", { numeric: true }),
        recentlyChangedSort.sortableTh("Oferta", "title"),
        recentlyChangedSort.sortableTh("Rok", "year", { numeric: true }),
        recentlyChangedSort.sortableTh("Cena", "price", { numeric: true }),
        recentlyChangedSort.sortableTh("Zmiany", "changes", { numeric: true }),
      ],
      recentlyChanged.rows.map((r) => [
        formatRelative(r.created_at),
        listingLink(r.id, r.title || r.id),
        el("span", { class: "tabular" }, r.year ?? "-"),
        el("span", { class: "tabular" }, formatPrice(r.last_price_amount)),
        summarizeChangedFields(r.changed_fields, r.field_count, r.change_count),
      ]),
      recentlyChanged.rows.map((r) => () => navigate(`#/listing/${r.id}`)),
      `Brak ofert z ostatnimi zmianami w oknie: ${activityWindowLabel}.`,
    );
    recentlyChangedPanel.setAttribute("data-activity-section", "changed");
    appendPager(recentlyChangedPanel, "changedPage", recentlyChanged.page, recentlyChanged.totalPages, "changed");
    view.appendChild(recentlyChangedPanel);
  }

  if (activeTab === "drops") {
    const priceChangeSortColumns = {
      when: "created_at",
      title: "lower(title)",
      year: "year",
      old_price: "CAST(old_value AS REAL)",
      new_price: "CAST(new_value AS REAL)",
      change: "price_change_amount",
    };
    const priceChangeSort = buildActivitySort("dropsSort", "dropsDir", "dropsPage", "drops", priceChangeSortColumns);
    const priceChangePage = readPageParam("dropsPage");
    const priceChanges = queryPagedSection(
      priceChangeBaseSql,
      priceChangeSort.sortExpr,
      priceChangeSort.sortDir,
      priceChangePage,
      "created_at DESC, title ASC",
    );
    const priceChangesPanel = panelTable(
      `Zmiany cen (${activityWindowLabel}) · ${priceChanges.total.toLocaleString("pl-PL")}`,
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
      `Brak zmian cen w oknie: ${activityWindowLabel}.`,
    );
    priceChangesPanel.setAttribute("data-activity-section", "drops");
    appendPager(priceChangesPanel, "dropsPage", priceChanges.page, priceChanges.totalPages, "drops");
    view.appendChild(priceChangesPanel);
  }

  if (activeTab === "mileage") {
    const mileageChangeSortColumns = {
      when: "created_at",
      title: "lower(title)",
      year: "year",
      old_mileage: mileageNumericExpr("old_value"),
      new_mileage: mileageNumericExpr("new_value"),
      change: "mileage_change_amount",
    };
    const mileageChangeSort = buildActivitySort(
      "mileageSort",
      "mileageDir",
      "mileagePage",
      "mileage",
      mileageChangeSortColumns,
    );
    const mileageChangePage = readPageParam("mileagePage");
    const mileageChanges = queryPagedSection(
      mileageChangeBaseSql,
      mileageChangeSort.sortExpr,
      mileageChangeSort.sortDir,
      mileageChangePage,
      "created_at DESC, title ASC",
    );
    const mileageChangesPanel = panelTable(
      `Zmiany przebiegu (${activityWindowLabel}) · ${mileageChanges.total.toLocaleString("pl-PL")}`,
      [
        mileageChangeSort.sortableTh("Kiedy", "when", { numeric: true }),
        mileageChangeSort.sortableTh("Oferta", "title"),
        mileageChangeSort.sortableTh("Rok", "year", { numeric: true }),
        mileageChangeSort.sortableTh("Z", "old_mileage", { numeric: true }),
        mileageChangeSort.sortableTh("Na", "new_mileage", { numeric: true }),
        mileageChangeSort.sortableTh("Zmiana", "change", { numeric: true }),
      ],
      mileageChanges.rows.map((r) => {
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
      mileageChanges.rows.map((r) => () => navigate(`#/listing/${r.id}`)),
      `Brak zmian przebiegu w oknie: ${activityWindowLabel}.`,
    );
    mileageChangesPanel.setAttribute("data-activity-section", "mileage");
    appendPager(mileageChangesPanel, "mileagePage", mileageChanges.page, mileageChanges.totalPages, "mileage");
    view.appendChild(mileageChangesPanel);
  }

  const statusSortColumns = {
    when: "created_at",
    title: "lower(title)",
    year: "year",
    price: "CAST(last_price_amount AS REAL)",
  };

  if (activeTab === "disappeared") {
    const disappearedSort = buildActivitySort(
      "disappearedSort",
      "disappearedDir",
      "disappearedPage",
      "disappeared",
      statusSortColumns,
    );
    const disappearedPage = readPageParam("disappearedPage");
    const disappeared = queryPagedSection(
      disappearedBaseSql,
      disappearedSort.sortExpr,
      disappearedSort.sortDir,
      disappearedPage,
      "created_at DESC, title ASC",
    );
    const disappearedPanel = panelTable(
      `Świeżo zniknięte (${activityWindowLabel}) · ${disappeared.total.toLocaleString("pl-PL")}`,
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
      `Nic nie zniknęło w oknie: ${activityWindowLabel}.`,
    );
    disappearedPanel.setAttribute("data-activity-section", "disappeared");
    appendPager(disappearedPanel, "disappearedPage", disappeared.page, disappeared.totalPages, "disappeared");
    view.appendChild(disappearedPanel);
  }

  if (activeTab === "appeared") {
    const appearedSort = buildActivitySort("appearedSort", "appearedDir", "appearedPage", "appeared", statusSortColumns);
    const appearedPage = readPageParam("appearedPage");
    const appeared = queryPagedSection(
      appearedBaseSql,
      appearedSort.sortExpr,
      appearedSort.sortDir,
      appearedPage,
      "created_at DESC, title ASC",
    );
    const appearedPanel = panelTable(
      `Świeżo dodane (${activityWindowLabel}) · ${appeared.total.toLocaleString("pl-PL")}`,
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
      `Brak nowych ofert w oknie: ${activityWindowLabel}.`,
    );
    appearedPanel.setAttribute("data-activity-section", "appeared");
    appendPager(appearedPanel, "appearedPage", appeared.page, appeared.totalPages, "appeared");
    view.appendChild(appearedPanel);
  }
}
