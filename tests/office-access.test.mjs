import assert from "node:assert/strict";
import test from "node:test";
import { authorizeUserAdministration, OfficeAccessError, requireOfficeProfile } from "../lib/office-access.mjs";

const id = "fictional-user-id";
function fixture({ role = "admin", profile = { id, role }, profileError = null, userError = null, user = { id }, throws = false } = {}) {
  const calls = [];
  const client = {
    auth: { getUser: async (token) => { calls.push(["verify", token]); return { data: { user }, error: userError }; } },
    from: (table) => {
      calls.push(["table", table]);
      return { select: () => ({ eq: (column, value) => {
        calls.push(["filter", column, value]);
        return { maybeSingle: async () => {
          if (throws) throw new Error("Fictional network error");
          return { data: profile, error: profileError };
        } };
      } }) };
    },
  };
  return { calls, client, factory: () => { calls.push(["client"]); return client; } };
}
const request = (value = "Bearer fictional-token") => new Request("https://example.invalid/api/users", { headers: value === null ? {} : { authorization: value } });

test("missing or malformed bearer tokens cannot initialize a privileged client", async () => {
  for (const token of [null, "", "fictional-token", "Basic abc", "Bearer", "Bearer abc def"]) {
    const f = fixture();
    assert.equal((await authorizeUserAdministration(request(token), f.factory)).response.status, 401);
    assert.deepEqual(f.calls, []);
  }
});

test("unverified sessions never reach the profile table", async () => {
  for (const options of [{ user: null }, { userError: { message: "expired" } }]) {
    const f = fixture(options);
    assert.equal((await authorizeUserAdministration(request(), f.factory)).response.status, 401);
    assert.deepEqual(f.calls, [["client"], ["verify", "fictional-token"]]);
  }
});

test("only the verified account's explicit manager profile grants administration", async () => {
  for (const role of ["admin", "supervisor"]) {
    const f = fixture({ role });
    const result = await authorizeUserAdministration(request("bearer fictional-token"), f.factory);
    assert.equal(result.adminClient, f.client);
    assert.equal(result.requesterId, id);
    assert.deepEqual(f.calls.at(-1), ["filter", "id", id]);
  }
  for (const profile of [null, { id, role: "empleado" }, { id, role: "consulta" }, { id, role: "owner" }, { id: "someone-else", role: "admin" }]) {
    const f = fixture({ profile });
    const result = await authorizeUserAdministration(request(), f.factory);
    assert.equal(result.response.status, 403);
    assert.equal(result.adminClient, undefined);
  }
});

test("profile and configuration errors fail closed without leaking internal errors", async () => {
  for (const options of [{ profileError: { message: "private fictional database detail" } }, { throws: true }]) {
    const result = await authorizeUserAdministration(request(), fixture(options).factory);
    assert.equal(result.response.status, 503);
    assert.equal(result.adminClient, undefined);
    assert.doesNotMatch(await result.response.text(), /private|fictional/);
  }
  assert.equal((await authorizeUserAdministration(request(), () => { throw new Error("service key"); })).response.status, 503);
});

test("all four approved office roles may enter; no default role or metadata can substitute for a profile", () => {
  for (const role of ["admin", "supervisor", "empleado", "consulta"]) {
    assert.equal(requireOfficeProfile({ id, role }, id).role, role);
  }
  for (const profile of [null, {}, { id }, { id, role: "ADMIN" }, { id: "other", role: "admin" }]) {
    assert.throws(() => requireOfficeProfile(profile, id), OfficeAccessError);
  }
});
