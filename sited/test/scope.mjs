// SCOPE 查询的鉴权、方法限制与无激活契约。
import assert from "node:assert/strict";
import router from "../src/index.js";

const id = "0123456789abcdef".repeat(4);
const names = [];
const env = {
  ROOT_DOMAIN: "platform.test",
  CELLD_OPENAPI_TOKEN: "admin-test",
  BIZ: {
    idFromName(name) { names.push(name); return { toString: () => id }; },
    get() { throw new Error("scope query must not create a cell stub"); },
  },
};
function request(method = "GET", token = "admin-test") {
  return new Request("https://echo.platform.test/__inner__/scope", {
    method,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}
for (let i = 0; i < 2; i++) {
  const response = await router.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { bizId: "echo", scope: `BizDataCell:${id}` });
}
assert.deepEqual(names, ["echo", "echo"]);
names.length = 0;
for (const token of [null, "wrong", ""]) {
  assert.equal((await router.fetch(request("GET", token), env)).status, 401);
}
for (const CELLD_OPENAPI_TOKEN of [undefined, ""]) {
  assert.equal((await router.fetch(request(), { ...env, CELLD_OPENAPI_TOKEN })).status, 401);
}
for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
  const response = await router.fetch(request(method), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
}
assert.deepEqual(names, []);
console.log("PASS scope query authentication, method restrictions and no cell activation");
