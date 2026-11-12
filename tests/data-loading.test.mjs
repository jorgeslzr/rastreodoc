import assert from "node:assert/strict";
import test from "node:test";
import { dataLoadErrorMessage, loadCompleteData } from "../lib/data-loading.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("all required reads run together and publish one complete ordered result", async () => {
  const last = deferred();
  const started = [];
  let published = false;
  const loading = loadCompleteData([
    () => { started.push("cases"); return { data: [{ id: "case" }] }; },
    () => { started.push("documents"); return last.promise; },
    () => { started.push("catalog"); return { data: [] }; },
  ]).then((result) => { published = true; return result; });
  await Promise.resolve();
  assert.deepEqual(started, ["cases", "documents", "catalog"]);
  assert.equal(published, false);
  last.resolve({ data: [{ id: "document" }] });
  assert.deepEqual(await loading, [[{ id: "case" }], [{ id: "document" }], []]);
});

test("one failed query rejects the whole read and cancels stalled siblings", async () => {
  let siblingSignal;
  const failure = { code: "503", message: "Fictional service failure" };
  const loading = loadCompleteData([
    () => ({ data: [{ id: "partial" }] }),
    () => ({ data: null, error: failure }),
    (signal) => { siblingSignal = signal; return new Promise(() => {}); },
  ]);
  await assert.rejects(loading, (error) => error === failure);
  assert.equal(siblingSignal.aborted, true);
});

test("an incomplete response cannot be mistaken for a legitimately empty table", async () => {
  for (const data of [null, undefined, {}, "", 0]) {
    await assert.rejects(loadCompleteData([() => ({ data })]), /Incomplete/);
  }
  assert.deepEqual(await loadCompleteData([() => ({ data: [], error: null })]), [[]]);
});

test("a thrown network error also cancels the remaining reads", async () => {
  let signal;
  await assert.rejects(loadCompleteData([
    () => { throw new TypeError("Fictional network failure"); },
    (current) => { signal = current; return new Promise(() => {}); },
  ]), /network failure/);
  assert.equal(signal.aborted, true);
});

test("the deadline releases a read even if its SDK ignores cancellation", async () => {
  const late = deferred();
  let requestSignal;
  const published = [];
  const loading = loadCompleteData([(signal) => {
    requestSignal = signal;
    return late.promise;
  }], { timeoutMs: 10 }).then((data) => published.push(data));
  await assert.rejects(loading, { name: "TimeoutError" });
  assert.equal(requestSignal.aborted, true);
  late.resolve({ data: [{ id: "late" }] });
  await new Promise(setImmediate);
  assert.deepEqual(published, []);
});

test("a canceled older load cannot replace a successful fresh retry", async () => {
  const controller = new AbortController();
  const old = deferred();
  const published = [];
  const first = loadCompleteData([() => old.promise], { signal: controller.signal })
    .then((data) => published.push(data));
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  const fresh = await loadCompleteData([() => ({ data: [{ id: "fresh" }] })]);
  published.push(fresh);
  old.resolve({ data: [{ id: "obsolete" }] });
  await new Promise(setImmediate);
  assert.deepEqual(published, [[[{ id: "fresh" }]]]);
});

test("a load canceled before starting never sends a query", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  await assert.rejects(loadCompleteData([() => { requests++; return { data: [] }; }], {
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(requests, 0);
});

test("load errors give a retry action without exposing server details", () => {
  assert.match(dataLoadErrorMessage({ name: "TimeoutError" }), /tardando.*Reintentar carga/);
  for (const error of [null, new Error("private SQL detail"), { status: 403, message: "private key" }]) {
    assert.equal(dataLoadErrorMessage(error), "No se pudo cargar la información completa. Revisa tu conexión y pulsa Reintentar carga.");
  }
});
