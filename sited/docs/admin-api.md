# Admin API

admin-api 用于业务 SCOPE 查询、模块发布与状态查询。请求发往业务子域名 `https://{bizId}.{ROOT_DOMAIN}`，路径由平台处理，不进入业务 WASM handler。

## 鉴权

在 `wrangler.jsonc` 的 `vars.CELLD_OPENAPI_TOKEN` 中配置非空 Token。所有 admin-api 请求必须携带：

```http
Authorization: Bearer <token>
```

Token 缺失、不匹配或平台 Token 为空时返回 `401`，正文为 `{"error":"unauthorized"}`。当前 Token 是全平台管理员权限，不支持按业务授权。

`ROOT_DOMAIN` 和 `WASM_BASE` 的配置要求见[配置与模块发布](../README.md#配置与模块发布)。根域名缺失或无效时入口返回 `503`。

## 查询业务 SCOPE

```bash
curl 'https://echo.<ROOT_DOMAIN>/__inner__/scope' \
  -H 'Authorization: Bearer <token>'
```

成功返回 `200 application/json`，并设置 `Cache-Control: no-store`：

```json
{
  "bizId": "echo",
  "scope": "BizDataCell:<64 位小写十六进制 ID>"
}
```

平台使用 `env.BIZ.idFromName(bizId)` 计算 ID，再以 `BizDataCell:<ID>` 返回 celld SCOPE。同一 BIZ namespace 和 bizId 的计算结果确定；更换 namespace 或业务标识后不能沿用原 SCOPE。

接口仅支持 GET；鉴权通过后使用其他方法返回 `405` 和 `Allow: GET`。查询不创建 cell stub、不激活业务 cell、不读取数据库或下载 WASM，不要求业务模块存在，也不依赖 `WASM_BASE`。返回值不表示业务已发布、正在运行或属于某个节点。

返回的 SCOPE 可用于 celld 内部 `POST /evict/<SCOPE>`。该操作仅驱逐目标节点上的实例；遍历节点时需检查各节点响应，对暂时无法驱逐的实例重试。查询 SCOPE 与驱逐都不阻止后续请求重新激活业务。

## 查询模块状态

```http
GET /__inner__/status
```

成功返回 `200 application/json`：

```json
{
  "bizId": "echo",
  "status": "ready",
  "moduleHash": "<64 位小写 SHA-256>",
  "moduleSize": 12345,
  "loaded": false,
  "lastError": null,
  "module": "wasm-modules/releases/echo-v1.wasm"
}
```

| 字段 | 语义 |
| --- | --- |
| `bizId` | 当前业务标识 |
| `status` | 有最近错误时为 `error`；存在已发布模块配置时为 `ready`；否则为 `empty` |
| `moduleHash`、`moduleSize`、`module` | 已发布配置；未配置时为 `null` |
| `loaded` | 当前 cell 是否持有 WASM runtime |
| `lastError` | 当前或持久化的最近模块加载错误；无错误时为 `null` |

`ready` 表示存在模块配置，不保证当前已加载或业务健康。未发布配置的业务仍可从默认 `{WASM_BASE}/{bizId}.wasm` 加载模块，因此可能同时出现 `status: "empty"` 和 `loaded: true`。状态查询会经 celld 定位或激活业务 cell，不执行业务 handler。

## 发布模块配置

```http
POST /__inner__/action/publish
Content-Type: application/json
```

```json
{
  "module": "wasm-modules/releases/echo-v1.wasm",
  "sha256": "<64 位小写 SHA-256>",
  "size": 12345
}
```

发布前先上传模块至配置的模块服务，并运行[静态校验与回归](validation.md)。`module` 必须以 `wasm-modules/` 开头，不允许 `..`、反斜杠或末尾斜杠；`sha256` 为 64 位小写十六进制；`size` 为不超过 16 MiB 的非负整数。

平台将 `module` 的 `wasm-modules/` 前缀去除，拼接到 `WASM_BASE`。例如上述模块下载自 `{WASM_BASE}/releases/echo-v1.wasm`。接口不接收或上传 WASM 文件。

平台下载模块，核对大小与 SHA-256，并尝试建立 Host runtime。成功后保存模块配置，清空当前 runtime 引用与最近错误；下次事件加载新实例，业务数据库保留。成功返回 `200`，字段与状态响应一致，`status` 为 `ready`，`loaded` 为 `false`。

| HTTP 状态 | 正文 | 含义 |
| --- | --- | --- |
| `400` | `{"error":"invalid JSON"}` | 正文不能解析为 JSON |
| `400` | `{"error":"invalid module"}` | 模块路径、哈希或大小字段无效 |
| `405` | `method not allowed` | publish 使用了非 POST 方法 |
| `422` | `{"error":"module hash or size mismatch"}` | 下载字节与声明不一致 |
| `422` | `{"error":"module rejected"}` | 下载、配置、实例校验或保存失败 |

运行时检查不能替代发布前静态校验。当前重新加载模块时不重新核对已保存哈希，模块服务应使用不可变版本路径。接口没有版本历史、专用回滚或数据迁移机制；重新发布旧模块时必须确保旧代码与当前数据库兼容。

## 接口范围

当前仅提供上述三个接口。其他 `/__inner__/` 路径返回 `404`；公开业务路径不能触发 alarm 或 dispose。celld 的节点健康、部署 reload、shutdown、cell 操作与复制协议属于[基础设施 API](api-overview.md)，不使用本接口的 Token。
