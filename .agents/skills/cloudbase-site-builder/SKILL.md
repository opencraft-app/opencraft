---
name: cloudbase-site-builder
description: 使用 Vela 托管 CloudBase 静态建站能力，为用户创建和发布静态网站。当用户要求建站、创建网站、部署网页、发布站点时使用。
---

# Vela 静态建站 Skill

## 概述

本 Skill 指导 AI 通过 Vela API 完成静态网站的创建、发布和访问。用户不需要腾讯云账号或密钥，Vela 主账号统一管理 CloudBase 资源。

## 前置条件

- 用户已登录 Vela 并持有有效的 session
- 用户当前套餐包含建站权益（1/3/10 个站点席位）
- 所有 API 调用通过 service-gateway 鉴权后转发到 ctl

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /v1/websites/capability | 查询建站权益和用量 |
| POST | /v1/websites | 创建站点 |
| GET | /v1/websites | 列出站点 |
| GET | /v1/websites/{siteId} | 查询站点详情 |
| POST | /v1/websites/{siteId}/releases | 创建发布 |
| GET | /v1/websites/{siteId}/releases | 列出发布历史 |
| GET | /v1/websites/{siteId}/operations/{opId} | 查询操作状态 |
| DELETE | /v1/websites/{siteId} | 删除站点 |

## 完整流程

### 第一步：查询权益

```
GET /v1/websites/capability
```

返回示例：
```json
{
  "max_sites": 3,
  "used_sites": 0,
  "monthly_traffic_bytes": 5368709120,
  "used_traffic_bytes": 0,
  "storage_bytes": 209715200,
  "max_artifact_size": 20971520,
  "max_files": 500,
  "daily_deploy_limit": 10
}
```

如果 `used_sites >= max_sites`，告知用户额度已满。
如果返回 `WEBSITE_NO_QUOTA` 错误，告知用户当前套餐不含建站权益。

### 第二步：需求澄清

与用户确认：
- 网站类型（个人主页/产品展示/落地页/文档站）
- 设计风格（简约/科技/活泼）
- 主要内容板块
- 语言（中文/英文/双语）

### 第三步：生成静态产物

生成纯静态 HTML/CSS/JS 文件。限制：
- 总大小不超过 `max_artifact_size`
- 文件数不超过 `max_files`
- 首页必须是 `index.html`
- 所有资源使用相对路径
- 不使用后端代码、数据库连接、API 密钥

### 第四步：创建站点

```
POST /v1/websites
{
  "name": "用户站点名称",
  "bundle_id": "从用户当前Pass获取",
  "pass_id": "从用户当前Pass获取"
}
```

返回示例：
```json
{
  "site_id": "ws-12345",
  "operation_id": "wo-67890"
}
```

### 第五步：创建发布

```
POST /v1/websites/{siteId}/releases
{
  "artifact_hash": "sha256:abc123...",
  "artifact_size": 102400,
  "file_count": 15
}
```

返回示例：
```json
{
  "release_id": "wr-11111",
  "operation_id": "wo-22222",
  "version": 1,
  "upload_url": "https://...",
  "upload_method": "PUT"
}
```

### 第六步：上传制品

将静态文件打包为 zip，通过 PUT 请求上传到 `upload_url`。

### 第七步：轮询操作状态

```
GET /v1/websites/{siteId}/operations/{operationId}
```

状态：`created` → `running` → `success` / `failed`

### 第八步：返回结果

部署成功后，站点访问地址为：
```
https://{vela-domain}/s/{siteId}/
```

将此 URL 返回给用户。

## 错误处理

| 错误码 | 说明 | 处理 |
|--------|------|------|
| WEBSITE_QUOTA_EXCEEDED | 站点数超限 | 告知用户升级套餐或删除旧站点 |
| WEBSITE_ARTIFACT_TOO_LARGE | 制品过大 | 压缩或减少资源 |
| WEBSITE_DEPLOY_LIMIT_EXCEEDED | 发布频率超限 | 等待次日 |
| WEBSITE_PASS_INACTIVE | Pass未激活 | 告知用户续费 |
| WEBSITE_NO_QUOTA | 套餐不含建站 | 告知用户升级套餐 |

## 注意事项

- 用户不需要也不应该接触腾讯云密钥、CloudBase 环境 ID 或 CLI
- 站点访问必须经过 Vela 的 `/s/{siteId}/` 代理，不直接暴露 CloudBase 域名
- 流量计量由 Vela 代理完成，用户看到的是套餐内额度
- Pass 到期后站点自动暂停，续费后恢复
