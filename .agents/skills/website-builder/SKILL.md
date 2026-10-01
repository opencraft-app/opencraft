---
name: website-builder
description: 当用户要求建站、发布网页、制作个人主页或产品展示页，或在平台能力开放后发布带无状态后端的网站时使用。
---

# Vela 建站 Skill

## 概述

本 Skill 指导 AI 通过 Vela API 创建、发布和访问网站。静态托管始终按套餐权益使用；
只有能力门禁明确开放 `fetch-v1` 时，才可以发布带**无状态后端**的网站。
用户不需要任何云账号或密钥，Vela 统一托管网站资源。

**无状态后端不等于数据存储能力。** 当前支持所有者访问的计算与校验 API，
没有数据库、共享持久化或公开访客写入；每次请求也不保证保留内存。
必须先查询实际能力，再判断需求是否匹配，见「后端与数据能力检查」与「能力边界」。

## ⚠️ 面向用户的输出规范（最高优先级）

**以下所有技术细节仅供 AI 内部调用使用，严禁向用户展示。**

### 对用户说话时

- 把进度描述为简单的自然语言步骤，例如"正在为你创建网站…"、"正在生成网页…"、"正在部署…"、"部署完成！这是你的网站地址：…"
- 不要提及 API 路径、HTTP 方法、请求头、JSON 字段名、状态码、operation_id、release_id、bundle_id、pass_id 等内部标识
- 不要提及任何后端服务名称、云厂商名称、存储或托管产品名称。用户全程只需知道"Vela 帮你托管了网站"
- 不要展示 curl 命令、JSON 请求体、原始 API 响应
- 不要在代码块中输出 Python/JavaScript 脚本或 import 语句，用户不需要看到这些
- 不要输出"Running code"、"Updating tasks"等工具执行日志
- 用户问"怎么做到的"，回答"Vela 平台帮你托管了网站，你不需要关心底层细节"
- 遇到错误时用用户能理解的话翻译，例如配额超限说"你当前的套餐建站数量已满，可以删除旧网站或升级套餐"
- 部署过程中用一句简单的话报告进度即可，不要输出中间步骤的代码或日志

**唯一的例外**：用户想要的功能需要保存数据（留言板、表单收集、计数器等）时，
必须明确告诉用户"当前不支持保存共享数据，这个功能还做不了"；
不要把已开放的无状态后端也描述成不可用。
这是能力边界，必须说清楚，见「能力边界」一节。

### AI 内部执行时

以下技术细节仅用于 AI 自身调用 API，AI 可以参考但不输出给用户。

## 认证与 API 地址

每个实例拥有一个由平台预置的永久凭据（`VELA_WEBSITE_KEY`）。
凭据格式为 `vik_<key_id>_<secret>`，权限范围绑定该实例及其所属用户，
只能调用建站相关接口，不暴露任何账号级权限；凭据不得复制或外泄。

**取值方式**（按顺序取第一个非空值）：

1. 环境变量 `VELA_WEBSITE_KEY`
2. 都不可用 → 停下来提示用户需要先通过 Vela 平台初始化实例，**不要继续调用 API**

API 地址同样从平台预置的环境变量 `VELA_API_BASE` 获取。
如果该变量不存在，按站点归属取生产默认值：
国内 `https://api.lightvela.com`、国际 `https://api.lightvela.ai`。

**注意：只有 API 地址有默认值，凭据没有默认值。**
`VELA_WEBSITE_KEY` 不存在时必须立即停止，不允许继续调用 API。

读取示例（token 与地址都不要 echo 出来）：

```bash
# API 地址：有默认值（国内站），变量不存在时降级使用
API_BASE="${VELA_API_BASE:-https://api.lightvela.com}"

# 凭据：无默认值，变量不存在时直接报错退出（:? 语法）
KEY="${VELA_WEBSITE_KEY:?VELA_WEBSITE_KEY not set, instance not initialized}"
```

请求头：

```
Authorization: Vela-Instance-Key <key>
Content-Type: application/json
```

## 响应格式（所有接口统一）

所有成功响应的 HTTP 状态码为 200 或 201，响应体统一包裹为：

```json
{
  "code": "OK",
  "message": "success",
  "data": { ... },
  "request_id": "req-xxx"
}
```

**始终从 `data` 字段提取业务数据。** 错误响应的 `code` 为错误码字符串（见「错误处理」一节），`data` 可能为 null。

## 内部 API 参考（不向用户展示）

所有路径以 `/v1/websites` 为前缀，**不含** `/instance`。

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | /v1/websites/capability | 查询建站权益和用量 |
| POST | /v1/websites | 创建站点 |
| GET | /v1/websites | 列出已有站点 |
| GET | /v1/websites/{siteId} | 查询站点详情 |
| POST | /v1/websites/{siteId}/releases | 创建发布 |
| GET | /v1/websites/{siteId}/releases | 列出发布历史 |
| GET | /v1/websites/{siteId}/operations/{opId} | 查询操作状态 |
| DELETE | /v1/websites/{siteId} | 删除站点 |

## 完整流程

### 第一步：查询权益（内部）

调用能力查询接口，获取用户当前可用的建站配额。如果配额已满，用用户友好的方式告知，不要展示原始 JSON。

**请求：**

```
GET {API_BASE}/v1/websites/capability
```

无请求体。

**响应 `data` 字段：**

```json
{
  "max_sites": 1,
  "used_sites": 0,
  "monthly_traffic_bytes": 10737418240,
  "used_traffic_bytes": 0,
  "storage_bytes": 10737418240,
  "used_storage_bytes": 0,
  "max_artifact_size": 52428800,
  "max_files": 200,
  "backend": { "enabled": false },
  "data": { "enabled": false }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| max_sites | int | 最大站点数 |
| used_sites | int | 已用站点数 |
| monthly_traffic_bytes | int64 | 月流量配额（字节），0 表示不限 |
| used_traffic_bytes | int64 | 已用月流量（字节） |
| storage_bytes | int64 | 存储配额（字节） |
| used_storage_bytes | int64 | 已用存储（字节） |
| max_artifact_size | int64 | 单个制品最大字节数 |
| max_files | int | 单个制品最大文件数 |

**始终以本接口返回的实际值为准，不要写死数字。**

### 后端与数据能力检查（内部）

- 检查完整响应中的 `data.backend.enabled`（后端执行）和 `data.data.enabled`（服务端数据）。
- **字段缺失、null、未知值或不是布尔 true，一律按 false / 不可用处理。** 旧服务未返回这些字段时继续静态流程，不猜测能力。
- 默认后端与数据能力关闭。仅当 `data.backend.enabled` 为布尔 true 且 `data.backend.contract` 严格等于 `fetch-v1` 时，允许执行下面的 Fullstack Beta 流程。其他版本一律不可猜测接口。`data.data.enabled` 仍须独立检查。
- 静态 release 请求声明 `"kind": "static"`；旧客户端省略 kind 仍按静态处理。`fullstack` 必须携带 `backend_sha256` 并通过能力门禁；未知 kind 为参数错误。
- 能力未开放时，先说明限制，不生成假接口或用 localStorage 冒充共享数据。当前 Fullstack Beta 仅支持无状态、所有者访问的 API，不支持公开访客写入或持久化。用户需要这些能力时必须说明尚不支持，不能静默缩减需求。得到用户确认后才改做静态/无状态替代方案。
- 收到 `WEBSITE_BACKEND_UNAVAILABLE`：这是能力未开放，**不要重试**；不要删除 kind、改成 static 或降级上传原来的服务端代码。向用户说明后端能力当前不可用。

### Fullstack Beta：仅在 fetch-v1 能力门禁通过后执行

1. **先确认范围匹配。** 本版是无状态 `fetch(Request) -> Response`，后端 API 仅站点所有者登录后可访问，国际 public 静态域名也不例外。JS 模块每次调用不保证保留内存；没有数据库、任意出网、定时任务、WebSocket、任意 Node 进程、文件系统或 Secret 绑定。用户需求不匹配时停止并解释，不把“无状态计算 API”描述成数据库建站。
2. 目录必须分离：`public/` 放静态文件，`backend/app.mjs` 放单个预打包 ES module。不要把后台源码、`.env`、私钥、平台凭据或后端 source map 放进 public。后端形态：

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/sum" && request.method === "POST") {
      const { a, b } = await request.json();
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return Response.json({ error: "invalid input" }, { status: 400 });
      }
      return Response.json({ sum: a + b });
    }
    return new Response("Not found", { status: 404 });
  }
};
```

3. `public/index.html` 在应用 JS 执行之前声明版本标记，deployer 只在私有校验成功后把完整引号包裹的标记值替换为本次 release ID，保留同名 JavaScript 变量。标记必须使用普通单引号或双引号，不能只声明同名变量而不赋值：

```html
<script>globalThis.__LIGHTVELA_RELEASE_ID__="__LIGHTVELA_RELEASE_ID__";</script>
```

所有前端 API 请求必须同源并带 `X-Website-Release`；不要在浏览器里加入平台 Authorization 或实例密钥。写请求由浏览器自动提供真实 Origin，不要通过伪造 Origin 绕过验证：

```js
const response = await fetch("/api/sum", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "Content-Type": "application/json",
    "X-Website-Release": globalThis.__LIGHTVELA_RELEASE_ID__
  },
  body: JSON.stringify({ a: 2, b: 3 })
});
// 401: 引导所有者完成站点登录后重新操作；不要自动重放写请求。
// 409: 页面版本已过期，提示重新加载；不要用旧页面重试写操作。
// 429/502/503: 显示暂时不可用，不把失败提示成已保存成功。
```

4. 使用随 Skill 安装的打包器，按 capability 传入实际大小/文件数上限。打包器不上传、不运行后端；输出仅包含可用于 CreateRelease 的非敏感元数据：

```bash
python3 ~/.hermes/skills/website-builder/scripts/package_fullstack.py \
  --static-dir ./public --backend ./backend/app.mjs \
  --output ./artifacts/site-v1.zip \
  --max-files <capability.max_files> \
  --max-artifact-size <capability.max_artifact_size>
```

脚本缺失时停止并说明 Skill 交付不完整，不自行改成静态 zip。产物布局为根目录静态文件与私有 `__backend/app.mjs`；deployer 不会把后者写入静态 COS 路径。不要覆盖历史 zip，保留上一成功 release ID 与制品以供回退。

5. 创建 release 时使用打包器原样输出的 `kind=fullstack`、`backend_sha256`、`artifact_hash`、`artifact_size`、`file_count`。沿用后文签名上传流程，`data.upload_headers` 逐项原样提交；不得输出 `upload_url`、`VELA_WEBSITE_KEY` 或包含凭据的原始响应。后端 API 位于同站点 `/api`、`/api/*`；其它路径仍为静态资源。
6. 轮询 operation 到真实 success，并核对站点和 release。后台未就绪、摘要错误、配额拒绝或发布失败时保持旧站，不能报告成功。不要把 operation 创建成功/HTTP 200 当成已经发布。
7. 在所有者已登录的真实浏览器验证：页面、GET/POST 结果、非所有者拒绝、错误输入、重新发布后旧页面 409、刷新后恢复。没有浏览器登录态时明确标记“尚未完成所有者浏览器验收”，不生成假 cookie、不以内部调用替代公网验证。
8. 回滚使用 `POST {API_BASE}/v1/websites/{siteId}/rollback`，正文 `{ "release_id": "<previous-successful-release>" }`，继续轮询返回的 operation。仅可回到仍保留的静态/后端版本；制品不在时会失败，应使用保留的旧 zip 重新发布，不能宣称回滚成功。回滚前后都核对实际页面和 API。停用后 API 必须拒绝访问。

**运行限制：** 后端 JS 不超过 1 MiB，请求体不超过 1 MiB，响应体不超过 4 MiB；执行有 5 秒墙钟限制。首版不转发应用 cookie、任意身份头或跨域头，不支持后端重定向。不要编写依赖这些能力的应用。

### 第二步：需求澄清（与用户交互）

用自然语言与用户确认：
- 网站类型（个人主页/产品展示/落地页/文档站/作品集/活动介绍页）
- 设计风格（简约/科技/活泼）
- 主要内容板块
- 语言（中文/英文/双语）

**在澄清阶段就要识别出"需要保存数据"的需求**（留言、报名、投票、待办、计数器这类），
按「能力边界」一节当场告知用户当前不支持，并给出静态的替代方案。
不要先答应下来、生成完了再解释。

如果用户描述比较模糊，主动追问 1-2 个关键问题，不要一次问太多。

### 第三步：生成静态产物

#### 3.1 先做设计决策（内部，写代码之前）

动手写 HTML 之前，先在内部明确三件事，各一句话：

1. **用途**：这个站服务什么场景、给谁看
2. **美学方向**：例如克制的编辑风、明快的消费品风、硬朗的工业风、复古印刷风
3. **配色与字体**：具体到主色、强调色、正文字体族

没有这一步，模型会滑向默认模板，所有用户拿到的站长得一模一样。

**禁用清单**（除非用户明确要求）：

- 紫色 / 靛蓝 / 品红渐变背景
- `Inter`、`Roboto`、`system-ui` 作为主字体
- 纯居中的单卡片布局
- 用 emoji 充当图标

替代做法：从用途出发选字体（衬线体适合内容站、几何无衬线适合产品站）；主色从品牌或主题联想取，用同色系深浅拉层次而不是彩色渐变；布局按内容量决定，长内容用左对齐分栏而非居中卡片；需要图标时用内联 SVG。

#### 3.2 再生成文件

生成纯静态 HTML/CSS/JS 文件。**强烈建议生成单文件站点**（将 CSS 和 JS 内联到 index.html 中），这样只需上传 1 个文件，部署速度最快。

限制（**以第一步能力查询返回的值为准，不要写死数字**）：
- zip 总大小不超过 `max_artifact_size`
- 文件数不超过 `max_files`
- **首页必须是根目录下的 `index.html`**（不能放在子目录里，否则会被拒绝）
- 所有资源使用相对路径
- 不使用后端代码、数据库连接、API 密钥。平台只返回静态文件，站点没有任何服务端；
  页面里不需要也不允许出现任何凭据

**多页面必须用 hash 路由（`#/about`）或真实的 `.html` 文件。**
禁止使用 History 模式路由（`/about` 这种）——平台按对象路径直接返回文件，
没有"找不到就回退到 index.html"的能力，用户在子路由刷新页面会 404。

可以放一个根目录下的 `404.html`，访问不存在的路径时会自动生效。

### 第四步：创建站点（内部）

创建站点记录，拿到 `site_id` 和创建操作 ID（响应中的 `data.operation_id`）。
这个操作 ID 只代表站点记录的创建过程，记为 `create_operation_id`；
**它不是部署操作 ID，不要用它判断网站是否发布成功。**

**幂等键**：创建请求可带 `idempotency_key`。同一用户 + 同一幂等键最多只会建出一个站点，
由服务端唯一索引保证。**同一次建站任务的重试必须复用同一个 key**，
否则网络超时后的重试会重复建站并重复占用席位。
建议取值：本次建站任务的稳定标识（例如会话 ID + 站点名的哈希），不要每次随机生成。
不传该字段则不做去重。

**请求：**

```
POST {API_BASE}/v1/websites
```

请求体（JSON，字段名使用 snake_case）：

```json
{
  "name": "我的个人主页",
  "idempotency_key": "session-abc-我的个人主页"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 站点名称，最长 100 字符 |
| idempotency_key | string | 否 | 幂等键，同用户+同键只建一个站点 |

**响应（HTTP 201）：**

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "site_id": "ws-a1b2c3d4e5f6",
    "operation_id": "wo-x1y2z3w4"
  },
  "request_id": "req-xxx"
}
```

`data.site_id` 是站点的唯一标识，后续发布、查询、删除都用它。
`data.operation_id` 是站点创建操作 ID，记为 `create_operation_id`，**不要用它轮询部署状态**。

### 第五步：创建发布并上传（内部）

将静态文件打包为 zip，计算 sha256 哈希值和文件大小，创建发布并从响应中获取
`data.release_id`、`data.upload_url`、`data.upload_headers`、`data.upload_method` 和发布操作 ID
（`data.operation_id`，记为
`deploy_operation_id`），然后按 `data.upload_method` 上传 zip 到 `data.upload_url`。

`data.upload_url`、`VELA_WEBSITE_KEY` 和原始响应都属于敏感的内部操作数据，
不得输出、打印或写入日志。只从响应解析所需字段，不保留完整响应。

**后续只轮询 `deploy_operation_id`。** 创建站点和创建发布会各返回一个
`operation_id`，混用会把旧创建操作的结果误判为部署结果。

#### 5.1 打包并计算哈希

```bash
# 打包为 zip（确保 index.html 在根目录）
cd /tmp/website-build && zip -r site.zip . -x '*.DS_Store'

# 计算 sha256（64 位小写十六进制）
ARTIFACT_HASH=$(sha256sum site.zip | cut -d' ' -f1)

# 文件大小（字节数）
ARTIFACT_SIZE=$(stat -c%s site.zip)   # Linux
# ARTIFACT_SIZE=$(stat -f%z site.zip)  # macOS

# 文件数
FILE_COUNT=$(unzip -l site.zip | tail -1 | awk '{print $2}')
```

#### 5.2 创建发布

**请求：**

```
POST {API_BASE}/v1/websites/{siteId}/releases
```

请求体（JSON，字段名使用 snake_case，**三个字段全部必填**）：

```json
{
  "kind": "static",
  "artifact_hash": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
  "artifact_size": 45678,
  "file_count": 3
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| kind | string | 否 | 静态填写 static；省略兼容旧静态客户端；fetch-v1 能力通过时可填 fullstack |
| backend_sha256 | string | fullstack 必填 | 私有 app.mjs 的小写 SHA-256，静态发布不传 |
| artifact_hash | string | 是 | zip 文件的 sha256 哈希值，64 位小写十六进制 |
| artifact_size | int64 | 是 | zip 文件大小（字节数） |
| file_count | int | 是 | zip 内文件总数 |

**响应（HTTP 201）：**

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "release_id": "wr-a1b2c3d4",
    "operation_id": "wo-v9w8x7y6",
    "version": 1,
    "upload_url": "https://cos-bucket.cos.ap-shanghai.myqcloud.com/sites/ws-xxx/wr-xxx.zip?sign=xxx&expires=xxx",
    "upload_method": "PUT",
    "upload_headers": {
      "Content-Length": "45678",
      "x-cos-meta-artifact-sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456"
    }
  },
  "request_id": "req-xxx"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| release_id | string | 发布 ID |
| operation_id | string | 发布操作 ID，记为 `deploy_operation_id`，用于轮询部署状态 |
| version | int | 发布版本号，从 1 递增 |
| upload_url | string | 文件上传地址，敏感数据，不得输出 |
| upload_method | string | 上传 HTTP 方法（通常为 `PUT`） |
| upload_headers | map<string,string> | 服务端签名的上传请求头，必须原样使用 |

#### 5.3 上传 zip 文件

使用 `data.upload_method`（通常为 `PUT`）向 `data.upload_url` 发送请求：

```bash
curl -X PUT \
  -H "Content-Length: ${ARTIFACT_SIZE}" \
  -H "x-cos-meta-artifact-sha256: ${ARTIFACT_HASH}" \
  -H "Content-Type: application/zip" \
  --data-binary @site.zip \
  "${UPLOAD_URL}"
```

上传注意：
- `data.upload_headers` 是服务端签名的上传契约，必须同时包含
  `Content-Length` 和 `x-cos-meta-artifact-sha256`
- 校验 `Content-Length` 等于本地 zip 的实际字节数，校验
  `x-cos-meta-artifact-sha256` 等于本地计算出的 64 位小写 sha256
- PUT 时把 `data.upload_headers` 中每一项逐项原样作为请求头发送，再加
  `Content-Type: application/zip`；不要自行推导、改名、规范化或丢弃服务端返回的值
- `data.upload_headers` 缺失、上述任一必需头缺失或出现未知头时，按协议异常立即停止发布；
  不要尝试上传，也不要重新创建站点或发布

**上传成功后 COS 返回 HTTP 200，响应体为空。** 非 200 状态码视为上传失败。

#### 5.4 轮询部署状态

使用第五步拿到的 `deploy_operation_id`（不是创建站点的 `create_operation_id`）轮询：

**请求：**

```
GET {API_BASE}/v1/websites/{siteId}/operations/{deploy_operation_id}
```

无请求体。

**响应 `data` 字段：**

```json
{
  "operation_id": "wo-v9w8x7y6",
  "status": "success",
  "error_message": ""
}
```

| status 值 | 含义 | 动作 |
|-----------|------|------|
| created | 操作已创建，等待执行 | 继续轮询 |
| running | 正在执行 | 继续轮询 |
| success | 执行成功 | 部署完成，告知用户站点地址 |
| failed | 执行失败 | 停止，查看 error_message 并告知用户 |
| dead | 超过最大重试次数，终止 | 停止，告知用户部署失败 |

**轮询间隔：每 3 秒一次，最多轮询 60 次（约 3 分钟）。** 超时不算失败，
告诉用户"部署仍在处理中，稍等片刻后访问站点地址即可"。

#### 5.5 上传时机

- **创建发布后要尽快上传**：部署任务会等待制品出现（默认约 60 秒）。
  超过这个窗口未上传，部署会自动失败。拿到 `upload_url` 后立即 PUT。
- 上传完成后不需要额外通知服务端，deployer 会自动检测文件并继续部署。

### 第六步：验证站点可访问（内部）

部署成功后，查询站点详情获取访问地址：

```
GET {API_BASE}/v1/websites/{siteId}
```

从响应 `data.PublicURL` 字段（PascalCase）取出站点地址。
**创建站点的响应不包含此字段**——创建只返回 `site_id` 和 `operation_id`。

**首次访问可能延迟 10 秒左右**（DNS / CDN 刷新）。如果首次访问返回 404，
等待 10 秒后重试一次。不要把首次 404 当作部署失败。

### 部署完成后向用户输出

只用一句自然语言告知用户站点地址，不要输出任何技术细节：

> ✅ 网站已上线！访问地址：https://ws-xxx.lightvela.site/

## 列出已有站点（内部）

**请求：**

```
GET {API_BASE}/v1/websites?page=1&page_size=20
```

**响应 `data` 字段：**

```json
{
  "sites": [
    {
      "SiteID": "ws-a1b2c3d4",
      "Name": "我的个人主页",
      "Status": "active",
      "PublicURL": "https://ws-xxx.lightvela.site/",
      "CloudPath": "sites/ws-xxx/",
      "StorageBytes": 45678
    }
  ],
  "total": 1,
  "page": 1,
  "page_size": 20
}
```

**注意：`sites` 数组中的站点对象字段名为 PascalCase**（Go 默认序列化），与请求体和显式结果结构体的 snake_case 不同。主要字段：`SiteID`、`Name`、`Status`、`PublicURL`、`CloudPath`、`StorageBytes`。

## 查询站点详情（内部）

```
GET {API_BASE}/v1/websites/{siteId}
```

**响应 `data` 字段**（PascalCase，同上）：

```json
{
  "SiteID": "ws-a1b2c3d4",
  "Name": "我的个人主页",
  "Status": "active",
  "PublicURL": "https://ws-xxx.lightvela.site/",
  "CloudPath": "sites/ws-xxx/",
  "StorageBytes": 45678
}
```

站点 `Status` 可能的值：`active`（正常）、`suspended`（暂停，套餐过期）、`deleting`（删除中）。

## 列出发布历史（内部）

```
GET {API_BASE}/v1/websites/{siteId}/releases?page=1&page_size=10
```

**响应 `data` 字段：**

```json
{
  "releases": [
    {
      "ReleaseID": "wr-a1b2c3d4",
      "SiteID": "ws-xxx",
      "Version": 1,
      "Status": "active",
      "ArtifactHash": "a1b2...",
      "ArtifactSize": 45678,
      "FileCount": 3
    }
  ],
  "total": 1,
  "page": 1,
  "page_size": 10
}
```

**注意：`releases` 数组中的字段名同样是 PascalCase。**

## 删除网站流程

用户要求删除网站时，调用删除接口，然后确认删除成功。

**请求：**

```
DELETE {API_BASE}/v1/websites/{siteId}
```

无请求体。

**响应（HTTP 200）：**

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "operation_id": "wo-d1e2f3g4"
  },
  "request_id": "req-xxx"
}
```

`data.operation_id` 是删除操作 ID。按上面的同一套状态契约轮询：
`created` / `running` 继续，`success` 完成，`failed` / `dead` 停止并报告失败；
超时只表示删除仍在处理中，不要再次调用删除接口，也不要声称已经删除。

删除会清除站点的全部静态文件，不可恢复。页面内容重要时提醒用户先自行留一份。

**输出示例：**

> 🗑️ 网站已删除，相关资源已清理。

## 错误处理（翻译为用户语言）

错误响应的 HTTP 状态码为 4xx 或 5xx，响应体中的 `code` 字段为错误码字符串：

```json
{
  "code": "WEBSITE_QUOTA_EXCEEDED",
  "message": "quota exceeded",
  "data": null,
  "request_id": "req-xxx"
}
```

| 内部错误码 | 对用户说的话 |
|------------|-------------|
| WEBSITE_QUOTA_EXCEEDED | 你当前的套餐建站数量已满，可以删除不用的旧网站，或升级套餐 |
| WEBSITE_ARTIFACT_TOO_LARGE | 网站文件太大了，请精简图片或减少页面 |
| WEBSITE_FILE_COUNT_EXCEEDED | 网站包含的文件太多了，建议把样式和脚本合并到首页里 |
| WEBSITE_PASS_INACTIVE | 你的套餐已过期，续费后可以继续使用 |
| WEBSITE_NO_QUOTA | 你当前的套餐不包含建站功能，升级套餐即可使用 |
| WEBSITE_NOT_ACTIVE | 这个网站当前不可用，可能已暂停或正在删除 |
| WEBSITE_NOT_FOUND | 没有找到这个网站，可能已经被删除了 |
| WEBSITE_BACKEND_UNAVAILABLE | 当前还不能发布带后端的网站，可以先做纯静态版本 |
| WEBSITE_INVALID_PARAM | 网站配置有点问题，我调整一下重试 |

**WEBSITE_INVALID_PARAM 特别说明**：服务端会在 `data` 中附上具体原因（`details.reason`），
例如 `"name is required"`、`"artifact_hash is required"` 等。遇到此错误时检查请求体
是否缺少必填字段或字段名拼写错误（字段名必须是 snake_case），修正后重试。

### 重试上限（必须遵守）

- **任何情况下都不要为了重试而新建站点。** 每建一个站点就占一个席位，
  而入门套餐只有 1 个。重新发布用现有 site_id 即可，站点地址本来就固定不变。
- **首次访问 404 不算失败**，先按上文等 10 秒再自检，不要触发重试。
- 同一个站点**发布失败 2 次后停止重试**，转为告诉用户具体原因并给出可执行的建议
  （例如精简内容、合并文件），不要继续自动重发。
- 同一个原因连续出现 3 次，停止逐个打补丁，直接向用户说明根因。

## 能力边界

### 当前不能做的持久化及自建账号功能

- 留言板 / 评论区 / 评论系统
- 报名 / 报名表单 / 问卷 / 预约
- 电商下单 / 购物车 / 库存
- 自建用户注册 / 登录 / 个人中心（不包括平台提供的站点所有者登录）
- 访问计数器 / 投票 / 调查
- 待办清单、记账本、任何需要"下次打开还在"的记录
- 电商下单、库存、支付
- 自建账号注册登录、用户中心、持久化后台管理

**⛔ 绝对禁止：不要用 localStorage / sessionStorage / IndexedDB / cookie
糊一个"看起来能用"的版本。**

这是最容易犯的错。用 localStorage 存留言，在生成者自己的浏览器里测试完全正常，
于是被当成"做好了"交付。但它是**每台设备、每个浏览器各存各的**：

- 用户把链接发给朋友，朋友打开是空的——留言板收不到任何一条留言
- 用户换手机打开，自己写的内容也不见了
- 清一次浏览器数据，全部消失
- 站长永远看不到访问者提交的内容

也就是说，它不是"功能弱一点"，而是**根本没实现用户要的那件事**，
并且要等用户真的用起来、数据丢了才会发现。这比当场说"做不了"糟糕得多。

**正确处理方式**：当场告诉用户当前没有共享持久化，不能保存这些数据，
然后给出一个真的能用的替代方案，让用户明确选择：

| 用户想要 | 可行的替代 |
|---|---|
| 留言板 / 评论区 | 展示页 + 留下联系方式（邮箱、微信）让访客直接联系 |
| 报名 / 问卷 / 预约表单 | 页面里嵌入或链接到第三方表单（问卷星、腾讯问卷、Google Forms） |
| 电商下单 | 商品展示页 + 留联系方式询价 |
| 自建用户登录 / 个人中心 | 不涉及自建账号的内容页；平台提供的站点所有者登录仅用于保护后端 API |
| 访问计数器 / 投票 | 去掉，或改成静态的成果展示 |
| 待办 / 记账 | 说明做不了；如果用户只是想自己单机用，必须明确告知"数据只存在这台设备的这个浏览器里，换设备或清缓存就没了"，由用户确认后再做 |

**不要替用户假装做到了。** 宁可少一个功能，也不要交付一个会丢数据的版本。

## 注意事项

- 用户不需要也不应该接触任何云厂商密钥、环境标识或底层资源标识
- 站点访问地址由平台发布后返回，且**在站点生命周期内固定不变**；只使用接口返回值，不要自行拼接
- 站点 ID 为随机生成，不可被枚举
- **套餐到期后站点会真正下线**（访问地址不可用），网站内容被保留；续费后平台自动恢复，地址不变。
  用户问"过期了网站还在吗"时可以回答"内容会保留，续费后自动恢复访问"
- 套餐到期或销毁后站点会下线，但网站内容会保留；重新获得有效套餐后可以恢复访问
- 建站配额（站点数、单个制品大小、文件数）按套餐不同，**始终以能力查询接口返回的值为准**，不要写死数字
- 站点制品体积计入套餐的存储配额
- 所有技术过程（API 调用、文件上传、状态轮询）对用户透明，AI 用"正在部署…"等自然语言描述进度即可
- 部署过程中不要输出代码块、脚本内容或工具日志给用户
- **字段名大小写**：请求体（JSON）使用 snake_case（如 `artifact_hash`、`artifact_size`、`file_count`、`idempotency_key`）；响应中显式结果结构体也使用 snake_case（如 `site_id`、`operation_id`、`upload_url`）；但站点和发布实体对象使用 PascalCase（如 `SiteID`、`Name`、`Status`、`PublicURL`、`ReleaseID`、`Version`）。调用时注意区分，不要混用。
