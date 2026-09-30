// 临时 celld 实例；模块和存储均位于本机临时目录。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createServer as netServer } from "node:net";
import { mkdtemp, cp, readFile, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
export const root = fileURLToPath(new URL("../", import.meta.url));
export { sleep };
const freePort = async () => {
  const s = netServer();
  await new Promise((yes, no) => { s.once("error", no); s.listen(0, "127.0.0.1", yes); });
  const port = s.address().port;
  await new Promise(yes => s.close(yes));
  return port;
};
export async function runtime(binary, { main, modules = new Map(), idle = 300, turn = 2 } = {}) {
  assert(binary, "需要 celld binary 路径");
  const dir = await mkdtemp(join(tmpdir(), "celld-"));
  await cp(join(root, "src"), join(dir, "src"), { recursive: true });
  await cp(join(root, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
  if (main) await writeFile(join(dir, "src/index.js"), main);
  const gets = new Map();
  const store = createServer((req, res) => {
    const name = req.url.slice(1).replace(/\.wasm$/, "");
    const bytes = modules.get(name);
    if (!bytes) { res.writeHead(404).end(); return; }
    if (req.method === "GET") gets.set(name, (gets.get(name) || 0) + 1);
    res.writeHead(200, { "content-type": "application/wasm", "content-length": bytes.length });
    res.end(req.method === "HEAD" ? undefined : bytes);
  });
  await new Promise((yes, no) => { store.once("error", no); store.listen(0, "127.0.0.1", yes); });
  const cellPath = join(dir, "src/cell.js");
  await writeFile(cellPath, (await readFile(cellPath, "utf8")).replace(
    "http://100.home.coooolfan.com:9000/wasm-modules", `http://127.0.0.1:${store.address().port}`));
  const port = await freePort();
  let child, log, generation = 0;
  const request = (biz, path = "/", method = "GET", body, headers = {}) => new Promise((yes, no) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method,
      headers: { host: `${biz ? biz + "." : ""}100.home.coooolfan.com`, ...headers } }, res => {
      const chunks = [];
      res.on("data", b => chunks.push(b));
      res.on("end", () => yes({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      res.on("error", no);
    });
    req.setTimeout(15000, () => req.destroy(new Error("HTTP timeout")));
    req.on("error", no); req.end(body);
  });
  const start = async () => {
    log = await open(join(dir, `dev-${++generation}.log`), "w");
    const env = { ...process.env };
    // dev 使用本地存储，不能继承生产对象存储配置。
    for (const key of Object.keys(env)) if (/^(CELLD_|AWS_|S3_)/.test(key)) delete env[key];
    child = spawn(resolve(binary), ["dev", "--port", String(port), "--logs"], {
      cwd: dir, detached: true, stdio: ["ignore", log.fd, log.fd],
      env: { ...env, CELLD_TURN_BUDGET_S: String(turn), CELLD_HANDLER_BUDGET_S: "30",
        CELLD_IDLE_EVICT_S: String(idle), CELLD_MAX_CELLS_PER_ISOLATE: "1" },
    });
    for (let i = 0; i < 120; i++) {
      assert(child.exitCode === null, `celld 意外退出：${dir}`);
      try { if ((await request(null)).status === 200) return; } catch {}
      await sleep(250);
    }
    throw new Error(`celld 启动超时：${dir}`);
  };
  const stop = async () => {
    if (!child) return;
    child.kill("SIGINT");
    for (let i = 0; i < 200 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGKILL");
      await sleep(500);
    }
    child = null; await log.close();
  };
  return { dir, port, gets, request, start, stop,
    logs: () => readFile(join(dir, `dev-${generation}.log`), "utf8"),
    async close() { await stop(); await new Promise(yes => store.close(yes)); console.log(`测试输出目录：${dir}`); },
  };
}
