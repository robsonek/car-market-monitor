import { state, el, query } from "../core.js";
import { formatRelative } from "../format.js";
import { field, input, checkboxField } from "../ui.js";
import { filterVisibleChanges, renderDiffSide } from "../changes-render.js";
import { navigate } from "../router.js";

export function viewChanges(view, params) {
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
