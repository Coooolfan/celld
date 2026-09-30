// 每业务一个 DO：模块缓存、可信事件分发和调用生命周期。
import { createRuntime, httpInput, invoke, InputError, readLimitedBody, LIMITS } from "./host-api.js";
const MODULE_CONFIG = "__celld_module";
class ModuleMissingError extends Error {}
const validModule = value => typeof value === "string" && value.startsWith("wasm-modules/") && !value.includes("..") && !value.includes("\\") && !value.endsWith("/");
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const wasmBase = env => {
  let url;
  try { url = new URL(typeof env?.WASM_BASE === "string" ? env.WASM_BASE.trim() : ""); } catch { throw new Error("WASM_BASE must be configured as an HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("WASM_BASE must be an HTTP(S) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
};

export class BizDataCell {
  constructor(state, env) { this.state = state; this.env = env; this.runtime = null; this.loading = null; this.loadingPhase = "idle"; this.lastError = null; }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__inner__/status" || url.pathname === "/__inner__/action/publish") {
      if (req.headers.get("x-celld-inner-request") !== "1") return new Response("not found", { status: 404 });
      return url.pathname.endsWith("/status") ? this.status() : this.publish(req);
    }
    const first = url.pathname.split("/").filter(Boolean)[0];
    if (first === "__alarm" || first === "__dispose") return new Response("not found", { status: 404 });
    const attempt = crypto.randomUUID();
    try { return await this.dispatch("http", await httpInput(req, attempt), attempt, req.method); }
    catch (e) {
      if (e instanceof ModuleMissingError) return new Response(`business not found: ${this.state.id.name}`, { status: 404 });
      if (e instanceof InputError) return new Response(e.message, { status: e.status });
      console.log(`[biz:${this.state.id.name}:${attempt}] HTTP invocation failed`);
      return new Response("Business execution failed", { status: 500 });
    }
  }

  async alarm(info) {
    if (!Number.isSafeInteger(info?.retryCount) || info.retryCount < 0) throw new Error("Invalid alarm metadata");
    const attempt = crypto.randomUUID();
    try { await this.dispatch("alarm", new TextEncoder().encode(JSON.stringify({ attempt_id: attempt, retry_count: info.retryCount })), attempt); }
    catch { console.log(`[biz:${this.state.id.name}:${attempt}] alarm invocation failed`); throw new Error("Business alarm failed"); }
  }

  async dispatch(kind, input, attempt, method) {
    if (this.runtime && (this.runtime.invalid || this.runtime.phase !== "idle")) this.runtime = null;
    if (!this.runtime) await this.ensureWasm();
    const rt = this.runtime;
    let result;
    try { result = invoke(rt, kind, input, attempt, method); }
    catch (e) { if (this.runtime === rt) this.runtime = null; throw e; }
    if (result.alarmAt !== null) await this.state.storage.setAlarm(result.alarmAt);
    return result.response;
  }

  async status() {
    const config = await this.state.storage.get(MODULE_CONFIG);
    const lastError = this.lastError || config?.lastError || null;
    return json(200, {
      bizId: this.state.id.name,
      status: lastError ? "error" : (config?.module ? "ready" : "empty"),
      moduleHash: config?.sha256 || null,
      moduleSize: Number.isSafeInteger(config?.size) ? config.size : null,
      loaded: Boolean(this.runtime),
      lastError,
      module: config?.module || null,
    });
  }

  async publish(req) {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body; try { body = await req.json(); } catch { return json(400, { error: "invalid JSON" }); }
    if (!validModule(body?.module) || !/^[a-f0-9]{64}$/.test(body.sha256 || "") || !Number.isSafeInteger(body.size) || body.size < 0 || body.size > LIMITS.module) return json(400, { error: "invalid module" });
    try {
      const bytes = await this.loadModule(body.module);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const actual = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
      if (actual !== body.sha256 || bytes.byteLength !== body.size) return json(422, { error: "module hash or size mismatch" });
      createRuntime(bytes, this.state);
      await this.state.storage.put(MODULE_CONFIG, { module: body.module, sha256: body.sha256, size: body.size, lastError: null });
      this.runtime = null;
      this.lastError = null;
      return json(200, { bizId: this.state.id.name, status: "ready", module: body.module, moduleHash: body.sha256, moduleSize: body.size, loaded: false, lastError: null });
    } catch { return json(422, { error: "module rejected" }); }
  }

  async loadModule(module) {
    const key = module || `wasm-modules/${this.state.id.name}.wasm`;
    if (!validModule(key)) throw new Error("invalid module");
    const resp = await fetch(`${wasmBase(this.env)}/${key.slice("wasm-modules/".length)}`);
    if (resp.status === 404) throw new ModuleMissingError("WASM module not found");
    if (!resp.ok) throw new Error("WASM download failed");
    return readLimitedBody(resp.body, LIMITS.module);
  }

  async ensureWasm() {
    if (this.runtime) return;
    if (this.loadingPhase === "instantiate") this.loading = null;
    if (!this.loading) {
      this.loadingPhase = "download";
      const loading = this.loadWasm().finally(() => { if (this.loading === loading) { this.loading = null; this.loadingPhase = "idle"; } });
      this.loading = loading;
    }
    await this.loading;
  }

  async loadWasm() {
    const config = await this.state.storage.get(MODULE_CONFIG);
    this.loadingPhase = "instantiate";
    try {
      this.runtime = createRuntime(await this.loadModule(config?.module), this.state);
      this.lastError = null;
      if (config?.lastError) await this.state.storage.put(MODULE_CONFIG, { ...config, lastError: null });
      console.log(`[biz:${this.state.id.name}] Host runtime ready`);
    } catch (e) {
      const message = e instanceof ModuleMissingError ? "module not found" : "module load failed";
      this.lastError = message;
      if (config) await this.state.storage.put(MODULE_CONFIG, { ...config, lastError: message });
      throw e;
    }
  }
}
