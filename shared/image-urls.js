const APOLLO_IMAGE_PATH_RE = /^\/v1\/files\/[^/]+\/image$/;
const APOLLO_HOST_RE = /(^|\.)apollo\.olxcdn\.com$/i;

export function parseImageUrlArray(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((url) => typeof url === "string");
  }
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((url) => typeof url === "string") : null;
  } catch {
    return null;
  }
}

export function isApolloSignedImageUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    return APOLLO_HOST_RE.test(parsed.hostname) && APOLLO_IMAGE_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function diffImageUrlArrays(oldInput, newInput) {
  const oldUrls = parseImageUrlArray(oldInput);
  const newUrls = parseImageUrlArray(newInput);
  if (oldUrls == null || newUrls == null) return null;

  const oldSet = new Set(oldUrls);
  const newSet = new Set(newUrls);
  const removed = oldUrls.filter((url) => !newSet.has(url));
  const added = newUrls.filter((url) => !oldSet.has(url));

  const allUrls = [...oldUrls, ...newUrls];
  const sameCount = oldUrls.length === newUrls.length;
  const allApolloSigned = allUrls.length > 0 && allUrls.every(isApolloSignedImageUrl);
  const zeroOverlap =
    removed.length === oldUrls.length && added.length === newUrls.length;
  // OTOMOTO/Apollo can mint a fully fresh signed gallery URL set even when the
  // seller only reorders photos. In that case there is zero raw URL overlap,
  // both sides have the same photo count, and rendering it as 40 removed + 40
  // added is strictly misleading.
  //
  // Note: the JWT payload has a `fn` field that *looks* like a stable filename,
  // but observation on real data shows it rotates alongside the signature —
  // so there is no stable per-image key anywhere in the URL. Don't try to
  // decode the JWT hoping to find one.
  const ambiguousSignedRefresh = allApolloSigned && sameCount && zeroOverlap;
  // Asymmetric version: same CDN rotation happened, but the counter also
  // changed — almost certainly the seller added or removed a few photos on
  // top of a full CDN refresh. We can't tell which specific URLs are "new"
  // vs "rotated", but we can at least report the net delta instead of a
  // misleading "30 removed + 37 added" when the reality is "+7".
  const asymmetricSignedRefresh = allApolloSigned && !sameCount && zeroOverlap;
  const netDelta = newUrls.length - oldUrls.length;

  return {
    oldUrls,
    newUrls,
    removed,
    added,
    sameCount,
    allApolloSigned,
    ambiguousSignedRefresh,
    asymmetricSignedRefresh,
    netDelta,
    equivalentAfterNormalization:
      (removed.length === 0 && added.length === 0) || ambiguousSignedRefresh,
  };
}
