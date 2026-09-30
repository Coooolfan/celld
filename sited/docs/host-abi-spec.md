# Host ABI 规范

适用运行时：本仓库 `sited` 分支的 celld v0.6.0。
本规范定义接口契约；使用方式和能力边界见 [项目说明](../README.md)。

本规范对应 `src/host-api.js`、`src/sql.js` 与 `sdk/host-api/`。
业务依赖 `host-api` crate，通过 `export_abi!` 生成导出，不自行声明 Host imports。
ABI 版本为 3，Host imports namespace 为 `celld_v3`，`abi_version()` 必须返回 3。

## 模块与内存

| 导出 | 签名 | 契约 |
|---|---|---|
| `abi_version` | `() -> i32` | 返回 3 |
| `memory` | memory32 | 单一、非 shared，发布校验要求最大 128 MiB |
| `alloc` | `(len: i32) -> i32` | 分配缓冲区，失败返回 0 |
| `dealloc` | `(ptr: i32, len: i32)` | 释放对应缓冲区 |
| `handle_http` | `(ptr: i32, len: i32) -> i32` | 执行一次并暂存响应，返回字节数；负数为失败 |
| `take_response` | `(ptr: i32, cap: i32) -> i32` | 复制并消费暂存响应；cap 不足不消费，返回所需长度 |
| `handle_alarm` | `(ptr: i32, len: i32) -> i32` | 0 成功，负数失败 |

模块上限 16 MiB。静态校验器检查签名、memory 最大值、imports 并拒绝 start section；
加载器检查 import 名称/种类、必需 exports、当前 memory 和运行时版本返回值。
完整静态检查是发布前置条件，加载器检查不是其替代品。

只有两个 handler 执行期间允许调用 Host imports。实例化、版本检查、分配、取响应和
释放期间不得调用 Host。指针越界、协议违规和 guest trap 终止调用，实例不再复用。
每次内存操作读取最新 `memory.buffer`，不缓存可能被 memory.grow 分离的 ArrayBuffer。

## Host imports

namespace 为 `celld_v3`，只声明实际使用的函数。

| import | 签名 | 契约 |
|---|---|---|
| `host_log` | `(ptr: i32, len: i32)` | UTF-8 日志；单条 4 KiB、每事件 64 KiB |
| `host_now` | `() -> i64` | Unix 毫秒时间戳 |
| `host_alarm_set_at` | `(at: i64) -> i32` | 接受调度意图返回 0，时间非法返回 -1 |
| `host_sql_exec` | `(ptr: i32, len: i32) -> i32` | 执行 SQL 请求并暂存成功或错误结果，返回编码字节数 |
| `host_sql_take` | `(ptr: i32, cap: i32) -> i32` | 只复制结果；cap 不足返回所需长度且不写入 |
| `host_sql_drop` | `()` | 放弃暂存结果，不取消或撤销 SQL |

所有存储操作固定作用于当前 cell。请求不包含可选择其他数据库的 scope、路径或 bizId。
不提供 WASI、文件系统、socket、出网或跨 cell 调用。

## HTTP 与 alarm

HTTP 输入：

```json
{
  "context": {"attempt_id":"宿主调用标识"},
  "request": {"method":"POST","path":"/api/items?a=1","headers":{},"body":"hello"}
}
```

输入为严格 UTF-8 JSON。SDK 的 Request 提供 method、path、headers、body、attempt_id。
`route()` 剥离 query；`query(key)` 返回原始编码值，不做 percent-decode。
GET/HEAD 不读取 body。body 最大 1 MiB，整个 WASM 输入最大 2 MiB。

HTTP 响应为：

```text
STATUS:CONTENT-TYPE
BODY
```

状态码为 200–599，content-type 非空且最多 1024 个 JS 字符，不能包含 CR/LF/NUL。
整个响应最大 4 MiB；HEAD 和 204/205/304 返回空 body。
没有 header 行或格式非法属于 ABI 错误，不自动退化为文本。
不支持任意响应 headers 或二进制 body。

Alarm 输入：

```json
{"attempt_id":"宿主调用标识","retry_count":0}
```

由运行时 `alarm(info)` 选择独立 WASM 导出；任何 HTTP 内容都不能选择该入口。
`/__alarm`、`/__dispose` 及其路径子树为保留路径，公开入口返回 404，无管理副作用。

业务入口示例：

```rust
use host_api::{Request, AlarmEvent, AlarmError};
host_api::export_abi!(http, alarm);
fn http(_: Request) -> String { host_api::text(200, "hello") }
fn alarm(_: AlarmEvent) -> Result<(), AlarmError> {
    host_api::schedule_alarm_at(host_api::now() + 60_000)
}
```

只使用 HTTP 的模块可用 `export_abi!(http)`；调用其 alarm 导出会明确失败。

### 调度与投递

`schedule_alarm_at()` 只接受调度意图，范围为 `0..=8_640_000_000_000_000` 毫秒。
同一事件最后一次意图生效。handler 正常结束、HTTP 响应通过校验和清理后，
宿主等待 `storage.setAlarm()`；失败传播，不重跑 handler。handler 失败时丢弃意图。

SQL、设置下一次 alarm 和确认当前 alarm 不是一个原子事务。
Alarm 可以重投递且有重试上限。业务持久化任务 ID 与进度，并用唯一键或条件 SQL 实现幂等。
`attempt_id` 仅用于日志关联，不是凭据或稳定业务任务 ID。

## SQL SDK 与 wire

```rust
sql::exec(query: &str, params: &[SqlValue]) -> Result<SqlResult, SqlError>
sql::batch(queries: &[SqlQuery]) -> Result<Vec<SqlResult>, SqlError>
```

`SqlQuery::new(query, params)` 构造查询。每个 query 对应一次 DO `sql.exec()`，
允许多语句；bindings 和 cursor 只对应最后一条 SQL。平台不解析或切割 SQL。
业务输入通过 `?` 绑定，不能拼入 SQL 源码。动态标识符需要业务白名单。

```rust
use host_api::{sql, SqlValue};
let result = sql::exec(
    "INSERT INTO items(content) VALUES (?) RETURNING id",
    &[SqlValue::Text("hello".into())],
)?;
```

类型与编码：

| Rust | JSON |
|---|---|
| `SqlValue::Null` | null |
| `SqlValue::Number(f64)` | JSON number |
| `SqlValue::Text(String)` | JSON string |
| `SqlValue::Blob(Vec<u8>)` | `{"blob":"AP8="}` |

Number 遵循 JS Number：不区分 INTEGER/REAL，不保证超过 ±(2^53−1) 的整数精度。
非有限数与负零不在传输范围内，返回 VALUE_ERROR，不静默编码为 NULL。
TEXT 严格 UTF-8；BLOB 为标准、规范 Base64。布尔、数组和其他对象不是 SQL 参数值。

请求：

```json
{"queries":[{"query":"SELECT ?, ? AS value","params":[1,{"blob":"AP8="}]}]}
```

成功结果：

```json
{"ok":true,"results":[{"columns":["?","value"],"rows":[[1,{"blob":"AP8="}]]}]}
```

返回位置行而非行对象，保留重复列名和特殊列名。`SqlResult` 包含 columns 和 rows，
不暴露扫描统计、连接级 last_insert_rowid 或 changes；新增 ID 使用 RETURNING。

错误结果：

```json
{"ok":false,"error":{"code":"SQL_ERROR","message":"SQL operation failed","query_index":0}}
```

错误类别为 INVALID_REQUEST、VALUE_ERROR、SQL_ERROR、RESULT_LIMIT、RESOURCE_LIMIT。
query_index 为 batch 中 exec 调用的零基索引，无法定位时为 null。
SQL message 是最长 240 个 JS 字符的运行时诊断，不保证格式稳定；无原生数字错误码、
rolled_back 或 retryable 字段。SDK 自身检测到非法 Host 回复时返回 ABI_ERROR。
业务不得将 SQL 错误降级为空列表或 0。

### 原子性与结果消费

exec 作为单元素 batch，通过 `storage.transactionSync()` 执行。
查询、迭代、编码和预算检查在同步回调内；异常在回调外转为 Err。
常规语法/约束/结果编码失败回滚本操作的事务性写入。

结果超限时使用公开 cursor.next() 耗尽剩余行后抛错，不再累积结果。
这不提供即时取消，清理仍可能耗时并被看门狗终止。同步事务硬终止后的回滚与连接恢复
要求运行时具备同步事务硬终止保护。SQL 尾注释兼容性与真实 commit/rollback/IO 故障恢复的测试范围见[测试说明](validation.md)。
连接级 PRAGMA 等状态不承诺随事务回滚。

```text
EMPTY → exec → READY
READY → take(足够) → EMPTY
READY → take(不足) → READY，不写字节
READY → drop → EMPTY
READY → exec → ABI 错误，不执行 SQL
```

SDK 执行一次、按精确长度分配、take 一次；扩容只能重调 take，不能重调 exec。
事件结束或实例废弃后清理 pending result，不能跨事件读取。

## 限额

| 项目 | 值 |
|---|---:|
| SQL 请求编码大小 | 1 MiB |
| 每 query 文本 | 100,000 bytes |
| 每 query 参数数 | 100 |
| 每 batch exec 调用数 | 128 |
| 每事件 SQL Host 执行次数 | 128 |
| 每事件累计 exec 调用数 | 1,024 |
| 每操作结果行数 | 10,000 |
| 每操作编码结果 | 4 MiB |
| 每事件累计结果 | 16 MiB，预留至少 1 KiB 错误空间 |

错误结果也计入预算；预算持续耗尽后终止调用，不允许无限产生拒绝结果。
计数是 exec 调用数，不是 query 内部 statement 数或扫描行数。
SQLite 的 native 限制同时生效；Host 预算不等于完整 CPU、native 内存或磁盘配额。

## 失败与发布

一次平台投递至多进入一次 handler。trap、取结果、解析和清理失败不重放。
已完成 SQL 不因后续 handler 失败撤销；断连或持久化确认失败可能产生不确定结果。
客户端重试和 alarm 重投递需要业务幂等，不承诺 exactly-once。

发布前必须完成静态校验与[测试说明](validation.md)中的回归。
平台与业务 WASM 使用匹配的 ABI 配套发布。
不修改 DO class、bizId 映射或业务数据位置；回滚配套平台/模块，不随意回滚业务数据。
