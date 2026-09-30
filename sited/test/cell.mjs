// node test/cell.mjs — 生命周期、并发、失败与 alarm 确认。
import assert from "node:assert/strict";
import { BizDataCell } from "../src/cell.js";
import { invoke, parseWasmResponse, LIMITS } from "../src/host-api.js";
import { setTimeout as sleep } from "node:timers/promises";
const enc=new TextEncoder();
function fixture({failAt,alarmFail=false,returned="200:text/plain\nok"}={}) {
  const stats={loads:0,handles:0,cleanups:0,arms:[],inputs:[],events:[]};
  const state={id:{name:"test"},storage:{sql:{},async setAlarm(at){stats.arms.push(at);if(alarmFail)throw Error("alarm failed");}}};
  const cell=new BizDataCell(state,{});
  cell.loadWasm=async()=>{
    stats.loads++; await sleep(5);
    const rt={exports:null,phase:"idle",invalid:false,invocation:null};
    let next=16;
    const ex={memory:new WebAssembly.Memory({initial:128,maximum:2048}),
      alloc(len){if(failAt==="alloc")throw Error("alloc");const p=next;next+=len+8;return p;},
      dealloc(){stats.cleanups++;if(failAt==="cleanup")throw Error("cleanup");},
      handle_http(p,n){stats.handles++;stats.inputs.push(new TextDecoder().decode(new Uint8Array(ex.memory.buffer,p,n)));stats.events.push({kind:"http",attempt:rt.invocation.attemptId,input:stats.inputs.at(-1),pending:rt.invocation.pending});rt.invocation.alarmAt=1000;
        if(failAt==="handler")throw Error("trap");return enc.encode(returned).length;},
      take_response(p){if(failAt==="take")throw Error("take");const b=enc.encode(returned);new Uint8Array(ex.memory.buffer,p,b.length).set(b);return b.length;},
      handle_alarm(p,n){stats.handles++;stats.events.push({kind:"alarm",attempt:rt.invocation.attemptId,input:new TextDecoder().decode(new Uint8Array(ex.memory.buffer,p,n)),pending:rt.invocation.pending});rt.invocation.alarmAt=2000;return failAt==="alarm"?-1:0;},
    };
    rt.exports=ex;cell.runtime=rt;
  };
  return {cell,stats,state};
}
for(const failAt of ["handler","take","cleanup"]){
  const {cell,stats}=fixture({failAt});
  const res=await cell.fetch(new Request("http://test/"));
  assert.equal(res.status,500);assert.equal(stats.handles,1);assert.equal(stats.loads,1);assert.equal(stats.arms.length,0);assert.equal(cell.runtime,null);
  if(failAt!=="cleanup")assert.equal(stats.cleanups,0,"失败后不再调用 guest 清理");
}
{
  const {cell,stats}=fixture({returned:"malformed"});
  assert.equal((await cell.fetch(new Request("http://test/"))).status,500);assert.equal(stats.handles,1);assert.equal(stats.arms.length,0);
}
console.log("PASS handler/取响应/解析/清理失败不重放、不应用 alarm 意图");
{
  const {cell,stats}=fixture();
  await Promise.all(Array.from({length:5},()=>cell.ensureWasm()));assert.equal(stats.loads,1);assert.equal(cell.loading,null);
  // 模拟不能执行 finally 的硬终止遗留状态。
  cell.runtime.phase="handler";cell.runtime.invocation={pending:new Uint8Array([1])};
  assert.equal((await cell.fetch(new Request("http://test/"))).status,200);assert.equal(stats.loads,2);
  const before=stats.handles;
  for(const path of ["/__alarm","/__alarm/x","/__dispose","/__dispose/x"]){
    assert.equal((await cell.fetch(new Request("http://test"+path,{method:"POST"}))).status,404);
  }
  assert.equal(stats.handles,before);
}
{
  const {cell}=fixture();let loads=0;
  cell.loadWasm=async()=>{loads++;await sleep(5);throw Error("load failed");};
  const results=await Promise.allSettled([cell.ensureWasm(),cell.ensureWasm(),cell.ensureWasm()]);
  assert(results.every(x=>x.status==="rejected"));assert.equal(loads,1);assert.equal(cell.loading,null);
  await assert.rejects(()=>cell.ensureWasm());assert.equal(loads,2);
}
console.log("PASS 冷加载去重、失败恢复、遗留执行状态拒绝、保留路由");
{
  const {cell,stats}=fixture();let controller;
  const body=new ReadableStream({start(c){controller=c;}});
  const slow=cell.fetch(new Request("http://test/slow",{method:"POST",body,duplex:"half"}));
  await sleep(1);assert.equal(stats.loads,0);
  await cell.fetch(new Request("http://test/fast"));
  cell.runtime.phase="handler";
  controller.enqueue(enc.encode("slow body"));controller.close();
  assert.equal((await slow).status,200);assert.equal(stats.loads,2);
  assert.equal(JSON.parse(stats.inputs.at(-1)).request.body,"slow body");
}
{
  const {cell,stats}=fixture({alarmFail:true});
  assert.equal((await cell.fetch(new Request("http://test/"))).status,500);assert.equal(stats.handles,1);assert.equal(cell.runtime.phase,"idle");
  await assert.rejects(()=>cell.alarm({retryCount:0}),/Business alarm failed/);assert.equal(stats.handles,2);
}
{
  const {cell,stats}=fixture({failAt:"alarm"});
  await assert.rejects(()=>cell.alarm({retryCount:0}));assert.equal(stats.handles,1);assert.equal(stats.arms.length,0);
  await assert.rejects(()=>cell.alarm({retryCount:-1}),/Invalid alarm/);
}
console.log("PASS 慢请求不混实例、alarm 失败传播、不重放");
{
  const {cell,stats}=fixture();
  assert.equal((await cell.fetch(new Request("http://test/",{method:"POST",body:"x".repeat(LIMITS.body+1)}))).status,413);assert.equal(stats.loads,0);
  assert.equal((await cell.fetch(new Request("http://test/",{method:"POST",body:new Uint8Array([255])}))).status,400);
}
for(const status of [204,205,304]){const r=parseWasmResponse(`${status}:text/plain\nignored`);assert.equal(r.status,status);assert.equal(await r.text(),"");}
assert.equal(await parseWasmResponse("200:text/plain\nignored","HEAD").text(),"");
for(const output of ["plain","099:text/plain\nx","600:text/plain\nx","200:\nx","200:text/plain\r\nx"])assert.throws(()=>parseWasmResponse(output));
console.log("PASS 请求大小/UTF-8 与响应协议");

// 并发请求通过 await 交错，验证共享加载和事件上下文隔离。
{
  const {cell,stats}=fixture(); let stream;
  const slow=cell.fetch(new Request("http://test/slow",{method:"POST",duplex:"half",body:new ReadableStream({start(c){stream=c;}})}));
  await sleep(1);
  await cell.alarm({retryCount:2});
  stream.enqueue(enc.encode("slow payload"));stream.close();
  assert.equal((await slow).status,200);assert.equal(stats.loads,1);
  assert.deepEqual(stats.events.map(e=>e.kind),["alarm","http"]);
  assert.notEqual(stats.events[0].attempt,stats.events[1].attempt);
  assert.equal(JSON.parse(stats.events[0].input).retry_count,2);
  assert.equal(JSON.parse(stats.events[1].input).request.body,"slow payload");
  assert(stats.events.every(e=>e.pending===null));
  assert.deepEqual(stats.arms,[2000,1000]);assert.equal(cell.runtime.invocation,null);
}
{
  const {cell,stats}=fixture();const good=cell.loadWasm;let loads=0;
  cell.loadWasm=async()=>{loads++;await sleep(10);throw Error("cold load rejected");};
  const results=await Promise.allSettled([cell.fetch(new Request("http://test/")),cell.alarm({retryCount:0})]);
  assert.equal(results[0].value.status,500);assert.equal(results[1].status,"rejected");
  assert.equal(loads,1);assert.equal(stats.handles,0);assert.equal(cell.loading,null);
  cell.loadWasm=good;
  await Promise.all([cell.fetch(new Request("http://test/next")),cell.alarm({retryCount:1})]);
  assert.equal(stats.loads,1);assert.equal(stats.handles,2);assert.equal(cell.runtime.invocation,null);
}
{
  const {cell,stats,state}=fixture();let rejectFirst;
  state.storage.setAlarm=at=>{stats.arms.push(at);return at===1000?new Promise((_,no)=>{rejectFirst=no;}):Promise.resolve();};
  const waiting=cell.fetch(new Request("http://test/"));
  while(!rejectFirst)await sleep(1);
  const rt=cell.runtime;
  await cell.alarm({retryCount:0});
  rejectFirst(Error("setAlarm rejected after next event"));
  assert.equal((await waiting).status,500);assert.equal(stats.handles,2);
  assert.equal(cell.runtime,rt);assert.equal(rt.phase,"idle");assert.equal(rt.invocation,null);
  assert.deepEqual(stats.arms,[1000,2000]);
}
console.log("PASS 并发：慢 body/HTTP/alarm 交错、共享冷加载失败及恢复、迟到调度失败不污染下一事件");
console.log("PASS Alarm 调度：成功 await、调度失败传播、不重放、rearm 意图丢弃与应用");
