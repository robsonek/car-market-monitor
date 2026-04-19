// Pure formatters + HTML text utilities. Czyste funkcje, żadnych side effectów,
// bez zależności od state/db — bezpieczne do testowania i importu z dowolnego miejsca.

// Mały whitelist dla decodeHtmlEntities. Większy zestaw jest w odpowiednim
// kodzie Node-side (nie tu) — tutaj pokrywamy entities które faktycznie
// pojawiają się w scrape payloadach oraz w SQL LIKE filtrowaniu search'a.
const HTML_NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeHtmlEntities(text) {
  if (!text) return "";
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => HTML_NAMED_ENTITIES[name] ?? `&${name};`)
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
      const n = Number.parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    });
}

export function stripHtml(html) {
  if (!html) return "";
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function formatPrice(value, currency = "PLN") {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${num.toLocaleString("pl-PL")} ${currency}`;
}

export function formatSignedPriceDelta(value, currency = "PLN") {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const prefix = num > 0 ? "+" : num < 0 ? "-" : "";
  return `${prefix}${formatPrice(Math.abs(num), currency)}`;
}

export function formatSignedPercentDelta(value) {
  if (value == null || value === "") return "";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const prefix = num > 0 ? "+" : num < 0 ? "-" : "";
  return `${prefix}${Math.abs(num).toFixed(1)}%`;
}

export function describePriceChange(oldValue, newValue) {
  const oldNum = Number(oldValue);
  const newNum = Number(newValue);
  if (!Number.isFinite(oldNum) || !Number.isFinite(newNum)) {
    return { className: "", label: "—" };
  }
  const amount = newNum - oldNum;
  const pct = oldNum > 0 ? (amount * 100.0) / oldNum : null;
  return {
    className: amount > 0 ? "price-rise" : amount < 0 ? "price-drop" : "",
    label: pct == null
      ? formatSignedPriceDelta(amount)
      : `${formatSignedPriceDelta(amount)} (${formatSignedPercentDelta(pct)})`,
  };
}

export function formatMileage(value) {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${num.toLocaleString("pl-PL")} km`;
}

export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
}

export function formatRelative(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return `${diffSec}s temu`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m temu`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h temu`;
  return `${Math.floor(diffSec / 86400)}d temu`;
}

export function isValidVin(vin) {
  if (!vin || vin.length !== 17) return false;
  if (/[^A-Za-z0-9]/.test(vin)) return false;
  if (/[IOQioq]/.test(vin)) return false;
  const upper = vin.toUpperCase();
  if (new Set(upper).size === 1) return false;
  if (/^[0-9]+$/.test(upper)) return false;
  if (/^[A-Z]+$/.test(upper)) return false;
  return true;
}

export function isValidRegistration(reg) {
  if (!reg || reg.length < 4) return false;
  const norm = reg.replace(/\s+/g, "").toUpperCase();
  if (norm.length < 4 || norm.length > 8) return false;
  if (/[^A-Z0-9]/.test(norm)) return false;
  if (new Set(norm).size === 1) return false;
  if (/^[A-Z]+$/.test(norm)) return false;
  if (/^[0-9]+$/.test(norm)) return false;
  return true;
}
