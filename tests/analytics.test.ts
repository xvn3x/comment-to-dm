import test from "node:test";
import assert from "node:assert/strict";
import { AnalyticsRangeError, bucketIndex, resolveRange } from "../src/server/analytics.js";

test("a single local day is split into hourly buckets that start at the requested moment", () => {
  const range = resolveRange("2026-08-18T00:00:00+05:00", "2026-08-19T00:00:00+05:00");
  assert.equal(range.unit, "hour");
  assert.equal(range.starts.length, 24);
  assert.equal(range.starts[0].toISOString(), "2026-08-17T19:00:00.000Z");
  assert.equal(range.starts[23].toISOString(), "2026-08-18T18:00:00.000Z");
});

test("longer ranges switch to daily buckets aligned with the requested day boundaries", () => {
  const range = resolveRange("2026-08-01T00:00:00+05:00", "2026-08-08T00:00:00+05:00");
  assert.equal(range.unit, "day");
  assert.equal(range.starts.length, 7);
  assert.equal(range.starts[1].toISOString(), "2026-08-01T19:00:00.000Z");
});

test("the hour/day switch happens exactly at two days", () => {
  assert.equal(resolveRange("2026-08-01T00:00:00Z", "2026-08-03T00:00:00Z").unit, "hour");
  assert.equal(resolveRange("2026-08-01T00:00:00Z", "2026-08-03T00:00:01Z").unit, "day");
});

test("buckets follow the caller's clock even with a half-hour offset", () => {
  const range = resolveRange("2026-08-18T00:00:00+05:30", "2026-08-19T00:00:00+05:30");
  assert.equal(range.starts.length, 24);
  // 09:15 in +05:30 belongs to the tenth hour of that local day, not to a UTC hour.
  assert.equal(bucketIndex(new Date("2026-08-18T09:15:00+05:30"), range), 9);
  assert.equal(bucketIndex(new Date("2026-08-18T23:59:59+05:30"), range), 23);
});

test("invalid, empty and oversized ranges are rejected instead of silently clamped", () => {
  assert.throws(() => resolveRange("not-a-date", "2026-08-18T00:00:00Z"), (error: unknown) => {
    return error instanceof AnalyticsRangeError && error.code === "invalid_range";
  });
  assert.throws(() => resolveRange("2026-08-18T00:00:00Z", "2026-08-18T00:00:00Z"), (error: unknown) => {
    return error instanceof AnalyticsRangeError && error.code === "empty_range";
  });
  assert.throws(() => resolveRange("2026-07-01T00:00:00Z", "2026-08-18T00:00:00Z"), (error: unknown) => {
    return error instanceof AnalyticsRangeError && error.code === "range_too_long";
  });
});

test("a partial last bucket is still returned so the current hour is visible", () => {
  const range = resolveRange("2026-08-18T00:00:00Z", "2026-08-18T05:20:00Z");
  assert.equal(range.starts.length, 6);
  assert.equal(range.starts[5].toISOString(), "2026-08-18T05:00:00.000Z");
});
