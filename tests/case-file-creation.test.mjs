import assert from "node:assert/strict";
import test from "node:test";
import { createCaseFileCreationClient } from "../lib/case-file-creation.mjs";

const missing = async () => ({ data: null, error: null });
const notCalled = () => assert.fail("Unexpected query");
const clientWith = (adapters) => createCaseFileCreationClient({ newId: () => "case-1", findById: notCalled, findByNumber: notCalled, ...adapters });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("a normal case capture trims its number and needs only one insert", async () => {
  const sent = [];
  const client = clientWith({ insert: async (input) => { sent.push(input); return { data: input }; } });
  assert.deepEqual(await client.save("  EX-001  "), { kind: "saved", data: { id: "case-1", number: "EX-001" } });
  assert.equal(sent.length, 1);
  assert.equal(client.hasPending(), false);
  assert.equal(client.isInFlight(), false);
});

test("double submission and verification share one in-flight case request", async () => {
  const held = deferred();
  let writes = 0;
  const client = clientWith({ insert: (input) => { writes++; return held.promise.then(() => ({ data: input })); } });
  const saving = client.save("EX-001");
  assert.equal((await client.save("OTHER")).kind, "busy");
  assert.equal((await client.verify()).kind, "busy");
  held.resolve();
  assert.equal((await saving).kind, "saved");
  assert.equal(writes, 1);
});

test("a lost insert reply is verified by ID without another write", async () => {
  let stored;
  let writes = 0;
  const client = clientWith({ insert: async (input) => { stored = input; writes++; throw new TypeError("Lost reply"); },
    findById: async (id) => ({ data: id === stored.id ? stored : null }) });
  assert.equal((await client.save("EX-001")).kind, "uncertain");
  assert.equal((await client.save("OTHER")).kind, "uncertain");
  assert.equal((await client.verify()).kind, "saved");
  assert.equal(writes, 1);
});

test("a pre-commit failure retries the same case ID and original number", async () => {
  const sent = [];
  const client = clientWith({ findById: missing, insert: async (input) => {
    sent.push(input);
    return sent.length === 1 ? { error: { code: "network" } } : { data: input };
  } });
  await client.save("EX-001");
  await client.save("CHANGED");
  assert.equal((await client.verify()).kind, "saved");
  assert.deepEqual(sent, [{ id: "case-1", number: "EX-001" }, { id: "case-1", number: "EX-001" }]);
});

test("an insert that finishes between verification and retry resolves its PK conflict", async () => {
  let stored;
  let reads = 0;
  let writes = 0;
  const client = clientWith({ findById: async () => ({ data: ++reads === 1 ? null : stored }), insert: async (input) => {
    if (++writes === 1) { stored = input; throw new TypeError("Lost reply"); }
    return { error: { code: "23505" } };
  } });
  await client.save("EX-001");
  assert.equal((await client.verify()).kind, "saved");
  assert.equal(writes, 2);
});

test("a number conflict selects the existing case with its stored spelling", async () => {
  const existing = { id: "older-case", number: "EX-001" };
  let lookedUp;
  const client = clientWith({ insert: async () => ({ error: { code: "23505" } }), findById: missing,
    findByNumber: async (number) => { lookedUp = number; return { data: existing }; } });
  assert.deepEqual(await client.save("ex-001"), { kind: "existing", data: existing });
  assert.equal(lookedUp, "ex-001");
  assert.equal(client.hasPending(), false);
  assert.equal((await client.verify()).kind, "empty");
});

test("a failed number lookup preserves the pending case until verification succeeds", async () => {
  let available = false;
  const sent = [];
  const client = clientWith({ insert: async (input) => { sent.push(input); return { error: { code: "23505" } }; }, findById: missing,
    findByNumber: async () => available ? { data: { id: "older-case", number: "EX-001" } } : { error: { code: "PGRST301" } } });
  assert.equal((await client.save("EX-001")).kind, "uncertain");
  available = true;
  assert.equal((await client.verify()).kind, "existing");
  assert.deepEqual(sent[0], sent[1]);
});

test("failed verification cannot drop the pending case or send a new insert", async () => {
  let writes = 0;
  const client = clientWith({ insert: async () => { writes++; throw new TypeError("Offline"); },
    findById: async () => ({ error: { code: "PGRST301" } }) });
  await client.save("EX-001");
  assert.equal((await client.verify()).kind, "uncertain");
  assert.equal(client.hasPending(), true);
  assert.equal(writes, 1);
});

test("a definitive first rollback permits a corrected capture with a new ID", async () => {
  let sequence = 0;
  const client = clientWith({ newId: () => `case-${++sequence}`, insert: async (input) => sequence === 1 ? { error: { code: "23514" } } : { data: input } });
  assert.equal((await client.save("EX-001")).kind, "failed");
  assert.equal(client.hasPending(), false);
  assert.deepEqual((await client.save("CORRECTED")).data, { id: "case-2", number: "CORRECTED" });
});

test("a denied retry cannot prove that the original uncertain insert rolled back", async () => {
  let original;
  let committed = false;
  let writes = 0;
  const client = clientWith({ insert: async (input) => {
    if (++writes === 1) { original = input; throw new TypeError("Lost reply"); }
    return { error: { code: "42501" } };
  }, findById: async () => ({ data: committed ? original : null }) });
  await client.save("EX-001");
  assert.equal((await client.verify()).kind, "uncertain");
  assert.equal(client.hasPending(), true);
  committed = true;
  assert.equal((await client.verify()).kind, "saved");
});

test("a malformed or mismatched insert response never claims a confirmed case", async () => {
  for (const data of [null, {}, { id: "wrong", number: "EX-001" }, { id: "case-1", number: "OTHER" }]) {
    const client = clientWith({ insert: async () => ({ data }) });
    assert.equal((await client.save("EX-001")).kind, "uncertain");
    assert.equal(client.hasPending(), true);
  }
});

test("a late insert reply cannot clear verification after the deadline", async () => {
  const held = deferred();
  let signal;
  const client = clientWith({ timeoutMs: 10, insert: (_input, current) => { signal = current; return held.promise; },
    findById: async () => ({ data: { id: "case-1", number: "EX-001" } }) });
  assert.equal((await client.save("EX-001")).kind, "uncertain");
  assert.equal(signal.aborted, true);
  held.resolve({ data: { id: "case-1", number: "EX-001" } });
  await new Promise(setImmediate);
  assert.equal(client.hasPending(), true);
  assert.equal((await client.verify()).kind, "saved");
});

test("a timed-out verification cannot later retry an insert after a slow read", async () => {
  const held = deferred();
  let writes = 0;
  const client = clientWith({ timeoutMs: 10, insert: async () => { writes++; throw new TypeError("Offline"); }, findById: () => held.promise });
  await client.save("EX-001");
  assert.equal((await client.verify()).kind, "uncertain");
  held.resolve({ data: null });
  await new Promise(setImmediate);
  assert.equal(writes, 1);
  assert.equal(client.hasPending(), true);
});

test("blank case numbers cannot send a query or allocate an ID", async () => {
  const client = clientWith({ insert: notCalled, newId: notCalled });
  assert.equal((await client.save("   ")).kind, "failed");
  assert.equal(client.hasPending(), false);
});
