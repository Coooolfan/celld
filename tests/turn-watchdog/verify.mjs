// 用法：node verify.mjs /absolute/path/to/celld [max_cells=32]
// 独立临时目录、单 Tokio 线程；退出时仅清理本测试创建的进程组。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, cp, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const binary = resolve(process.argv[2]);
const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CELLD_|AWS_|S3_)/.test(key)));
const maxCells = process.argv[3] || "32";
const dir = await mkdtemp(join(tmpdir(), "celld-watchdog-"));
const fixture = fileURLToPath(new URL(".", import.meta.url));
await cp(join(fixture, "src"), join(dir, "src"), { recursive: true });
await cp(join(fixture, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
const log = await open(join(dir, "dev.log"), "w");
const port = 19876;
const base = `http://127.0.0.1:${port}`;
// 启动前检查端口，防止误把已有服务当作测试进程。
const net = await import("node:net");
await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => server.close(resolve));
});
const child = spawn(binary, ["dev", "--port", String(port), "--logs"], {
  cwd: dir, detached: true, stdio: ["ignore", log.fd, log.fd],
  env: { ...testEnv, CELLD_TOKIO_THREADS: "1",
    CELLD_MAX_CELLS_PER_ISOLATE: maxCells, CELLD_TURN_BUDGET_S: "1", CELLD_HANDLER_BUDGET_S: "30" },
});
const request = (path, timeout = 7000) => fetch(base + path, { signal: AbortSignal.timeout(timeout) });
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`celld exited: ${child.exitCode}`);
    try { ready = (await request("/health", 500)).status === 200; } catch {}
    if (ready) break;
    await sleep(250);
  }
  assert(ready, "服务应启动成功");
  assert.equal((await request("/write")).status, 200);
  assert.equal((await request("/write?biz=neighbor")).status, 200);
  assert.deepEqual(await (await request("/facet-write")).json(), { n: 1 });
  assert.deepEqual(await (await request("/facet-ping?biz=neighbor")).json(), { n: 0 });
  assert.equal(await (await request("/facet-egress")).text(), "denied");
  const waiting = performance.now();
  assert.deepEqual(await (await request("/wait")).json(), { n: 1 });
  assert(performance.now() - waiting >= 1400, "异步等待超过 turn budget 仍应成功");
  console.log(`PASS max_cells=${maxCells} 异步等待 1.5s 不计入同步 turn budget`);
  for (const path of ["/inline-spin", "/async-spin", "/wasm-spin", "/loaded-spin", "/router-spin", "/router-async-spin", "/facet-spin", "/facet-async-spin"]) {
    const start = performance.now();
    const response = await request(path);
    const body = await response.text();
    const elapsed = performance.now() - start;
    assert.equal(response.status, 500, `${path}: ${body}`);
    assert(elapsed < 6000, `${path}: 应在 turn 超时后立即失败，不等待 30s handler budget`);
    assert(elapsed >= 800, `${path}: 死循环必须实际执行至预算到期`);
    for (let i = 0; i < 10; i++) {
      assert.equal((await request("/health")).status, 200);
      assert.deepEqual(await (await request("/ping")).json(), { n: 1 });
      assert.deepEqual(await (await request("/ping?biz=neighbor")).json(), { n: 1 });
      assert.deepEqual(await (await request("/facet-ping")).json(), { n: 1 });
      assert.deepEqual(await (await request("/facet-ping?biz=neighbor")).json(), { n: 0 });
    }
    console.log(`PASS max_cells=${maxCells} ${path} 500 ${elapsed.toFixed(0)}ms；后续请求与持久化正常`);
  }
  const burst = performance.now();
  const responses = await Promise.all([
    ...Array.from({ length: 4 }, (_, i) => request(`/inline-spin?biz=burst${i}`, 15000)),
    request("/ping?biz=neighbor", 15000),
  ]);
  for (const response of responses.slice(0, 4)) assert.equal(response.status, 500);
  assert.deepEqual(await responses[4].json(), { n: 1 });
  assert.deepEqual(await (await request("/ping")).json(), { n: 1 });
  console.log(`PASS max_cells=${maxCells} 四个并发失控请求与正常请求全部收敛 ${Math.round(performance.now() - burst)}ms`);
  console.log(`日志：${dir}/dev.log`);
} catch (error) {
  console.error((await readFile(join(dir, "dev.log"), "utf8")).slice(-14000));
  throw error;
} finally {
  // 节点处于独立进程组，监督器收尾最多等待 35 秒。
  // 给监督器时间关闭节点，不能在 500ms 后杀掉监督器留下孤儿节点。
  try { process.kill(child.pid, "SIGINT"); } catch {}
  for (let attempt = 0; attempt < 400 && child.exitCode === null && child.signalCode === null; attempt++) {
    await sleep(100);
  }
  assert(child.exitCode !== null || child.signalCode !== null, "dev 监督器应完成节点清理并退出");
  await log.close();
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
