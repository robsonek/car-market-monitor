import { state, el, query } from "../core.js";
import { formatDate, formatRelative, formatMileage, formatPrice } from "../format.js";
import { activeBadge, formatEnum, lastEditCell } from "../ui.js";
import { setListingWatched } from "../bootstrap.js";
import { navigate, route } from "../router.js";
import { watchlistEntryKey } from "../watchlist.js";

export function viewWatchlist(view) {
  view.classList.add("view-wide");
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
            l.fuel_type, l.engine_power, l.advert_updated_at, l.advert_created_at
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
      el("th", {}, "Ostatnia edycja"),
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
    lastEditCell(row),
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
