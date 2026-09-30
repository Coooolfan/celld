// node test/abi-harness.mjs — WASM 模块、平台 Host API 与可计数 SQLite 测试适配器。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRuntime, invoke, httpInput, makeHostImports, LIMITS } from "../src/host-api.js";
import { newSqlBudget, SQL_LIMITS } from "../src/sql.js";
const enc = new TextEncoder(), dec = new TextDecoder();
const wasm = (name) => readFileSync(new URL(`../examples/${name}/target/wasm32-unknown-unknown/release/${name}_wasm.wasm`,import.meta.url));
function storage() {
  const db = new DatabaseSync(":memory:");
  const stats = [];
  return { stats, close:()=>db.close(),
    sql: {exec(query,...params){
      stats.push({query,params});
      const s = db.prepare(query);
      s.setReturnArrays(true);
      return {columnNames:s.columns().map(c=>c.name), raw:()=>s.iterate(...params)};
    }},
    transactionSync(fn) { db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;} },
  };
}
async function call(rt,path="/",method="GET",body) {
  const req = new Request("http://test"+path,{method,...(body===undefined?{}:{body})});
  const input=await httpInput(req,"test-attempt");
  return invoke(rt,"http",input,"test-attempt",method).response;
}
const s=storage();
const state={id:{name:"test"},storage:s};
try {
  const echo=createRuntime(wasm("echo"),state);
  assert.match(await(await call(echo)).text(),/<!DOCTYPE html>/);
  assert.equal(await(await call(echo,"/api/echo","POST","空格 + % & 中文 😀")).text(),"空格 + % & 中文 😀");
  assert.equal(await(await call(echo,"/run?input=a%20b")).text(),"a%20b");
  assert.equal((await call(echo,"/running")).status,404);
  assert.throws(()=>invoke(echo,"alarm",enc.encode('{"attempt_id":"a","retry_count":0}'),"a"),/Alarm handler failed/);
  assert.equal(echo.invalid,true);
  console.log("PASS 真实 echo WASM、HTTP 输入、unsupported alarm");

  const upper=createRuntime(wasm("upper"),state);
  const value="O'Reilly\"\\\n中文";
  const created=await(await call(upper,"/api/items","POST",JSON.stringify({content:value}))).json();
  assert.equal(created.content,value.toUpperCase());
  const inserts=s.stats.filter(x=>x.query.startsWith("INSERT"));
  assert.equal(inserts.length,1);assert.equal(inserts[0].params[0],value.toUpperCase());
  assert(!inserts[0].query.includes(value));
  assert.equal((await call(upper,"/api/items/nope","PUT",'{"content":"bad"}')).status,404);
  const invalid=await call(upper,"/api/items","POST","not-json");assert.equal(invalid.status,400);
  const list=await(await call(upper,"/api/items")).json();assert.equal(list.length,1);
  assert.deepEqual(await(await call(upper,`/api/items/${created.id}`)).json(),[created]);
  const updated=await(await call(upper,`/api/items/${created.id}`,"PUT",JSON.stringify({content:"updated ' 中文"}))).json();
  assert.equal(updated.content,"UPDATED ' 中文");
  assert.equal((await call(upper,"/api/items","POST",'{"content":123}')).status,400);
  assert.equal((await call(upper,`/api/items/${created.id}`,"DELETE")).status,200);
  assert.equal((await call(upper,`/api/items/${created.id}`)).status,404);
  assert.equal((await call(upper,`/api/items/${created.id}`,"DELETE")).status,404);
  assert.deepEqual(await(await call(upper,"/api/items")).json(),[]);
  console.log("PASS upper CRUD、参数绑定、JSON 转义和无效输入");

  // 直接驱动真实 Host imports，验证缓冲区协议和阶段限制。
  const rt={exports:{memory:new WebAssembly.Memory({initial:128,maximum:2048})},phase:"handler",invalid:false,
    invocation:{attemptId:"host",pending:null,sql:newSqlBudget(),logBytes:0,alarmAt:null}};
  const host=makeHostImports(rt,state);
  const input=enc.encode(JSON.stringify({queries:[{query:"SELECT ? AS x",params:["x".repeat(10000)]}]}));
  new Uint8Array(rt.exports.memory.buffer,0,input.length).set(input);
  const before=s.stats.length;
  const len=host.host_sql_exec(0,input.length);assert(len>4096);
  assert.equal(host.host_sql_take(20000,1),len);
  assert.equal(s.stats.length,before+1);
  assert.throws(()=>host.host_sql_exec(0,input.length),/must be taken/);
  assert.equal(s.stats.length,before+1);
  const out=30000;assert.equal(host.host_sql_take(out,len),len);
  assert.equal(JSON.parse(dec.decode(new Uint8Array(rt.exports.memory.buffer,out,len))).results[0].rows[0][0].length,10000);
  assert.throws(()=>host.host_sql_take(out,len),/No pending/);
  assert.equal(s.stats.length,before+1);
  console.log("PASS SQL pending/短缓冲区/take 单次执行");

  for(const phase of ["loading","version","alloc","response","cleanup","idle"]){
    rt.phase=phase;
    for(const action of [()=>host.host_now(),()=>host.host_log(0,0),()=>host.host_alarm_set_at(1n),()=>host.host_sql_exec(0,0),()=>host.host_sql_take(0,0),()=>host.host_sql_drop()])assert.throws(action,/outside handler/);
  }
  rt.phase="handler";
  assert.throws(()=>host.host_sql_exec(-1,8),/out of bounds/);
  assert.throws(()=>host.host_sql_exec(0,-1),/Invalid memory/);
  assert.equal(host.host_alarm_set_at(-1n),-1);
  assert.equal(host.host_alarm_set_at(8640000000000001n),-1);
  assert.equal(host.host_alarm_set_at(1234n),0);assert.equal(rt.invocation.alarmAt,1234);
  assert.equal(host.host_alarm_set_at(5678n),0);assert.equal(rt.invocation.alarmAt,5678);
  assert.throws(()=>host.host_log(0,LIMITS.log+1),/Log budget/);
  // memory.grow 后读取新的 buffer。
  const old=rt.exports.memory.buffer;rt.exports.memory.grow(1);assert.equal(old.byteLength,0);
  host.host_sql_exec(0,input.length);host.host_sql_drop();assert.equal(rt.invocation.pending,null);
  console.log("PASS Host 阶段、memory 范围、memory.grow、alarm 意图与日志预算");

  const exhausted={...rt,invocation:{...rt.invocation,pending:null,sql:{calls:SQL_LIMITS.calls,queries:0,bytes:0}}};
  const capped=makeHostImports(exhausted,state);const capBefore=s.stats.length;
  const n=capped.host_sql_exec(0,input.length);capped.host_sql_take(out,n);
  assert.equal(JSON.parse(dec.decode(new Uint8Array(rt.exports.memory.buffer,out,n))).error.code,"RESOURCE_LIMIT");
  assert.equal(s.stats.length,capBefore);
} finally { s.close(); }
