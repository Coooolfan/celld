# 本 fork 与上游的差异

本 fork 在上游 celld v0.6.0 上提供 `sited/` WASM 业务平台，并增加同步 turn 超时保护、可配置的 isolate cell 上限、同步事务硬终止收尾，以及失败激活时的副本资源清理。本文统一追踪相对上游基线的有效差异，说明行为、边界、实现入口与验证范围。

## 比较范围

| 项目 | 本文基线 |
| --- | --- |
| 上游仓库 | [denoland/celld](https://github.com/denoland/celld) |
| fork 仓库 | [Coooolfan/celld](https://github.com/Coooolfan/celld) |
| fork 分支 | `sited` |
| 上游版本 | `v0.6.0`，`bad4649d01f0db84cdc9093527e72e64ca7a14bf` |
| fork 比较对象 | 当前检出的 fork 代码；精确版本使用 `git rev-parse HEAD` 获取 |

本文比较固定上游基线 v0.6.0 与本 fork，不用于比较上游其他版本。下列 runtime 改动与平台层能力共同构成 fork 的差异。

## sited 平台层

`sited/` 是 fork 新增的业务平台，不修改 celld 的通用部署与持久化协议。它使用上游 Durable Objects、SQLite 和 alarm 构建独立业务运行单元，核心目标为以业务为单位横向扩容、数据持久化、空闲实例释放、业务隔离与独立发版。

| 能力 | fork 提供的行为 | 实现与规范 |
| --- | --- | --- |
| 业务路由与状态单元 | `{bizId}.{ROOT_DOMAIN}` 定位独立 BizDataCell；每业务一个数据库和 WASM runtime | [index.js](../sited/src/index.js)、[cell.js](../sited/src/cell.js) |
| 部署配置 | 显式配置 `ROOT_DOMAIN`、`WASM_BASE`，无环境地址默认值；空管理 Token 禁用管理接口 | [sited 配置](../sited/README.md#配置与模块发布) |
| host-api | `celld_v3` imports 提供当前业务的 SQL、日志、时间与 alarm 意图；包含 Rust SDK | [Host ABI](../sited/docs/host-abi-spec.md)、[SDK](../sited/sdk/host-api/src/lib.rs) |
| admin-api | 不激活 cell 的业务 SCOPE 查询；模块状态查询与发布，发布校验大小、哈希并保存配置，下次事件加载新实例 | [Admin API](../sited/docs/admin-api.md) |
| 模块校验与执行边界 | 静态校验器限制 imports、exports、memory、模块大小和 start section；handler 失败后实例不复用，不立即重放 | [校验器](../sited/tools/validate-wasm/src/main.rs)、[隔离边界](../sited/docs/cpu-isolation.md) |
| 示例与回归 | echo、upper、vote 展示 HTTP、CRUD、原子 batch 与 alarm；回归验证 ABI、预算、发布和本地恢复 | [示例](../sited/examples/README.md)、[测试说明](../sited/docs/validation.md) |

API 职责见 [API 分层](../sited/docs/api-overview.md)。业务 WASM 的接口能力来自 sited host-api，不等同于可以直接调用全部 celld Worker/DO API。基础设施所有权、跨节点复制与故障恢复仍由 celld 提供。

平台不提供每业务独立进程或完整硬配额、版本注册表、灰度与自动回滚。重新加载模块时不重新核对已保存哈希，正式发布应使用不可变模块路径。平台回归不覆盖多节点故障、OOM、真实磁盘与对象存储故障。

## Runtime 行为差异概览

| 场景 | 上游 v0.6.0 | 本 fork |
| --- | --- | --- |
| 普通 Worker / DO 同步代码一直不让出 isolate | handler budget 在请求驱动流程中检查，无法靠该流程打断一直不返回的 turn | 独立线程检测 turn 墙钟超时，调用 V8 终止执行；驱动流程收到终止结果后收尾未应答请求 |
| 每个 isolate 承载多少 cell | 固定上限 32 | 默认仍为 32，可通过 `CELLD_MAX_CELLS_PER_ISOLATE` 调整 |
| `transactionSync()` 调用栈被 V8 硬终止 | JS 的 catch/finally 可能被跳过，事务和句柄收尾可能遗留 | 原生调用边界回滚该 cell 的未提交事务，清理待写 KV、游标和相关事件锁，并使旧事务句柄失效 |
| Restore 完成后启动失败，例如 class 注册缺失 | 直接进入 Dormant，Restore 已打开的副本可能遗留 | 先进入 `Cleaning(StartFailed)`，等待副本清理完成，再回到 Dormant 并结束失败请求 |
| 本地快照被消费或副本被移除 | 相关 epoch 空目录可能留下 | 尝试非递归删除空目录，保留仍有内容的目录 |

### 1. 同步 turn 超时看门狗

一个 turn 是一次持有 isolate 的同步执行片段。fork 在进入 turn 后开始计时，由独立于 Tokio 的线程每 250 ms 检查一次，因此即使单个 Tokio 执行线程被同步死循环占住，也能发出 V8 终止信号。

普通池中的 Slot 和动态加载 Worker 的独立 Slot 都注册到看门狗。终止标记属于当前 turn；退出时清除迟到的终止信号，避免误终止下一个 turn。Worker 和 DO 的请求驱动流程处理该结果，及时结束未应答请求，后续 turn 可以继续使用 isolate。已有回归中的失控 HTTP 请求返回 500。

| 配置 | 上游 v0.6.0 | fork 行为 |
| --- | --- | --- |
| `CELLD_TURN_BUDGET_S` | 无此设置 | 正整数秒；未设置时沿用 `CELLD_HANDLER_BUDGET_S`，默认 300 秒 |
| `CELLD_MAX_CELLS_PER_ISOLATE` | 无此设置，固定 32 | 正整数；默认 32；设为 1 可缩小共享 isolate 的阻塞影响范围，但会增加内存占用 |
| `CELLD_HANDLER_BUDGET_S` | 已有，默认 300 秒 | 继续限制跨 turn、包含异步等待的 handler 总时长 |

上游已有 Dynamic Worker 显式 CPU 预算。fork 的 turn 看门狗与该机制共同工作，CPU 限额本身不是 fork 新增能力。

turn budget 计量墙钟时间，包含同步 native 调用和 OS 暂停调度的时间，不包含排队或异步等待。250 ms 是检查间隔，不是精确中断时限。看门狗不能即时打断尚未返回 V8 的阻塞 native 调用；模块初始化中尚未注册到 Slot 的执行也不在该保护范围内。已经提交的数据和已经发出的响应不会因终止而撤销。

实现入口：[pool.rs](../crates/celld/pool.rs)、[runtime.rs](../crates/celld/runtime.rs)、[js.rs](../crates/celld/js.rs)、[main.rs](../crates/celld/main.rs)、[env_vars.rs](../crates/celld/env_vars.rs)。环境变量说明见[运行文档](README.md#environment-variables)。

### 2. 同步事务硬终止收尾

fork 用内部原生操作 `__storage_transaction_sync` 包住同步事务的 BEGIN、业务 callback、COMMIT 和普通异常回滚。当看门狗或 `state.abort()` 在这个动态调用栈内触发 V8 硬终止时，原生层在调用返回后完成收尾，即使 JS catch/finally 没有执行：

- 标记整条事务控制链失效，拒绝旧句柄的迟到操作和异步父事务的迟到提交。
- 丢弃该 cell 尚未 flush 的 KV，关闭 SQL/KV 游标，回滚仍然打开的整个 SQLite 事务。
- 沿用所属 reaction 的事件终止收尾，释放相关 input gate；保留已有 abort 原因。
- 如果回滚失败，记录 SQL critical-error 并拒绝后续存储操作。

嵌套同步栈硬终止时回滚整个未提交事务；普通异常继续沿用 savepoint 语义。同步 callback 不接收参数，返回值及普通异常对象身份保持原有语义。此前已提交的数据、事务开始前排队的 KV 和其他 cell 的事务保留。

v0.6.0 的 facet 按上游契约使用独立数据库、独立提交和复制。父事务被终止时，已提交的 facet 写入仍然保留。facet 独立提交是上游行为，fork 的收尾遵循该边界。

该保护范围是 `transactionSync()` 的动态调用栈，也包括异步父事务包裹同步事务的情况；不能据此推断纯异步事务在该调用栈之外被终止也得到同样保护。这是内部保护操作，没有新增业务可调用的事务 API。

实现入口：[harness.js](../crates/celld/js/harness.js)、[storage_ops.rs](../crates/celld/js/storage_ops.rs)、[storage.rs](../crates/celld/storage.rs)，原生操作注册在 [js.rs](../crates/celld/js.rs)。

### 3. 失败激活与 epoch 空目录清理

Restore 成功但 StartRuntime 失败时，fork 进入 `Cleaning(StartFailed)`，通过已有 Rebase stop 路径等待持久化确认并关闭副本。清理完成后才进入 Dormant，并以 `RuntimeFailed` 结束等待请求。重复 wake 和过期完成不会提前结束清理。

如果启动或发布的迟到完成到达时已失去所有权，无论结果是否为明确失败，都执行 Fence/CloseInPlace 收尾：只关闭资源，不进行持久化确认，也不产生供后继 epoch 复用的缓存。

消费本地快照和移除副本后，fork 调用非递归 `remove_dir` 尝试回收空 epoch 目录。`FileSystem` trait 新增该可选方法，默认返回 Unsupported；DirectFileSystem 使用系统的空目录删除操作。因此自定义文件系统可以继续使用默认实现，但可能留下空目录。

这项改动不扫描部署前积累的历史 epoch，也不消除缺失 class 引起的周期激活重试。清理失败继续沿用已有失败重试机制。

实现入口：[logic/lib.rs](../crates/logic/lib.rs)、[logic/types.rs](../crates/logic/types.rs)、[actor.rs](../crates/celld/actor.rs)、[ltx_repl.rs](../crates/celld/ltx_repl.rs)、[ltx host.rs](../crates/ltx/src/host.rs)。

## 新增回归与验证范围

| 回归 | 验证内容 | 入口 |
| --- | --- | --- |
| turn 看门狗 | JS/WASM 死循环、普通与 loaded Worker、DO/facet、await 后死循环、终止后恢复、CPU 预算共存、cell 上限 32/1 | [tests/turn-watchdog](../tests/turn-watchdog/README.md) |
| 同步事务终止 | SQL/KV/alarm 回滚、嵌套和异步父事务、旧句柄/游标失效、邻居事务存活、facet 独立提交、重启恢复 | [tests/transaction-termination](../tests/transaction-termination/README.md) |
| 失败激活 | 缺失 class 重复启动失败时的 FD/epoch 增长、恢复 class 后数据可读、状态机收尾与 fencing | [tests/failed-activation](../tests/failed-activation/README.md) |
| V8 终止探针 | 独立线程能否终止死循环，以及终止后 isolate 能否复用 | [terminate_probe.rs](../crates/celld/examples/terminate_probe.rs) |
| sited 平台 | 配置、Host ABI、SQL、预算、模块发布、实例恢复与业务示例 | [sited 测试](../sited/docs/validation.md) |

各回归文档提供运行命令、断言和适用范围。失败激活回归支持通过 `--expect-leak` 检查存在泄漏的 binary，作为修复效果的对照。

这些回归使用本地存储，覆盖范围不包含生产、多节点、OOM、真实磁盘故障、对象存储网络故障、模块初始化或所有 native 阻塞场景。上游 `celld_internal_tests` 需要额外提供 `CELLD_INTERNAL_*` / `CELLD_CONFORMANCE_*` 外部测试源码。

## 与上游保持一致的部分

相对 v0.6.0，fork 没有修改仓库根目录 `Cargo.toml`、`Cargo.lock`、celld 的 Wrangler 配置结构或数据库/对象存储格式。sited 的 Rust crates 使用独立 Cargo workspace、manifest 与 lockfile。celld 包版本仍为 `0.6.0`，仅靠版本号无法区分上游 binary 与 fork binary；发布时应同时记录 Git commit 和产物 SHA-256。

fork 沿用上游 v0.6.0 的服务实现、CPU 限额、facet 提交契约和 fleet 恢复协议。部署升级与降级须遵守上游的数据格式和版本兼容约束。

## 查看源码差异

在仓库根目录可复现本文的代码比较：

```sh
git rev-parse HEAD
git merge-base --is-ancestor v0.6.0 HEAD
git diff --stat v0.6.0 HEAD
git diff v0.6.0 HEAD -- crates sited docs tests .gitignore
```

上述命令比较已提交代码；检查尚未提交的改动使用 `git diff` 和 `git status --short`。

## 维护约定

新增、修改或移除 fork 特有的行为、接口、配置与限制时，在同一改动中更新本文的对应条目、实现入口与验证范围。本文维护有效差异，不记录开发过程或按提交堆积变更日志。

同步上游时，核对并更新比较基线；上游已提供等价能力的改动不再作为 fork 独有差异列出。数据格式与升级兼容性变化应同时更新运行文档和相关回归。
