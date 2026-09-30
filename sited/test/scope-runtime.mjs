// node test/scope-runtime.mjs /absolute/path/to/celld
// 在真实 namespace 中验证 SCOPE 格式、确定性与重启稳定性。
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtime } from "./runtime-support.mjs";

const r = await runtime(process.argv[2]);
try {
  const configPath = join(r.dir, "wrangler.jsonc");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.vars.CELLD_OPENAPI_TOKEN = "scope-test";
  config.vars.WASM_BASE = "";
  await writeFile(configPath, JSON.stringify(config));
  await r.start();
  const query = async biz => {
    const response = await r.request(biz, "/__inner__/scope", "GET", undefined, { authorization: "Bearer scope-test" });
    assert.equal(response.status, 200, response.body);
    const value = JSON.parse(response.body);
    assert.equal(value.bizId, biz);
    assert.match(value.scope, /^BizDataCell:[0-9a-f]{64}$/);
    return value.scope;
  };
  assert.equal((await r.request("echo", "/__inner__/scope")).status, 401);
  const scope = await query("echo");
  assert.equal(await query("echo"), scope);
  assert.notEqual(await query("another-biz"), scope);
  await r.stop();
  await r.start();
  assert.equal(await query("echo"), scope);
  console.log("PASS runtime SCOPE format, deterministic mapping and restart stability without WASM configuration");
} finally { await r.close(); }
