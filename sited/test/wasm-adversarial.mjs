// Host 阶段、不重放、实例恢复、模块校验：真实 WAT/WASM + 实际 Host + SQLite。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createRuntime, invoke } from "../src/host-api.js";
import { BizDataCell } from "../src/cell.js";
const root=fileURLToPath(new URL("../",import.meta.url));
export const dir=mkdtempSync(join(tmpdir(),"wasm-matrix-"));
const manifest=join(root,"tools/validate-wasm/Cargo.toml");
for(const args of [["run","--locked","--quiet","--manifest-path",manifest,"--example","fixtures","--",dir],
  ["build","--locked","--quiet","--manifest-path",manifest]]) {
  const child=spawnSync("cargo",args,{encoding:"utf8"});
  assert.equal(child.status,0,child.stderr);
}
const validator=join(root,"tools/validate-wasm/target/debug/validate-wasm");
const wasm=name=>readFileSync(join(dir,`${name}.wasm`));
const input=new TextEncoder().encode('{}');
const db=new DatabaseSync(":memory:"); db.exec("CREATE TABLE audit(v INTEGER)");
let executions=0, alarms=0;
const storage={
  sql:{exec(query,...params){executions++;const s=db.prepare(query);s.setReturnArrays(true);
    return {columnNames:s.columns().map(c=>c.name),raw:()=>s.iterate(...params)};}},
  transactionSync(fn){db.exec("BEGIN");try{const result=fn();db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}},
  async setAlarm(){alarms++;},
};
const state={id:{name:"matrix"},storage};
try {
  for(const phase of ["start","version","alloc-in","alloc-out","take","dealloc"]) {
    for(const host of ["log","now","alarm","sql","take","drop"]) {
      const name=`phase-${phase}-${host}`;
      if(phase==="start")assert.equal(spawnSync(validator,[join(dir,`${name}.wasm`)]).status,1);
      assert.throws(()=>{
        const rt=createRuntime(wasm(name),state);
        invoke(rt,"http",input,name);
      },/Host call outside handler/,name);
      assert.equal(executions,0);assert.equal(alarms,0);
    }
  }
  console.log("PASS Host 阶段：36 个真实 WASM 的 start/version/输入输出 alloc/take/dealloc × 六类 Host 均拒绝，SQL/alarm 零副作用");
  for(const name of ["missing-export","wrong-signature","wrong-kind","missing-memory-export","no-maximum","large-maximum",
    "shared","multiple-memories","memory64","unknown-import","wrong-namespace","wrong-import-signature"]) {
    const result=spawnSync(validator,[join(dir,`invalid-${name}.wasm`)],{encoding:"utf8"});
    assert.equal(result.status,1,`${name}: ${result.stdout} ${result.stderr}`);
    console.log(`PASS 模块校验 拒绝 ${name}`);
  }
  assert.equal(spawnSync(validator,[join(dir,"valid.wasm")]).status,0);
  assert.throws(()=>createRuntime(wasm("invalid-version2"),state),/Unsupported ABI version/);
  console.log("PASS 模块校验：合法签名通过；错误 ABI version 在加载时拒绝；初始化 start 在发布校验拒绝");
  for(const failure of ["trap","take","parse","cleanup"]) {
    const before=executions;
    const cell=new BizDataCell(state,{});let loads=0;let old;
    cell.loadWasm=async()=>{
      cell.runtime=createRuntime(wasm(loads++===0?`write-${failure}`:"write-pending"),state);
      old??=cell.runtime;
    };
    const r=await cell.fetch(new Request("http://test/"));
    assert.equal(r.status,500);assert.equal(executions,before+1);assert.equal(loads,1);
    assert.equal(cell.runtime,null);assert.equal(old.invocation,null);assert.equal(old.invalid,true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit").get().n,executions);
    assert.equal((await cell.fetch(new Request("http://test/next"))).status,200);
    assert.notEqual(cell.runtime,old);assert.equal(loads,2);assert.equal(executions,before+2);
    assert.equal(cell.runtime.invocation,null);
    console.log(`PASS 不重放 / 实例恢复：真实 WASM 写入后 ${failure} 失败恰好写一次；下一事件新实例且已提交写入保留`);
  }
  // 未 take 的 pending 不能进入下一事件，即使复用成功的 WASM instance。
  const rt=createRuntime(wasm("write-pending"),state);
  for(const attempt of ["first","second"]) {
    assert.equal(invoke(rt,"http",input,attempt).response.status,200);
    assert.equal(rt.invocation,null);assert.equal(rt.phase,"idle");
  }
  console.log("PASS 实例恢复：成功事件未消费的 SQL pending 清理，下一事件上下文独立");
} finally {db.close();console.log(`WASM 夹具目录：${dir}`);}
