// node test/sql-runtime.mjs /absolute/path/to/celld
import assert from "node:assert/strict";
import { runtime } from "./runtime-support.mjs";
const r = await runtime(process.argv[2], { main: `
import { executeSql, newSqlBudget } from './sql.js';
export class BizDataCell {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const input = new Uint8Array(await req.arrayBuffer());
    return new Response(executeSql(this.state.storage, input, newSqlBudget()));
  }
}
export default { fetch(req, env) {
  if (new URL(req.url).pathname === '/') return new Response('ready');
  return env.BIZ.get(env.BIZ.idFromName('sql-test')).fetch(req);
} };
` });
const q = (query, params = []) => ({ query, params });
async function run(...queries) {
  const res = await r.request(null, "/sql", "POST", JSON.stringify({ queries }));
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}
try {
  await r.start();
  assert.equal((await run(q("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT UNIQUE)"))).ok, true);
  const text = "a'; DROP TABLE t;--\u0000中文";
  const inserted = await run(q("INSERT INTO t(v) VALUES (?) RETURNING id,v", [text]));
  assert.deepEqual(inserted.results[0].rows, [[1, text]]);
  assert.equal((await run(q("INSERT INTO t(v) VALUES ('before')"), q("SELECT * FROM missing"))).ok, false);
  assert.deepEqual((await run(q("SELECT count(*) FROM t"))).results[0].rows, [[1]]);
  console.log("PASS 参数绑定与 batch 回滚");

  // 有活动 RETURNING cursor 时超限，回滚后反复检查数据与后续事务。
  const many = "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10002) INSERT INTO t(v) SELECT 'row-'||x FROM n RETURNING id";
  const over = await run(q(many));
  assert.equal(over.error?.code, "RESULT_LIMIT", JSON.stringify(over));
  for (let i = 0; i < 5; i++) {
    const after = await run(q("SELECT count(*) FROM t"));
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.deepEqual(after.results[0].rows, [[1]]);
    assert.equal((await run(q("INSERT INTO t(v) VALUES (?)", [`after-${i}`]), q("DELETE FROM t WHERE v=?", [`after-${i}`]))).ok, true);
  }
  console.log("PASS RETURNING 提前退出、事务回滚、后续事务无部分写入");
  const valueError = await run(q("INSERT INTO t(v) VALUES ('infinity') RETURNING 9e999"));
  assert.equal(valueError.error?.code, "VALUE_ERROR");
  assert.deepEqual((await run(q("SELECT count(*) FROM t"))).results[0].rows, [[1]]);
  const blob = await run(q("SELECT ?, ?, ?, 1 AS x, 2 AS x", [{ blob: "AP8=" }, null, 1.5]));
  assert.deepEqual(blob.results[0].rows, [[{ blob: "AP8=" }, null, 1.5, 1, 2]]);
  const prefix = await run(q("INSERT INTO t(v) VALUES ('prefix'); SELECT * FROM missing"));
  assert.equal(prefix.ok, false);
  assert.deepEqual((await run(q("SELECT count(*) FROM t"))).results[0].rows, [[1]]);
  for (const sql of ["BEGIN", "SAVEPOINT x", "ATTACH DATABASE ':memory:' AS other", "SELECT * FROM _cf_KV", "SELECT load_extension('x')"]) {
    assert.equal((await run(q(sql))).ok, false, sql);
  }
  console.log("PASS 类型、编码失败回滚、多语句失败回滚、authorizer");

  const allBytes = {blob: Buffer.from(Array.from({length:256}, (_,i)=>i)).toString("base64")};
  const values = ["'\";--/*注释*/\u0000中文😀", null, {blob:""}, allBytes,
    Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.1, -1.25];
  assert.deepEqual((await run(q(`SELECT ${values.map(()=>"?").join(",")}`, values))).results[0].rows, [values]);
  for (const value of [true, [], {}, {blob:"AB=="}, {blob:"A==="}, "\ud800"]) {
    assert.equal((await run(q("SELECT ?", [value]))).error.code, "VALUE_ERROR");
  }
  for (const number of ["-0", "1e999", "-1e999"]) {
    const invalid = await r.request(null,"/sql","POST",`{"queries":[{"query":"SELECT ?","params":[${number}]}]}`);
    assert.equal(JSON.parse(invalid.body).error.code, "VALUE_ERROR");
  }
  const malformed = await r.request(null,"/sql","POST",Buffer.from([255]));
  assert.equal(JSON.parse(malformed.body).error.code,"INVALID_REQUEST");
  const large = await run(q("SELECT 9223372036854775807"));
  assert.equal(large.results[0].rows[0][0], Number("9223372036854775807"));
  assert.notEqual(BigInt(large.results[0].rows[0][0]), 9223372036854775807n, "不得伪装成无损 i64");
  console.log("PASS 绑定与类型 / Number：全部 byte、空 BLOB、Unicode、非法编码、安全整数与有损 i64");

  const shape = await run(q('SELECT 1 AS x, 2 AS x, ? AS "__proto__", ? AS "", NULL AS "中文"', [allBytes, "text"]));
  assert.deepEqual(shape.results[0], {columns:["x","x","__proto__","","中文"], rows:[[1,2,allBytes,"text",null]]});
  assert.deepEqual((await run(q('SELECT v AS "__proto__" FROM t WHERE 0'))).results[0], {columns:["__proto__"],rows:[]});
  console.log("PASS 数据结构：空结果、重复/特殊列名与位置行无损");

  const multi = await run(q("INSERT INTO t(v) VALUES('semi;colon'); SELECT ? AS last", ["last;--"]));
  assert.equal(multi.ok,true,JSON.stringify(multi));
  assert.deepEqual(multi.results, [{columns:["last"],rows:[["last;--"]]}]);
  assert.equal((await run(q("SELECT count(*) FROM t WHERE v='semi;colon'"))).results[0].rows[0][0],1);
  assert.equal((await run(q("CREATE TABLE trig(v TEXT); CREATE TABLE audit(v TEXT); CREATE TRIGGER copied AFTER INSERT ON trig BEGIN INSERT INTO audit VALUES('first;'||NEW.v); INSERT INTO audit VALUES('second;'||NEW.v); END; INSERT INTO trig VALUES (?) RETURNING v", ["bound"]))).ok,true);
  assert.deepEqual((await run(q("SELECT v FROM audit ORDER BY rowid"))).results[0].rows, [["first;bound"],["second;bound"]]);
  console.log("PASS SQL 语法：多语句、字符串分号、trigger 与最后语句绑定/结果；尾注释另见 sql-tail-runtime.mjs");

  const baseline = (await run(q("SELECT v FROM t ORDER BY id"))).results[0].rows;
  for (const bad of ["INSER INTO t(v) VALUES('bad')", "INSERT INTO t(v) VALUES('semi;colon')",
    "INSERT OR FAIL INTO t(v) VALUES('partial'),('semi;colon')"]) {
    const failed = await run(q("INSERT INTO t(v) VALUES('batch-prefix')"),q(bad));
    assert.equal(failed.ok,false); assert.equal(failed.error.code,"SQL_ERROR");
    assert.deepEqual((await run(q("SELECT v FROM t ORDER BY id"))).results[0].rows,baseline);
  }
  console.log("PASS 事务：语法错误、唯一约束和 OR FAIL 回滚已写入前缀");
} finally { await r.close(); }
