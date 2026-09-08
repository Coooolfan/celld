// node verify.mjs /absolute/path/to/celld [max_cells=32]
// 临时本地存储、loopback 监听；不访问生产资源。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, open } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
assert(process.argv[2], "需要 celld binary 路径");
const binary = resolve(process.argv[2]);
const maxCells = process.argv[3] || "32";
const dir = await mkdtemp(join(tmpdir(), "celld-transaction-termination-"));
const fixture = fileURLToPath(new URL(".", import.meta.url));
await cp(join(fixture, "src"), join(dir, "src"), { recursive: true });
await cp(join(fixture, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
const server = createServer();
await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
const port = server.address().port;
await new Promise(yes => server.close(yes));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(CELLD_|AWS_|S3_)/.test(key)) delete env[key];
let child, log, generation = 0;
const request = (path, cell = "a") => fetch(`${base}${path}?cell=${cell}`, { signal: AbortSignal.timeout(9000) });
const isolates = new Map();
const read = async (path = "/read", cell = "a") => {
  const r = await request(path, cell); const text = await r.text();
  assert.equal(r.status, 200, text);
  assert(r.headers.has("x-test-isolate"));
  isolates.set(cell, r.headers.get("x-test-isolate"));
  return JSON.parse(text);
};
const expected = { rows: ["committed"], pending: null, baseline: "keep", flushed: null, alarm: null };
async function start() {
  log = await open(join(dir, `dev-${++generation}.log`), "w");
  child = spawn(binary, ["dev", "--port", String(port), "--logs"], {
    cwd: dir, detached: true, stdio: ["ignore", log.fd, log.fd],
    env: { ...env, CELLD_TOKIO_THREADS: "1", CELLD_TURN_BUDGET_S: "1",
      CELLD_HANDLER_BUDGET_S: "30", CELLD_MAX_CELLS_PER_ISOLATE: maxCells },
  });
  for (let i = 0; i < 120; i++) {
    assert(child.exitCode === null, "celld 意外退出");
    try { if ((await request("/health")).status === 200) return; } catch {}
    await sleep(250);
  }
  throw Error("celld 启动超时");
}
async function stop() {
  if (!child) return;
  child.kill("SIGINT");
  for (let i = 0; i < 400 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  assert(child.exitCode !== null || child.signalCode !== null, "dev 进程应清理并退出");
  child = null; await log.close();
  const probe = createServer();
  await new Promise((yes, no) => { probe.once("error", no); probe.listen(port, "127.0.0.1", yes); });
  await new Promise(yes => probe.close(yes));
}
try {
  await start();
  for (const cell of ["a", "b"]) assert.deepEqual(await read("/init", cell), expected);
  if (maxCells === "32") assert.equal(isolates.get("a"), isolates.get("b"), "必须实际共用 isolate");
  if (maxCells === "1") assert.notEqual(isolates.get("a"), isolates.get("b"), "必须实际分属 isolate");
  for (const path of ["/ordinary-throw", "/return-value", "/nested", "/explicit-rollback", "/slow-async"]) {
    assert.deepEqual(await read(path), expected);
  }
  console.log(`PASS max_cells=${maxCells} 普通异常/嵌套/显式回滚与异步事务`);
  // 邻居事务可以跨 await 存活，另一个 cell 的终止不能回滚它。
  for (const path of ["/terminate", "/terminate-resume", "/terminate-nested", "/terminate-cursor", "/terminate-returning", "/terminate-abort", "/terminate-async"]) {
    const neighbor = read("/slow-async", "b");
    await sleep(100);
    const began = performance.now();
    const r = await request(path); const body = await r.text();
    assert.equal(r.status, 500, `${path}: ${body}`);
    if (path !== "/terminate-abort") assert(performance.now() - began >= 700, "应实际运行至预算到期");
    assert.deepEqual(await neighbor, expected);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await read(), expected, path);
      assert.deepEqual(await read("/read", "b"), expected, path);
    }
    assert.deepEqual(await read("/stale"), expected, "已终止的事务句柄/游标不得继续写入");
    console.log(`PASS max_cells=${maxCells} ${path}；SQL/KV/alarm 回滚、邻居与已提交数据保留`);
  }
  assert.deepEqual(await read("/init", "parent"), expected);
  const parent = await read("/future-alarm", "parent");
  parent.baseline = "parent-pending";
  assert.equal((await request("/terminate-parent-pending", "parent")).status, 500);
  assert.deepEqual(await read("/read", "parent"), parent);
  console.log(`PASS max_cells=${maxCells} 事务外排队 KV 与此前已提交 alarm 保留`);
  const aborted = await request("/abort-outside"); assert.equal(aborted.status, 500);
  assert.deepEqual(await read(), expected);
  await read("/arm");
  let alarm;
  for (let i = 0; i < 40; i++) {
    await sleep(250); alarm = await read();
    if (alarm.rows.includes("alarm-ok")) break;
  }
  assert.deepEqual(alarm, { ...expected, rows: ["committed", "alarm-ok"] });
  console.log(`PASS max_cells=${maxCells} alarm 同步事务终止后重试`);
  await stop(); await start();
  assert.deepEqual(await read(), { ...expected, rows: ["committed", "alarm-ok"] });
  assert.deepEqual(await read("/read", "b"), expected);
  assert.deepEqual(await read("/read", "parent"), parent);
  console.log(`PASS max_cells=${maxCells} 进程重启仅恢复已提交状态`);
} finally {
  await stop();
  console.log(`证据目录：${dir}`);
}
