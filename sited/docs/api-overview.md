# API 分层

sited 的平台接口分为 host-api 和 admin-api。celld 提供节点、cell、存储和运行时基础设施接口。

| 接口层 | 调用方 | 职责 | 规范 |
| --- | --- | --- | --- |
| host-api | 业务 WASM | 当前业务的 SQL、日志、时间和 alarm 调度 | [Host ABI](host-abi-spec.md) |
| admin-api | 平台管理员、发布工具 | 业务 SCOPE 查询、模块配置、发布和状态查询 | [Admin API](admin-api.md) |
| celld 基础设施 API | 平台 JS、基础设施管理员、celld 节点 | cell 定位、持久化、节点健康、部署加载与 fleet 运维 | [运行文档](../../docs/README.md)、[安全边界](../../docs/security.md) |

## host-api

WASM imports 使用 `celld_v3` namespace，Rust SDK 位于 [sdk/host-api](../sdk/host-api/src/lib.rs)。所有 Host 调用绑定当前业务，不能选择其他业务数据库。

| WASM import | 功能 | Rust SDK |
| --- | --- | --- |
| `host_log` | 写业务日志 | `log()` |
| `host_now` | 获取当前毫秒时间戳 | `now()` |
| `host_alarm_set_at` | 设置事件结束后应用的 alarm 意图 | `schedule_alarm_at()` |
| `host_sql_exec` | 执行参数化 SQL 或原子 batch，暂存结果 | `sql::exec()`、`sql::batch()` |
| `host_sql_take` | 将暂存结果复制到 WASM 内存，不重执行 SQL | SDK 内部调用 |
| `host_sql_drop` | 丢弃暂存结果 | SDK 内部调用 |

平台反向调用 WASM 的导出为 `abi_version`、`alloc`、`dealloc`、`handle_http`、`handle_alarm` 和 `take_response`，另需导出 `memory`。这些属于 ABI 契约，不是 WASM 调用宿主的 imports。

host-api 不提供业务出网、文件系统、跨业务调用、平台管理权限或 alarm 查询/删除。签名、编码、预算和失败语义见 [Host ABI 规范](host-abi-spec.md)。

## admin-api

admin-api 位于 `https://{bizId}.{ROOT_DOMAIN}`，使用平台管理 Bearer Token。

| 接口 | 功能 |
| --- | --- |
| `GET /__inner__/scope` | 计算 bizId 对应的 celld SCOPE，不激活 cell |
| `GET /__inner__/status` | 查询模块配置、加载状态与最近错误 |
| `POST /__inner__/action/publish` | 校验并保存模块配置，下次事件加载新实例 |

admin-api 不负责上传模块文件，也不提供业务列表、停用/删除、版本历史、专用回滚、配额设置、日志查询、数据库管理或手动触发 alarm。`/__alarm` 和 `/__dispose` 是禁止的业务路径，不是管理接口。

## celld 基础设施 API

### 节点与 fleet 运维

| 路径 | 功能 | 监听端口 |
| --- | --- | --- |
| `/.well-known/celld/health` | 节点健康检查 | 公开 |
| `/state` | 节点状态、负载和计数器 | 内部 |
| `POST /reload` | 重新加载 fleet 部署 | 内部 |
| `POST /shutdown` | 优雅停止并交接 cell；支持 `handoff=preserve` | 内部 |
| `POST /rebalance/pause` | 暂停再平衡 | 内部 |
| `POST /rebalance/resume` | 恢复再平衡 | 内部 |
| `/cell/<SCOPE>` | 定位或激活 cell | 内部 |
| `/evict/<SCOPE>` | 尝试驱逐 resident cell | 内部 |
| `/do/<ID>` | 向普通 Durable Object 投递请求 | 内部 |
| `/runtime/<SCOPE>` | fleet HMAC 鉴权的保留运行时管理入口 | 内部 |
| `/peer/*` | 节点间诊断、复制、交接与隧道协议 | 内部 |

内部 operator API 是 alpha 接口，路径与响应可随版本改变。多数 operator 操作不鉴权，依赖可信私网，不能使用 sited Bearer Token 替代网络隔离。`/runtime/` 使用 fleet HMAC；`/peer/*` 应由 celld 或配套工具使用。具体权限见[安全文档](../../docs/security.md#use-the-internal-operator-api)。

运维 CLI 包括 `celld deploy`、`celld diagnose`、`celld cell list`，以及 D1、KV、R2、Queue 和 Workflow 管理命令。命令及部署兼容要求见[运行文档](../../docs/README.md)。

### 平台 JS 使用的运行时接口

sited 通过 celld 的 `env.BIZ.idFromName/get` 和 `stub.fetch()` 定位业务 cell，使用 `state.storage.get/put` 保存模块配置，使用 `storage.sql.exec()`、`transactionSync()` 和 `setAlarm()` 提供业务存储与调度。WASM 仅通过 host-api 使用获准的能力。

发布某业务 WASM 属于 admin-api；更新平台 Worker 部署、停止节点和操作 cell 属于 celld 基础设施层。业务模块自己实现的 HTTP 路径属于业务 API。
