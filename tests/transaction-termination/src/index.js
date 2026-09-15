// 同步事务终止验收；所有数据属于本测试自己的 DO。
const spin = () => { while (true) {} };
const isolateId = crypto.randomUUID();
export class TransactionCell {
  constructor(state, env) { this.state = state; this.env = env; this.leaked = null; this.cursor = null; }
  facet() {
    return this.state.facets.get("counter", () => ({
      class: this.env.LOADER.get("transaction-facet", () => ({
        mainModule: "facet.js", globalOutbound: null,
        modules: { "facet.js": `
          import { DurableObject } from "cloudflare:workers";
          export class Counter extends DurableObject {
            async fetch(req) {
              const sql = this.ctx.storage.sql;
              sql.exec("CREATE TABLE IF NOT EXISTS counter(n INTEGER)").toArray();
              if (new URL(req.url).pathname === "/write") sql.exec("INSERT INTO counter VALUES (1)").toArray();
              return Response.json(sql.exec("SELECT COUNT(*) AS n FROM counter").toArray()[0]);
            }
          }
        ` },
      })).getDurableObjectClass("Counter"),
    }));
  }
  init() {
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS entries(v TEXT)").toArray();
  }
  read() {
    return this.state.storage.transactionSync(() => ({
      rows: this.state.storage.sql.exec("SELECT v FROM entries ORDER BY rowid").toArray().map(r => r.v),
      pending: this.state.storage.kv.get("pending") ?? null,
      baseline: this.state.storage.kv.get("baseline") ?? null,
      flushed: this.state.storage.kv.get("flushed") ?? null,
    }));
  }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    this.init();
    const storage = this.state.storage;
    const write = value => storage.sql.exec("INSERT INTO entries VALUES (?)", value).toArray();
    if (path === "/facet-read") {
      return this.facet().fetch(new Request("http://facet/read"));
    } else if (path === "/terminate-facet") {
      await storage.transaction(async () => {
        const result = await this.facet().fetch(new Request("http://facet/write"));
        if (result.status !== 200 || (await result.json()).n !== 1) throw Error("facet 写入失败");
        storage.transactionSync(() => spin());
      });
    } else if (path === "/init") {
      storage.transactionSync(() => { write("committed"); storage.kv.put("baseline", "keep"); });
    } else if (path === "/ordinary-throw") {
      const error = new Error("ordinary");
      try {
        storage.transactionSync(tx => {
          write("rollback");
          tx.put("pending", "discard");
          throw error;
        });
        throw new Error("应抛出原始错误");
      } catch (e) { if (e !== error) throw e; }
    } else if (path === "/return-value") {
      const value = {};
      if (storage.transactionSync(() => value) !== value) throw Error("返回值应原样保留");
      if (storage.transactionSync(() => Promise.resolve(1)) instanceof Promise === false) throw Error("同步事务不得等待 Promise");
    } else if (path === "/nested") {
      storage.transactionSync(tx => {
        tx.sql.exec("INSERT INTO entries VALUES ('outer')").toArray();
        tx.put("baseline", "parent-pending");
        try {
          tx.transactionSync(inner => {
            inner.sql.exec("INSERT INTO entries VALUES ('inner')").toArray();
            inner.put("baseline", "child-pending");
            throw Error("inner");
          });
        } catch (e) { if (e.message !== "inner") throw e; }
        if (tx.kv.get("baseline") !== "parent-pending") throw Error("子事务回滚不能丢失父事务排队写入");
        tx.kv.put("baseline", "keep");
        tx.sql.exec("DELETE FROM entries WHERE v='outer'").toArray();
      });
    } else if (path === "/reentrant-root") {
      await storage.transaction(async outer => {
        outer.sql.exec("INSERT INTO entries VALUES ('outer')").toArray();
        try {
          await storage.transaction(async inner => {
            inner.sql.exec("INSERT INTO entries VALUES ('inner')").toArray();
            await new Promise(resolve => setTimeout(resolve, 10));
            throw Error("inner");
          });
        } catch (error) { if (error.message !== "inner") throw error; }
        storage.transactionSync(inner => {
          const rows = inner.sql.exec("SELECT v FROM entries ORDER BY rowid").toArray().map(row => row.v);
          if (JSON.stringify(rows) !== JSON.stringify(["committed", "outer"])) throw Error("根句柄重入必须使用父事务视图");
          inner.sql.exec("DELETE FROM entries WHERE v='outer'").toArray();
        });
      });
    } else if (path === "/explicit-rollback") {
      storage.transactionSync(tx => { tx.sql.exec("INSERT INTO entries VALUES ('rollback')").toArray(); tx.rollback(); });
    } else if (path === "/abort-outside") {
      this.state.abort("abort outside transaction");
    } else if (path === "/slow-async") {
      await storage.transaction(async tx => {
        tx.sql.exec("INSERT INTO entries VALUES ('async')").toArray();
        await new Promise(r => setTimeout(r, 1800));
        tx.sql.exec("DELETE FROM entries WHERE v='async'").toArray();
      });
    } else if (path === "/stale") {
      if (this.cursor) {
        // 一个预取行可以由 JS 返回，继续迭代必须失败或结束，不能恢复 native 写入。
        let returned = 0;
        try { for (const row of this.cursor.raw()) { if (++returned > 1) break; } } catch {}
        if (returned > 1) return Response.json({ error: "terminated cursor still advances" }, { status: 500 });
      }
      if (this.leaked) {
        let rejected = false;
        try { this.leaked.sql.exec("INSERT INTO entries VALUES ('stale')").toArray(); }
        catch { rejected = true; }
        if (!rejected) return Response.json({ error: "stale transaction handle accepted SQL" }, { status: 500 });
      }
    } else if (path === "/arm") {
      await storage.setAlarm(Date.now() + 300);
    } else if (path === "/future-alarm") {
      await storage.setAlarm(Date.now() + 7_200_000);
    } else if (path.startsWith("/terminate")) {
      if (path === "/terminate-resume") await new Promise(r => setTimeout(r, 20));
      if (path === "/terminate-parent-pending") storage.put("baseline", "parent-pending");
      if (path === "/terminate-async" || path === "/terminate-root-sync") {
        await storage.transaction(async tx => {
          tx.sql.exec("INSERT INTO entries VALUES ('async-parent')").toArray();
          const target = path === "/terminate-root-sync" ? storage : tx;
          target.transactionSync(inner => { inner.sql.exec("INSERT INTO entries VALUES ('inner')").toArray(); spin(); });
        });
      } else {
        storage.transactionSync(tx => {
          this.leaked = tx;
          tx.sql.exec("INSERT INTO entries VALUES ('uncommitted')").toArray();
          tx.kv.put("flushed", "discard");
          tx.setAlarm(Date.now() + 3_600_000);
          // 保持排队状态直到终止，不能被后续 setAlarm 或 SQL 隐式 flush。
          tx.put("pending", "discard");
          if (path === "/terminate-abort") this.state.abort("abort in transaction");
          if (path === "/terminate-nested") {
            tx.transactionSync(inner => { inner.sql.exec("INSERT INTO entries VALUES ('nested')").toArray(); spin(); });
          } else if (path === "/terminate-cursor") {
            const c = tx.sql.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT x FROM n");
            this.cursor = c;
            for (const row of c.raw()) {}
          } else if (path === "/terminate-returning") {
            this.cursor = tx.sql.exec("INSERT INTO entries SELECT 'r1' UNION ALL SELECT 'r2' UNION ALL SELECT 'r3' RETURNING v");
            this.cursor.next();
            spin();
          } else spin();
        });
      }
    }
    return Response.json({ ...this.read(), alarm: await storage.getAlarm() }, { headers: { "x-test-isolate": isolateId } });
  }
  async alarm(info) {
    this.init();
    const storage = this.state.storage;
    if (info.retryCount === 0) {
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO entries VALUES ('alarm-uncommitted')").toArray();
        spin();
      });
    }
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO entries SELECT 'alarm-ok' WHERE NOT EXISTS(SELECT 1 FROM entries WHERE v='alarm-ok')").toArray();
    });
  }
}
export default {
  fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ready");
    return env.CELLS.get(env.CELLS.idFromName(url.searchParams.get("cell") || "a")).fetch(req);
  },
};
