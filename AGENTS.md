# AGENTS.md

## 项目与边界

- 本仓库是 celld fork；`sited/` 是面向 WASM 业务的平台层。
- 核心诉求：以业务为单位横向扩容、数据持久化、scale-to-zero、业务隔离、独立发版。无需默认引入单业务多副本或分片。
- 业务能力放在 `sited/`；celld runtime 改动保持聚焦。`crates/logic` 负责纯状态与决策，`crates/celld` 负责效果执行与适配。
- `host-api` 是 WASM 调用宿主的接口；`admin-api` 是平台业务运维接口；节点、fleet、cell 管理由 celld 基础设施层负责。参见 [API 分层](sited/docs/api-overview.md)。
- 保持每业务独立 cell、数据库和 WASM 内存；Host 调用绑定当前业务。协议变更同步更新 JS、Rust SDK、静态校验器与规范。
- 域名和模块服务地址使用部署配置；不要将环境地址或凭据写入代码。

## 产物要求

- 文档、注释、示例和用户可见文字始终面向开发者/用户，描述最终行为与契约，不记录中间过程、演变原因或任务流水账。
- 详细接口与架构说明放入对应文档，AGENTS.md 仅保留必要约束与入口。
- fork 特有行为、接口、配置或限制变化时，同步维护 [与上游的差异](docs/fork-differences.md)；同步上游时核对基线与已合入上游的能力。
- 不提交构建目录、日志、测试证据或凭据；遵循 `.gitignore`。

## 验证

- 按改动范围选择验证，不把本地单节点测试通过表述为生产或多节点保证。
- Rust runtime 构建：仓库根目录执行 `cargo build --locked --release -p celld`；纯决策层测试：`cargo test --locked -p celld-logic`。
- sited 需要 Rust、Node.js 24、esbuild 和 `wasm32-unknown-unknown` target；在 `sited/` 执行 `bash test/build.sh` 构建模块、SDK 与校验器。
- JS 改动运行相关 `node test/<name>.mjs`；运行时回归显式传入本次改动对应的 celld binary，不依赖 PATH 中的版本。命令与覆盖限制见 [测试说明](sited/docs/validation.md)。
- 看门狗、事务终止和激活恢复改动使用对应 [fork 回归](docs/fork-differences.md#新增回归与验证范围)。修改持久化或所有权协议前阅读 [保证与存储契约](docs/guarantees.md)。
- 接口或配置变化同步更新文档；升级与回滚遵守 [运行文档](docs/README.md) 的版本和数据格式约束。
