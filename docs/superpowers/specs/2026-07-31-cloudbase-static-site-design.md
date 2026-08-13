# CloudBase 静态建站权益 — 详细设计

> 分支: `codex/cloudbase-static-site`
> 日期: 2026-07-31
> 状态: 设计稿，待虾米老师确认后开始实现

## 1. 目标

Vela 主账号持有 CloudBase 环境，按套餐给用户分配静态站点席位。用户通过 AI Skill 调用 Vela API 完成建站，不接触腾讯云密钥。

一期只做静态网站。不做云函数、数据库、动态后端、用户自定义域名。

## 2. 套餐配额

### 2.1 席位档位

| 套餐档位 | 可建站点数 | 月流量(GB) | 存储(MB) | 单次制品(MB) | 发布频率(次/日) |
|---------|-----------|----------|---------|------------|---------------|
| free    | 1         | 1        | 50      | 10         | 5             |
| basic   | 3         | 5        | 200     | 20         | 10            |
| pro     | 10        | 20       | 500     | 50         | 20            |

运营在 bundle 表新增 `static_site_quota` 列，存 JSON：`{"max_sites":1,"monthly_traffic_bytes":1073741824,...}`。
默认值 `0`（不包含建站权益）。

### 2.2 存量用户处理

5 万注册用户不批量迁移。采用**懒初始化**：

- 用户第一次调用 `GET /v1/websites/capability` 时，ctl 查 `user_resource_quota` 是否有 `WEBSITE_STATIC_SITE` 行。
- 没有 → 读用户当前有效 Pass 对应的 Bundle 的 `static_site_quota`，在同一事务内 `INSERT IGNORE` 写入 `user_resource_quota`。
- 有 → 直接返回当前可用额度。
- Pass 到期/换套餐时，`CompletePass` / `ChangePassEntitlement` 负责更新配额行（旧套餐释放、新套餐分配）。

### 2.3 流量配额

流量用单独的用量表 `website_usage_daily` 按日聚合，不做实时精确扣减（避免每个请求写 DB）。流量代理每小时跑一次汇总，把当日已用量写入 `user_resource_quota` 的 `resource_quota_available` 列。

超额时流量代理返回平台停用页，不转发到 CloudBase。

## 3. 数据库 Schema

### 3.1 迁移 000028: bundle 新增 static_site_quota

```sql
ALTER TABLE `bundle`
    ADD COLUMN `static_site_quota` JSON NULL COMMENT '静态建站配额JSON';
```

### 3.2 迁移 000029: website_sites 表

```sql
CREATE TABLE IF NOT EXISTS `website_sites` (
    `id`              BIGINT       NOT NULL AUTO_INCREMENT,
    `site_id`         VARCHAR(64)  NOT NULL COMMENT '业务站点ID ws-xxxxxxxx',
    `user_id`         VARCHAR(64)  NOT NULL,
    `pass_id`         VARCHAR(64)  NOT NULL COMMENT '创建时关联的Pass',
    `bundle_id`       VARCHAR(64)  NOT NULL COMMENT '创建时关联的套餐',
    `name`            VARCHAR(128) NOT NULL DEFAULT '' COMMENT '站点名称',
    `status`          VARCHAR(32)  NOT NULL DEFAULT 'creating' COMMENT 'creating/active/suspended/deleted',
    `cloud_path`      VARCHAR(512) NOT NULL DEFAULT '' COMMENT 'CloudBase中的路径 sites/<siteId>/releases/<releaseId>/',
    `public_url`      VARCHAR(512) NOT NULL DEFAULT '' COMMENT 'Vela分配的公开URL',
    `created_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `deleted_time`    DATETIME     NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_site_id` (`site_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 3.3 迁移 000030: website_releases 表

```sql
CREATE TABLE IF NOT EXISTS `website_releases` (
    `id`              BIGINT       NOT NULL AUTO_INCREMENT,
    `release_id`      VARCHAR(64)  NOT NULL COMMENT '业务发布ID wr-xxxxxxxx',
    `site_id`         VARCHAR(64)  NOT NULL,
    `user_id`         VARCHAR(64)  NOT NULL,
    `version`         INT          NOT NULL DEFAULT 1 COMMENT '递增版本号',
    `status`          VARCHAR(32)  NOT NULL DEFAULT 'pending' COMMENT 'pending/deploying/active/failed/rolled_back',
    `artifact_hash`   VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'SHA-256',
    `artifact_size`   BIGINT       NOT NULL DEFAULT 0 COMMENT '制品大小(字节)',
    `file_count`      INT          NOT NULL DEFAULT 0,
    `error_message`   VARCHAR(1024) NOT NULL DEFAULT '',
    `created_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_release_id` (`release_id`),
    KEY `idx_site_id` (`site_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 3.4 迁移 000031: website_operations 表

```sql
CREATE TABLE IF NOT EXISTS `website_operations` (
    `id`              BIGINT       NOT NULL AUTO_INCREMENT,
    `operation_id`    VARCHAR(64)  NOT NULL COMMENT '业务操作ID wo-xxxxxxxx',
    `site_id`         VARCHAR(64)  NOT NULL,
    `release_id`      VARCHAR(64)  NOT NULL DEFAULT '',
    `user_id`         VARCHAR(64)  NOT NULL,
    `operation_type`  VARCHAR(32)  NOT NULL COMMENT 'create/deploy/delete',
    `status`          VARCHAR(32)  NOT NULL DEFAULT 'created' COMMENT 'created/running/success/failed',
    `error_message`   VARCHAR(2048) NOT NULL DEFAULT '',
    `created_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_operation_id` (`operation_id`),
    KEY `idx_site_id` (`site_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 3.5 迁移 000032: website_usage_daily 表

```sql
CREATE TABLE IF NOT EXISTS `website_usage_daily` (
    `id`              BIGINT       NOT NULL AUTO_INCREMENT,
    `site_id`         VARCHAR(64)  NOT NULL,
    `user_id`         VARCHAR(64)  NOT NULL,
    `usage_date`      DATE         NOT NULL COMMENT '统计日期',
    `traffic_bytes`   BIGINT       NOT NULL DEFAULT 0 COMMENT '当日流量(字节)',
    `request_count`   BIGINT       NOT NULL DEFAULT 0 COMMENT '当日请求数',
    `created_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_site_date` (`site_id`, `usage_date`),
    KEY `idx_user_date` (`user_id`, `usage_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 3.6 迁移 000033: id_gen 预置

```sql
INSERT IGNORE INTO `id_gen` (`name`, `max_id`) VALUES
    ('website_site', 0),
    ('website_release', 0),
    ('website_operation', 0);
```

### 3.7 迁移 000034: user_resource_quota 预置 resource_name

```sql
-- 不需要DDL变更，user_resource_quota表已存在。
-- 只需在代码中注册 WEBSITE_STATIC_SITE 和 WEBSITE_TRAFFIC 两个 resource_name。
```

## 4. API 设计

### 4.1 用户端 API（经 service-gateway 鉴权后转发到 ctl）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/v1/websites/capability` | 查询当前用户的建站权益和用量 |
| POST | `/v1/websites` | 创建站点（幂等，带 Idempotency-Key） |
| GET  | `/v1/websites` | 列出用户站点 |
| GET  | `/v1/websites/{siteId}` | 查询站点详情 |
| POST | `/v1/websites/{siteId}/releases` | 创建发布（上传制品+触发部署） |
| GET  | `/v1/websites/{siteId}/releases` | 列出站点发布历史 |
| GET  | `/v1/websites/{siteId}/operations/{operationId}` | 查询异步操作状态 |
| DELETE | `/v1/websites/{siteId}` | 删除站点 |

### 4.2 内部 API（供 worker 回调）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/internal/ctl/websites/operations/{operationId}/complete` | worker 回写操作完成 |
| POST | `/internal/ctl/websites/operations/{operationId}/fail` | worker 回写操作失败 |

### 4.3 公开访问路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/s/{siteId}` | 流量代理：转发到 CloudBase 静态托管并计量 |

## 5. 关键流程

### 5.1 创建站点

```
1. Agent → GET /v1/websites/capability
   - ctl 懒初始化配额（若无 WEBSITE_STATIC_SITE 行）
   - 返回 {max_sites, used_sites, traffic_remaining_bytes, ...}

2. Agent → POST /v1/websites {name, idempotency_key}
   - ctl 事务内：
     a) AllocQuota(WEBSITE_STATIC_SITE, 1) — 原子扣席位
     b) GenId('website_site') 生成 site_id
     c) INSERT website_sites (status=creating)
     d) INSERT website_operations (type=create, status=created)
   - 返回 {site_id, operation_id}
   - 异步：worker 拿到 operation 后调 CloudBase 创建目录结构
```

### 5.2 发布站点

```
1. Agent → POST /v1/websites/{siteId}/releases {artifact_hash, artifact_size, file_count}
   - ctl 校验：
     a) site 属于当前用户且 status in (creating, active)
     b) artifact_size 不超套餐限制
     c) 发布频率未超限
   - ctl 事务内：
     a) GenId('website_release') 生成 release_id
     b) INSERT website_releases (status=pending, version=自增)
     c) INSERT website_operations (type=deploy, status=created)
     d) 生成短时 COS 预签名上传地址
   - 返回 {release_id, operation_id, upload_url, upload_headers}
   - Agent 上传制品到 COS

2. Agent → POST /v1/websites/{siteId}/releases/{releaseId}/deploy
   - ctl 事务内：
     a) 更新 release status=deploying
     b) 更新 operation status=running
   - 异步：worker 从 COS 拉取制品 → 调 CloudBase 管理 API 部署到 sites/{siteId}/releases/{releaseId}/
   - worker → POST /internal/ctl/websites/operations/{operationId}/complete
     - ctl 事务内：
       a) 更新 release status=active
       b) 更新 site status=active, public_url
       c) 更新 operation status=success
```

### 5.3 公开访问与流量计量

```
访客 → GET /s/{siteId}/path/to/page.html
  → 流量代理（新路由，在 service-gateway 或独立服务中）：
    1. 查 site_id → site 是否 active
    2. 查 user_id → 是否有额度
    3. 代理转发到 CloudBase 静态托管 URL
    4. 响应返回前记录 Content-Length 到 Redis 原子计数器
    5. 后台每小时汇总 Redis → website_usage_daily → 扣减 user_resource_quota
```

### 5.4 Pass 到期/换套餐

```
Pass 到期 → ctl 的 IsolatePass 链路：
  1. site status → suspended（代理返回停用页）
  2. 保留数据和 CloudBase 制品一段时间
  3. 最终释放席位和清理 CloudBase 制品

换套餐 → ctl 的 ChangePassEntitlement：
  1. 读旧套餐配额和新套餐配额
  2. 如果新配额 < 已用数 → 降级超额站点为 suspended
  3. 更新 user_resource_quota 行
```

## 6. 需要新增的代码模块

### 6.1 ctl（Go）

| 路径 | 说明 |
|------|------|
| `ctl/migrations/000028_add_bundle_static_site_quota.up.sql` | bundle 新增列 |
| `ctl/migrations/000029_create_website_sites.up.sql` | 站点表 |
| `ctl/migrations/000030_create_website_releases.up.sql` | 发布表 |
| `ctl/migrations/000031_create_website_operations.up.sql` | 操作表 |
| `ctl/migrations/000032_create_website_usage_daily.up.sql` | 用量表 |
| `ctl/migrations/000033_seed_website_id_gen.up.sql` | id_gen 预置 |
| `ctl/pkg/model/website/entity.go` | 站点/发布/操作实体 |
| `ctl/pkg/model/website/dao.go` | DAO 接口和实现 |
| `ctl/pkg/logic/website/logic.go` | 业务逻辑（配额校验、事务） |
| `ctl/main/api/website_handler.go` | HTTP handler |
| `ctl/main/api/server.go`（修改） | 注册新路由 |

### 6.2 service-gateway（Go）

修改 `argocd/services/service-gateway/beijing-sandbox/config.yaml`：

```yaml
  - name: ctl-websites
    prefix: /v1/websites
    methods: [GET, POST, DELETE, OPTIONS]
    upstream: http://ctl-api.ctl.svc.cluster.local
    access: authenticated
    auth_strategy: session
    response_header_timeout: 30s

  - name: website-proxy
    prefix: /s
    methods: [GET, HEAD, OPTIONS]
    upstream: http://website-proxy.website.svc.cluster.local
    access: public
    response_header_timeout: 30s
```

### 6.3 流量代理（新建 Go 服务 或 嵌入 service-gateway）

一期建议嵌入 service-gateway 作为新路由，避免新增独立服务和部署。

### 6.4 部署 Worker（新建 Go 服务 in workers/）

| 路径 | 说明 |
|------|------|
| `workers/cmd/website-deployer/main.go` | 入口 |
| `workers/internal/website/deployer.go` | CloudBase 管理 API 调用 |
| `workers/internal/website/types.go` | 类型定义 |

### 6.5 Vela 建站 Skill

| 路径 | 说明 |
|------|------|
| `.agents/skills/cloudbase-site-builder/SKILL.md` | Skill 主文件 |

## 7. 北京测试环境部署

1. 代码改完后 push 到 `codex/cloudbase-static-site` 分支
2. 构建 ctl 和 service-gateway 镜像
3. 更新 argocd/services/ctl/beijing-sandbox/ 和 service-gateway 的 platform.env
4. 合 MR 到 gitops 分支触发 Argo CD 同步
5. 验证：创建测试用户 → 调 API 建站 → 访问站点

## 8. 容量评估

- 5万注册用户，假设10%使用建站 = 5000用户
- 平均每用户2个站点 = 10000站点
- CloudBase 共享环境：静态托管无硬性站点数限制，但需关注 CDN 流量和存储
- DB：website_sites 表 10万行级别，主键和索引完全够用
- id_gen 原子自增无并发瓶颈

## 9. 不做（一期）

- 云函数、数据库、动态后端
- 用户自定义域名
- 用户腾讯云子账号
- CloudBase AI/Agent 能力
- 多环境/多地域部署
- 严格实时流量扣减（用日聚合+阈值熔断替代）
