// Core: jedyny mutowalny shared state + trzon DOM/DB używany wszędzie.
// `state` jest singletonem — moduł ES cache'uje wynik importu, więc każdy
// importer dostaje ten sam obiekt.

export const state = {
  db: null,
  sizeBytes: 0,
  watchlistEntries: [],
  savedFilterEntries: [],
  galleryLightbox: null,
  closeTopbarMenu: null,
  scrollPositions: new Map(),
  pendingNavigationScrollMode: null,
  pendingNavigationScrollTop: null,
  pendingNavigationScrollTarget: null,
};

export function query(db, sql, params = []) {
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

export function el(tag, attrs = {}, ...children) {
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

export function clearView() {
  const view = document.getElementById("view");
  view.innerHTML = "";
  view.className = "";
  return view;
}

export function clickStartedInInteractiveElement(event) {
  return event.target instanceof Element && Boolean(event.target.closest("a, button"));
}
