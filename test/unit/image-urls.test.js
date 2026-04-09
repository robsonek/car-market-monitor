import { test } from "node:test";
import assert from "node:assert/strict";

import { diffImageUrlArrays, isApolloSignedImageUrl, parseImageUrlArray } from "../../shared/image-urls.js";

function makeApolloUrl(fn) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ fn, w: [{ fn: "wg4gnqp6y1f-OTOMOTOPL", s: "16" }] })).toString("base64url");
  return `https://ireland.apollo.olxcdn.com/v1/files/${header}.${payload}.sig/image`;
}

test("parseImageUrlArray parses JSON arrays and rejects invalid input", () => {
  assert.deepEqual(parseImageUrlArray(JSON.stringify(["a", "b", 1, null])), ["a", "b"]);
  assert.equal(parseImageUrlArray("{"), null);
  assert.equal(parseImageUrlArray(null), null);
});

test("isApolloSignedImageUrl detects Apollo signed gallery URLs", () => {
  assert.equal(isApolloSignedImageUrl(makeApolloUrl("photo-a-OTOMOTOPL")), true);
  assert.equal(isApolloSignedImageUrl("https://example.invalid/photo-a.jpg"), false);
});

test("diffImageUrlArrays treats exact set equality as equivalent even if order differs", () => {
  const diff = diffImageUrlArrays(
    JSON.stringify(["https://example.invalid/photo-a.jpg", "https://example.invalid/photo-b.jpg"]),
    JSON.stringify(["https://example.invalid/photo-b.jpg", "https://example.invalid/photo-a.jpg"]),
  );

  assert.equal(diff?.equivalentAfterNormalization, true);
  assert.deepEqual(diff?.removed, []);
  assert.deepEqual(diff?.added, []);
});

test("diffImageUrlArrays collapses same-count Apollo signed refreshes", () => {
  const diff = diffImageUrlArrays(
    JSON.stringify([makeApolloUrl("old-a-OTOMOTOPL"), makeApolloUrl("old-b-OTOMOTOPL")]),
    JSON.stringify([makeApolloUrl("new-a-OTOMOTOPL"), makeApolloUrl("new-b-OTOMOTOPL")]),
  );

  assert.equal(diff?.ambiguousSignedRefresh, true);
  assert.equal(diff?.equivalentAfterNormalization, true);
});

test("diffImageUrlArrays flags asymmetric Apollo refreshes with positive net delta", () => {
  const diff = diffImageUrlArrays(
    JSON.stringify([
      makeApolloUrl("old-a-OTOMOTOPL"),
      makeApolloUrl("old-b-OTOMOTOPL"),
    ]),
    JSON.stringify([
      makeApolloUrl("new-a-OTOMOTOPL"),
      makeApolloUrl("new-b-OTOMOTOPL"),
      makeApolloUrl("new-c-OTOMOTOPL"),
      makeApolloUrl("new-d-OTOMOTOPL"),
    ]),
  );

  assert.equal(diff?.asymmetricSignedRefresh, true);
  assert.equal(diff?.ambiguousSignedRefresh, false);
  assert.equal(diff?.equivalentAfterNormalization, false);
  assert.equal(diff?.netDelta, 2);
});

test("diffImageUrlArrays flags asymmetric Apollo refreshes with negative net delta", () => {
  const diff = diffImageUrlArrays(
    JSON.stringify([
      makeApolloUrl("old-a-OTOMOTOPL"),
      makeApolloUrl("old-b-OTOMOTOPL"),
      makeApolloUrl("old-c-OTOMOTOPL"),
    ]),
    JSON.stringify([makeApolloUrl("new-a-OTOMOTOPL")]),
  );

  assert.equal(diff?.asymmetricSignedRefresh, true);
  assert.equal(diff?.netDelta, -2);
});

test("diffImageUrlArrays keeps real non-Apollo replacements visible", () => {
  const diff = diffImageUrlArrays(
    JSON.stringify(["https://example.invalid/photo-a.jpg"]),
    JSON.stringify(["https://example.invalid/photo-b.jpg"]),
  );

  assert.equal(diff?.equivalentAfterNormalization, false);
  assert.deepEqual(diff?.removed, ["https://example.invalid/photo-a.jpg"]);
  assert.deepEqual(diff?.added, ["https://example.invalid/photo-b.jpg"]);
});
