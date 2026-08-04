---
name: cloudbase-site-builder
description: 使用 Vela 托管 CloudBase 静态建站能力，为用户创建和发布静态网站。当用户要求建站、创建网站、部署网页、发布站点时使用。
---

# Vela 静态建站 Skill

## 概述

本 Skill 指导 AI 通过 Vela API 完成静态网站的创建、发布和访问。用户不需要腾讯云账号或密钥，Vela 主账号统一管理所有后端资源。

## ⚠️ 面向用户的输出规范（最高优先级）

**以下所有技术细节仅供 AI 内部调用使用，严禁向用户展示。**

### 对用户说话时

- 把进度描述为简单的自然语言步骤，例如"正在为你创建网站…"、"正在生成网页…"、"正在部署…"、"部署完成！这是你的网站地址：…"
- 不要提及 API 路径、HTTP 方法、请求头、JSON 字段名、状态码、operation_id、release_id、bundle_id、pass_id 等内部标识
- 不要提及 任何 后端服务名称
- 不要展示 curl 命令、JSON 请求体、原始 API 响应
- 不要在代码块中输出 Python/JavaScript 脚本或 import 语句，用户不需要看到这些
- 不要输出"Running code"、"Updating tasks"等工具执行日志
- 用户问"怎么做到的"，回答"Vela 平台帮你托管了网站，你不需要关心底层细节"
- 遇到错误时用用户能理解的话翻译，例如配额超限说"你当前的套餐建站数量已满，可以删除旧网站或升级套餐"
- 部署过程中用一句简单的话报告进度即可，不要输出中间步骤的代码或日志

### AI 内部执行时

以下技术细节仅用于 AI 自身调用 API，AI 可以参考但不输出给用户。

## 认证与 API 地址

所有请求需要携带用户的 Bearer Token。获取方式：

1. 从环境变量 `VELA_AUTH_TOKEN` 读取（Vela 机器上自动注入）
2. 如果环境变量不存在，从 `~/.vela/auth-token` 文件读取
3. 如果都不可用，提示用户需要先登录 Vela

API 地址：从环境变量 `VELA_API_BASE` 读取，默认 `https://lightclaw.tech`

请求头：`Authorization: Bearer <token>` + `Content-Type: application/json`

## 内部 API 参考（不向用户展示）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | /v1/passes | 获取用户当前套餐信息 |
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

### 第二步：获取套餐信息（内部）

获取用户当前 Pass 信息，提取 pass_id 和 bundle_id 用于后续创建。

### 第三步：需求澄清（与用户交互）

用自然语言与用户确认：
- 网站类型（个人主页/产品展示/落地页/文档站）
- 设计风格（简约/科技/活泼）
- 主要内容板块
- 语言（中文/英文/双语）

如果用户描述比较模糊，主动追问 1-2 个关键问题，不要一次问太多。

### 第四步：生成静态产物

生成纯静态 HTML/CSS/JS 文件。**强烈建议生成单文件站点**（将 CSS 和 JS 内联到 index.html 中），这样只需上传 1 个文件，部署速度最快。

限制：
- 总大小不超过能力查询返回的 max_artifact_size（当前 10MB）
- 文件数不超过 max_files（当前 500）
- 首页必须是 index.html
- 所有资源使用相对路径
- 不使用后端代码、数据库连接、API 密钥

### 第五步：创建站点（内部）

创建站点记录，拿到 site_id 和 operation_id。

### 第六步：创建发布并上传（内部）

将静态文件打包为 zip，计算 sha256 哈希值和文件大小，创建发布获取上传 URL，然后 PUT 上传 zip 到该 URL。

上传注意：
- Content-Type: application/zip
- 不需要 Authorization 头（预签名 URL 自带鉴权）
- URL 有效期 1 小时

### 第七步：等待部署完成（内部）

轮询操作状态，状态变化：created → running → success / failed。每 3 秒轮询一次，最多等待 2 分钟。

### 第八步：返回结果（面向用户）

确认发布完成后，再查询一次站点详情，读取系统返回的站点访问地址并直接告诉用户。不要自行拼接或改写该地址。地址格式形如 `https://{env-id}-{app-id}.tcloudbaseapp.com/...`。

**输出示例（参考风格）：**

> ✅ 网站部署完成！
>
> 🌐 访问地址：https://example-env-1234567890.tcloudbaseapp.com/sites/ws-a1b2c3d4/releases/wr-xxx/index.html
>
> 你的网站已经上线，可以通过这个链接访问。如果需要修改内容，告诉我重新部署即可。

## 错误处理（翻译为用户语言）

| 内部错误码 | 对用户说的话 |
|------------|-------------|
| WEBSITE_QUOTA_EXCEEDED | 你当前的套餐建站数量已满，可以删除不用的旧网站，或升级套餐 |
| WEBSITE_ARTIFACT_TOO_LARGE | 网站文件太大了，请精简图片或减少页面 |
| WEBSITE_PASS_INACTIVE | 你的套餐已过期，续费后可以继续使用 |
| WEBSITE_NO_QUOTA | 你当前的套餐不包含建站功能，升级套餐即可使用 |

## 删除网站流程

用户要求删除网站时，调用删除接口，然后确认删除成功。

**输出示例：**

> 🗑️ 网站已删除，相关资源已清理。

## 注意事项

- 用户不需要也不应该接触腾讯云密钥、环境 ID 或任何底层资源标识
- 站点访问地址由平台发布后返回
- 站点 ID 为随机生成，不可被枚举
- 套餐到期后站点自动暂停，续费后恢复
- 所有技术过程（API 调用、文件上传、状态轮询）对用户透明，AI 用"正在部署…"等自然语言描述进度即可
- 部署过程中不要输出代码块、脚本内容或工具日志给用户
