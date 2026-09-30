// Host ABI。每个 runtime 拥有独立内存、Host 闭包和事件上下文。
import { executeSql, newSqlBudget, SQL_LIMITS } from "./sql.js";
export const LIMITS = Object.freeze({ body: 1024 * 1024, input: 2 * 1024 * 1024,
  response: 4 * 1024 * 1024, module: 16 * 1024 * 1024, memory: 128 * 1024 * 1024,
  log: 4096, logEvent: 64 * 1024 });
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
export class AbiError extends Error {}
export class InputError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const requireAbi = (condition, message) => { if (!condition) throw new AbiError(message); };
const REQUIRED = ["abi_version", "alloc", "dealloc", "handle_http", "handle_alarm", "take_response"];
const IMPORTS = ["host_log", "host_now", "host_alarm_set_at", "host_sql_exec", "host_sql_take", "host_sql_drop"];

function range(rt, ptr, len) {
  requireAbi(Number.isInteger(ptr) && Number.isInteger(len) && len >= 0 && len <= 0x7fffffff, "Invalid memory range");
  const p = ptr >>> 0;
  const buffer = rt.exports.memory.buffer;
  requireAbi(buffer.byteLength <= LIMITS.memory && p <= buffer.byteLength && len <= buffer.byteLength - p, "Memory range out of bounds");
  return new Uint8Array(buffer, p, len);
}
const active = rt => {
  requireAbi(rt.phase === "handler" && rt.invocation !== null && !rt.invalid, "Host call outside handler");
  return rt.invocation;
};

export function makeHostImports(rt, state) {
  return {
    host_log(ptr, len) {
      const ctx = active(rt);
      const bytes = range(rt, ptr, len);
      requireAbi(len <= LIMITS.log && ctx.logBytes + len <= LIMITS.logEvent, "Log budget exceeded");
      ctx.logBytes += len;
      console.log(`[wasm:${state.id.name}:${ctx.attemptId}] ${dec.decode(bytes)}`);
    },
    host_now() { active(rt); return BigInt(Date.now()); },
    host_alarm_set_at(at) {
      const ctx = active(rt);
      if (typeof at !== "bigint" || at < 0n || at > 8640000000000000n) return -1;
      ctx.alarmAt = Number(at);
      return 0;
    },
    host_sql_exec(ptr, len) {
      const ctx = active(rt);
      requireAbi(ctx.pending === null, "SQL result must be taken or dropped before exec");
      // 超大但合法的输入由 SQL 层拒绝；不得先复制不受限的 guest 缓冲区。
      ctx.pending = executeSql(state.storage, range(rt, ptr, len), ctx.sql);
      requireAbi(ctx.sql.calls <= SQL_LIMITS.calls + 1 && ctx.sql.bytes <= SQL_LIMITS.eventBytes, "SQL event budget exhausted");
      const reply = JSON.parse(dec.decode(ctx.pending));
      if (!reply.ok) console.log(JSON.stringify({ biz: state.id.name, attempt_id: ctx.attemptId,
        sql_call: ctx.sql.calls, query_index: reply.error.query_index, code: reply.error.code }));
      return ctx.pending.length;
    },
    host_sql_take(ptr, cap) {
      const ctx = active(rt);
      requireAbi(ctx.pending !== null, "No pending SQL result");
      range(rt, ptr, cap);
      const bytes = ctx.pending;
      if (cap < bytes.length) return bytes.length;
      range(rt, ptr, bytes.length).set(bytes);
      ctx.pending = null;
      return bytes.length;
    },
    host_sql_drop() { active(rt).pending = null; },
  };
}

export function createRuntime(bytes, state) {
  requireAbi(bytes.byteLength <= LIMITS.module, "WASM module too large");
  const module = new WebAssembly.Module(bytes);
  for (const imp of WebAssembly.Module.imports(module)) {
    requireAbi(imp.module === "celld_v3" && imp.kind === "function" && IMPORTS.includes(imp.name), "Unsupported WASM import");
  }
  const rt = { exports: null, instance: null, invocation: null, phase: "loading", invalid: false };
  rt.instance = new WebAssembly.Instance(module, { celld_v3: makeHostImports(rt, state) });
  rt.exports = rt.instance.exports;
  for (const name of REQUIRED) requireAbi(typeof rt.exports[name] === "function", `Missing export: ${name}`);
  requireAbi(rt.exports.memory instanceof WebAssembly.Memory, "Missing memory");
  requireAbi(!(typeof SharedArrayBuffer !== "undefined" && rt.exports.memory.buffer instanceof SharedArrayBuffer), "Shared memory unsupported");
  requireAbi(rt.exports.memory.buffer.byteLength <= LIMITS.memory, "WASM memory too large");
  requireAbi(rt.exports.abi_version() === 3, "Unsupported ABI version");
  rt.phase = "idle";
  return rt;
}

export async function readLimitedBody(body, max) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        void reader.cancel().catch(() => {});
        throw new InputError(413, "Payload too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function httpInput(req, attemptId) {
  const url = new URL(req.url);
  let body = "";
  if (req.method !== "GET" && req.method !== "HEAD") {
    const bytes = await readLimitedBody(req.body, LIMITS.body);
    try { body = dec.decode(bytes); } catch { throw new InputError(400, "Body must be UTF-8"); }
  }
  const headers = Object.fromEntries(req.headers);
  const bytes = enc.encode(JSON.stringify({ context: { attempt_id: attemptId }, request: {
    method: req.method, path: url.pathname + url.search, headers, body,
  } }));
  if (bytes.length > LIMITS.input) throw new InputError(413, "Request envelope too large");
  return bytes;
}

export function parseWasmResponse(output, method = "GET") {
  const nl = output.indexOf("\n");
  const colon = output.indexOf(":");
  requireAbi(nl > 0 && colon === 3 && colon < nl && /^[2-5][0-9]{2}$/.test(output.slice(0, colon)), "Malformed HTTP response");
  const status = Number(output.slice(0, colon));
  const type = output.slice(colon + 1, nl);
  requireAbi(type.length > 0 && type.length <= 1024 && !/[\r\n\0]/.test(type), "Invalid content type");
  return new Response(method === "HEAD" || [204, 205, 304].includes(status) ? null : output.slice(nl + 1), {
    status, headers: { "content-type": type },
  });
}

// 这个函数不可含 await。异常后不再调用 guest，执行中标记在硬终止后仍可检测。
export function invoke(rt, kind, bytes, attemptId, method = "GET") {
  requireAbi(rt.phase === "idle" && !rt.invalid && rt.invocation === null, "Runtime is not idle");
  requireAbi(bytes.length > 0 && bytes.length <= LIMITS.input, "Invalid input size");
  const ctx = { attemptId, pending: null, sql: newSqlBudget(), alarmAt: null, logBytes: 0 };
  rt.invocation = ctx;
  rt.phase = "alloc";
  try {
    const ex = rt.exports;
    const inPtr = ex.alloc(bytes.length);
    requireAbi(inPtr !== 0, "Input allocation failed");
    range(rt, inPtr, bytes.length).set(bytes);
    rt.phase = "handler";
    const n = kind === "http" ? ex.handle_http(inPtr, bytes.length) : ex.handle_alarm(inPtr, bytes.length);
    rt.phase = "response";
    let response = null, outPtr = 0;
    if (kind === "http") {
      requireAbi(Number.isInteger(n) && n > 0 && n <= LIMITS.response, "Invalid response length");
      outPtr = ex.alloc(n);
      requireAbi(outPtr !== 0, "Output allocation failed");
      range(rt, outPtr, n);
      const written = ex.take_response(outPtr, n);
      requireAbi(written === n, "Incomplete WASM response");
      response = parseWasmResponse(dec.decode(range(rt, outPtr, n)), method);
    } else requireAbi(n === 0, "Alarm handler failed");
    rt.phase = "cleanup";
    ex.dealloc(inPtr, bytes.length);
    if (outPtr !== 0) ex.dealloc(outPtr, n);
    ctx.pending = null;
    rt.invocation = null;
    rt.phase = "idle";
    return { response, alarmAt: ctx.alarmAt };
  } catch (e) {
    rt.invalid = true;
    rt.phase = "failed";
    ctx.pending = null;
    rt.invocation = null;
    throw e;
  }
}
