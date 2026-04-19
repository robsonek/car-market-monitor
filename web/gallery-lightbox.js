// Lightbox dla galerii zdjęć. Izolowany moduł — jedyna zależność to `state`
// (gdzie trzymana jest referencja do zainicjalizowanego lightboxa, żeby
// `initGalleryLightbox` był idempotentny).

import { state, el } from "./core.js";

function normalizeGalleryIndex(index, length) {
  if (length <= 0) return 0;
  const value = Number(index);
  if (!Number.isFinite(value)) return 0;
  return ((Math.trunc(value) % length) + length) % length;
}

function renderGalleryLightbox() {
  const lightbox = state.galleryLightbox;
  if (!lightbox) return;
  const total = lightbox.urls.length;
  if (total === 0) {
    closeGalleryLightbox({ restoreFocus: false });
    return;
  }

  lightbox.index = normalizeGalleryIndex(lightbox.index, total);
  const currentUrl = lightbox.urls[lightbox.index];
  lightbox.counter.textContent = `${lightbox.index + 1} / ${total}`;
  lightbox.image.src = currentUrl;
  lightbox.image.alt = `Zdjęcie ${lightbox.index + 1} z ${total}`;
  const singleImage = total === 1;
  lightbox.prevButton.disabled = singleImage;
  lightbox.nextButton.disabled = singleImage;
  lightbox.strip.innerHTML = "";

  for (const [index, url] of lightbox.urls.entries()) {
    const thumbButton = el(
      "button",
      {
        type: "button",
        class: `gallery-lightbox-thumb${index === lightbox.index ? " is-active" : ""}`,
        "aria-label": `Pokaż zdjęcie ${index + 1}`,
        "aria-current": index === lightbox.index ? "true" : null,
        onclick: () => showGalleryLightboxImage(index),
      },
      el("img", { src: url, loading: "lazy", alt: "" }),
    );
    lightbox.strip.appendChild(thumbButton);
  }

  const activeThumb = lightbox.strip.querySelector(".gallery-lightbox-thumb.is-active");
  if (activeThumb) activeThumb.scrollIntoView({ block: "nearest", inline: "center" });
  lightbox.updateStripScrollButtons();
}

function showGalleryLightboxImage(index) {
  const lightbox = state.galleryLightbox;
  if (!lightbox || lightbox.urls.length === 0) return;
  lightbox.index = normalizeGalleryIndex(index, lightbox.urls.length);
  renderGalleryLightbox();
}

function shiftGalleryLightbox(delta) {
  const lightbox = state.galleryLightbox;
  if (!lightbox || lightbox.urls.length <= 1) return;
  lightbox.index = normalizeGalleryIndex(lightbox.index + delta, lightbox.urls.length);
  renderGalleryLightbox();
}

export function openGalleryLightbox(urls, index = 0, trigger = null) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  const lightbox = initGalleryLightbox();
  lightbox.urls = urls.slice();
  lightbox.index = normalizeGalleryIndex(index, lightbox.urls.length);
  lightbox.lastFocused =
    trigger instanceof HTMLElement
      ? trigger
      : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  renderGalleryLightbox();
  lightbox.overlay.hidden = false;
  lightbox.overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("gallery-lightbox-open");
  const activeThumb = lightbox.strip.querySelector(".gallery-lightbox-thumb.is-active");
  if (activeThumb) activeThumb.scrollIntoView({ block: "nearest", inline: "center" });
  lightbox.updateStripScrollButtons();
  lightbox.closeButton.focus();
}

export function closeGalleryLightbox(options = {}) {
  const lightbox = state.galleryLightbox;
  if (!lightbox || lightbox.overlay.hidden) return;
  lightbox.overlay.hidden = true;
  lightbox.overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("gallery-lightbox-open");
  const lastFocused = lightbox.lastFocused;
  lightbox.lastFocused = null;
  if (options.restoreFocus !== false && lastFocused && document.contains(lastFocused)) {
    lastFocused.focus();
  }
}

function handleGalleryLightboxKeydown(event) {
  const lightbox = state.galleryLightbox;
  if (!lightbox || lightbox.overlay.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeGalleryLightbox();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    shiftGalleryLightbox(-1);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    shiftGalleryLightbox(1);
  }
}

export function initGalleryLightbox() {
  if (state.galleryLightbox) return state.galleryLightbox;

  const counter = el("div", { class: "gallery-lightbox-counter", "aria-live": "polite" });
  const closeButton = el(
    "button",
    {
      type: "button",
      class: "gallery-lightbox-close",
      "aria-label": "Zamknij galerię",
      onclick: () => closeGalleryLightbox(),
    },
    "✕",
  );
  const image = el("img", { class: "gallery-lightbox-image", alt: "" });
  const prevButton = el(
    "button",
    {
      type: "button",
      class: "gallery-lightbox-nav gallery-lightbox-nav-prev",
      "aria-label": "Poprzednie zdjęcie",
      onclick: () => shiftGalleryLightbox(-1),
    },
    "‹",
  );
  const nextButton = el(
    "button",
    {
      type: "button",
      class: "gallery-lightbox-nav gallery-lightbox-nav-next",
      "aria-label": "Następne zdjęcie",
      onclick: () => shiftGalleryLightbox(1),
    },
    "›",
  );
  const strip = el("div", {
    class: "gallery-lightbox-strip",
    "aria-label": "Miniatury galerii",
    onwheel: (event) => {
      const { deltaX, deltaY } = event;
      const delta = Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : deltaX;
      if (delta === 0) return;
      event.preventDefault();
      strip.scrollLeft += delta;
    },
  });
  const stripScrollPrev = el(
    "button",
    {
      type: "button",
      class: "gallery-lightbox-strip-scroll gallery-lightbox-strip-scroll-prev",
      "aria-label": "Przewiń miniatury w lewo",
      onclick: () => strip.scrollBy({ left: -Math.max(strip.clientWidth * 0.8, 160), behavior: "smooth" }),
    },
    "‹",
  );
  const stripScrollNext = el(
    "button",
    {
      type: "button",
      class: "gallery-lightbox-strip-scroll gallery-lightbox-strip-scroll-next",
      "aria-label": "Przewiń miniatury w prawo",
      onclick: () => strip.scrollBy({ left: Math.max(strip.clientWidth * 0.8, 160), behavior: "smooth" }),
    },
    "›",
  );
  const stripWrap = el(
    "div",
    { class: "gallery-lightbox-strip-wrap" },
    stripScrollPrev,
    strip,
    stripScrollNext,
  );
  const updateStripScrollButtons = () => {
    const maxScroll = strip.scrollWidth - strip.clientWidth;
    const canPrev = strip.scrollLeft > 4;
    const canNext = strip.scrollLeft < maxScroll - 4;
    stripScrollPrev.classList.toggle("is-visible", canPrev);
    stripScrollNext.classList.toggle("is-visible", canNext);
  };
  strip.addEventListener("scroll", updateStripScrollButtons, { passive: true });
  window.addEventListener("resize", updateStripScrollButtons);
  const dialog = el(
    "div",
    {
      class: "gallery-lightbox-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Galeria zdjęć",
      onclick: (event) => event.stopPropagation(),
    },
    el(
      "div",
      { class: "gallery-lightbox-topbar" },
      counter,
      closeButton,
    ),
    el(
      "div",
      { class: "gallery-lightbox-stage" },
      prevButton,
      el("div", { class: "gallery-lightbox-frame" }, image),
      nextButton,
    ),
    stripWrap,
  );
  const overlay = el("div", {
    class: "gallery-lightbox",
    hidden: "hidden",
    "aria-hidden": "true",
    onclick: (event) => {
      if (event.target === overlay) closeGalleryLightbox();
    },
  }, dialog);

  document.addEventListener("keydown", handleGalleryLightboxKeydown);
  document.body.appendChild(overlay);

  state.galleryLightbox = {
    overlay,
    counter,
    closeButton,
    image,
    prevButton,
    nextButton,
    strip,
    updateStripScrollButtons,
    urls: [],
    index: 0,
    lastFocused: null,
  };
  return state.galleryLightbox;
}
