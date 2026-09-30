# 测试说明

以下命令在 `sited/` 下执行。需要 Rust、Node.js 24、esbuild、WASM target 和本仓库的 celld binary。先执行构建脚本生成测试依赖的 WASM 与静态校验器。

```bash
bash test/build.sh
node test/sql.mjs
node test/abi-harness.mjs
node test/cell.mjs
node test/budgets.mjs
node test/wasm-adversarial.mjs
node test/sql-runtime.mjs /absolute/path/to/celld
node test/sql-tail-runtime.mjs /absolute/path/to/celld
node test/sql-termination.mjs /absolute/path/to/celld
node test/module-runtime.mjs /absolute/path/to/celld
node test/examples-runtime.mjs /absolute/path/to/celld
node test/platform-runtime.mjs /absolute/path/to/celld
```

## 覆盖范围

- 参数化 SQL、值编码、结果提取、预算、权限和常规事务错误。
- WASM 签名、imports、exports、memory 上限、start section 和 ABI 标识。
- HTTP/alarm 来源隔离、实例恢复、失败不自动重放和 alarm 幂等。
- 同步 turn 超时与同步事务硬终止后的数据和连接恢复。
- 模块加载、发布、管理鉴权与本地存储恢复。
- echo 页面原文回显、upper CRUD、vote 投票与 batch 数量边界。

运行时测试启动本地 celld，使用临时存储。`sql-tail-runtime.mjs` 包含 SQL 尾注释兼容性断言；该已知问题会使对应测试失败。

## 覆盖限制

测试不覆盖真实 SQLite commit/rollback/native IO 故障注入、多节点迁移与故障切换、OOM、磁盘耗尽、长期资源压力或生产部署。测试成功仅表示对应断言通过。

接口契约见[Host ABI 规范](host-abi-spec.md)，资源边界见[执行与业务隔离边界](cpu-isolation.md)。
