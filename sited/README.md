# sited

面向 agent 的 WASM 业务平台。每个业务使用独立的 Durable Object cell、SQLite 数据库、HTTP 子域名和 alarm。业务模块运行于 `wasm32-unknown-unknown`，通过 Host ABI 访问当前 cell 的存储、时间、日志和 alarm。

## 运行模型

```text
HTTP → Parent Worker → bizId → BIZ.idFromName(bizId)
                              └─ BizDataCell
                                 ├─ 下载并加载业务 WASM
                                 ├─ 实例专属 Host imports
                                 ├─ SQLite / transactionSync
                                 └─ alarm handler
```

业务模块无法选择其他业务的数据库，也不能访问平台 env、文件系统、socket 或其他 cell。HTTP 与 alarm 使用不同导出；公开业务路径不能调用 alarm 或 dispose 管理动作。

一次投递至多执行一次 handler。失败调用不立即重放，后续事件使用干净实例。已提交 SQL 不因后续 handler 失败撤销；客户端重试和 alarm 重投递需要业务实现幂等。

运行时使用本仓库 `sited` 分支的 celld v0.6.0，执行保护见[本 fork 与上游的差异](../docs/fork-differences.md)。

## Host API

Host imports 使用 `celld_v3` namespace，Rust SDK 位于 `sdk/host-api/`。业务通过 `export_abi!` 导出 HTTP 和 alarm handler。

- SQL 使用参数绑定，支持 Number、TEXT、NULL 和 BLOB；整数精度遵循 JavaScript Number 的 ±(2^53−1) 范围。
- `sql::exec()` 和 batch 返回 `Result`；SQL 错误不会降级为空结果。
- 每个 query 可含多条 SQL，bindings 和结果对应最后一条实际语句。
- batch 使用同步原子事务，不提供跨 Host 调用的交互式事务。
- SQL 结果只执行一次，再次提取暂存结果不会重执行。
- HTTP body 和 response 为文本，不支持任意 response headers 或二进制 HTTP。
- alarm 调度在事件结束时应用，Host 调用返回不表示调度已持久化。

传输格式、签名、限额和错误语义见[Host ABI 规范](docs/host-abi-spec.md)。

## 构建

需要 Rust、Node.js 24、esbuild，以及 `wasm32-unknown-unknown` target。以下命令从仓库根目录执行：

```bash
rustup target add wasm32-unknown-unknown
cd sited
bash test/build.sh
```

构建脚本生成 echo、upper、vote 和测试模块，运行 SDK 与静态校验器测试，并校验模块的 ABI、imports、exports、memory、大小和 start section。WASM memory maximum 为 128 MiB。构建输出位于各 crate 的 `target/`，由 Git 忽略。

示例接口与使用方式见[WASM 示例](examples/README.md)，回归命令与覆盖范围见[测试说明](docs/validation.md)。

## 配置与模块发布

`wrangler.jsonc` 声明 `BIZ` Durable Object 绑定与管理接口 Token。配置 `vars.CELLD_OPENAPI_TOKEN` 后，管理请求使用 `Authorization: Bearer <token>`；空 Token 禁用管理接口。

在 `wrangler.jsonc` 的 `vars` 中配置 `ROOT_DOMAIN` 与 `WASM_BASE`，两者均无默认地址：

```json
{
  "ROOT_DOMAIN": "apps.example.com",
  "WASM_BASE": "https://modules.example.com/wasm-modules"
}
```

`ROOT_DOMAIN` 为不含协议、端口和路径的根域名，业务入口为 `{bizId}.{ROOT_DOMAIN}`。`WASM_BASE` 为模块目录的 HTTP(S) URL，可含端口和路径，不允许凭据、query 或 fragment；末尾斜杠可省略。根域名缺失或无效时入口返回 503；模块地址缺失或无效时模块加载失败。

模块默认路径为 `{WASM_BASE}/{bizId}.wasm`。将构建后的模块上传到该位置，或通过管理接口指定模块对象：

| 接口 | 用途 |
| --- | --- |
| `GET /__inner__/status` | 查询业务模块配置、加载状态与错误 |
| `POST /__inner__/action/publish` | 校验并保存模块配置，下次事件加载新实例 |

管理接口使用业务子域名。publish 请求为 JSON：

```json
{
  "module": "wasm-modules/echo.wasm",
  "sha256": "<模块 SHA-256，64 位小写十六进制>",
  "size": 12345
}
```

发布前须运行静态校验和回归。平台与业务模块必须使用匹配的 Host ABI；回滚时恢复配套的平台和模块，保留已确认的业务数据。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | 路由、cell 生命周期、Host API 和 SQL 适配 |
| `sdk/host-api/` | Rust SDK |
| `examples/echo/` | HTTP 回显示例 |
| `examples/upper/` | 参数化 CRUD 示例 |
| `examples/vote/` | batch 与 alarm 示例 |
| `tools/validate-wasm/` | WASM 静态校验器与测试 fixture 生成器 |
| `test/` | 单元、ABI、运行时、预算和恢复测试 |
| `docs/` | Host ABI、隔离边界和测试说明 |

## 能力边界

- 业务使用独立 cell、SQLite、WASM instance 和线性内存，不提供 WASI 或业务出网 API。
- turn watchdog 限制同步 WASM/JavaScript 执行时间，不能保证 native SQL/IO 即时中断。
- 每 isolate 一个 cell 不等于每业务独占 CPU、内存、磁盘或进程；没有每业务硬配额。
- SQL 尾注释存在已知兼容性问题，测试保留对应断言。
- 多节点迁移、故障切换、OOM、磁盘耗尽、大库性能及真实 SQLite commit/rollback/IO 故障不在现有回归覆盖范围内。
- 不提供完整模块版本注册表、灰度发布或自动化回滚。

具体隔离语义见[执行与业务隔离边界](docs/cpu-isolation.md)。
