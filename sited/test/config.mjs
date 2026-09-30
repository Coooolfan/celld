// 部署配置：根域名路由、模块目录与无效配置拒绝。
import assert from "node:assert/strict";
import router from "../src/index.js";
import { BizDataCell } from "../src/cell.js";

let routed;
const env = {
  ROOT_DOMAIN: " Apps.Example.com. ",
  BIZ: {
    idFromName(name) { return name; },
    get(id) { return { fetch() { routed = id; return new Response("ok"); } }; },
  },
};
assert.equal((await router.fetch(new Request("https://echo.apps.example.com/"), env)).status, 200);
assert.equal(routed, "echo");
assert.match(await (await router.fetch(new Request("https://apps.example.com/"), env)).text(), /\{bizId\}\.apps\.example\.com/);
routed = null;
assert.equal((await router.fetch(new Request("https://echo.other.example/api"), env)).status, 404);
assert.equal(routed, null);
for (const ROOT_DOMAIN of [undefined, "", "https://apps.example.com", "apps.example.com:8080", "apps.example.com/path", "bad..example", "-bad.example"]) {
  assert.equal((await router.fetch(new Request("https://echo.apps.example.com/"), { ...env, ROOT_DOMAIN })).status, 503);
}

const originalFetch = globalThis.fetch;
const requested = [];
globalThis.fetch = async url => { requested.push(url); return new Response(new Uint8Array([0, 97, 115, 109])); };
try {
  for (const WASM_BASE of ["https://modules.example.com/artifacts", "https://modules.example.com/artifacts/", "http://127.0.0.1:9000/artifacts///"]) {
    const cell = new BizDataCell({ id: { name: "echo" } }, { WASM_BASE });
    await cell.loadModule();
    assert.equal(requested.at(-1), `${WASM_BASE.replace(/\/+$/, "")}/echo.wasm`);
    await cell.loadModule("wasm-modules/releases/echo-v1.wasm");
    assert.equal(requested.at(-1), `${WASM_BASE.replace(/\/+$/, "")}/releases/echo-v1.wasm`);
  }
  const before = requested.length;
  for (const WASM_BASE of [undefined, "", "/modules", "file:///modules", "https://user:pass@example.com/modules", "https://example.com/modules?token=x", "https://example.com/modules#x"]) {
    await assert.rejects(() => new BizDataCell({ id: { name: "echo" } }, { WASM_BASE }).loadModule(), /WASM_BASE/);
  }
  assert.equal(requested.length, before);
} finally { globalThis.fetch = originalFetch; }
console.log("PASS configurable root domain and module service URL");
