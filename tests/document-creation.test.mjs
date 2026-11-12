import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentCreationClient } from "../lib/document-creation.mjs";

const record = (input) => ({ ...input, qr_token: "22222222-2222-4222-8222-222222222222", status: "EN_OFICINA", last_movement_at: "2026-11-12T10:00:00.123456Z", case_files: { number: "FICTICIO" }, document_types: { name: "CERTIFICADO" }, agencies: { name: "REGISTRO PÚBLICO" } });
const draft = { case_file_id: "case-1", document_type_id: "type-1", deed_entries: [{ folio_forma: "Original" }] };

test("a double submit creates one document while the first request is pending", async () => {
  let finish;
  let requests = 0;
  const client = createDocumentCreationClient({ newId: () => "doc-1", find: () => assert.fail(), insert: (input) => {
    requests++;
    return new Promise((resolve) => { finish = () => resolve({ data: record(input), error: null }); });
  } });
  const first = client.save(draft);
  assert.equal((await client.save(draft)).kind, "busy");
  finish();
  assert.equal((await first).kind, "saved");
  assert.equal(requests, 1);
  assert.equal(client.hasPending(), false);
});

test("a lost reply is verified by ID without repeating the insert", async () => {
  let saved;
  let inserts = 0;
  const client = createDocumentCreationClient({ newId: () => "doc-1", insert: async (input) => {
    inserts++;
    saved = record(input);
    throw new TypeError("Fictional connection loss after commit");
  }, find: async (id) => ({ data: id === saved.id ? saved : null, error: null }) });
  assert.equal((await client.save(draft)).kind, "uncertain");
  assert.equal((await client.save(draft)).kind, "uncertain");
  assert.equal((await client.verify()).kind, "saved");
  assert.equal(inserts, 1);
});

test("a pre-commit failure retries the original ID and a snapshot of the form", async () => {
  const sent = [];
  const input = structuredClone(draft);
  const client = createDocumentCreationClient({ newId: () => "doc-1", find: async () => ({ data: null, error: null }), insert: async (value) => {
    sent.push(structuredClone(value));
    return sent.length === 1 ? { data: null, error: { code: "network" } } : { data: record(value), error: null };
  } });
  assert.equal((await client.save(input)).kind, "uncertain");
  input.deed_entries[0].folio_forma = "Changed after submit";
  assert.equal((await client.verify()).kind, "saved");
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[1].deed_entries[0].folio_forma, "Original");
});

test("an insert that is still committing is resolved after its primary-key conflict", async () => {
  let stored;
  let reads = 0;
  let inserts = 0;
  const client = createDocumentCreationClient({ newId: () => "doc-1", find: async () => ({ data: ++reads === 1 ? null : stored, error: null }), insert: async (input) => {
    if (++inserts === 1) { stored = record(input); throw new TypeError("Lost reply"); }
    return { data: null, error: { code: "23505" } };
  } });
  await client.save(draft);
  assert.equal((await client.verify()).kind, "saved");
  assert.equal(stored.id, "doc-1");
  assert.equal(inserts, 2);
});

test("failed verification keeps the pending ID even if authentication has expired", async () => {
  let inserts = 0;
  const client = createDocumentCreationClient({ newId: () => "doc-1", insert: async () => { inserts++; throw new TypeError("offline"); }, find: async () => ({ data: null, error: { code: "PGRST301" } }) });
  await client.save(draft);
  assert.equal((await client.verify()).kind, "uncertain");
  assert.equal(client.hasPending(), true);
  assert.equal(inserts, 1);
});

test("a confirmed constraint rollback allows a corrected new capture", async () => {
  let sequence = 0;
  const client = createDocumentCreationClient({ newId: () => `doc-${++sequence}`, find: () => assert.fail(), insert: async (input) => sequence === 1 ? { data: null, error: { code: "23503" } } : { data: record(input), error: null } });
  assert.equal((await client.save(draft)).kind, "failed");
  assert.equal(client.hasPending(), false);
  assert.equal((await client.save(draft)).data.id, "doc-2");
});

test("an incomplete insert reply never clears the pending verification", async () => {
  const client = createDocumentCreationClient({ newId: () => "doc-1", find: () => assert.fail(), insert: async () => ({ data: { id: "doc-1" }, error: null }) });
  assert.equal((await client.save(draft)).kind, "uncertain");
  assert.equal(client.hasPending(), true);
});
