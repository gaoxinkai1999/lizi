import test from "node:test";
import assert from "node:assert/strict";
import { currentShift } from "../src/current-shift.js";

test("current production shift uses Shanghai time and the night shift's starting date", () => {
  for (const [instant, date, shift] of [
    ["2026-10-10T06:59:59+08:00", "2026-10-09", "night"],
    ["2026-10-10T07:00:00+08:00", "2026-10-10", "day"],
    ["2026-10-10T18:59:59+08:00", "2026-10-10", "day"],
    ["2026-10-10T19:00:00+08:00", "2026-10-10", "night"],
    ["2027-01-01T00:00:00+08:00", "2026-12-31", "night"],
    ["2028-03-01T06:00:00+08:00", "2028-02-29", "night"],
    ["2026-10-10T11:00:00Z", "2026-10-10", "night"],
  ]) {
    assert.deepEqual(currentShift(new Date(instant)), { date, shift }, instant);
  }
});
