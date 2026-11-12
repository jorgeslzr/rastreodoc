export const OFFICE_TIME_ZONE = "America/Mexico_City";

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: OFFICE_TIME_ZONE, calendar: "gregory", numberingSystem: "latn",
  year: "numeric", month: "2-digit", day: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("es-MX", {
  timeZone: OFFICE_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// Derive a calendar date in the office's zone. Keep the original timestamp
// untouched for writes, conflict checks and elapsed-time calculations.
export function officeDateKey(value) {
  const date = validDate(value);
  if (!date) return null;
  const parts = dayFormatter.formatToParts(date);
  const part = (name) => parts.find((entry) => entry.type === name).value;
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

export function formatOfficeDateTime(value) {
  const date = validDate(value);
  return date ? timeFormatter.format(date) : "No disponible";
}

export function reportDateRangeError(start, end) {
  return start && end && start > end ? "La fecha Desde no puede ser posterior a Hasta." : null;
}

// day is a precomputed officeDateKey, so filtering never needs to reformat
// every document's timestamp while a user types in another field.
export function matchesReportDateRange(day, start = "", end = "") {
  if (reportDateRangeError(start, end)) return false;
  if (!start && !end) return true;
  if (!day) return false;
  return (!start || day >= start) && (!end || day <= end);
}
