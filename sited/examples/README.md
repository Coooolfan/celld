# WASM 示例

三个业务示例使用 [`sdk/host-api/`](../sdk/host-api/) 中的共享 Rust SDK，运行于 sited 的 `BizDataCell`。

在仓库根目录构建：

```bash
cd sited
bash test/build.sh
```

业务模块输出为 `examples/{name}/target/wasm32-unknown-unknown/release/{name}_wasm.wasm`。将模块上传到平台配置的 `WASM_BASE`，以 `{bizId}.wasm` 命名，或使用模块发布接口指定对象。平台配置见[项目说明](../README.md#配置与模块发布)。

## echo

| 接口 | 行为 |
| --- | --- |
| `GET /` | 文本回显页面，通过 POST 原样提交用户输入 |
| `POST /api/echo` | 原样返回 UTF-8 请求 body |
| `GET /run?input=...` | 返回 input 参数的原始编码值，不进行 URL 解码 |

echo 不提供 alarm handler。

## upper

| 接口 | 行为 |
| --- | --- |
| `GET /` | 文本大写与 CRUD 页面 |
| `GET /run?input=...` | 对参数原始编码值执行 ASCII 大写转换 |
| `GET /api/items` | 返回全部记录 |
| `GET /api/items/{id}` | 返回包含指定记录的数组；不存在时返回 404 |
| `POST /api/items` | 接收 `{"content":"text"}`，保存大写文本，返回 201 |
| `PUT /api/items/{id}` | 更新 content，返回更新后的记录 |
| `DELETE /api/items/{id}` | 删除记录；不存在时返回 404 |

大写转换仅作用于 ASCII 字母，其他字符保持原样。SQL 使用参数绑定，数据存储在当前业务的 SQLite 中。upper 不提供 alarm handler。

## vote

| 接口 | 行为 |
| --- | --- |
| `GET /` | 品牌投票页面 |
| `GET /api/results` | 返回各选项票数与总票数 |
| `POST /api/vote` | 接收 `{"option":"APPLE"}`，记录一票，返回 201 |
| `POST /api/batch` | 接收 `{"count":128}`，原子写入指定数量的 HUAWEI 票 |

选项为 HUAWEI、APPLE、INTEL，输入大小写不敏感。batch 数量必须为 1–128。该示例不提供身份验证或重复投票限制。

成功访问业务接口后会设置 alarm。alarm 每 60 秒记录总票数并设置下一次调度；它不修改票数。调度通过 SQLite 保存，cell 重载后保留。

## 测试

```bash
node test/abi-harness.mjs
node test/examples-runtime.mjs /absolute/path/to/celld
node test/platform-runtime.mjs /absolute/path/to/celld
```

ABI 测试检查 echo 与 upper 的接口和 Host 协议。示例运行时测试检查 echo 页面提交、upper CRUD、vote 投票和 batch 边界。平台运行时测试检查 alarm、重载与重启后的数据恢复。
