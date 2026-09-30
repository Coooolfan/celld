// node test/sql.mjs — SQL Host 请求、类型、预算与错误协议。
import assert from "node:assert/strict";
import { executeSql, newSqlBudget, SQL_LIMITS as L } from "../src/sql.js";
const enc=new TextEncoder(),dec=new TextDecoder();
const query=(query="SELECT 1",params=[])=>({query,params});
function fixture(rows=[[1]],options={}) {
  const stats={calls:0,commits:0,rollbacks:0,reads:0};
  const storage={
    sql:{exec(){stats.calls++;if(options.execError)throw Error("diagnostic SQL failure");return {
      columnNames:options.columns||["x"],
      raw:function*(){for(const row of rows){stats.reads++;yield row;}},
      next(){return {done:true};},
    };}},
    transactionSync(fn){try{const result=fn();if(options.commitError)throw Error("commit failed");stats.commits++;return result;}catch(e){stats.rollbacks++;if(options.rollbackError)throw Error("rollback failed");throw e;}},
  };
  return {stats,storage};
}
function run(storage,request,budget=newSqlBudget()) {
  return JSON.parse(dec.decode(executeSql(storage,request instanceof Uint8Array?request:enc.encode(JSON.stringify(request)),budget)));
}
const f=fixture();
for(const request of [null,{},[],{queries:[]},{queries:Array.from({length:129},()=>query())},{queries:[{query:"SELECT 1"}]},{queries:[query("x".repeat(L.queryBytes+1))]},{queries:[query("SELECT ?",Array(101).fill(0))]}]) {
  assert.equal(run(f.storage,request).error.code,"INVALID_REQUEST");
}
assert.equal(f.stats.calls,0);
for(const value of [true,[],{}, {blob:"A==="}, {blob:"AB=="}, {blob:"AA==",other:1}, "\ud800"]){
  assert.equal(run(f.storage,{queries:[query("SELECT ?",[value])]}).error.code,"VALUE_ERROR");
}
assert.equal(run(f.storage,new Uint8Array([255])).error.code,"INVALID_REQUEST");
assert.equal(run(f.storage,new Uint8Array(L.requestBytes+1)).error.code,"INVALID_REQUEST");
assert.equal(f.stats.calls,0);
console.log("PASS 严格请求 schema、UTF-8、Base64、参数类型与输入上限");
for(const value of [NaN,Infinity,-Infinity,-0,{},true]){
  const f=fixture([[value]]);
  assert.equal(run(f.storage,{queries:[query()]}).error.code,"VALUE_ERROR");assert.equal(f.stats.commits,0);assert.equal(f.stats.rollbacks,1);
}
{
  const vals=[null,1.5,Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER,"\u0000中文",new Uint8Array([0,255]),new ArrayBuffer(0)];
  const f=fixture([vals],{columns:["x","x","a","b","__proto__","blob","empty"]});
  const r=run(f.storage,{queries:[query()]});
  assert.deepEqual(r.results[0].rows,[[null,1.5,Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER,"\u0000中文",{blob:"AP8="},{blob:""}]]);
}
{
  const f=fixture(Array.from({length:L.rows},()=>[1]));assert.equal(run(f.storage,{queries:[query()]}).ok,true);
  const over=fixture(Array.from({length:L.rows+1},()=>[1]));assert.equal(run(over.storage,{queries:[query()]}).error.code,"RESULT_LIMIT");assert.equal(over.stats.commits,0);
}
{
  const f=fixture([["x".repeat(L.resultBytes)]]);assert.equal(run(f.storage,{queries:[query()]}).error.code,"RESULT_LIMIT");assert.equal(f.stats.rollbacks,1);
}
for(const [name,budget] of [["calls",{calls:L.calls,queries:0,bytes:0}],["queries",{calls:0,queries:L.queries,bytes:0}],["bytes",{calls:0,queries:0,bytes:L.eventBytes-1023}]]){
  const f=fixture();assert.equal(run(f.storage,{queries:[query()]},budget).error.code,"RESOURCE_LIMIT",name);assert.equal(f.stats.calls,0);
}
{
  const f=fixture([["x".repeat(2048)]]);const budget={calls:0,queries:0,bytes:L.eventBytes-2048};
  assert.equal(run(f.storage,{queries:[query()]},budget).error.code,"RESULT_LIMIT");assert.equal(f.stats.commits,0);
}
console.log("PASS 结果类型、行/字节边界、每事件累计预算");
for(const options of [{execError:true},{commitError:true},{execError:true,rollbackError:true}]){
  const f=fixture([[1]],options);const r=run(f.storage,{queries:[query()]});
  assert.equal(r.error.code,"SQL_ERROR");assert(!('outcome' in r.error));assert(!('retryable' in r.error));assert.equal(f.stats.calls,1);
  assert.equal(r.error.query_index,options.execError?0:null);
}
console.log("PASS 执行/commit/rollback 错误传播；无原生错误码或重试保证");
