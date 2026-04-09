// Tests for diffFieldMaps. The function is small but its semantics are
// load-bearing: every row in listing_changes comes from here, so silent
// regressions translate directly into either spam (noisy fields leaking) or
// missed changes (over-aggressive filtering).

import { test } from "node:test";
import assert from "node:assert/strict";

import { diffFieldMaps, NOISY_FIELD_PREFIXES } from "../../src/lib/scrape.js";

function makeApolloUrl(fn) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ fn, w: [{ fn: "wg4gnqp6y1f-OTOMOTOPL", s: "16" }] })).toString("base64url");
  return `https://ireland.apollo.olxcdn.com/v1/files/${header}.${payload}.sig/image`;
}

test("diffFieldMaps emits added/removed/modified entries sorted by key", () => {
  const previous = {
    "title": "Old title",
    "price.value": "300000",
    "removed.field": "gone",
  };
  const next = {
    "title": "New title",
    "price.value": "300000",
    "added.field": "fresh",
  };
  const changes = diffFieldMaps(previous, next);
  // Must be sorted lexicographically by field_name
  const names = changes.map((c) => c.field_name);
  assert.deepEqual(names, [...names].sort());
  // added.field should be "added" (old=null, new=fresh)
  const added = changes.find((c) => c.field_name === "added.field");
  assert.deepEqual(added, { field_name: "added.field", old_value: null, new_value: "fresh" });
  // removed.field should be "removed" (old=gone, new=null)
  const removed = changes.find((c) => c.field_name === "removed.field");
  assert.deepEqual(removed, { field_name: "removed.field", old_value: "gone", new_value: null });
  // title modified
  const title = changes.find((c) => c.field_name === "title");
  assert.deepEqual(title, { field_name: "title", old_value: "Old title", new_value: "New title" });
  // unchanged price.value must NOT appear
  assert.equal(changes.find((c) => c.field_name === "price.value"), undefined);
});

test("diffFieldMaps drops every noisy prefix from output", () => {
  const previous = { "title": "Same" };
  const next = { "title": "Same" };
  // Inject a fake change under every noisy prefix on both sides — the diff
  // must still be empty.
  for (const prefix of NOISY_FIELD_PREFIXES) {
    previous[`${prefix}.x`] = "old-blob";
    next[`${prefix}.x`] = "new-blob";
    previous[prefix] = "another-old";
    next[prefix] = "another-new";
  }
  const changes = diffFieldMaps(previous, next);
  assert.equal(changes.length, 0, "noisy fields produced diff rows");
});

test("diffFieldMaps treats null and missing as equivalent", () => {
  const previous = { "a": null };
  const next = {};
  assert.deepEqual(diffFieldMaps(previous, next), []);
});

test("diffFieldMaps ignores value_added_services reorder-only transport noise", () => {
  const previous = {
    value_added_services: JSON.stringify([
      { __typename: "AdValueAddedService", appliedAt: null, exportedAdId: null, name: "topads", validity: "2026-04-12T22:16:46Z" },
      { __typename: "AdValueAddedService", appliedAt: "2026-04-05T21:16:00Z", exportedAdId: null, name: "bump_up", validity: null },
      { __typename: "AdValueAddedService", appliedAt: null, exportedAdId: "1054700195", name: "export_olx", validity: "2026-04-12T21:16:46Z" },
    ]),
  };
  const next = {
    value_added_services: JSON.stringify([
      { appliedAt: "2026-04-05T21:16:00Z", exportedAdId: null, name: "bump_up", validity: null },
      { appliedAt: null, exportedAdId: "1054700195", name: "export_olx", validity: "2026-04-12T21:16:46Z" },
      { appliedAt: null, exportedAdId: null, name: "topads", validity: "2026-04-12T22:16:46Z" },
    ]),
  };

  assert.deepEqual(diffFieldMaps(previous, next), []);
});

test("diffFieldMaps ignores ambiguous Apollo gallery URL refresh with the same count", () => {
  const previous = {
    "images.count": "3",
    "images.urls": JSON.stringify([
      makeApolloUrl("old-a-OTOMOTOPL"),
      makeApolloUrl("old-b-OTOMOTOPL"),
      makeApolloUrl("old-c-OTOMOTOPL"),
    ]),
  };
  const next = {
    "images.count": "3",
    "images.urls": JSON.stringify([
      makeApolloUrl("new-a-OTOMOTOPL"),
      makeApolloUrl("new-b-OTOMOTOPL"),
      makeApolloUrl("new-c-OTOMOTOPL"),
    ]),
  };

  assert.deepEqual(diffFieldMaps(previous, next), []);
});

test("diffFieldMaps still reports real images.urls changes for stable non-Apollo URLs", () => {
  const previous = {
    "images.count": "2",
    "images.urls": JSON.stringify([
      "https://example.invalid/photo-a.jpg",
      "https://example.invalid/photo-b.jpg",
    ]),
  };
  const next = {
    "images.count": "2",
    "images.urls": JSON.stringify([
      "https://example.invalid/photo-c.jpg",
      "https://example.invalid/photo-d.jpg",
    ]),
  };

  assert.deepEqual(diffFieldMaps(previous, next), [
    {
      field_name: "images.urls",
      old_value: previous["images.urls"],
      new_value: next["images.urls"],
    },
  ]);
});

test("diffFieldMaps handles empty inputs without crashing", () => {
  assert.deepEqual(diffFieldMaps({}, {}), []);
  assert.deepEqual(diffFieldMaps(null, null), []);
  assert.deepEqual(diffFieldMaps(undefined, { a: "1" }), [
    { field_name: "a", old_value: null, new_value: "1" },
  ]);
});
