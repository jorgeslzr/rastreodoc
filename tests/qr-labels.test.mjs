import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import { createQrImageCache, generateQrDataUrl, QR_IMAGE_OPTIONS, buildQrPrintHtml } from "../lib/qr-labels.mjs";
import { findCatalogRecord, indexReportMovements } from "../lib/office-lookups.mjs";

test("preview and print share a pending image and failed generation can be retried", async () => {
  let calls = 0;
  const cache = createQrImageCache(async () => {
    if (++calls === 1) throw new Error("Fictional rendering failure");
    return "image-A";
  });
  const first = cache.get("A");
  assert.equal(cache.get("A"), first);
  await assert.rejects(first);
  assert.equal(await cache.get("A"), "image-A");
  assert.equal(await cache.get("A"), "image-A");
  assert.equal(calls, 2);
});

test("image reuse is specific to the token and bounded by least-recent use", async () => {
  const calls = [];
  const cache = createQrImageCache(async (token) => { calls.push(token); return `image-${token}`; }, 2);
  await cache.get("A"); await cache.get("B"); await cache.get("A"); await cache.get("C");
  assert.equal(await cache.get("A"), "image-A");
  assert.equal(await cache.get("B"), "image-B");
  assert.deepEqual(calls, ["A", "B", "C", "B"]);
});

test("generated QR content and image settings match the previous label format", async () => {
  const token = "12345678-1234-4234-8234-123456789abc";
  const original = await QRCode.toDataURL(`RDOC:${token}`, { width: 420, margin: 1, errorCorrectionLevel: "H" });
  assert.deepEqual(QR_IMAGE_OPTIONS, { width: 420, margin: 1, errorCorrectionLevel: "H" });
  assert.equal(await generateQrDataUrl(token), original);
  await assert.rejects(generateQrDataUrl(undefined));
});

test("print page escapes its title and includes every supplied label", () => {
  const html = buildQrPrintHtml({ title: '<script>"Ficticio"</script>', styles: "@page{size:40mm 30mm}", labels: ['<section id="label-1"></section>', '<section id="label-2"></section>'] });
  assert.ok(html.includes("&lt;script&gt;&quot;Ficticio&quot;&lt;/script&gt;"));
  assert.ok(html.includes('id="label-1"') && html.includes('id="label-2"'));
});

test("catalog lookup preserves accents and compares case/outer whitespace", () => {
  const records = [{ id: "1", name: "TESORERÍA MUNICIPAL" }];
  assert.equal(findCatalogRecord(records, "  tesorería municipal ").id, "1");
  assert.equal(findCatalogRecord(records, "TESORERIA MUNICIPAL"), undefined);
  assert.equal(findCatalogRecord(records, "OTRA"), undefined);
});

test("receipt indexes preserve latest-first history, empty receipts and missing documents", () => {
  const movements = [
    { id: 5, receipt_number: "", documents: { id: "A" } },
    { id: 4, receipt_number: "B-new", documents: { id: "B" } },
    { id: 3, receipt_number: "A-old", documents: { id: "A" } },
    { id: 2, receipt_number: "B-old", documents: { id: "B" } },
    { id: 1, receipt_number: "Deleted", documents: null },
  ];
  const { latest, receipts } = indexReportMovements(movements);
  assert.equal(latest.get("A").id, 5);
  assert.equal(receipts.get("A"), "A-old");
  assert.equal(latest.get("B").id, 4);
  assert.equal(receipts.get("B"), "B-new");
  assert.equal(latest.size, 2);
  assert.equal(latest.get("not-in-history"), undefined);
});
