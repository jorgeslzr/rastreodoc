import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { authErrorMessage, createAuthFetch, createSessionRecovery, withAuthDeadline } from "../lib/auth-recovery.mjs";

test("only a confirmed credential error is reported as an incorrect password", () => {
  assert.match(authErrorMessage({ code: "invalid_credentials", status: 400 }), /Usuario o contraseña incorrectos/);
  assert.match(authErrorMessage({ message: "Invalid login credentials" }), /Usuario o contraseña incorrectos/);
  for (const error of [{ status: 503 }, { status: 429 }, { name: "AuthRetryableFetchError" }, { name: "TimeoutError" }, new TypeError("Failed to fetch"), { message: "Unknown private server detail" }]) {
    assert.doesNotMatch(authErrorMessage(error), /contraseña incorrectos/);
    assert.doesNotMatch(authErrorMessage(error), /private server detail/);
  }
});

test("rate limits, service errors and account state have distinct useful messages", () => {
  assert.match(authErrorMessage({ status: 429 }), /Espera unos minutos/);
  assert.match(authErrorMessage({ status: 503, name: "AuthRetryableFetchError" }), /servicio de acceso/);
  assert.match(authErrorMessage({ code: "email_not_confirmed" }), /confirmar el correo/);
  assert.match(authErrorMessage({ code: "user_banned" }), /cuenta está deshabilitada/);
  assert.match(authErrorMessage({ code: "refresh_token_not_found" }, "session"), /sesión caducó/);
});

test("database writes retain their existing body, headers and caller signal", async () => {
  const controller = new AbortController();
  const init = { method: "POST", body: "fictional-write", headers: { Authorization: "fixture" }, signal: controller.signal };
  const calls = [];
  const fetchAuth = createAuthFetch(async (...args) => { calls.push(args); return "ok"; }, 1);
  const url = "https://fixture.invalid/rest/v1/rpc/save_document_operation";
  assert.equal(await fetchAuth(url, init), "ok");
  assert.equal(calls[0][0], url);
  assert.equal(calls[0][1], init);
  assert.equal(calls[0][1].signal, controller.signal);
});

test("Auth keeps request details and respects a caller abort in addition to its deadline", async () => {
  const controller = new AbortController();
  const init = { method: "POST", body: "fictional-login", headers: { apikey: "fixture" }, signal: controller.signal };
  let sent;
  await createAuthFetch(async (_input, options) => { sent = options; }, 100)("https://fixture.invalid/auth/v1/token", init);
  assert.equal(sent.body, init.body);
  assert.equal(sent.headers, init.headers);
  assert.notEqual(sent.signal, controller.signal);
  assert.equal(controller.signal.aborted, false);
  controller.abort();
  assert.equal(sent.signal.aborted, true);
});

test("an Auth deadline also aborts a response body that stops arriving", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
    response.write('{"unfinished":');
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await createAuthFetch(undefined, 500)(`http://127.0.0.1:${server.address().port}/auth/v1/token`);
  assert.equal(response.status, 200);
  await assert.rejects(response.text(), (error) => ["AbortError", "TimeoutError"].includes(error.name));
});

test("an Auth Request object retains its own abort signal", async () => {
  const controller = new AbortController();
  const request = new Request("https://fixture.invalid/auth/v1/token", { method: "POST", body: "fixture", signal: controller.signal });
  let sent;
  await createAuthFetch(async (input, init) => { assert.equal(input, request); sent = init; })(request);
  controller.abort("caller-cancelled");
  assert.equal(sent.signal.aborted, true);
  assert.equal(sent.signal.reason, "caller-cancelled");
});

test("a UI deadline ends a stalled wait without claiming a credential failure", async () => {
  await assert.rejects(withAuthDeadline(() => new Promise(() => {}), 5), (error) => {
    assert.equal(error.name, "TimeoutError");
    assert.match(authErrorMessage(error), /conexión o de tiempo de espera/);
    return true;
  });
});

function recovery(getSession, timeoutMs = 1000) {
  const state = { session: null, error: null, loading: null, changes: [] };
  const client = createSessionRecovery({ getSession, timeoutMs,
    onSession: (session) => { state.session = session; state.changes.push(session); },
    onError: (error) => { state.error = error; },
    onLoading: (loading) => { state.loading = loading; },
  });
  return { state, client };
}

test("a recovery failure releases loading and permits a successful retry", async () => {
  let calls = 0;
  const session = { user: { id: "fixture-user" } };
  const { state, client } = recovery(async () => {
    if (++calls === 1) throw new TypeError("Failed to fetch");
    return { data: { session }, error: null };
  });
  assert.equal(await client.load(), false);
  assert.equal(state.loading, false);
  assert.match(state.error, /Reintentar sesión/);
  assert.equal(await client.load(), true);
  assert.equal(state.session, session);
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
});

test("a late initial session read cannot undo a newer sign-in event", async () => {
  let finish;
  const { state, client } = recovery(() => new Promise((resolve) => { finish = resolve; }));
  const first = client.load();
  await Promise.resolve();
  const signedIn = { user: { id: "signed-in-user" } };
  client.accept(signedIn);
  finish({ data: { session: null }, error: null });
  assert.equal(await first, false);
  assert.equal(state.session, signedIn);
  assert.deepEqual(state.changes, [signedIn]);
  assert.equal(state.loading, false);
});

test("an obsolete recovery error cannot overwrite a newer successful retry", async () => {
  let failOld;
  let calls = 0;
  const session = { user: { id: "new-session" } };
  const { state, client } = recovery(() => ++calls === 1
    ? new Promise((_resolve, reject) => { failOld = reject; })
    : Promise.resolve({ data: { session }, error: null }));
  const first = client.load();
  await Promise.resolve();
  assert.equal(await client.load(), true);
  failOld(new Error("Fictional older response"));
  await first;
  assert.equal(state.session, session);
  assert.equal(state.error, null);
});

test("a timed-out recovery accepts a later valid Auth event", async () => {
  const { state, client } = recovery(() => new Promise(() => {}), 5);
  assert.equal(await client.load(), false);
  assert.equal(state.loading, false);
  assert.match(state.error, /recuperar tu sesión/);
  const session = { user: { id: "recovered-user" } };
  client.accept(session);
  assert.equal(state.session, session);
  assert.equal(state.error, null);
});

test("unmount discards a late session read and malformed responses expose a retry", async () => {
  let finish;
  const { state, client } = recovery(() => new Promise((resolve) => { finish = resolve; }));
  const pending = client.load();
  await Promise.resolve();
  client.dispose();
  finish({ data: { session: { user: { id: "stale" } } }, error: null });
  await pending;
  assert.deepEqual(state.changes, []);
  const malformed = recovery(async () => ({ data: {}, error: null }));
  assert.equal(await malformed.client.load(), false);
  assert.equal(malformed.state.loading, false);
  assert.match(malformed.state.error, /Reintentar sesión/);
});
