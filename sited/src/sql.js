// 同步 DO SQL 适配器。仅使用 storage.sql.exec 与 transactionSync 公开接口。
export const SQL_LIMITS = Object.freeze({
  requestBytes: 1024 * 1024, queryBytes: 100_000, params: 100, batch: 128,
  calls: 128, queries: 1024, rows: 10_000, resultBytes: 4 * 1024 * 1024,
  eventBytes: 16 * 1024 * 1024,
});
const enc = new TextEncoder();

export class SqlError extends Error {
  constructor(code, message, queryIndex = null) {
    super(message);
    this.code = code;
    this.query_index = queryIndex;
  }
}
const fail = (code, message) => { throw new SqlError(code, message); };
const exact = (v, keys) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

function validText(text) {
  if (!text.isWellFormed()) fail("VALUE_ERROR", "TEXT must contain valid Unicode");
  return text;
}

function number(value) {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    fail("VALUE_ERROR", "SQL number cannot be represented by this ABI");
  }
  return value;
}

function decodeValue(value) {
  if (value === null) return null;
  if (typeof value === "string") return validText(value);
  if (typeof value === "number") return number(value);
  if (exact(value, ["blob"]) && typeof value.blob === "string") {
    const s = value.blob;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) {
      fail("VALUE_ERROR", "Invalid Base64 BLOB");
    }
    let raw;
    try { raw = atob(s); }
    catch { fail("VALUE_ERROR", "Invalid Base64 BLOB"); }
    if (btoa(raw) !== s) fail("VALUE_ERROR", "Noncanonical Base64 BLOB");
    return Uint8Array.from(raw, c => c.charCodeAt(0)).buffer;
  }
  fail("VALUE_ERROR", "Expected null, number, text or BLOB");
}

function encodeValue(value) {
  if (value === null) return null;
  if (typeof value === "number") return number(value);
  if (typeof value === "string") return validText(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return { blob: btoa(binary) };
  }
  fail("VALUE_ERROR", "Unsupported SQL result value");
}

export function newSqlBudget() {
  return { calls: 0, queries: 0, bytes: 0 };
}

// 所有失败结果也计入事件预算。最低预留错误空间，避免耗尽预算后无法报告拒绝。
export function executeSql(storage, input, budget) {
  let index = null;
  let bytes;
  try {
    if (++budget.calls > SQL_LIMITS.calls) fail("RESOURCE_LIMIT", "SQL call limit exceeded");
    if (budget.bytes + 1024 > SQL_LIMITS.eventBytes) fail("RESOURCE_LIMIT", "SQL event byte limit exceeded");
    if (input.byteLength > SQL_LIMITS.requestBytes) fail("INVALID_REQUEST", "SQL request too large");
    let request;
    try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)); }
    catch { fail("INVALID_REQUEST", "SQL request must be UTF-8 JSON"); }
    if (!exact(request, ["queries"]) || !Array.isArray(request.queries)
      || request.queries.length < 1 || request.queries.length > SQL_LIMITS.batch) {
      fail("INVALID_REQUEST", "Expected 1..128 queries");
    }
    if (budget.queries + request.queries.length > SQL_LIMITS.queries) {
      fail("RESOURCE_LIMIT", "SQL query count exceeded");
    }
    budget.queries += request.queries.length;
    const queries = request.queries.map((q, i) => {
      index = i;
      if (!exact(q, ["query", "params"]) || typeof q.query !== "string"
        || !Array.isArray(q.params) || q.params.length > SQL_LIMITS.params
        || enc.encode(q.query).length > SQL_LIMITS.queryBytes) {
        fail("INVALID_REQUEST", "Invalid SQL query or parameter count");
      }
      validText(q.query);
      return { query: q.query, params: q.params.map(decodeValue) };
    });
    index = null;
    bytes = storage.transactionSync(() => {
      const parts = ['{"ok":true,"results":['];
      let size = enc.encode(parts[0]).length + 2;
      let rowCount = 0;
      const append = text => {
        size += enc.encode(text).length;
        if (size > SQL_LIMITS.resultBytes || budget.bytes + size > SQL_LIMITS.eventBytes - 1024) {
          fail("RESULT_LIMIT", "SQL result byte limit exceeded");
        }
        parts.push(text);
      };
      queries.forEach((q, i) => {
        index = i;
        const cursor = storage.sql.exec(q.query, ...q.params);
        try {
          append((i ? "," : "") + '{"columns":' + JSON.stringify(cursor.columnNames.map(validText)) + ',"rows":[');
          let first = true;
          for (const row of cursor.raw()) {
            if (++rowCount > SQL_LIMITS.rows) fail("RESULT_LIMIT", "SQL result row limit exceeded");
            append((first ? "" : ",") + JSON.stringify(row.map(encodeValue)));
            first = false;
          }
          append("]}");
        } catch (error) {
          // 公开 cursor 无 close()。耗尽剩余行后再抛错回滚，不物化或编码剩余结果。
          // 结果预算不限制 SQLite 的计算时间；清理仍受运行时执行预算约束。
          try { while (!cursor.next().done) {} } catch { /* 保留原始失败，事务负责回滚。 */ }
          throw error;
        }
      });
      parts.push("]}");
      const result = enc.encode(parts.join(""));
      index = null;
      return result;
    });
  } catch (e) {
    const code = e instanceof SqlError ? e.code : "SQL_ERROR";
    const message = String(e?.message || "SQL operation failed").slice(0, 240);
    bytes = enc.encode(JSON.stringify({ ok: false, error: { code, message, query_index: index } }));
  }
  budget.bytes += bytes.length;
  return bytes;
}
