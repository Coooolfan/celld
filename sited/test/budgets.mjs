// 预算：精确 limit/limit+1 及累计边界。storage 替身仅验证 Host 预算，不证明 native 故障恢复。
import assert from "node:assert/strict";
import { executeSql,newSqlBudget,SQL_LIMITS as S } from "../src/sql.js";
import { httpInput,invoke,makeHostImports,LIMITS as H } from "../src/host-api.js";
const enc=new TextEncoder(),dec=new TextDecoder();
const q=(query="SELECT 1",params=[])=>({query,params});
let executions=0,commits=0,rollbacks=0,rows=[[1]];
const storage={sql:{exec(){executions++;return{columnNames:["x"],raw:function*(){yield* rows;},next(){return{done:true};}};}},
  transactionSync(fn){try{const v=fn();commits++;return v;}catch(e){rollbacks++;throw e;}}};
const bytes=queries=>enc.encode(JSON.stringify({queries}));
const run=(input,budget=newSqlBudget())=>JSON.parse(dec.decode(executeSql(storage,input,budget)));
for(const [name,ok,bad] of [
  ["query bytes",bytes([q("x".repeat(S.queryBytes))]),bytes([q("x".repeat(S.queryBytes+1))])],
  ["params",bytes([q("SELECT ?",Array(S.params).fill(1))]),bytes([q("SELECT ?",Array(S.params+1).fill(1))])],
  ["batch",bytes(Array.from({length:S.batch},()=>q())),bytes(Array.from({length:S.batch+1},()=>q()))],
]) {
  assert.equal(run(ok).ok,true,name);const before=executions;
  assert.equal(run(bad).error.code,"INVALID_REQUEST",name);assert.equal(executions,before);
}
const overhead=bytes([q("SELECT ?",[""])]).length;
for(const extra of [0,1]) {
  const input=bytes([q("SELECT ?",["x".repeat(S.requestBytes-overhead+extra)])]);
  assert.equal(input.length,S.requestBytes+extra);
  assert.equal(run(input).ok,extra===0);
}
console.log("PASS 预算 SQL 输入：request/query/params/batch 均测 limit 和 limit+1");
const rowInput=bytes([q()]);
for(const n of [S.rows,S.rows+1]){rows=Array.from({length:n},()=>[1]);assert.equal(run(rowInput).ok,n===S.rows);}
const resultOverhead=JSON.stringify({ok:true,results:[{columns:["x"],rows:[[""]]}]}).length;
for(const extra of [0,1]) {
  rows=[["x".repeat(S.resultBytes-resultOverhead+extra)]];
  const before=commits;assert.equal(run(rowInput).ok,extra===0);assert.equal(commits-before,extra===0?1:0);
}
console.log("PASS 预算 SQL 输出：10,000 行与 4 MiB 编码大小精确边界；超限不提交");
rows=[[1]];
{
  const budget=newSqlBudget();
  for(let i=0;i<S.calls;i++)assert.equal(run(rowInput,budget).ok,true);
  const before=executions;assert.equal(run(rowInput,budget).error.code,"RESOURCE_LIMIT");assert.equal(executions,before);
}
{
  const budget=newSqlBudget(),batch=bytes(Array.from({length:S.batch},()=>q()));
  for(let i=0;i<S.queries/S.batch;i++)assert.equal(run(batch,budget).ok,true);
  const before=executions;assert.equal(run(rowInput,budget).error.code,"RESOURCE_LIMIT");assert.equal(executions,before);
}
{
  const budget=newSqlBudget();rows=[["x".repeat(S.resultBytes-resultOverhead)]];
  for(let i=0;i<3;i++)assert.equal(run(rowInput,budget).ok,true);
  rows=[["x".repeat(S.resultBytes-resultOverhead-1024)]];assert.equal(run(rowInput,budget).ok,true);
  assert.equal(budget.bytes,S.eventBytes-1024);
  rows=[[1]];const before=commits;assert.equal(run(rowInput,budget).error.code,"RESULT_LIMIT");assert.equal(commits,before);
  assert.equal(run(rowInput,budget).error.code,"RESOURCE_LIMIT");
}
console.log("PASS 预算 SQL 累计：128 调用、1,024 exec、16 MiB 减错误预留的实际累计执行边界");
for(const extra of [0,1]) {
  const req=new Request("http://test/",{method:"POST",body:"x".repeat(H.body+extra)});
  if(extra)await assert.rejects(()=>httpInput(req,"a"),e=>e.status===413);else await httpInput(req,"a");
}
const empty=new Request("http://test/",{headers:{"x-pad":""}});
const envelopeOverhead=(await httpInput(empty,"a")).length;
for(const extra of [0,1]) {
  const req=new Request("http://test/",{headers:{"x-pad":"x".repeat(H.input-envelopeOverhead+extra)}});
  if(extra)await assert.rejects(()=>httpInput(req,"a"),e=>e.status===413);
  else assert.equal((await httpInput(req,"a")).length,H.input);
}
for(const extra of [0,1]) {
  const n=H.response+extra;let allocs=0;
  const rt={phase:"idle",invalid:false,invocation:null,exports:{memory:new WebAssembly.Memory({initial:128,maximum:2048}),
    alloc:()=>++allocs===1?16:2*1024*1024,dealloc(){},handle_http:()=>n,
    take_response(p){const data=enc.encode("200:text/plain\n"+"x".repeat(n-15));new Uint8Array(rt.exports.memory.buffer,p,data.length).set(data);return n;}}};
  if(extra)assert.throws(()=>invoke(rt,"http",enc.encode("{}"),"a"),/response length/);
  else assert.equal((await invoke(rt,"http",enc.encode("{}"),"a").response.text()).length,n-15);
}
console.log("PASS 预算 HTTP：1 MiB body、2 MiB envelope、4 MiB response 精确边界");
const rt={phase:"handler",invalid:false,exports:{memory:new WebAssembly.Memory({initial:128,maximum:2048})},
  invocation:{pending:null,sql:newSqlBudget(),logBytes:0,alarmAt:null,attemptId:"budget"}};
const host=makeHostImports(rt,{storage,id:{name:"budget"}});
const original=console.log;let logs=0;console.log=()=>{logs++;};
try {
  for(let i=0;i<H.logEvent/H.log;i++)host.host_log(0,H.log);
  assert.throws(()=>host.host_log(0,1),/budget/);assert.equal(logs,16);
  rt.invocation.logBytes=0;assert.throws(()=>host.host_log(0,H.log+1),/budget/);
} finally {console.log=original;}
new Uint8Array(rt.exports.memory.buffer,0,rowInput.length).set(rowInput);
for(let i=0;i<S.calls;i++){const n=host.host_sql_exec(0,rowInput.length);host.host_sql_take(2048,n);}
const n=host.host_sql_exec(0,rowInput.length);host.host_sql_take(2048,n);
assert.throws(()=>host.host_sql_exec(0,rowInput.length),/budget exhausted/);
console.log("PASS 预算 Host：日志单条/累计边界、SQL 拒绝结果后继续滥用触发 ABI 终止");
