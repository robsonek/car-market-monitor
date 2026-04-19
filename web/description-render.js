// Renderowanie opisu listingu: bezpieczny parse + sanitizacja HTML,
// lista telefonów. Wyekstrahowane z view/listing-detail.

import { el } from "./core.js";

const DESCRIPTION_ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "div", "em", "i", "li", "ol", "p", "span", "strong", "u", "ul",
]);

const DESCRIPTION_DROP_TAGS = new Set([
  "iframe", "math", "noscript", "object", "script", "style", "svg", "template",
]);

// phones_json shape from migration 0003: {"main":[...],"description":[...]}.
// Defensive parsing — older snapshots might not have it set yet.
export function parsePhonesJson(raw) {
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
export function renderDescriptionHtml(rawHtml) {
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

export function renderPhoneList(numbers) {
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
