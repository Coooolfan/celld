// node test/platform-runtime.mjs /absolute/path/to/celld
// 真实平台、WASM 与临时 celld 存储；不连接生产资源。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { runtime, root, sleep } from "./runtime-support.mjs";
const modules = new Map();
const wasm = async name => readFile(join(root, `examples/${name}/target/wasm32-unknown-unknown/release/${name}_wasm.wasm`));
const upper = await wasm("upper"), echo = await wasm("echo");
const probe = await readFile(join(root, "test/wasm-runtime-probe/target/wasm32-unknown-unknown/release/runtime_probe_wasm.wasm"));
for (const [name, bytes] of [["a",upper],["b",upper],["vote",await wasm("vote")],["probe",probe],["retry",probe]]) modules.set(name, bytes);
const r = await runtime(process.argv[2], { modules, idle: 2, turn: 2 });
async function json(biz, path = "/", method = "GET", body, status = 200, headers = {}) {
  const resp = await r.request(biz, path, method, body, headers);
  assert.equal(resp.status, status, resp.body);
  return JSON.parse(resp.body);
}
const n = (s, kind) => s.rows.find(r => r.kind === kind)?.n || 0;
const q = (query, params = []) => ({ query, params });
const sql = (...queries) => json("probe", "/sql", "POST", JSON.stringify(queries));
try {
  await r.start();
  assert.equal((await r.request("missing")).status,404);
  const input = "quote'\"\\\u0000中文";
  await json("a","/api/items","POST",JSON.stringify({content:input}),201);
  await json("b","/api/items","POST",'{"content":"beta"}',201);
  assert.deepEqual((await json("a","/api/items")).map(x=>x.content),[input.toUpperCase()]);
  assert.deepEqual((await json("b","/api/items")).map(x=>x.content),["BETA"]);
  console.log("PASS 真实 WASM、参数绑定、业务隔离");

  const initial = await json("probe");
  assert.equal(initial.version,3);
  const loaded = r.gets.get("probe");
  for (const path of ["/__dispose","/__dispose/x","/__alarm","/__alarm/x"]) {
    for (const method of ["GET","POST"]) assert.equal((await r.request("probe",path,method)).status,404);
  }
  for (const path of ["/%5f%5falarm", "/%5f%5fdispose", "/x?kind=alarm"]) {
    const s = await json("probe",path,"POST",'{"retry_count":0,"kind":"alarm"}',200,{"x-event-kind":"alarm"});
    assert.equal(n(s,"alarms"),0);
  }
  assert.equal(r.gets.get("probe"),loaded);
  console.log("PASS HTTP 无法伪造 alarm；公开 dispose 无副作用");

  await json("probe","/write","POST");
  for (const [path, count] of [["/write-trap",2],["/malformed",3],["/write-spin",4]]) {
    const prior = r.gets.get("probe");
    const start = Date.now();
    assert.equal((await r.request("probe",path)).status,500);
    const recovered = await json("probe");
    assert.equal(n(recovered,"writes"),count,JSON.stringify(recovered));
    assert.equal(recovered.calls,1,"下一事件必须使用干净 WASM instance");
    assert(r.gets.get("probe") > prior,"必须重新加载");
    assert.deepEqual((await json("b","/api/items")).map(x=>x.content),["BETA"]);
    console.log(`PASS ${path} 不重放、实例重建、SQL 保留，${Date.now()-start}ms`);
  }
  assert.equal((await r.request("probe","/head","HEAD")).body,"");
  const empty = await r.request("probe","/empty");
  assert.equal(empty.status,204); assert.equal(empty.body,"");

  const vals = [null, 1.5, 9007199254740991, {blob:"AP8="}, "'\u0000中文"];
  const values = await sql(q("SELECT ?,?,?,?,?",vals));
  assert.deepEqual(values.results[0].rows,[vals]);
  assert.equal((await sql(q("CREATE TABLE data(id INTEGER PRIMARY KEY, v TEXT UNIQUE)"))).ok,true);
  const many = await sql(q("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO data(v) SELECT 'r-'||x FROM n RETURNING id,v"));
  assert.equal(many.results[0].rows.length,2000);
  assert.deepEqual((await sql(q("SELECT count(*) FROM data"))).results[0].rows,[[2000]]);
  assert.equal((await sql(q("INSERT INTO data(v) VALUES ('prefix')"),q("SELECT * FROM missing"))).ok,false);
  assert.deepEqual((await sql(q("SELECT count(*) FROM data"))).results[0].rows,[[2000]]);
  const over = await sql(q("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10002) INSERT INTO data(v) SELECT 'large-'||x FROM n RETURNING id"));
  assert.equal(over.error.code,"RESULT_LIMIT");
  assert.deepEqual((await sql(q("SELECT count(*) FROM data"))).results[0].rows,[[2000]]);
  assert.equal((await sql(q("INSERT INTO data(v) VALUES('infinity') RETURNING 9e999"))).error.code,"VALUE_ERROR");
  assert.deepEqual((await sql(q("SELECT count(*) FROM data"))).results[0].rows,[[2000]]);
  console.log("PASS Rust SDK Number/BLOB、RETURNING 大结果一次执行、batch 与结果错误回滚");
  // 单值保持在 native SQL 限额内，用多行合计触发 Host 编码预算。
  const largeBlobs=await sql(q("SELECT zeroblob(1048576) FROM (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4)"));
  assert.equal(largeBlobs.error.code,"RESULT_LIMIT",JSON.stringify(largeBlobs));
  assert.equal((await r.request("probe","/sql","POST","x".repeat(1048577))).status,413);
  assert.deepEqual((await json("b","/api/items")).map(x=>x.content),["BETA"]);
  assert.deepEqual((await sql(q("SELECT count(*) FROM data"))).results[0].rows,[[2000]]);
  console.log("PASS 预算：真实大 BLOB 编码/HTTP 输入超限拒绝，当前业务恢复且邻居可用");
  // 有界物化触发超限后，清理超大 cursor 的 JS 循环可能被看门狗终止。
  const duringSql = await r.request("probe","/sql","POST",JSON.stringify([
    q("INSERT INTO data(v) VALUES('must-rollback')"),
    q("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT x FROM n"),
  ]));
  assert.equal(duringSql.status,500,duringSql.body);
  const afterSqlTermination = await sql(q("SELECT count(*) FROM data"));
  assert.equal(afterSqlTermination.ok,true,JSON.stringify(afterSqlTermination));
  assert.deepEqual(afterSqlTermination.results[0].rows,[[2000]]);
  console.log("PASS SQL cursor 清理期间硬终止、事务恢复与未提交写入回滚");

  // 持久化：确认上游成功响应后，代理不向客户端发送任何响应字节。
  // 同一幂等键重试及进程重启都只能看到一条已确认写入。
  assert.equal((await sql(q("CREATE TABLE delivery(id TEXT PRIMARY KEY)"))).ok,true);
  const payload=JSON.stringify([q("INSERT INTO delivery(id) VALUES(?) ON CONFLICT(id) DO NOTHING RETURNING id",["one-request"])]);
  let complete, upstreamCalls=0;
  const received=new Promise(yes=>{complete=yes;});
  const proxy=createServer((req,res)=>{
    upstreamCalls++;
    const upstream=httpRequest({hostname:"127.0.0.1",port:r.port,path:"/sql",method:"POST",headers:{host:"probe.100.home.coooolfan.com"}}, reply=>{
      const chunks=[];reply.on("data",b=>chunks.push(b));
      reply.on("end",()=>{complete({status:reply.statusCode,body:Buffer.concat(chunks).toString()});res.destroy();});
      reply.on("error",e=>{complete({error:e.message});res.destroy();});
    });
    upstream.on("error",e=>{complete({error:e.message});res.destroy();});
    req.pipe(upstream);
  });
  await new Promise(yes=>proxy.listen(0,"127.0.0.1",yes));
  try {
    await assert.rejects(()=>new Promise((yes,no)=>{
      const client=httpRequest({hostname:"127.0.0.1",port:proxy.address().port,path:"/",method:"POST"},yes);
      client.on("error",no);client.setTimeout(10000,()=>client.destroy(Error("timeout")));client.end(payload);
    }),/socket hang up/);
    const upstream=await received;assert.equal(upstream.status,200,JSON.stringify(upstream));
    assert.deepEqual(JSON.parse(upstream.body).results[0].rows,[["one-request"]]);assert.equal(upstreamCalls,1);
  } finally {await new Promise(yes=>proxy.close(yes));}
  assert.deepEqual((await json("probe","/sql","POST",payload)).results[0].rows,[]);
  assert.deepEqual((await sql(q("SELECT id FROM delivery"))).results[0].rows,[["one-request"]]);
  console.log("PASS 持久化：SQL 提交并收到上游成功响应后丢弃客户端响应，同幂等键重试不重复写入");

  await json("retry","/arm-retry","POST");
  let retried;
  for (let i=0;i<40;i++) {
    await sleep(250); retried=await json("retry");
    if(n(retried,"attempts")>=2) break;
  }
  assert.equal(n(retried,"attempts"),2,JSON.stringify(retried));
  assert.equal(n(retried,"alarms"),1);
  console.log("PASS alarm 失败重试、失败 rearm 意图丢弃、业务唯一键幂等");

  // 模块通过闲置驱逐重载，不使用公开管理接口。
  modules.set("a",echo);
  await sleep(9000);
  assert.equal((await r.request("a","/run?input=hello")).body,"hello");
  modules.set("a",upper);
  await sleep(9000);
  assert.deepEqual((await json("a","/api/items")).map(x=>x.content),[input.toUpperCase()]);
  console.log("PASS 闲置驱逐、替换模块、SQLite 保留");

  await json("vote","/api/vote","POST",'{"option":"APPLE"}',201);
  await r.stop(); await r.start();
  assert.deepEqual((await json("b","/api/items")).map(x=>x.content),["BETA"]);
  assert.equal(n(await json("probe"),"writes"),4);
  assert.deepEqual((await sql(q("SELECT id FROM delivery"))).results[0].rows,[["one-request"]]);
  assert.equal(n(await json("retry"),"alarms"),1,"成功 alarm 确认后重启不能重复计入");
  let fired=false;
  for(let i=0;i<80;i++) {
    if((await r.logs()).includes("vote [alarm]: periodic stats — total votes: 1")){fired=true;break;}
    await sleep(1000);
  }
  assert(fired,"重启后 alarm 应主动唤醒业务");
  assert.equal((await json("vote","/api/results")).total,1);
  console.log("PASS 进程重启、持久化数据与 alarm 主动唤醒");
} finally { await r.close(); }
