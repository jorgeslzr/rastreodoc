export function findCatalogRecord(records, name) {
  const normalized = name.trim().toLocaleLowerCase("es-MX");
  return records.find((record) => record.name.trim().toLocaleLowerCase("es-MX") === normalized);
}

// Rows arrive newest first, ordered by occurred_at and id in the API query.
// Preserve the old distinction between the latest row and a nonempty receipt.
export function indexReportMovements(movements) {
  const latest = new Map();
  const receipts = new Map();
  for (const movement of movements) {
    const id = movement.documents?.id;
    if (!id) continue;
    if (!latest.has(id)) latest.set(id, movement);
    if (movement.receipt_number && !receipts.has(id)) receipts.set(id, movement.receipt_number);
  }
  return { latest, receipts };
}
