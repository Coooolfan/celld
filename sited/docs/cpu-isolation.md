# 执行与业务隔离边界

每个业务使用独立的 Durable Object cell、SQLite 数据库、WASM instance 和线性内存。Host imports 绑定到当前 cell，业务模块不能选择其他业务的存储。

## 执行预算

celld 的 turn watchdog 限制同步 WASM/JavaScript 执行时间。通过 `CELLD_TURN_BUDGET_S` 设置正整数秒预算；通过 `CELLD_MAX_CELLS_PER_ISOLATE=1` 缩小共享 isolate 的阻塞影响范围。失败实例不继续处理后续事件，后续投递使用干净实例。

预算计量墙钟时间，不是每业务 CPU 配额。看门狗不能保证 native SQL/IO 即时中断，尚未注册到 Slot 的模块初始化也不在其保护范围内。详细语义见[fork 执行保护](../../docs/fork-differences.md)。

## 资源与网络

- 每 isolate 一个 cell 不提供独占 CPU 核心、进程、内存或磁盘。
- WASM ABI 不提供 WASI、文件系统、socket、业务出网或跨 cell 调用。
- 平台可信 JS 层通过 HTTP 下载 WASM；该权限不暴露给业务模块。
- celld 与业务运行在同一进程中，不提供每业务独立的网络 namespace。

Host API 的模块大小、线性内存、请求、日志和 SQL 结果限额见[Host ABI 规范](host-abi-spec.md)。这些限额不等同于完整的 CPU、native 内存或磁盘硬配额。
