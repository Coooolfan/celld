# 失败激活资源清理回归

适用于 fork 的 v0.6.0 `sited`。验证 Restore 成功、class 注册缺失时的启动失败，不连接远程服务。

## 执行

需要 Rust、Python 3.11+、Node/npm（`celld dev` 构建使用），以及 `pgrep`、`lsof`。

```sh
rustc +1.94.1 --edition 2021 --test crates/logic/lib.rs -o /tmp/celld-failed-activation-state-tests
/tmp/celld-failed-activation-state-tests
python3 tests/failed-activation/verify.py /absolute/path/to/fixed/celld
python3 tests/failed-activation/verify.py /absolute/path/to/old/celld --expect-leak
```

每次测试创建独立临时项目、对象库和进程组。日志及 `report.json` 保留在输出的证据目录；测试退出时停止其 dev 监督器及节点。

## 验收范围

- 创建 LostCell 和 NeighborCell，持久化 SQL 行与 KV。
- 移除 LostCell 的 class 导出及绑定注册，保留历史数据，在隔离对象库注入旧 migration seed。周期扫描与 cleanup 均按 1 秒 tick 运行。
- 默认运行 30 轮邻居和根入口探测，再观察 5 秒；日志必须确认至少 30 次真实 class 缺失启动失败。
- 以 `lsof` 统计目标 cell 的 SQLite 描述符，分别统计 epoch 目录、文件数和逻辑文件大小。修复版采样不得超过 10 个 FD、3 个 epoch，文件大小不得持续增长超过 1 MiB；允许采样撞上短暂激活。
- 恢复 class 和绑定，验证原 SQL/KV 数据，再重启一次重复验证；邻居数据始终不变。
- `--expect-leak` 要求旧版 FD 至少增长 20 个且 epoch 增长，避免没有真正触发失败的假阳性。
- 5 项确定性状态机测试覆盖成功启动、失败清理等待与 RuntimeFailed 语义、resume 收尾、失去所有权后的迟到成功/失败、清理期间 fencing。重复 wake 和过期完成不能提前结束清理。

## 实现与限制

失败启动进入 `Cleaning(StartFailed)`，通过现有 Rebase stop 路径等待持久化确认并关闭副本；清理成功后才进入 Dormant。失去所有权的迟到完成只使用 Fence/CloseInPlace。复用快照后以非递归 `remove_dir` 回收空 epoch 目录，保留有内容的目录；未实现该可选操作的自定义文件系统可能留下空目录。

本回归不注入磁盘故障、对象存储网络失败或真实节点租约失效。状态机验证了“没有清理完成事件就不重激活”；执行器继续沿用现有失败重试机制，不将永久 I/O 故障视作成功释放。此修复不扫描或删除部署前积累的历史 epoch，也不消除缺失 class 的周期唤醒。
