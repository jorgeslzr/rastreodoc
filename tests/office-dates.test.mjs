import assert from "node:assert/strict";
import test from "node:test";
import { formatOfficeDateTime, matchesReportDateRange, officeDateKey, reportDateRangeError } from "../lib/office-dates.mjs";

test("office days change at Mexico City midnight, not at UTC midnight", () => {
  assert.equal(officeDateKey("2026-11-12T05:59:59.999999+00:00"), "2026-11-11");
  assert.equal(officeDateKey("2026-11-12T06:00:00.000001+00:00"), "2026-11-12");
  assert.equal(officeDateKey("2026-11-12T23:59:59Z"), "2026-11-12");
});

test("day keys handle year, month and leap-day boundaries", () => {
  assert.equal(officeDateKey("2026-01-01T05:30:00Z"), "2025-12-31");
  assert.equal(officeDateKey("2026-03-01T05:30:00Z"), "2026-02-28");
  assert.equal(officeDateKey("2024-03-01T05:30:00Z"), "2024-02-29");
});

test("the IANA zone respects historical daylight saving rather than subtracting a fixed offset", () => {
  assert.equal(officeDateKey("2021-07-02T05:30:00Z"), "2021-07-02");
  assert.equal(officeDateKey("2026-07-02T05:30:00Z"), "2026-07-01");
});

test("equivalent timestamp offsets agree and an input Date keeps its original instant", () => {
  const instant = new Date("2026-11-12T05:30:00.123Z");
  const before = instant.toISOString();
  assert.equal(officeDateKey(instant), "2026-11-11");
  assert.equal(officeDateKey("2026-11-11T23:30:00.123456-06:00"), "2026-11-11");
  formatOfficeDateTime(instant);
  assert.equal(instant.toISOString(), before);
});

test("display dates use the same office day and unambiguous 24-hour times", () => {
  assert.match(formatOfficeDateTime("2026-11-12T05:30:00Z"), /11\/11\/2026.*23:30:00/);
  assert.match(formatOfficeDateTime("2026-11-12T06:00:00Z"), /12\/11\/2026.*00:00:00/);
});

test("missing or invalid timestamps never turn into a made-up epoch date", () => {
  for (const value of [null, undefined, "", "not-a-date", false, {}, NaN, Infinity, new Date("invalid")]) {
    assert.equal(officeDateKey(value), null);
    assert.equal(formatOfficeDateTime(value), "No disponible");
  }
  assert.equal(officeDateKey(0), "1969-12-31");
});

test("report boundaries include the full office day and allow open-ended ranges", () => {
  assert.equal(matchesReportDateRange("2026-11-11", "2026-11-11", "2026-11-11"), true);
  assert.equal(matchesReportDateRange("2026-11-12", "2026-11-11", "2026-11-11"), false);
  assert.equal(matchesReportDateRange("2026-11-11", "", "2026-11-11"), true);
  assert.equal(matchesReportDateRange("2026-11-12", "2026-11-12", ""), true);
  assert.equal(matchesReportDateRange(null), true);
  assert.equal(matchesReportDateRange(null, "2026-11-11", ""), false);
});

test("an inverted range reports an actionable error instead of a valid empty report", () => {
  assert.equal(reportDateRangeError("2026-11-12", "2026-11-11"), "La fecha Desde no puede ser posterior a Hasta.");
  assert.equal(matchesReportDateRange("2026-11-11", "2026-11-12", "2026-11-11"), false);
  assert.equal(reportDateRangeError("2026-11-11", "2026-11-11"), null);
  assert.equal(reportDateRangeError("2026-11-11", ""), null);
});
