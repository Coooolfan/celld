// 模块校验：真实 celld 上的非法初始化/分配，不在 Node 主线程执行无限循环。
import assert from "node:assert/strict";
import { mkdtemp,readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtime,root } from "./runtime-support.mjs";
const dir=await mkdtemp(join(tmpdir(),"native-modules-"));
const built=spawnSync("cargo",["run","--quiet","--locked","--manifest-path",join(root,"tools/validate-wasm/Cargo.toml"),"--example","fixtures","--",dir],{encoding:"utf8"});
assert.equal(built.status,0,built.stderr);
const valid=await readFile(join(dir,"valid.wasm"));
const names=["invalid-version2","invalid-missing-export","invalid-unknown-import","alloc-null","alloc-oob","spin-version","spin-alloc"];
const modules=new Map([["neighbor",valid]]);
for(const name of names)modules.set(name,await readFile(join(dir,`${name}.wasm`)));
const r=await runtime(process.argv[2],{modules,turn:1});
const failures=[];
try {
  await r.start();assert.equal((await r.request("neighbor")).body,"ok");
  for(const name of names) {
    let step="首次拒绝";
    try {
      const started=Date.now();
      const rejected=await r.request(name);
      assert.equal(rejected.status,500,JSON.stringify(rejected));
      if(name.startsWith("spin"))assert(Date.now()-started>=700,"应实际运行到 watchdog 到期");
      modules.set(name,valid);
      step="下一事件恢复";
      const recovered=await r.request(name);
      assert.equal(recovered.status,200,`${name} 后的新事件：${JSON.stringify(recovered)}`);
      assert.equal(recovered.body,"ok");
      assert.equal((await r.request("neighbor")).body,"ok");
      console.log(`PASS 模块校验 ${name} 明确失败，替换合法模块后下一事件恢复，邻居正常`);
    } catch(e) {failures.push(name);console.log(`FAIL ${name} ${step}: ${e.message}`);}
  }
  assert.deepEqual(failures,[],"非法模块及恢复必须逐个通过，不可跳过失败");
} finally {await r.close();}
