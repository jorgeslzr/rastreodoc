import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentDeletionClient } from "../lib/document-deletion.mjs";

const document = { id: "archived-doc", label: null, archived_at: "2026-11-13T02:00:00.123456Z", last_movement_at: "2026-11-12T23:00:00.654321Z" };
const confirmed = (input) => ({ data: { document_id: input.p_document_id, operation_id: input.p_operation_id, deleted: true } });
const options = { newId: () => "request-id", timeoutMs: 1000 };

test("active documents and missing confirmation never produce a delete request", async () => {
  let calls = 0;
  const client = createDocumentDeletionClient(async () => { calls++; }, options);
  assert.equal((await client.remove({ ...document, archived_at: null }, "ELIMINAR")).kind, "failed");
  assert.equal((await client.remove(document, "eliminar")).kind, "failed");
  assert.equal(calls, 0);
  assert.equal(client.hasPending(), false);
});

test("immediate double submission sends one deletion with exact timestamps", async () => {
  let release, input;
  const client = createDocumentDeletionClient((args) => { input = args; return new Promise((resolve) => { release = resolve; }); }, options);
  const first = client.remove(document, "ELIMINAR");
  await Promise.resolve();
  assert.equal((await client.remove(document, "ELIMINAR")).kind, "busy");
  assert.equal(input.p_expected_archived_at, document.archived_at);
  assert.equal(input.p_expected_movement_at, document.last_movement_at);
  release(confirmed(input));
  assert.equal((await first).kind, "deleted");
  assert.equal(client.hasPending(), false);
});

test("a lost reply retains the same operation and payload for verification", async () => {
  const requests = [];
  const client = createDocumentDeletionClient(async (input) => {
    requests.push(input);
    if (requests.length === 1) throw new Error("connection lost after commit");
    return confirmed(input);
  }, options);
  assert.equal((await client.remove(document, "ELIMINAR")).kind, "uncertain");
  assert.equal(client.hasPending(), true);
  assert.equal((await client.remove({ ...document, id: "other" }, "ELIMINAR")).kind, "uncertain");
  assert.equal((await client.verify()).kind, "deleted");
  assert.deepEqual(requests[0], requests[1]);
  assert.equal((await client.verify()).kind, "empty");
});

test("a known rollback on the first request releases the operation", async () => {
  for (const code of ["PT409", "PT422", "42501", "PGRST202"]) {
    const client = createDocumentDeletionClient(async () => ({ error: { code } }), options);
    assert.equal((await client.remove(document, "ELIMINAR")).kind, code === "PT409" ? "conflict" : "failed");
    assert.equal(client.hasPending(), false);
  }
});

test("an expired session or conflict on verification does not undo proof of the original uncertain deletion", async () => {
  const requests = [];
  const client = createDocumentDeletionClient(async (input) => {
    requests.push(input);
    if (requests.length < 4) return { error: { code: ["503", "PGRST301", "PT409"][requests.length - 1] } };
    return confirmed(input);
  }, options);
  assert.equal((await client.remove(document, "ELIMINAR")).kind, "uncertain");
  assert.equal((await client.verify()).kind, "uncertain");
  assert.equal((await client.verify()).kind, "uncertain");
  assert.equal(client.hasPending(), true);
  assert.equal((await client.verify()).kind, "deleted");
  for (const request of requests) assert.deepEqual(request, requests[0]);
});

test("a timeout releases the spinner but a late response cannot clear pending verification", async () => {
  let release;
  const requests = [];
  const client = createDocumentDeletionClient((input) => {
    requests.push(input);
    return requests.length === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(confirmed(input));
  }, { ...options, timeoutMs: 10 });
  assert.equal((await client.remove(document, "ELIMINAR")).kind, "uncertain");
  assert.equal(client.isInFlight(), false);
  release(confirmed(requests[0]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.hasPending(), true);
  assert.equal((await client.verify()).kind, "deleted");
  assert.deepEqual(requests[0], requests[1]);
});

test("malformed and mismatched confirmations never report success", async () => {
  for (const response of [null, { deleted: true }, { document_id: "other", operation_id: "request-id", deleted: true }, { document_id: document.id, operation_id: "other", deleted: true }]) {
    const client = createDocumentDeletionClient(async () => ({ data: response }), options);
    assert.equal((await client.remove(document, "ELIMINAR")).kind, "uncertain");
    assert.equal(client.hasPending(), true);
  }
});
