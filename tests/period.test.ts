import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, nextLocalMidnight, periodBounds, retentionMinDate, toDateInput, todayAnchor,
} from "../src/client/period.js";
import type { Period } from "../src/client/types.js";

const DAY_MS = 86_400_000;

function period(patch: Partial<Period> = {}): Period {
  return { kind: "today", date: "2026-08-19", from: "2026-08-13", to: "2026-08-19", ...patch };
}

test("today follows the day anchor, not the moment the tab was opened", () => {
  const bounds = periodBounds(period(), "2026-08-19");
  assert.notEqual(bounds, "invalid");
  if (typeof bounds === "string") return;
  assert.equal(bounds.from.getTime(), new Date(2026, 7, 19).getTime());
  assert.equal(bounds.to.getTime(), new Date(2026, 7, 20).getTime());
});

test("crossing local midnight shifts today, all and a range that ends today", () => {
  const before = periodBounds(period(), "2026-08-19");
  const after = periodBounds(period(), "2026-08-20");
  if (typeof before === "string" || typeof after === "string") throw new Error("bounds expected");
  assert.equal(after.from.getTime() - before.from.getTime(), DAY_MS);
  assert.equal(after.to.getTime() - before.to.getTime(), DAY_MS);

  const allBefore = periodBounds(period({ kind: "all" }), "2026-08-19");
  const allAfter = periodBounds(period({ kind: "all" }), "2026-08-20");
  if (typeof allBefore === "string" || typeof allAfter === "string") throw new Error("bounds expected");
  assert.equal(allAfter.to.getTime() - allBefore.to.getTime(), DAY_MS);
  assert.equal(allAfter.from.getTime() - allBefore.from.getTime(), DAY_MS);
  assert.equal(allAfter.from.getTime(), new Date(2026, 6, 22).getTime());

  // Пользовательский диапазон задан датами и от смены суток не зависит.
  const rangeBefore = periodBounds(period({ kind: "range" }), "2026-08-19");
  const rangeAfter = periodBounds(period({ kind: "range" }), "2026-08-20");
  assert.deepEqual(rangeBefore, rangeAfter);
});

test("the retention window and the max selectable date follow the anchor", () => {
  assert.equal(retentionMinDate("2026-08-19"), "2026-07-21");
  assert.equal(retentionMinDate("2026-08-20"), "2026-07-22");
});

test("next local midnight is calendar based, not now plus 24 hours", () => {
  const lateEvening = new Date(2026, 7, 19, 23, 30, 0, 0);
  assert.equal(nextLocalMidnight(lateEvening).getTime(), new Date(2026, 7, 20).getTime());
  assert.ok(nextLocalMidnight(lateEvening).getTime() - lateEvening.getTime() < DAY_MS);

  const earlyMorning = new Date(2026, 7, 19, 0, 5, 0, 0);
  assert.equal(nextLocalMidnight(earlyMorning).getTime(), new Date(2026, 7, 20).getTime());

  const monthEnd = new Date(2026, 7, 31, 18, 0, 0, 0);
  assert.equal(nextLocalMidnight(monthEnd).getTime(), new Date(2026, 8, 1).getTime());

  const yearEnd = new Date(2026, 11, 31, 12, 0, 0, 0);
  assert.equal(nextLocalMidnight(yearEnd).getTime(), new Date(2027, 0, 1).getTime());
});

test("the anchor is the local calendar date of the given moment", () => {
  assert.equal(todayAnchor(new Date(2026, 7, 19, 23, 59, 59)), "2026-08-19");
  assert.equal(todayAnchor(new Date(2026, 7, 20, 0, 0, 1)), "2026-08-20");
  assert.equal(toDateInput(addDays(new Date(2026, 7, 31), 1)), "2026-09-01");
});

test("invalid and oversized ranges are still refused", () => {
  assert.equal(periodBounds(period({ kind: "range", from: "2026-08-19", to: "2026-08-13" }), "2026-08-19"), "invalid");
  assert.equal(periodBounds(period({ kind: "range", from: "2026-07-01", to: "2026-08-19" }), "2026-08-19"), "too_long");
  assert.equal(periodBounds(period({ kind: "date", date: "" }), "2026-08-19"), "invalid");
  assert.equal(periodBounds(period(), ""), "invalid");
});
