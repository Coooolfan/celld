// node test/sql-termination.mjs /absolute/path/to/celld
// 仅用公开 DO API 验证 transactionSync 被硬终止后的连接恢复。
import assert from "node:assert/strict";
import { runtime } from "./runtime-support.mjs";
const r = await runtime(process.argv[2], { turn: 1, main: `
export class BizDataCell {
  constructor(state) { this.state = state; }
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/abort') { this.state.abort('reset SQL state'); return new Response('unreachable'); }
    if (path === '/raw') { return Response.json({ok:true,result:this.state.storage.sql.exec('SELECT count(*) AS n FROM t').one()}); }
    try {
      const result = this.state.storage.transactionSync(() => {
        const sql = this.state.storage.sql;
        sql.exec('CREATE TABLE IF NOT EXISTS t(v INTEGER)').toArray();
        if (path === '/terminate') {
          sql.exec('INSERT INTO t VALUES(1)').toArray();
          const c = sql.exec('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT x FROM n');
          for (const row of c.raw()) {}
        }
        return sql.exec('SELECT count(*) AS n FROM t').one();
      });
      return Response.json({ok:true,result});
    } catch (e) { return Response.json({ok:false,error:e.message}); }
  }
}
export default { fetch(req, env) {
  if (new URL(req.url).pathname === '/') return new Response('ready');
  return env.BIZ.get(env.BIZ.idFromName('termination')).fetch(req);
} };
` });
try {
  await r.start();
  const before = await r.request(null,"/read");
  assert.equal(JSON.parse(before.body).result.n,0);
  const terminated = await r.request(null,"/terminate");
  assert.equal(terminated.status,500);
  console.log("termination:",JSON.stringify(terminated));
  const observations = [];
  for (const path of ["/read","/raw","/abort","/read","/raw"]) {
    const response = await r.request(null,path);
    observations.push({path,...response});
    console.log(path,JSON.stringify(response));
  }
  const recovered = JSON.parse(observations[3].body);
  assert.equal(recovered.ok,true,"硬终止后，公开 abort 应恢复可用的事务连接");
  assert.equal(recovered.result.n,0,"被终止的事务不得留下未提交写入");
} finally { await r.close(); }
