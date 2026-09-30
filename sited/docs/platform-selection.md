# wasmCloud 与 celld/sited 选型

本文面向平台开发者，评估横向扩容、数据持久化、scale-to-zero、业务隔离、独立发版，以及部署与运维难度。横向扩容以业务为单位：增加节点以承载更多独立业务，不要求单个业务多副本并行。wasmCloud 能力基线为开源 v2.10 系列及官方 v2 文档，评估日期为 2026-09-30；celld 基线为本仓库 v0.6.0 fork 与 `sited/` 实现。本文是架构评估，不包含 wasmCloud 部署实测或两平台性能基准。

## 建议

**建议继续 celld fork。** 当前 sited 的运行单位是独立有状态业务：一个 `bizId` 对应一个 cell、SQLite 数据库、模块配置与 alarm。不同业务可分布到不同节点，符合以业务为单位扩容的要求；celld 的状态所有权、恢复与休眠模型也与这一结构匹配。单业务分片不是上线前置条件，多节点可靠性、业务独立发布与恢复演练仍是上线门槛。

部署与日常运维方面，celld 的基础组件较少，可使用 VM、systemd 或 Docker，无需为执行平台额外运营 Kubernetes、调度 operator 或消息控制总线。wasmCloud 的优势主要是标准化能力接口、Kubernetes 管理与 OCI/GitOps 发布；这些优势是否值得迁移，取决于团队是否已有对应基础设施，以及是否需要更多语言与能力接口。

这项判断来自状态模型与运维边界，不以已有投入作为依据。五项诉求本身没有规定必须使用每业务 SQLite；外部 PostgreSQL 同样可以满足持久化需求。

## 五项诉求对照

| 诉求 | celld fork + 当前 sited | wasmCloud 开源 v2 | 匹配判断 |
| --- | --- | --- | --- |
| 横向扩容 | 不同业务 cell 分布于 fleet；增加节点提高可承载的业务总量 | 不同业务 workload 调度到不同 host；host 池与机器容量另行扩展 | 两者满足，celld 与当前业务单位直接对应；无需单业务 HPA/KEDA |
| 数据持久化 | 每 cell SQLite，LTX 复制与对象存储；写响应受 durability proof 约束 | 通过 PostgreSQL、JetStream KV、Redis 等后端持久化；默认内存后端不能用于持久数据 | 两者可满足，管理责任与一致性模型不同 |
| scale-to-zero | 配置空闲驱逐后业务实例释放，HTTP/alarm 可恢复 cell；fleet 节点仍常驻 | 可按调用创建实例、回收空闲池或将 workload 副本降至零；host 仍常驻，零副本 HTTP 唤醒需接入方案 | 当前有状态业务的休眠与恢复偏向 celld |
| 业务隔离 | 独立数据库、WASM 内存与受限 Host ABI；共享进程与机器，无完整每业务硬配额 | Wasmtime、WIT 能力授权、网络限制与 Kubernetes 管理边界；共用 host 也共用进程资源 | wasmCloud 的管理与授权能力更完整；两者均需另设强资源隔离 |
| 独立发版 | 每业务发布模块配置，下次事件加载新实例；缺少完整版本、灰度与自动回滚 | 每业务可用独立 WorkloadDeployment 和 OCI 产物，接入 GitOps | wasmCloud 更完整；sited 已有基本发布入口 |

wasmCloud 扩容与 scale-to-zero 的具体边界见[自动扩容文档](https://wasmcloud.com/docs/kubernetes-operator/operator-manual/autoscaling/)，存储后端见[Host 接口配置](https://wasmcloud.com/docs/kubernetes-operator/host-interface-configuration/)。本项目能力见 [sited 使用说明](../README.md)、[cell 生命周期与持久化](../../docs/README.md)和[隔离边界](cpu-isolation.md)。

## 横向扩容与状态模型

celld 在一个时刻只允许一个节点拥有并服务某个 cell。当前路由 `BIZ.idFromName(bizId)` 将业务与状态单元对应，增加节点能提高不同业务的总容量。容量规划须确保单个业务能够装进一个节点，并为高负载业务配置限流或单独部署。持续繁忙的 resident cell 不会仅因加节点立即重新平衡；新增容量对新业务与可迁移空闲业务更直接，需要测量驱逐与迁移后的分布收敛，见[ownership balancing](../../README.md)。

wasmCloud 可以为每个业务建立独立 WorkloadDeployment，再分布到 host 池。其执行实例内存不能作为持久状态或唯一状态所有者；使用共享数据库时，仍需通过权限和事务维护隔离与正确性。当前需求不需要借助同业务多副本扩容，也无需为此引入 HPA/KEDA。

wasmCloud 区分实例池并发与跨 host 副本，见[并发与连接](https://wasmcloud.com/docs/kubernetes-operator/operator-manual/concurrency-and-connections/)。组件不是 Pod，不能直接用 Pod CPU/memory 指标做组件 HPA；需要外部指标，且 host 池和机器容量需分别管理。

## 持久化与恢复

celld 将状态复制、所有权 fencing、故障接管和写确认纳入 cell 生命周期。单节点依靠 bucket proof，多节点可通过 follower fsync 证明写持久化，再上传对象存储。RPO=0 受存储契约与故障模型限制，见[持久化保证](../../docs/guarantees.md)。当前 sited 回归未覆盖多节点迁移、真实磁盘故障与对象存储故障，不能把上游契约等同于本业务平台已经完成生产验证。

wasmCloud 可使用外部持久后端，但其执行平台不替数据库提供复制、备份、事务或故障恢复保证。选 PostgreSQL 时，应设置每业务独立角色与授权范围，并管理连接池、迁移、备份和恢复；Redis 还需明确持久化策略。官方接口列出了 PostgreSQL query/prepared，以及 KV 的内存、Redis、NATS、文件系统后端。内存后端会随实例或后端生命周期丢失，节点文件系统也不能直接视为多节点共享持久化。

**基于官方运行时与存储接口，本评估没有发现与 celld cell 等价的“每业务 SQLite + 单一所有者 + 自动复制恢复 + durable alarm”完整内置契约。** 保留该模型迁移需要自建状态服务或插件；只增加一个 SQLite 插件不能解决多节点所有权与恢复。[运行时与插件](https://wasmcloud.com/docs/runtime/)

## scale-to-zero 的三个层次

1. **执行实例归零**：业务空闲时不保留 WASM 实例，但共享 host 仍运行。两者都能提供这种经济模型。sited 需要设置 `CELLD_IDLE_EVICT_S`；wasmCloud 可不设置实例池，或设置池回收。
2. **业务部署副本归零并自动唤醒**：请求必须在没有副本时仍被接收，并触发扩容。wasmCloud 支持零副本，但普通 Service 的零 endpoint 不会自动缓冲首个 HTTP 请求；必须配置可在零副本时工作的入口激活或外部事件信号。官方自动扩容示例的最低副本为 1，不能直接作为 HTTP 从零唤醒方案。
3. **整个平台计算资源归零**：两者都需要额外的基础设施启停和外部唤醒机制。celld 的 fleet、wasmCloud 的 host 与控制组件均不是自动零成本，持久化也有费用。

HTTP 首次请求的下载、编译、状态恢复、调度与网络耗时应一起计量；WASM 实例化很快不能推导出端到端冷启动无延迟。

celld alarm 在 cell 不驻留时仍可唤醒状态。迁移后的定时执行需要持久调度器、任务存储与失败重投递机制；运行在业务副本内的循环或 timer 无法在副本归零后继续唤醒业务。此项是对生命周期的推论，不声称 wasmCloud 无法接入外部调度器。

## 隔离与配额

两平台均提供 WASM 线性内存隔离。sited 的 Host ABI 不暴露出网、文件系统或跨业务存储选择权；wasmCloud 提供更丰富的 WIT/WASI 授权与网络配置，但授权面也更大。数据库权限仍须在后端落实；不同 namespace 或不同接口绑定不自动等于数据隔离。

wasmCloud 的 HTTP 出网默认拒绝；raw socket 策略默认 `count`，需要明确开启 `enforce`。共享不可信业务 host group 不应启用同 host 本地路由，因为它绕过网络入口控制，且路由声明不证明域名所有权。[业务安全文档](https://wasmcloud.com/docs/kubernetes-operator/workload-security/)

wasmCloud 提供失控 guest 的 epoch 中断保护，但触发条件包括调用已超时或放弃、没有其他仍需执行的调用以及 guest 被判定阻塞；这不是固定每业务 CPU 时间片。[失控执行保护](https://wasmcloud.com/blog/wasmcloud-2-8-release/)

其 guest memory 总预算可启用 `enforce`，默认是 `count`；它针对 host 的 guest 内存，不等于每业务独享进程内存或 CPU。native 插件、数据库连接和宿主内存也需要资源余量。[内存预算](https://wasmcloud.com/blog/wasmcloud-2-9-release/)

需要进程故障、OOM 或 CPU 争抢不能影响其他业务时，应使用独立 host group/Pod 或独立 celld 进程，加上 cgroup、网络与存储配额。Kubernetes namespace 本身不把同一 host 内的组件分成独立进程。

## 独立发版与迁移成本

wasmCloud 可将业务分别编译为 Component Model 产物，推送 OCI registry，再更新各自 WorkloadDeployment。GitOps 可管理基础设施与业务各自的发布节奏；数据 schema 仍需兼容多版本并行与回滚。[CI/CD 与 GitOps](https://wasmcloud.com/docs/kubernetes-operator/operator-manual/cicd/)

sited 已支持每业务 publish，但目前仅在 publish 时核对 SHA-256 与大小，后续 `loadWasm()` 不重新核验下载字节。用于正式独立发布前，应使用不可变模块对象、每次加载核验、版本记录、回滚入口和数据迁移策略。直接覆盖默认 `{bizId}.wasm` 不能保证不同激活时刻加载同一版本。实现见 [cell.js](../src/cell.js)。

迁移涉及四类工作：

- **业务 ABI**：当前 `wasm32-unknown-unknown` 与 `celld_v3` imports 不能直接作为 wasmCloud 原生组件发布；需 WIT/Component Model 适配并重新构建。SDK 可以封装差异，但 SQL 与事务语义仍需调整。
- **业务数据**：SQLite schema、数据与同步 batch 迁往 PostgreSQL 等后端时，需要处理 SQL 方言、类型、并发事务和一致切换；代码回滚不会自动回滚数据。
- **业务生命周期**：alarm、幂等、重投递和每业务状态归属需要明确替代实现。
- **平台运维**：主要集群方案需要 Kubernetes、runtime-operator、NATS 控制通信、host、OCI registry；按需求再接入数据库、指标服务、KEDA 和入口激活。开源版本不需要购买托管产品才能使用上述公开能力。

wasmCloud v2 的主线集群架构使用 Kubernetes CRD，NATS 负责 operator 与 host 的控制通信；也可嵌入 `wash-runtime`，但自建调度需自行承担控制职责。不要按 v1 的 wadm/lattice 架构估算 v2 运维成本。[v2 架构](https://wasmcloud.com/docs/migration/)

## 部署与运维难度

以下难度判断基于组件依赖和操作职责，假设团队从普通 VM 与托管对象存储开始，没有现成的 Kubernetes/数据库/GitOps 平台，不代表实测工时。

| 工作 | celld fork + sited | wasmCloud 开源 v2 |
| --- | --- | --- |
| 首次生产部署 | 中：构建 fork binary、节点配置、对象存储、私网、入口、模块服务、进程监管 | 较高：Kubernetes、Helm/CRD、operator、NATS、host 池、OCI、入口，以及持久后端和调度 |
| 增加承载业务的节点 | 较低：准备本地磁盘、私网地址和同一 bucket 配置，启动节点并检查健康与业务分布 | 中：扩 host 池，必要时扩机器；检查调度、host 容量和数据库连接余量 |
| 单个业务发布 | 较低，但需补齐：上传不可变 WASM、发布业务配置、检查结果 | 中且标准化：构建/推送 OCI、更新业务 manifest，检查 workload 状态 |
| 日常基础组件维护 | 中：节点、对象存储契约/费用、本地磁盘、模块服务、证书与密钥 | 较高：执行层之外还需维护控制组件、集群网络与数据库；已有平台时增量负担明显下降 |
| 监控与排障 | 组件链路短，但需了解 cell ownership、fencing、复制日志和 V8；接入告警与业务维度仪表盘 | 工具体系较完整，但需区分 ingress/Service、operator、NATS、host、接口绑定与数据库故障 |
| 运行时升级 | 中到高：自行构建与回归，逐项确认协议/数据格式和回滚条件 | 中到高：协调 chart、CRD、operator、host、接口版本，并验证 drain 和数据库兼容 |
| 数据备份与恢复 | 中到高：持久副本不等于备份，fleet 模式不能只假设 bucket 已包含全部已确认写入 | 中到高：数据库/PVC/JetStream 的备份、权限、任务状态，以及集群配置恢复 |
| 底层执行或复制故障 | 高：fork 维护者承担定位、修复、回归和上线责任 | 中到高：减少自维护运行时补丁，可使用上游问题与发布渠道；业务和插件故障仍由团队负责 |

wasmCloud 的官方 Helm 方案部署 operator、NATS 与 host group，HTTP 通过 Service/EndpointSlice 路由；对当前需求可固定每业务所需副本数，无需 HPA/KEDA、指标适配器或 GitOps 才能运行。GitOps 与可观测设施按团队需求接入。[operator 架构](https://wasmcloud.com/docs/kubernetes-operator/operator-manual/overview/)

官方还提供 K3s + Docker Compose 示例，能降低试用门槛，但内部仍运行 Kubernetes 与上述控制组件，并使用已弃用的 gateway；不宜直接等同于完成了生产高可用设计。[轻量部署](https://wasmcloud.com/docs/kubernetes-operator/operator-manual/lightweight-deployments/)

### celld/sited 的生产部署组成

建议先采用托管、满足条件写入契约的对象存储，避免同时承担运行时和自建存储集群的可靠性工作。生产组成包括：

- **celld 节点**：至少两个节点才有 follower proof；需要更高故障余量时配置三个及以上，数量按故障目标确定。各节点有稳定身份、持久本地目录、健康检查、自动重启与优雅停止。
- **共享 bucket**：保存部署、所有权、复制数据与 wake 信息。凭证属于 fleet 管理权限，必须控制访问，并监控请求错误与费用。
- **可信节点网络**：internal listener 仅在私网或加密 overlay 可达，公开 HTTP 入口经负载均衡和 TLS。节点之间可以转发到业务 owner。
- **业务模块服务**：存放不可变 WASM，提供受控下载与每业务发布；业务模块服务可以独立于 fleet bucket，但需保障 HTTP 可达性与产物一致性。
- **部署与运维自动化**：构建并记录 fork commit/产物摘要，统一配置、监控、升级、备份与恢复命令。

celld 提供单进程部署、诊断和健康接口，但 `sited/` 尚没有完整的生产部署包；不能把可运行示例视为部署自动化已完成。具体节点、网络和 supervisor 契约见[运行文档](../../README.md)与[保证文档](../../docs/guarantees.md)。

### 升级与恢复约束

celld 文档允许兼容版本逐节点优雅升级，但明确列出跨版本例外。例如 v0.5.1 → v0.6.0 使用 fleet durability 时要求全停升级；wake 格式迁移也有禁止旧写者返回的约束。数据格式升级后的回滚可能要求恢复完整备份，不能统一采用“换回旧 binary”。这些是运行时升级限制，业务 WASM 发版应使用独立流程。[升级与停止](../../docs/README.md)、[格式迁移](../../docs/guarantees.md#start-a-fleet-with-this-format)

wasmCloud 的 Kubernetes 工具能自动化资源更新，但不自动证明版本兼容。升级时仍需协调 CRD、chart 和 host；Helm 对 `crds/` 的升级存在单独处理要求。数据库 schema 与业务代码回滚也必须分别安排。[CRD 升级注意事项](https://wasmcloud.com/docs/kubernetes-operator/workload-security/)

### 运维结论

**在以业务为单位扩容、希望少组件部署的前提下，celld 的部署与常规运维负担更小；fork 的可靠性工程负担更大。** 应限制 runtime 补丁范围，将发布和配额等产品能力放到 sited，避免自行扩建一套通用编排平台。

若已有受管理的 Kubernetes、数据库、registry、GitOps 和值班体系，wasmCloud 的额外运维难度可降至中等，其标准工具与上游维护价值更突出。托管设施会减少组件操作工作，但仍需评估固定成本、业务数据隔离与 alarm 替代方案。

## 选型条件与上线标准

| 条件 | 选择 |
| --- | --- |
| 以业务为单位扩容、独立有状态业务、空闲时释放实例，重视部署简洁 | 继续 celld fork |
| 已有 Kubernetes/数据库/GitOps 运维体系，需要标准 WIT 接口与更丰富语言生态 | wasmCloud 的收益提高，可按完整业务契约验证后决定迁移 |
| 每业务必须有独立 CPU/内存/进程故障边界 | 两者都配置独立进程/Pod，按隔离成本再选 |
| 要求平台节点归零且首个请求自动唤醒 | 两者都需外部激活方案，单靠运行时不能满足 |

继续 fork 的必要工作是：验证业务跨节点分布与故障接管；补齐不可变模块与加载校验；建立每业务流量、存储和执行配额；提供可重复的部署、升级与恢复操作。runtime fork 应保持聚焦，通用修复尽量同步上游，业务发布与配额放在 sited。

迁移决策应至少满足以下可验收标准，不以简单 hello-world 为依据：

| 项目 | 标准 |
| --- | --- |
| 扩容 | 多业务从 1 到 N 节点后可承载业务数与总吞吐提高；验证新增业务分布、空闲业务迁移与故障恢复，数据无丢写或错误重复 |
| 持久化 | 已确认写入在杀进程、丢节点和恢复后保持正确；明确网络分区与多副本故障范围 |
| 从零唤醒 | 空闲实例释放；HTTP 首个请求和持久任务均能恢复执行，记录端到端 p95/p99 |
| 隔离 | 死循环、memory.grow、SQL 重负载和连接耗尽时，邻居业务延迟与错误率符合服务目标 |
| 发布 | A 更新/回滚不影响 B；版本字节可验证，schema 与旧代码兼容 |
| 成本 | 对比低活跃业务规模下总内存、数据库连接、持久化 IO、控制组件费用及运维工作 |

现有 [sited 测试](validation.md)可以复用业务断言；多节点、资源故障与真实冷启动需要专门环境。只迁移 echo、upper 的 CRUD 无法证明 durable alarm、状态接管或生产隔离满足要求。
