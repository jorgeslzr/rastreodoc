import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentOperationClient, documentOperationArguments } from "../lib/document-operations.mjs";

const document = { id: "doc", status: "EN_OFICINA", label: "Original", last_movement_at: "2026-11-09T10:00:00.123456Z" };
const args = documentOperationArguments(document, { status: "ENVIADO", receiptNumber: "123" });
const response = { document: { ...document, status: "ENVIADO", last_movement_at: "2026-11-09T11:00:00.654321Z" }, duplicate: false };

test("two immediate submissions make exactly one write request", async () => {
  let finish;
  let requests = 0;
  const client = createDocumentOperationClient(() => {
    requests += 1;
    return new Promise((resolve) => { finish = resolve; });
  }, () => "operation-1");
  const first = client.save(args);
  assert.equal((await client.save(args)).kind, "busy");
  assert.equal(requests, 1);
  finish({ data: response, error: null });
  assert.equal((await first).kind, "saved");
  assert.equal(client.hasPending(), false);
});

test("a lost response is verified with the original operation ID and payload", async () => {
  const requests = [];
  const client = createDocumentOperationClient(async (request) => {
    requests.push(request);
    if (requests.length === 1) throw new TypeError("Lost response after commit");
    return { data: { ...response, duplicate: true }, error: null };
  }, () => "stable-id");
  assert.equal((await client.save(args)).kind, "uncertain");
  assert.equal((await client.save({ ...args, p_receipt_number: "different" })).kind, "pending");
  assert.equal(requests.length, 1);
  const result = await client.retry();
  assert.equal(result.kind, "saved");
  assert.equal(result.data.duplicate, true);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[1].p_operation_id, "stable-id");
});

test("a conflict is not reported as a success and allows a new reviewed operation", async () => {
  let count = 0;
  const client = createDocumentOperationClient(async () => {
    count += 1;
    return count === 1 ? { error: { code: "PT409" } } : { data: response, error: null };
  }, () => String(count));
  assert.equal((await client.save(args)).kind, "conflict");
  assert.equal(client.hasPending(), false);
  assert.equal((await client.save(args)).kind, "saved");
});

test("an expired session during verification does not erase an uncertain write", async () => {
  const requests = [];
  const client = createDocumentOperationClient(async (request) => {
    requests.push(request);
    if (requests.length === 1) throw new TypeError("Lost committed response");
    if (requests.length === 2) return { error: { code: "PGRST301" } };
    return { data: { ...response, duplicate: true }, error: null };
  }, () => "keep-this-id");
  assert.equal((await client.save(args)).kind, "uncertain");
  assert.equal((await client.retry()).kind, "uncertain");
  assert.equal(client.hasPending(), true);
  assert.equal((await client.retry()).kind, "saved");
  assert.deepEqual(requests[2], requests[0]);
});

test("SQL validation or missing migration never falls back to separate writes", async () => {
  for (const code of ["PT422", "PGRST202"]) {
    let requests = 0;
    const client = createDocumentOperationClient(async () => {
      requests += 1;
      return { error: { code } };
    }, () => "id");
    assert.equal((await client.save(args)).kind, code === "PT422" ? "invalid" : "unavailable");
    assert.equal(client.hasPending(), false);
    assert.equal(requests, 1);
  }
});

test("an incomplete success or a server error retains the original request", async () => {
  for (const result of [{ data: null, error: null }, { error: { code: "502" } }]) {
    const client = createDocumentOperationClient(async () => result, () => "id");
    assert.equal((await client.save(args)).kind, "uncertain");
    assert.equal(client.hasPending(), true);
  }
});

test("expected state preserves server timestamp precision for concurrent updates", () => {
  assert.equal(args.p_expected_movement_at, "2026-11-09T10:00:00.123456Z");
  assert.equal(args.p_expected_status, "EN_OFICINA");
  assert.equal(args.p_expected_label, "Original");
  const correction = documentOperationArguments(document, { changeLabel: true, label: "Corregida", isCorrection: true });
  assert.equal(correction.p_requested_status, null);
  assert.equal(correction.p_change_label, true);
  assert.equal(correction.p_label, "Corregida");
});
