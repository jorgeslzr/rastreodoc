import assert from "node:assert/strict";
import test from "node:test";
import { refreshAfterSave, scanLookupMessage } from "../lib/operation-feedback.mjs";

test("a failed report refresh preserves the previously loaded rows", async () => {
  let rows = [{ id: "existing" }];
  let warned = false;
  const ok = await refreshAfterSave(
    async () => ({ data: null, error: { message: "offline" } }),
    (data) => { rows = data; },
    () => { warned = true; },
  );
  assert.equal(ok, false);
  assert.deepEqual(rows, [{ id: "existing" }]);
  assert.equal(warned, true);
});

test("a thrown network error also preserves the report and warns", async () => {
  let updated = false;
  let warned = false;
  assert.equal(await refreshAfterSave(
    async () => { throw new TypeError("Failed to fetch"); },
    () => { updated = true; },
    () => { warned = true; },
  ), false);
  assert.equal(updated, false);
  assert.equal(warned, true);
});

test("a successful empty result really clears the report", async () => {
  let rows = [{ id: "old" }];
  assert.equal(await refreshAfterSave(
    async () => ({ data: [], error: null }),
    (data) => { rows = data; },
    () => assert.fail("Unexpected warning"),
  ), true);
  assert.deepEqual(rows, []);
});

test("QR lookup distinguishes query failure, absent document and found document", () => {
  assert.match(scanLookupMessage({ message: "offline" }, null), /No fue posible consultar/);
  assert.match(scanLookupMessage(null, null), /No encontramos un documento activo/);
  assert.equal(scanLookupMessage(null, { id: "found" }), null);
});

test("an older response cannot replace a newer report", async () => {
  let finishOld;
  let version = 1;
  let rows = [];
  const oldRefresh = refreshAfterSave(
    () => new Promise((resolve) => { finishOld = resolve; }),
    (data) => { rows = data; },
    () => assert.fail("An obsolete error must not overwrite the current notice"),
    () => version === 1,
  );
  version = 2;
  await refreshAfterSave(async () => ({ data: [{ id: "new" }], error: null }),
    (data) => { rows = data; }, () => assert.fail("Unexpected error"), () => version === 2);
  finishOld({ data: [{ id: "old" }], error: null });
  await oldRefresh;
  assert.deepEqual(rows, [{ id: "new" }]);
});
