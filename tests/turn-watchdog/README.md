# celld 同步 turn 看门狗回归

验证打过看门狗补丁的 celld 在单 Tokio 执行线程下能终止失控代码，及时返回 HTTP
错误，并继续服务正常请求。每轮使用独立临时目录和本地对象存储，不访问实验服务器。

```bash
node verify.mjs ../../target/release/celld 32
node verify.mjs ../../target/release/celld 1
```

运行前需有 Node.js、esbuild 和已构建的 celld。测试监听 `127.0.0.1:19876`，
端口被占用时直接失败。测试结束向自己创建的 dev 监督器发送 SIGINT，等待其关闭
独立进程组中的节点，并核对端口已释放；临时目录及日志保留供检查。

固定配置：`CELLD_TOKIO_THREADS=1`、`CELLD_TURN_BUDGET_S=1`、
`CELLD_HANDLER_BUDGET_S=30`。两轮分别设置 `CELLD_MAX_CELLS_PER_ISOLATE=32/1`。

验证范围：

- DO 同步 JS 死循环、异步 fetch 恢复后的死循环、WASM 死循环。
- loaded worker、普通路由 worker 同步及异步恢复后的死循环。
- facet 同步及异步恢复后的死循环；facet 禁网且拥有独立 SQLite。
- 各失控请求返回 500，耗时小于 6 秒，不等待 30 秒 handler budget。
- 每次终止后连续十轮请求路由、原 cell 和相邻 cell，验证服务恢复及各库计数保留。
- 同时读取原业务与相邻业务的 facet，验证各库分别保留 1/0 行，终止不污染相邻业务。
- 1.5 秒异步等待不受 1 秒同步 turn budget 影响。
- 四个并发失控 cell 与一个正常请求在有限时间内全部返回。
- Dynamic Worker 显式 CPU 预算 50/5000/1000 ms 与 1 秒 turn 预算共同启用；分别验证 CPU 先到、turn 先到及接近同时到期，每项重复两次并复用原 loaded Worker，确认后续请求与邻居恢复。

本测试验证已有 SQLite 数据在终止后仍可读，不验证进程重启后的持久化恢复。
不覆盖 native 阻塞、模块初始化、alarm、WebSocket 和多节点迁移。

## 适用基线与验收

基线为上游 `42269c1`（v0.5.1）。看门狗在 `Slot::turn_in()` 内计时，
保留 per-cell 调度及全局 heap identity。合并后的请求驱动循环及
`PendingEventIdle` 收尾均报告 turn 硬终止；保留 cross-entry durability gate、
shutdown 取消和 Queue producer 的全事件周期许可。Worker Loader 通过
`wrangler.jsonc` 的 `worker_loaders` 声明，不使用已移除的环境变量。
上游内部测试依赖未随仓库提供的 `CELLD_INTERNAL_*` / `CELLD_CONFORMANCE_*`
外部源码，本回归使用实际 release 二进制，不宣称覆盖该内部测试集。

验证快照（2026-09-20，macOS ARM64）：Rust 1.94.1 release 构建、修改文件的
rustfmt 检查、JS 语法及 `git diff --check` 通过。单 Tokio 线程、每 isolate
cell 上限 32/1 两轮均通过八类死循环、并发请求收敛、异步等待、终止后连续读取、
facet SQL 隔离及禁网检查，退出后端口释放。显式 CPU 预算与 turn watchdog
共同启用的三组重复终止与恢复通过；50 ms CPU 预算约 55–58 ms 终止，
5000 ms CPU 预算由 turn watchdog 在约 1.0–1.2 秒终止。构建 hash 与事务验收见
[同步事务硬终止回归](../transaction-termination/README.md)。

这些结果不代表已验证模块顶层初始化、native 阻塞、多节点或生产环境。
