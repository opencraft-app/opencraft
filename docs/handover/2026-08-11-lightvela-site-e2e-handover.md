# LightVela 国际站建站端到端交接文档

> **日期**：2026-08-11
> **分支**：`codex/site-cos-gateway`
> **仓库**：`git@git.woa.com:wisp/mono2.git`
> **目标**：国际站域名 `lightvela.site` 静态网站托管功能上线
> **测试环境**：北京 Sandbox（tke-bj8）
> **状态**：北京测试环境曾完成 API 直调 HTTPS E2E；当前真实用户站点回归未闭环，生产证书、DNS 切换和生产发布均未完成
>
> **剩余事项集中清单**：见 [2026-08-18-lightvela-site-remaining-todos.md](2026-08-18-lightvela-site-remaining-todos.md)。本文件保留架构和历史验收上下文，发布前以集中清单为准。

> **源码交付边界**：除生产证书自动化接入、生产 CLB/DNS 切换和受保护环境中的 secret render/apply 外，源码、迁移、流水线和 sgprod GitOps 骨架应保持可直接合入 `master`。本后端分支不包含 `frontend/**`、frontend GitOps 或 frontend Application 变更，不会自动触发 frontend 构建；但最新 `master` 已包含此前合入的建站入口代码，后端验收完成前禁止手动发布国际站 frontend。

---

## 目录

1. [功能概述](#一功能概述)
2. [系统架构](#二系统架构)
3. [数据流向](#三数据流向)
4. [反向代理与域名路由](#四反向代理与域名路由)
5. [配额管理](#五配额管理)
6. [数据库变更](#六数据库变更)
7. [TAT 凭据下发](#七tat-凭据下发)
8. [website-builder Skill](#八website-builder-skill)
9. [测试环境改动清单](#九测试环境改动清单)
10. [生产发布清单](#十生产发布清单)
11. [回滚方案](#十一回滚方案)
12. [待完成事项](#十二待完成事项)
13. [风险评估](#十三风险评估)
14. [附录](#十四附录)

---

## 一、功能概述

### 1.1 做了什么

为 LightVela 国际站（`lightvela.site`）实现了**纯静态网站托管**功能。用户通过 Vela 平台创建的 CVM 实例上的 AI Agent（Hermes）可以：

1. 生成静态网页文件（HTML/CSS/JS）
2. 通过平台 API 创建站点、上传制品、发布上线
3. 获得一个 `https://<site_id>.lightvela.site/` 的公网 HTTPS 地址
4. 访问者通过该地址直接访问托管内容

### 1.2 套餐配额

| 套餐 | 托管应用数 | 存储空间 | 月度流量 |
|---|---|---|---|
| 启航 / 启航 AI（`bundle_launch%`） | 1 | 5GB | 10GB |
| 巡游 / 巡游 AI（`bundle_cruise%`） | 5 | 40GB | 20GB |

### 1.3 与国内站的区别

| 维度 | 国内站（本期不展示入口） | 国际站（本次新增） |
|---|---|---|
| 域名 | 历史测试域 `*.sites.lightclaw.tech`，不作为本期正式入口 | `*.lightvela.site` |
| API | `https://api.lightvela.com` | `https://api.lightvela.ai` |
| COS | 腾讯云北京/上海 | 腾讯云上海（同一 bucket） |
| TLS 证书 | 已有 | 需新申请付费泛域名证书 `*.lightvela.site` |

---

## 二、系统架构

### 2.1 整体拓扑

```
用户浏览器
  │
  │  HTTPS  https://ws-xxx.lightvela.site/
  ▼
CLB（lb-kbl26vb5，140.143.177.178）
  │
  ▼
K8s Ingress（qcloud ingress class）
  │  TLS 终止：证书 ID ZtmnNUcl（*.lightvela.site，Let's Encrypt）
  │  Host: *.lightvela.site → svc: site-gateway:80
  ▼
site-gateway（Go，2 副本）
  │  1. 从 Host 头提取 site_id（ws-xxx）
  │  2. 查 DB website_sites 表获取 cloud_path
  │  3. 如果 Host 不匹配随机域名格式，查 website_custom_domains 表
  │  4. 校验站点状态（active/suspended/blocked）
  │  5. 反向代理到 COS
  ▼
COS Bucket（7869-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746 / ap-shanghai）
  │  路径：sites/<site_id>/index.html
  │  同时存储：_artifacts/<site_id>/<release_id>.zip
  ▼
返回静态文件给用户浏览器
```

### 2.2 建站发布流程

```
用户机器上的 Hermes Agent
  │  通过 website-builder Skill
  │  Authorization: Vela-Instance-Key vik_xxx_yyy
  ▼
service-gateway（路由：ctl-instance-websites）
  │  allowlist 过滤
  ▼
ctl-api-websites（Go，端口 9590）
  │  1. websiteInstanceAuthMiddleware 校验 Vela-Instance-Key
  │  2. 从 Redis 查 token → 得到 user_id + instance_id
  │  3. 注入 X-User-Id / X-Instance-Id
  │
  │  创建站点 → 写 website_sites 表
  │  创建发布 → 写 website_releases 表
  │  生成预签名 PUT URL → 用户直接上传到 COS
  │  LPUSH 到 Redis 通知 deployer
  ▼
website-deployer（Go，temporal-workers 命名空间）
  │  1. BRPOP Redis 队列获取 operation
  │  2. 下载 ZIP 制品 → 校验 SHA256
  │  3. 解压到 COS sites/<site_id>/
  │  4. 更新站点状态为 active
  ▼
用户访问 https://ws-xxx.lightvela.site/ → 200 OK
```

### 2.3 组件清单

| 组件 | 命名空间 | 镜像 | 作用 |
|---|---|---|---|
| `ctl-api-websites` | ctl | `lightclaw/ctl:test-20260811-e2e-fix` | 建站 API（创建/发布/查询/删除） |
| `site-gateway` | ctl | `lightclaw/site-gateway:custom-domain-202608101310` | 反向代理 COS → HTTP |
| `website-deployer` | temporal-workers | `lightclaw/workers:test-20260810-181025` | 从 COS 下载制品 → 解压 → 部署 |
| Ingress `lightclaw-sites-public` | ctl | — | TLS 终止 + Host 路由 |
| Secret `site-gateway-lightvela-tls` | ctl | — | TLS 证书引用（qcloud_cert_id） |
| Secret `ctl-runtime-secrets` | ctl | — | COS AK/SK（用户账号） |
| Secret `site-gateway-secrets` | ctl | — | COS AK/SK（用户账号） |
| Secret `website-deployer-secrets` | temporal-workers | — | COS AK/SK（用户账号） |

---

## 三、数据流向

### 3.1 创建站点

```
Skill → POST /v1/websites
  → ctl 校验配额（bundle.static_site_quota）
  → INSERT website_sites (site_id, user_id, pass_id, bundle_id, status='creating')
  → 生成 cloud_path = "sites/<site_id>/"
  → 生成 public_url = "https://<site_id>.lightvela.site/"
  → UPDATE website_sites SET status='active', public_url=...
  → 返回 site_id + public_url
```

### 3.2 创建发布

```
Skill → POST /v1/websites/{siteId}/releases
  body: {"artifact_hash":"<sha256>","artifact_size":<bytes>,"file_count":<int>}
  → INSERT website_releases (release_id, site_id, version=N+1, status='pending')
  → 生成预签名 PUT URL（COS _artifacts/<site_id>/<release_id>.zip）
  → 返回 upload_url + release_id
```

### 3.3 上传制品

```
Skill → HTTP PUT <upload_url>
  → 直接上传 ZIP 到 COS（预签名 URL，15 分钟有效）
```

### 3.4 部署

```
ctl → LPUSH Redis key="website:deploy:queue" operation_id
  → website-deployer BRPOP
  → 下载 _artifacts/<site_id>/<release_id>.zip
  → 校验 SHA256 + 文件数
  → 解压到 sites/<site_id>/（覆盖旧版本）
  → UPDATE website_releases SET status='active'
  → UPDATE website_sites SET status='active'
  → 旧版本 release 状态变 superseded
```

### 3.5 访问站点

```
浏览器 → GET https://ws-xxx.lightvela.site/index.html
  → Ingress TLS 终止
  → site-gateway 从 Host 提取 "ws-xxx"
  → SELECT * FROM website_sites WHERE site_id='ws-xxx'
  → 校验 status='active'
  → 反向代理 GET cos://<bucket>/sites/ws-xxx/index.html
  → 返回文件内容
```

---

## 四、反向代理与域名路由

### 4.1 DNS 配置

| 记录 | 值 | 说明 |
|---|---|---|
| `*.lightvela.site` → A 记录 | `140.143.177.178` | 指向 CLB |
| CLB ID | `lb-kbl26vb5` | qcloud ingress 关联的负载均衡 |

> **⚠️ 临时配置**：`*.lightvela.site` 的 DNS 目前指向北京测试环境 CLB。生产发布前需要将 DNS 切换到生产环境 CLB IP。

### 4.2 TLS 证书

#### 测试环境（北京 Sandbox）

| 属性 | 值 |
|---|---|
| 域名 | `*.lightvela.site` |
| 证书 ID | `ZtmnNUcl` |
| 颁发者 | Let's Encrypt（ACME 免费证书，仅测试用） |
| 有效期至 | 2026-11-08 |
| 账号 | 虾米老师个人账号 |
| K8s Secret | `site-gateway-lightvela-tls`（Opaque，key=`qcloud_cert_id`） |

#### 生产环境（sgprod）

| 属性 | 值 |
|---|---|
| 域名 | `*.lightvela.site` |
| 证书类型 | **付费泛域名证书**（不能复用测试 Let's Encrypt 免费证书） |
| 状态 | ❌ 未申请 — 生产发布前必须完成 |
| 申请方式 | 通过腾讯云 SSL 证书控制台申请付费泛域名证书 |
| 部署方式 | 平台证书自动化在 sgprod `ctl` namespace 创建/轮换稳定 live Secret；不随 site-gateway 日常发布下发，GitOps 不保存证书 ID |
| K8s Secret | `site-gateway-wildcard-tls`（Opaque，key=`qcloud_cert_id`） |

### 4.3 Ingress 规则

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: lightclaw-sites-public
  namespace: ctl
  annotations:
    ingress.cloud.tencent.com/direct-access: "true"
    ingress.cloud.tencent.com/pass-to-target: "true"
    kubernetes.io/ingress.class: qcloud
    kubernetes.io/ingress.qcloud-loadbalance-id: lb-kbl26vb5
spec:
  ingressClassName: qcloud
  rules:
  - host: "*.sites.lightclaw.tech"
    http:
      paths:
      - backend:
          service:
            name: site-gateway
            port:
              number: 80
        path: /
        pathType: Prefix
  - host: "*.lightvela.site"
    http:
      paths:
      - backend:
          service:
            name: site-gateway
            port:
              number: 80
        path: /
        pathType: Prefix
  tls:
  - hosts: ["*.lightvela.site"]
    secretName: site-gateway-lightvela-tls
  - hosts: ["*.sites.lightclaw.tech"]
    secretName: sites-lightclaw-tech-wildcard-tls
```

### 4.4 site-gateway 路由逻辑

site-gateway 的 `hostroute` 包负责从 HTTP Host 头解析 site_id：

1. **随机子域名匹配**：`ws-<hex>.lightvela.site` → 直接提取 `ws-<hex>` 作为 site_id
2. **自定义域名匹配**：如果 Host 不匹配随机格式 → 查 `website_custom_domains` 表 → 获取 site_id
3. **根域名配置**：环境变量 `SITE_GATEWAY_ROOT_DOMAINS=lightvela.site,sites.lightclaw.tech`，逗号分隔，用于从 Host 中剥离根域名后提取 site_id

代码位置：`site-gateway/internal/hostroute/hostroute.go`

### 4.5 COS 反向代理

site-gateway 的 `origin/cos.go` 负责将 HTTP 请求反向代理到 COS：

1. 构造 COS 对象 URL：`https://<bucket>.cos.<region>.myqcloud.com/<cloud_path>/<object_key>`
2. 使用 AK/SK 签名请求
3. 透传 HTTP 响应给客户端

**关键环境变量**：

| 环境变量 | 用途 | 值 |
|---|---|---|
| `SITE_GATEWAY_COS_BUCKET` | site-gateway 自身 COS 访问 | `7869-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746` |
| `SITE_GATEWAY_COS_REGION` | COS 区域 | `ap-shanghai` |
| `WEBSITE_COS_BUCKET` | 兼容变量（同上） | 同上 |
| `WEBSITE_COS_REGION` | 兼容变量（同上） | `ap-shanghai` |

> **⚠️ 重要**：site-gateway 使用 `SITE_GATEWAY_COS_*` 前缀的环境变量，而不是 `WEBSITE_COS_*`。如果只设了 `WEBSITE_COS_*`，site-gateway 的 COS 访问会失败。

---

## 五、配额管理

### 5.1 配额存储

配额存储在 `bundle` 表的 `static_site_quota` JSON 列中：

```json
{
  "max_sites": 1,
  "monthly_traffic_bytes": 10737418240,
  "storage_bytes": 5368709120,
  "max_artifact_size": 52428800,
  "max_files": 500
}
```

### 5.2 配额执行

配额校验在 `ctl/pkg/logic/website/capability.go` 中实现：

1. **站点数限制**：创建站点时 `SELECT COUNT(*) FROM website_sites WHERE user_id=? AND status IN ('creating','active','suspended','blocked')`，与 `max_sites` 比较
2. **存储限制**：每个制品的 `artifact_size` 累加到用户的 `storage_bytes` 总量，与 `storage_bytes` 配额比较
3. **制品大小限制**：单个 `artifact_size` 与 `max_artifact_size` 比较
4. **文件数限制**：ZIP 内文件数与 `max_files` 比较（deployer 校验）
5. **流量限制**：`website_usage_daily` 表按日记录流量，site-gateway 按请求累加

### 5.3 配额查询 API

```
GET /v1/websites/capability
Authorization: Vela-Instance-Key vik_xxx_yyy
```

返回：
```json
{
  "code": "OK",
  "data": {
    "max_sites": 1,
    "used_sites": 0,
    "storage_bytes": 5368709120,
    "used_storage_bytes": 0,
    "monthly_traffic_bytes": 10737418240,
    "used_monthly_traffic_bytes": 0
  }
}
```

### 5.4 配额懒创建

`WEBSITE_STATIC_SITE` 行不是在 migration 中预创建的。用户首次调用建站能力查询时，CTL 从 `pass` 表查找用户当前有效套餐，从 `bundle` 表读取 `static_site_quota`，如果没有 `website_usage` 行则懒创建。

---

## 六、数据库变更

### 6.1 迁移文件

**一次生产 DB 变更**（自定义域名表已合并到 000028）：

| 文件 | 说明 |
|---|---|
| `ctl/migrations/000028_create_static_website_platform.up.sql` | 建站平台核心表 + 自定义域名表 |


### 6.2 000028 — 建站平台核心

**对 `bundle` 表的变更**：

```sql
ALTER TABLE `bundle` ADD COLUMN `static_site_quota` JSON NULL
    COMMENT 'static website quota template'
    AFTER `features`;
```

**配额种子数据**：

```sql
-- 启航 / 启航 AI
UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 1, 'monthly_traffic_bytes', 10737418240,
    'storage_bytes', 5368709120, 'max_artifact_size', 52428800, 'max_files', 500
) WHERE `bundle_id` LIKE 'bundle_launch%';

-- 巡游 / 巡游 AI
UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 5, 'monthly_traffic_bytes', 21474836480,
    'storage_bytes', 42949672960, 'max_artifact_size', 52428800, 'max_files', 500
) WHERE `bundle_id` LIKE 'bundle_cruise%';
```

**新建表**：

| 表 | 用途 |
|---|---|
| `website_sites` | 站点主表（site_id, user_id, pass_id, bundle_id, status, cloud_path, public_url, storage_bytes） |
| `website_releases` | 发布版本表（release_id, site_id, version, status, artifact_hash, artifact_size） |
| `website_operations` | 异步操作表（operation_id, site_id, release_id, operation_type, status, lease_token） |
| `website_usage_daily` | 按日统计流量和请求数 |
| `website_custom_domains` | 自定义域名绑定表（domain → site_id 映射） |

### 6.3 ~~000029~~ 自定义域名表（已合并到 000028）

```sql
CREATE TABLE `website_custom_domains` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `domain` VARCHAR(253) NOT NULL COMMENT 'normalized: lowercase, no trailing dot',
    `site_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    ...
);
```

### 6.4 测试环境 DB 验证

在测试环境 DB（`10.15.224.4:3306`，库名 `ctl`）中已验证：

| bundle_id | max_sites | storage | traffic | max_artifact | max_files |
|---|---|---|---|---|---|
| bundle_free_trial_01 | 1 | 5GB | 10GB | 20MB | 500 |
| bundle_launch_01 | 1 | 5GB | 10GB | 50MB | 500 |
| bundle_cruise_01 | 5 | 40GB | 20GB | 50MB | 500 |
| bundle_voyage_01 | 3 | 20GB | 25GB | 50MB | 500 |
| bundle_launch_ai_01 | 1 | 5GB | 10GB | 50MB | 500 |
| bundle_cruise_ai_01 | 5 | 40GB | 20GB | 50MB | 500 |
| bundle_voyage_ai_01 | 3 | 20GB | 25GB | 50MB | 500 |

> **注意**：`bundle_free_trial_01` 的 `max_artifact_size` 是 20MB（20971520），与其他 launch 套餐的 50MB 不同。生产迁移时需确认是否要统一。

---

## 七、TAT 凭据下发

### 7.1 凭据格式

```
vik_<key_id>_<secret>
```

- `key_id` = base64url_no_padding(random(16 bytes))，固定 22 字符
- `secret` = random(32 bytes)，base64url_no_padding 编码后固定 43 字符
- 服务端只存储 `SHA-256(salt || secret)`，不存储明文
- 凭据无 TTL（永久有效），需主动撤销

### 7.2 凭据签发

CTL 内部 API：

```http
POST /internal/ctl/instances/{vela_instance_id}/website-credential
Authorization: Bearer <CTL_INTERNAL_TOKEN>
```

- CTL 从 DB 查 instance → 推导 user_id
- 生成 token，写 Redis（key: `{website-instance-keys}:<key_id>`）
- 返回明文 token（仅此一次）

### 7.3 TAT 下发流程

**Step 1：创建 TAT 命令（每区域一次）**

```bash
HERMES_TAT_REGION=ap-beijing \
  bash .ci/runtime/commands/create_hermes_website_credential_command.sh
```

- 命令内容 = install 脚本 + 参数占位符 `{{tat-hidden:website_key}}` + `{{api_base}}`
- `website_key` 为 TAT 隐藏参数，不出现在控制台/日志
- 返回 `HERMES_TAT_COMMAND_ID=cmd-xxx`

**Step 2：逐台调用 TAT（每台实例独立调用）**

```bash
echo '{"cloud_id":"ins-xxx","website_key":"vik_xxx_yyy"}' | \
HERMES_TAT_COMMAND_ID=cmd-xxx \
HERMES_TAT_REGION=ap-beijing \
HERMES_TAT_API_BASE=https://api.lightvela.ai \
  bash .ci/runtime/commands/invoke_hermes_website_credential_command.sh
```

- 每台实例独立调用（因为每台 token 不同）
- 脚本轮询 TAT 任务状态直到 SUCCESS/FAILED

**Step 3：机器端安装脚本**

`images/helpers/install-hermes-website-credential.sh`：

1. 校验 token 格式（不打印）
2. 原子写入 `/etc/vela/website-credential.env`（root:agentuser 0440）
3. 发现 Hermes gateway systemd user unit
4. 添加 drop-in `vela-website-credential.conf`（`EnvironmentFile=/etc/vela/website-credential.env`）
5. 重启 Hermes gateway 服务
6. 验证 `VELA_WEBSITE_KEY` 存在（不打印值）

### 7.4 测试环境 TAT 状态

**⚠️ 当前问题**：北京测试环境的沙箱实例没有 TAT Agent。`tccli tat DescribeAutomationAgentStatus` 对所有 10 台 RUNNING 实例返回空。

原因：测试环境使用 E2B 沙箱后端（`api.e2b.app`），沙箱实例虽有 `cloud_id` 和内网 IP，但不是直接用 Tencent Cloud TAT 管理的 CVM。

之前 handover（2026-08-07）提到的 6 台 TAT Agent Online 的实例已被回收重建。

**生产环境**：生产 CVM 是真实腾讯云 CVM，TAT Agent 默认安装，可直接使用上述 TAT 下发流程。

---

## 八、website-builder Skill

### 8.1 Skill 位置

`.agents/skills/website-builder/SKILL.md`

### 8.2 认证

Skill 从环境变量读取凭据：

```bash
KEY="${VELA_WEBSITE_KEY:?VELA_WEBSITE_KEY not set, instance not initialized}"
API_BASE="${VELA_API_BASE:-https://api.lightvela.com}"
```

请求头：`Authorization: Vela-Instance-Key <key>`

### 8.3 API 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /v1/websites/capability | 查询建站权益和用量 |
| POST | /v1/websites | 创建站点 |
| GET | /v1/websites | 列出已有站点 |
| GET | /v1/websites/{siteId} | 查询站点详情 |
| POST | /v1/websites/{siteId}/releases | 创建发布 |
| GET | /v1/websites/{siteId}/releases | 列出发布历史 |
| GET | /v1/websites/{siteId}/operations/{opId} | 查询操作状态 |
| DELETE | /v1/websites/{siteId} | 删除站点 |

### 8.4 完整建站流程

1. 查询权益 → 获取配额
2. 创建站点 → 获得 `site_id` + `public_url`
3. 生成静态文件 → 打包 ZIP
4. 创建发布 → 获得 `upload_url` + `release_id`
5. 上传 ZIP 到 `upload_url`（HTTP PUT）
6. 轮询操作状态直到 `success`
7. 访问 `public_url` 验证（等待 10 秒后 curl）
8. 首次 404 不算失败，等 10 秒重试

### 8.5 Skill 分发方式（与 TAT 凭据下发的区别）

**⚠️ 重要区分**：website-builder Skill 和建站凭据是两个独立的东西，分发方式完全不同：

| 组件 | 分发方式 | 文件/脚本 |
|---|---|---|
| **建站凭据** (`VELA_WEBSITE_KEY` + `VELA_API_BASE`) | TAT 参数化命令 | `images/helpers/install-hermes-website-credential.sh` |
| **website-builder Skill** (`SKILL.md`) | Hermes 镜像内置 / SkillHub 安装 | `.agents/skills/website-builder/SKILL.md` |

**TAT 只下发凭据，不下发 Skill 文件本身。**

Skill 的分发渠道：
1. **Hermes 镜像构建**：`images/build.sh` 在构建 Hermes 镜像时，通过 `curate_hermes_skills()` 函数从 `${RUNTIME_HOME}/.hermes/skills/` 目录管理预装 Skill
2. **SkillHub 安装**：`images/build.sh` 通过 `SKILLHUB_INSTALL_URL` 安装 SkillHub CLI（`/usr/local/bin/skillhub`），用户/平台可以通过 `skillhub install` 命令安装额外 Skill
3. **手动部署**：通过 SSH 或通用 TAT 命令（`.ci/runtime/commands/create_hermes_tat_command.sh`）将 SKILL.md 复制到机器的 `${RUNTIME_HOME}/.hermes/skills/` 或 `${RUNTIME_HOME}/.agents/skills/` 目录

**当前状态**：website-builder Skill 尚未集成到 Hermes 镜像的 `curate_hermes_skills` keep_list 中。生产发布前需要：
- 将 website-builder 加入 Hermes 镜像的预装 Skill 列表，或
- 通过 SkillHub 发布后让用户 `skillhub install website-builder`，或
- 通过通用 TAT 命令批量部署到所有用户机器

**仓库中与 TAT 相关的完整脚本清单**：

| 脚本 | 用途 |
|---|---|
| `.ci/runtime/commands/create_hermes_website_credential_command.sh` | 创建参数化 TAT 命令（建站凭据专用） |
| `.ci/runtime/commands/invoke_hermes_website_credential_command.sh` | 逐台调用 TAT 命令下发凭据 |
| `.ci/runtime/commands/create_hermes_tat_command.sh` | 创建通用 TAT 命令（可用于 Skill 部署等） |
| `.ci/runtime/commands/invoke_hermes_tat_command.sh` | 批量调用通用 TAT 命令 |
| `images/helpers/install-hermes-website-credential.sh` | 机器端安装脚本（TAT 命令体内嵌入） |

---

## 九、测试环境改动清单

### 9.1 永久改动（已在 GitOps 或代码中）

这些改动已经通过 GitOps 或代码提交，在测试环境通过 Argo CD 或 `kubectl set env` 生效，需要同步到生产 GitOps。

| 改动 | 类型 | 说明 |
|---|---|---|
| DB Migration 000028 | DB | 建 `bundle.static_site_quota` 列 + 4 张 website 表 |

| site-gateway 代码 | 代码 | 自定义域名查表、根域名环境变量、COS 反代统一 |
| website-deployer 代码 | 代码 | COS bucket 统一、流式临时文件、并发 16 |
| ctl-api 建站逻辑 | 代码 | credential 签发/校验、quota 校验、Redis 队列通知 |
| website-builder Skill | Skill | 完重建站流程 + 用户输出规范 |
| TAT 下发脚本 | 脚本 | install-hermes-website-credential.sh + 创建/调用脚本 |
| workers k8s manifests | GitOps | website-deployer deployment（beijing-sandbox/sgprod/shprod） |

### 9.2 临时改动（kubectl live patch，不在 GitOps 中）

这些改动是通过 `kubectl set env` / `kubectl patch` 直接在测试环境执行的，**不在 GitOps 分支中**。生产发布前必须将这些配置写入 GitOps manifests。

| 组件 | 改动 | 命令 |
|---|---|---|
| `site-gateway` deployment | `SITE_GATEWAY_ROOT_DOMAINS=lightvela.site,sites.lightclaw.tech` | `kubectl set env deploy/site-gateway` |
| `site-gateway` deployment | `SITE_GATEWAY_COS_BUCKET` + `SITE_GATEWAY_COS_REGION` 改为用户 bucket | `kubectl set env deploy/site-gateway` |
| `site-gateway` deployment | `WEBSITE_COS_BUCKET` + `WEBSITE_COS_REGION` 同上 | `kubectl set env deploy/site-gateway` |
| `ctl-api-websites` deployment | `WEBSITE_COS_BUCKET` + `WEBSITE_COS_REGION` 改为用户 bucket | `kubectl set env deploy/ctl-api-websites` |
| `website-deployer` deployment | `WEBSITE_COS_BUCKET` + `WEBSITE_COS_REGION` 改为用户 bucket | `kubectl set env deploy/website-deployer` |
| Ingress `lightclaw-sites-public` | 添加 `*.lightvela.site` host + TLS | `kubectl patch ingress` |
| Secret `site-gateway-lightvela-tls` | 测试环境创建/更新为 Opaque + `qcloud_cert_id=ZtmnNUcl` | `kubectl create secret` |
| Secret `ctl-runtime-secrets` | COS AK/SK 改为用户账号凭据 | `kubectl patch secret` |
| Secret `site-gateway-secrets` | COS AK/SK 改为用户账号凭据 | `kubectl patch secret` |
| Secret `website-deployer-secrets` | COS AK/SK 改为用户账号凭据 | `kubectl patch secret` |
| DNS `*.lightvela.site` | A 记录指向测试环境 CLB `140.143.177.178` | DNS 控制台 |

### 9.3 测试环境当前镜像

| Deployment | Image | 说明 |
|---|---|---|
| `ctl-api-websites` | `lightclaw/ctl:test-20260811-e2e-fix` | 含建站 API + COS 统一 |
| `site-gateway` | `lightclaw/site-gateway:custom-domain-202608101310` | 含自定义域名支持 |
| `website-deployer` | `lightclaw/workers:test-20260810-181025` | 含 COS 统一 + 流式部署 |
| `frontend-web` | 现有镜像（约 10 天前） | 在 `lightclaw.pages.dev` |

### 9.4 COS Bucket 统一

**⚠️ 关键修复**：三个组件原来使用不同的 COS bucket，现已统一为同一个：

| 组件 | 原 Bucket | 新 Bucket |
|---|---|---|
| ctl-api-websites | `test-vela-user-sites-1388575217`（ap-beijing） | `7869-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746`（ap-shanghai） |
| website-deployer | `test-vela-user-sites-1388575217` | 同上 |
| site-gateway | `test-vela-user-sites-1388575217` | 同上 |

原因：原 bucket APPID `1388575217` 与用户账号 APPID `1251810746` 不同，用户凭据无法访问。统一到用户账号名下的 bucket 后所有组件都能正常读写。

---

## 十、生产发布清单

### 10.0 sgprod（新加坡生产）就绪状态

> 分支 `codex/site-cos-gateway` 已准备以下配置，但尚未合入 `master`，也尚未发布到生产。

**✅ 已就绪：**

| 组件 | 配置文件 | 关键值 |
|---|---|---|
| site-gateway | `argocd/services/site-gateway/sgprod/site-gateway-platform.env` | `SITE_GATEWAY_ROOT_DOMAINS=lightvela.site`，`SITE_GATEWAY_COS_BUCKET=lightvela-user-sites-1388575217`，`SITE_GATEWAY_COS_REGION=ap-singapore` |
| website-deployer | `argocd/services/workers-website-deployer/sgprod/workers-platform.env` | `WEBSITE_COS_BUCKET=lightvela-user-sites-1388575217`，`WEBSITE_COS_REGION=ap-singapore`，`WEBSITE_SITE_ROOT_DOMAIN=lightvela.site` |
| COS AK/SK | `argocd/secrets/sgprod/website-deployer-secrets.sops.yaml` | SOPS 加密，已配置 |
| COS AK/SK | `argocd/secrets/sgprod/site-gateway-secrets.sops.yaml` | SOPS 加密，已配置 |
| COS Bucket/Region/AK/SK | `argocd/secrets/sgprod/ctl-website-runtime-secrets.sops.yaml` | SOPS 加密，已配置 |
| Argo Application | `argocd/apps/sgprod/site-gateway.yaml` | targetRevision=`gitops`，cluster=`sgprod` |
| Argo Application | `argocd/apps/sgprod/workers-website-deployer.yaml` | targetRevision=`gitops`，cluster=`sgprod` |
| Argo AppProject | `argocd/projects/sgprod-site-gateway.yaml` | ✅ |
| Argo AppProject | `argocd/projects/sgprod-workers-website-deployer.yaml` | ✅ |
| SSM manifest | `scripts/ssm_manifest.site-gateway.sgprod.yaml` | region=`ap-singapore` ✅ |
| SSM manifest | `scripts/ssm_manifest.workers-website-deployer.sgprod.yaml` | region=`ap-singapore` ✅ |
| COS lifecycle | `workers/k8s/overlays/sgprod/website-deployer/` | 有 deployment.yaml + kustomization.yaml |

**❌ 仍需处理：**

| 占位符 / 待办 | 文件 | 期望值 / 操作 |
|---|---|---|
| 生产 TLS Secret | 平台证书自动化 | 在 sgprod `ctl` 预置/更新 `site-gateway-wildcard-tls`；证书 ID 只存在于 live Secret，不写入 `argocd/**`，并独立完成续期和轮换 |
| `REPLACE_BOOTSTRAP_TAG`（镜像） | `sgprod/*-platform.env` | CI 流水线自动填充 |
| DB 迁移 000028 | sgprod MySQL | CTL 流水线生产门禁执行一次（含 5 张表和配额 seed） |
| DNS `*.lightvela.site` | DNS 控制台 | 当前指向测试 CLB，需切到 sgprod CLB |
| TAT 命令 | ap-singapore | 需在生产区域创建 |

### 10.1 发布前必须完成

- [ ] **1. DNS 切换准备**
  - 当前 `*.lightvela.site` DNS 指向北京测试环境 CLB `140.143.177.178`
  - 生产发布前需将 DNS 切换到生产环境 CLB IP
  - 建议方案：先在 DNS 控制台将 TTL 调低（60s），发布时切换 A 记录

- [ ] **2. TLS 证书配置到生产**
  - **不能复用测试证书**（测试用 Let’s Encrypt 免费证书，不便于生产管理和续期）
  - 需重新申请生产专用 `*.lightvela.site` 泛域名证书
  - sgprod GitOps 只配置稳定 Secret 名：`site-gateway-wildcard-tls`
  - 平台证书自动化负责申请/续期、上传腾讯云 SSL，并更新 `ctl` 命名空间 live Secret 的 `qcloud_cert_id`
  - 证书 ID 轮换不修改 GitOps；更新后验证 qcloud Ingress controller 和公网 HTTPS 已切到新证书
  - site-gateway 日常 Kustomize 只引用稳定 Secret 名称，不创建或覆盖证书绑定

- [x] **3. COS Bucket ✅ 已创建已配置**
  - 新加坡生产 COS bucket `lightvela-user-sites-1388575217`（`ap-singapore`）**已创建**
  - 三个组件的 GitOps 配置**已写入**：
    - `argocd/services/workers-website-deployer/sgprod/workers-platform.env`
    - `argocd/services/site-gateway/sgprod/site-gateway-platform.env`
    - `argocd/secrets/sgprod/ctl-website-runtime-secrets.sops.yaml`（加密）
  - COS AK/SK SOPS 密钥**已配置**：
    - `argocd/secrets/sgprod/website-deployer-secrets.sops.yaml`
    - `argocd/secrets/sgprod/site-gateway-secrets.sops.yaml`
    - `argocd/secrets/sgprod/ctl-website-runtime-secrets.sops.yaml`
  - `WEBSITE_SITE_ROOT_DOMAIN=lightvela.site` 已配置（原占位符已修复）
  - SSM manifest 已就位：`scripts/ssm_manifest.workers-website-deployer.sgprod.yaml`
  - ⚠️ 测试环境仍使用虾米老师个人 bucket `7869-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746`，生产环境用正式 bucket

- [ ] **4. DB 迁移**
  - 生产 DB 执行 `000028` 一次 migration（已合并自定义域名表）
  - 验证 `bundle.static_site_quota` 列已创建
  - 验证配额种子数据正确（launch=1/5GB/10GB，cruise=5/40GB/20GB）
  - 验证 5 张 website 表已创建：`website_sites`、`website_releases`、`website_operations`、`website_usage_daily`、`website_custom_domains`

- [ ] **5. GitOps manifests**
  - sgprod 的 site-gateway、website-deployer、Ingress 和 SOPS 结构已在功能分支准备
  - 发布前在受保护环境核验现有 SOPS 是否对应当前 SSM；仅在 SSM 变更或 SOPS 过期/无效时按现有 manifest 重新导出，随后执行 secret scan 和 KSOPS render 校验
  - 替换生产镜像 tag 等发布期占位符后再合入 `gitops`；生产证书 ID 不进入 GitOps

- [x] **6. service-gateway 建站路由配置**
  - sgprod 已包含 `ctl-websites` 和 `ctl-instance-websites` 路由
  - `ctl-instance-websites` 已配置 8 条 allowlist 精确匹配建站 API 路径
  - `/v1/frontend/runtime-config` 已在最新 `master`，是计费/实名的后端运行时配置接口，不是建站 UI 开关，也不属于本 MR 差异

- [ ] **7. 镜像构建**
  - 从 `codex/site-cos-gateway` 分支构建生产镜像
  - 推送到生产 TCR
  - 更新 GitOps 中的 image tag

- [ ] **8. TAT 命令创建**
  - 在生产区域（ap-shanghai）创建 TAT 命令
  - 使用 `create_hermes_website_credential_command.sh`
  - 记录 CommandId

- [ ] **9. 用户实例凭据下发**
  - 遍历所有生产 CVM 实例
  - 调用 CTL 内部 API 签发 per-instance token
  - 通过 TAT 下发到每台机器
  - 验证 `/etc/vela/website-credential.env` 已安装

### 10.2 发布步骤

1. **合入 master** → 触发本次命中的后端流水线并确认生产 TCR 中目标镜像存在；本分支无 frontend 路径变更，不自动触发 frontend 构建，但必须冻结从当前 `master` 手动发布国际站 frontend
2. **生产发布准备** → 由平台证书自动化申请/托管正式 `*.lightvela.site` 证书并创建 `site-gateway-wildcard-tls`；准备生产 CLB 地址但暂不切 DNS
3. **受保护配置** → 核验现有 SOPS 是否对应生产 SSM；仅在 SSM 变更或 SOPS 过期/无效时重新导出，执行 secret scan 和 KSOPS render；不得输出 secret 明文
4. **DB 迁移** → CTL 发布门禁执行唯一的 `000028`，验证版本 28、5 张表和配额 seed
5. **Promote 后端 GitOps** → 分别 promote CTL、service-gateway、website-deployer 和 site-gateway，审查并合并到 `gitops`；本阶段不 promote frontend
6. **Argo CD sync** → 人工同步并验证 revision、workload image、`Synced / Healthy`
7. **TLS/CLB 验证** → 先用 Host 绑定或临时解析验证生产 CLB、Ingress 和正式证书，确认后再切 wildcard DNS
8. **DNS 切换** → `*.lightvela.site` 从北京测试 CLB 切到 sgprod CLB，等待 TTL 收敛
9. **TAT 小流量下发** → 给少量真实用户实例安装凭据和 website-builder Skill
10. **真实 HTTPS E2E** → 在真实用户机器创建、发布、访问 `https://<site_id>.lightvela.site/`、删除并验证 404；通过后扩大下发
11. **前端后发** → 后端验收通过后再合入/发布 Sarah 前端分支；若后端就绪前必须发布其他 frontend 需求，先在独立前端 MR 增加默认关闭的建站 feature flag

### 10.3 发布后验证

```bash
# 1. 验证 DNS 解析
dig +short test.lightvela.site

# 2. 验证 TLS
curl -v https://ws-xxx.lightvela.site/ 2>&1 | grep "subject\|issuer"

# 3. 验证站点访问
curl -sk https://ws-xxx.lightvela.site/ -o /dev/null -w '%{http_code}'

# 4. 验证 API
curl -s https://api.lightvela.ai/v1/websites/capability \
  -H "Authorization: Vela-Instance-Key vik_xxx_yyy"

# 5. 验证用户机器凭据
ssh agentuser@<instance_ip>
cat /etc/vela/website-credential.env | grep VELA_WEBSITE_KEY | wc -c
systemctl --user is-active hermes-gateway.service
```

---

## 十一、回滚方案

### 11.1 DNS 回滚

```bash
# 将 *.lightvela.site DNS 切回测试环境或删除
# 在 DNS 控制台操作
```

### 11.2 GitOps 回滚

```bash
# 回滚 gitops 分支到发布前的 commit
git checkout gitops
git reset --hard <pre-release-commit>
git push --force-with-lease origin gitops
# Argo CD 自动检测并回滚
```

### 11.3 DB 回滚

```bash
# 执行 down migration
# 000029 已合并到 000028，回滚只需跑 000028 down
mysql -h <prod-db> -e "USE ctl; source ctl/migrations/000028_create_static_website_platform.down.sql;"
```

> **注意**：DB 回滚会删除所有 website 表和数据。只在确认无用户数据时执行。

### 11.4 测试环境恢复

如果需要恢复测试环境到发布前状态：

1. 删除 Ingress 中的 `*.lightvela.site` 规则
2. 删除 Secret `site-gateway-lightvela-tls`
3. 恢复三个 deployment 的 COS bucket 环境变量为原值
4. 恢复三个 Secret 的 AK/SK 为原值
5. 删除 DNS `*.lightvela.site` A 记录

---

## 十二、待完成事项

### 12.1 生产发布前必做

| # | 事项 | 优先级 | 说明 |
|---|---|---|---|
| 1 | ~~创建生产专用 COS bucket~~ ✅ | 已完成 | bucket `lightvela-user-sites-1388575217`（ap-singapore）已创建，GitOps + SOPS 已配置 |
| 2 | 持久化仍需保留的非证书临时改动 | P0 | 应用/路由配置进入 GitOps；平台维护的 TLS live Secret 不写入 GitOps |
| 3 | service-gateway 生产路由 | P0 | 建站路由已在最新 `master` 准备；本 MR 不含 frontend 或 frontend runtime-config 路由变更 |
| 4 | DNS 切换方案确认 | P0 | 需要与产品确认 DNS 管理权限 |
| 5 | TLS 证书生产部署 | P0 | 正式泛域名证书和平台自动化尚未完成；需验证轮换时 live Secret 更新、CLB 切换和公网 HTTPS |
| 6 | 镜像构建+推送生产 TCR | P0 | 从分支构建 |
| 7 | bundle_free_trial_01 的 max_artifact_size | P1 | 测试环境是 20MB，需确认生产是否统一为 50MB |
| 8 | TAT 命令在生产区域创建 | P1 | sgprod 所在生产区域 |
| 9 | 用户实例凭据批量下发 | P1 | 生产 CVM 应该有 TAT Agent |

### 12.2 测试环境待做

| # | 事项 | 说明 |
|---|---|---|
| 1 | 真实用户机器端到端测试 | 历史 E2E 是 API 直调；仍需通过 TAT 下发的 token + website-builder Skill 在真实 LightVela 用户机器闭环 |
| 2 | TAT 下发验证 | 需确认测试环境实际 LightVela 底层机器，并通过 TAT 验证 token 与 Skill 下发 |
| 3 | 前端管理界面验证 | 国际测试前端已出现“我的作品”，但仍需结合真实用户机器完成创建、发布和访问闭环 |
| 4 | 站点删除后公网 404 验证 | 已在之前测试验证，但 DNS/TLS 变更后需重新验证 |
| 5 | 配额耗尽场景测试 | 创建 max_sites 个站点后再创建应返回 WEBSITE_NO_QUOTA |
| 6 | 自定义域名绑定测试 | website_custom_domains 功能的端到端验证 |

### 12.3 代码合并

- 当前分支 `codex/site-cos-gateway` 包含 563 个文件变更
- **绝对不可以推 master**
- 需要 create MR → code review → 合并到 master
- master 合并后从 master 构建生产镜像
- GitOps 分支更新 image tag + 环境变量

---

## 十三、风险评估

| 风险 | 等级 | 说明 | 缓解措施 |
|---|---|---|---|
| ~~COS bucket 用个人账号~~ | ✅ 已解决 | 生产 bucket `lightvela-user-sites-1388575217`（ap-singapore）已创建并配置 | 无需额外操作 |
| DNS 切换导致短暂不可用 | 🟡 中 | `*.lightvela.site` 从测试 CLB 切到生产 CLB 时有短暂中断 | 低 TTL（60s），在低峰期切换 |
| TAT Agent 未安装 | 🟡 中 | 生产 CVM 应该有 TAT，但需确认 | 发布前批量检查 TAT Agent 状态 |
| 配额 free_trial 不一致 | 🟢 低 | free_trial 的 max_artifact_size 是 20MB vs 50MB | 确认后统一 |
| 证书过期 | 🟡 中 | 测试 Let's Encrypt 证书 2026-11-08 过期；生产需申请付费证书并管理续期 | 测试证书设置告警；生产证书按付费证书管理流程续期 |
| Redis 队列积压 | 🟡 中 | 大量并发发布时 deployer 可能积压 | 监控队列长度，扩容 deployer |
| 沙箱实例 TAT 不可用 | 🟡 中 | 测试环境沙箱无 TAT，无法测 Skill on machine | 生产 CVM 有 TAT，或用 SSH 替代测试 |

---

## 十四、附录

### 14.1 关键代码路径

| 文件 | 作用 |
|---|---|
| `ctl/migrations/000028_create_static_website_platform.up.sql` | DB 迁移：建站平台核心表 |

| `ctl/main/api/website_credential_handler.go` | 凭据签发/校验 |
| `ctl/main/api/website_handler.go` | 建站 API handler |
| `ctl/main/api/server.go:242-252` | 建站路由注册 + auth middleware |
| `ctl/main/api/server.go:734` | TAT session 端点 |
| `ctl/pkg/logic/website/logic.go` | 建站核心逻辑（创建/发布/删除） |
| `ctl/pkg/websiteauth/store.go` | Redis 凭据存储 |
| `site-gateway/internal/hostroute/hostroute.go` | Host → site_id 路由 |
| `site-gateway/internal/origin/cos.go` | COS 反向代理 |
| `site-gateway/internal/sitemeta/sitemeta.go` | 站点元数据查询 |
| `workers/internal/website/deployer.go` | 制品部署器 |
| `workers/internal/website/storage.go` | COS 存储操作 |
| `images/helpers/install-hermes-website-credential.sh` | TAT 机器端安装脚本 |
| `.ci/runtime/commands/create_hermes_website_credential_command.sh` | TAT 命令创建 |
| `.ci/runtime/commands/invoke_hermes_website_credential_command.sh` | TAT 命令调用 |
| `.agents/skills/website-builder/SKILL.md` | 建站 Skill |

### 14.2 关键 API 详情

**鉴权头格式**：
```
Authorization: Vela-Instance-Key vik_<key_id>_<secret>
```
（注意：不是 `Vela-Instance-Key: <token>`，是 `Authorization: Vela-Instance-Key <token>`）

**创建发布请求体**：
```json
{
  "artifact_hash": "<sha256>",
  "artifact_size": <bytes>,
  "file_count": <int>
}
```
（注意：不是 `artifact_type` / `version` / `description`）

**凭据签发**：
```http
POST /internal/ctl/instances/{instanceId}/website-credential
Authorization: Bearer <CTL_INTERNAL_TOKEN>
```

### 14.3 测试环境连接信息

| 资源 | 值 |
|---|---|
| DevCloud SSH | 从本机私有凭据文件读取，交接文档不记录账号密码 |
| K8s kubeconfig | `/etc/lightclaw-ci/kubeconfig_beijing_sandbox`（DevCloud 上） |
| DB Host | `10.15.224.4:3306` |
| DB Name | `ctl` |
| Redis | `10.15.231.163:6379` |
| COS Bucket | `7869-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746` / `ap-shanghai` |
| CLB IP | `140.143.177.178`（lb-kbl26vb5） |
| 测试站点 | `https://ws-82eeb1f6397c988f.lightvela.site/` |

### 14.4 测试账号

测试账号登录命令仅保存在本机私有文件 `~/.lightclaw/test-login-commands.txt`，不得写入仓库。曾进入 Git 历史的测试 token 和跳板凭据必须轮换。

测试 URL：`https://lightclaw.pages.dev/agents/websites/`

### 14.5 环境变量速查

**site-gateway**：
- `SITE_GATEWAY_ROOT_DOMAINS=lightvela.site,sites.lightclaw.tech`
- `SITE_GATEWAY_COS_BUCKET=7869-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746`
- `SITE_GATEWAY_COS_REGION=ap-shanghai`
- `WEBSITE_COS_BUCKET`（同上）
- `WEBSITE_COS_REGION`（同上）

**ctl-api-websites**：
- `WEBSITE_COS_BUCKET=7869-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746`
- `WEBSITE_COS_REGION=ap-shanghai`

**website-deployer**：
- `WEBSITE_COS_BUCKET=7869-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746`
- `WEBSITE_COS_REGION=ap-shanghai`

### 14.6 E2E 测试记录

> 以下为 2026-08-11 的历史 API 直调记录，不代表当前真实用户机器链路或生产环境已经验收。2026-08-13 回归时，站点 `ws-b9ee58a2fe00cbf9` 虽为 `active`，但其发布目录缺少可读取的 `index.html`，旧域名和 `lightvela.site` 均返回 404；需要重新发布并通过 TAT + Skill 链路复测。

| 步骤 | 状态 | 详情 |
|---|---|---|
| DB 迁移 | ✅ | 000028 已执行（含自定义域名表），表和配额数据正确 |
| TLS 证书 | ✅ | `*.lightvela.site` 证书 ID `ZtmnNUcl`，Let's Encrypt |
| Ingress 配置 | ✅ | `*.lightvela.site` host + TLS 已添加 |
| DNS 解析 | ✅ | `*.lightvela.site` → `140.143.177.178` |
| COS Bucket 统一 | ✅ | 三个组件使用同一 bucket |
| 站点创建 | ✅ | `ws-82eeb1f6397c988f`，public_url `https://ws-82eeb1f6397c988f.lightvela.site/` |
| 制品上传 | ✅ | ZIP 610 bytes，SHA256 校验通过 |
| 部署 | ✅ | operation `wo-a4f3c18013eea322` status=success |
| HTTPS 访问 | ✅ | `curl -sk https://ws-82eeb1f6397c988f.lightvela.site/` → 200 + 正确 HTML |
| 站点删除 | ✅ | 站点数和存储回到 0 |

### 14.7 相关文档

| 文档 | 路径 |
|---|---|
| COS site-gateway handover | `docs/handover/2026-08-06-cos-site-gateway-handover.md` |
| 实例身份与建站凭据 | `docs/handover/2026-08-07-instance-identity-website-token-handover.md` |
| TAT 凭据下发指南 | `docs/handover/2026-08-07-hermes-website-token-delivery-for-agent.md` |
| 建站迁移 runbook | `docs/runbooks/ctl-website-migration-shprod.md` |
| 部署 SOP | `.agents/skills/deploy-beijing-sandbox/SKILL.md` |
| 建站 Skill | `.agents/skills/website-builder/SKILL.md` |

---

> **本文档不含任何 token、密钥、密码的实际值。所有凭据仅以占位符或环境变量名表示。**
