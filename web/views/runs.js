import { state, el, query } from "../core.js";
import { formatDate } from "../format.js";
import { statusBadge, truncate } from "../ui.js";

export function viewRuns(view) {
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
