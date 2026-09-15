# 同步事务硬终止回归

验证 `storage.transactionSync()` 动态调用栈被 turn 看门狗或 `state.abort()` 终止后，未提交的 SQL/KV/alarm 不进入后续事件；已提交数据、其他 cell 的事务仍可用。

## 运行

需要 Rust 1.94.1、Node.js 24 和 PATH 中的 esbuild：

```bash
cargo +1.94.1 build --locked --release -p celld
node tests/transaction-termination/verify.mjs target/release/celld 32
node tests/transaction-termination/verify.mjs target/release/celld 1
node tests/turn-watchdog/verify.mjs target/release/celld 32
node tests/turn-watchdog/verify.mjs target/release/celld 1
```

测试使用临时项目、本地存储和随机 loopback 端口；清除继承的 `CELLD_`、`AWS_`、`S3_` 环境变量。仅启动和停止测试自己的 dev 进程，结束后检查端口释放。临时目录与 `dev-*.log` 保留，路径输出到 stdout。无需云账号或生产资源。

## 断言

- 普通异常保持错误对象身份；同步返回值和 Promise 返回值不变。
- 普通/嵌套/显式回滚正常；子事务回滚不丢失父事务排队的 KV 写入。
- 异步父事务通过根 storage 句柄重入异步/同步事务时，保留父事务视图与子事务回滚语义。
- 父事务写入 facet 后在同步调用栈内被终止，facet 延迟镜像回滚，后续读取恢复原值。
- HTTP 同步栈、await 恢复后的同步事务、嵌套同步事务、大 SELECT cursor、未耗尽的 INSERT RETURNING cursor 均可被看门狗终止。
- `state.abort()` 在同步事务内部终止；事务之外的 abort 后也可继续使用存储。
- `transaction()` 包裹的 `transactionSync()` 终止后，原生连接与 input gate 都恢复。
- 事务内已写入 SQLite 的 KV 和尚未 flush 的 `put()` 均被取消；旧事务句柄拒绝继续执行 SQL，旧 cursor 不能继续推进原生 statement。
- 事务开始前排队的 KV，以及此前已提交的 SQL、KV、alarm 保留。
- 邻居 cell 的异步事务跨 await 存活。响应携带模块初始化时生成的随机 ID，断言 `max_cells=32` 时实际共享 isolate，`1` 时实际分属 isolate。
- alarm 中的同步事务硬终止后重试成功，失败尝试的写入不可见。
- 停止 dev 再以同一临时存储启动：仅恢复已提交数据和 alarm，不恢复被取消的写入。

## 原生保护边界

同步事务的 BEGIN、业务回调、COMMIT 和普通异常回滚都在原生 `TryCatch` 的调用范围内。V8 硬终止跳过 JS catch/finally 时，原生层不取消终止、不重新执行业务，而是：

1. 设置事务链共享的内部失效标记，防止旧句柄和异步父事务的迟到收尾继续操作连接。
2. 丢弃该 cell 的未 flush KV，关闭该 cell 的 SQL/KV cursor，回滚仍然打开的整个 SQLite 事务；不清理其他 cell。
   同时调用上游 `abandon_root_transaction()` 清理延迟 facet 镜像并使对应 facet 重新读取持久化状态。
3. 回滚失败时使用现有 SQL critical-error 状态拒绝后续存储操作；不把未知状态当作成功。
4. 沿用所属 reaction 的事件终止收尾，释放相关 input gate；保留已有 abort 原因。

这不是业务可调用的新 SQL/事务 API，不改变数据库格式。嵌套同步栈硬终止意味着整个栈不能继续，因此回滚整个事务，而不是仅回滚子 savepoint。普通异常仍使用原有 savepoint 语义。

## 验收口径

2026-09-15，macOS ARM64、Rust 1.94.1、Node.js v24.20.0：上述四组真实 release binary 测试通过。上游基线为 `12d5b6333fe52717325addcfe1e99e9fd4f77bcd`（v0.5.0），包含 fork 的独立 watchdog 和同步事务硬终止保护。构建产物 SHA-256：

```text
d1a24797c15856e79aca5de9e679d351e1f120c207101627c967c8a204a2e5bb
```

范围限于 `transactionSync()` 动态调用栈内的硬终止，包括异步父事务包裹它的情况。未覆盖纯异步事务在该调用栈之外被终止、真实磁盘 I/O/commit/rollback 故障注入、OOM、多节点和 Cloudflare 云上同条件对照。`celld_internal_tests` 所需外部测试语料未运行。

看门狗不是 native SQL/IO 的即时中断器；原生保护层在执行返回后收尾。通过这些回归不等于完成所有资源隔离或故障恢复验收，也不表示已部署生产。

回滚代码可撤销独立修复提交；不需迁移业务数据。回滚会重新暴露同步事务终止缺陷，依赖该保证的上层平台不得继续投递此类业务。binary 发布、维护窗口和生产回滚需独立授权。

以上只描述 fork 补丁的撤销。0.4.1 → 0.5.0 的引擎升级涉及 alarm discovery 格式迁移，必须遵守上游停机与备份要求；不能以恢复旧 binary 代替数据格式回滚验证。
