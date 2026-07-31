# CloudBase 静态建站 — 详细实现计划

> 分支: `codex/cloudbase-static-site`
> 前置设计: `docs/superpowers/specs/2026-07-31-cloudbase-static-site-design.md`

## 已完成

- ✅ 迁移 000028-000033（6个SQL文件）
- ✅ `ctl/pkg/model/website/entity.go`（4个实体 + 配额类型 + 状态常量）
- ✅ `ctl/pkg/model/website/dao.go`（4个DAO接口 + 实现，有1处需修复）

---

## Phase 3: 修复 dao.go 编译错误

### 文件: `ctl/pkg/model/website/dao.go`

**问题**: `CountDeploysToday` 中链式调用 `.Count(&struct{}{}).Count(nil)` 不合法。

**修复方案**:
```go
func (d *releaseDao) CountDeploysToday(siteID string) (int64, error) {
    now := time.Now()
    start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
    var count int64
    err := resource.GormDB.Table(d.TableName).
        Where("site_id = ? AND created_time >= ?", siteID, start).
        Count(&count).Error
    return count, err
}
```

**验证**: `cd ctl && go build ./pkg/model/website/` 编译通过。

---

## Phase 4: ctl 业务逻辑层

### 文件: `ctl/pkg/logic/website/logic.go`

**包**: `website`

**依赖**:
- `ctl/pkg/model/website` (entity + dao)
- `ctl/pkg/model/idgen` (GenId)
- `ctl/pkg/model/userresourcequota` (AllocQuota / FreeQuota / SelectQuota)
- `ctl/pkg/model/bundle` (读 static_site_quota)
- `ctl/pkg/model/pass` (读用户有效Pass)
- `ctl/pkg/resource` (GormDB)

**接口**:
```go
type Logic interface {
    // 懒初始化配额，返回用户建站能力摘要
    GetCapability(ctx context.Context, userID string) (*Capability, error)
    // 创建站点（事务：扣席位 + 写site + 写operation）
    CreateSite(ctx context.Context, userID, passID, bundleID, name, idempotencyKey string) (*CreateSiteResult, error)
    // 列出站点
    ListSites(userID string, page, pageSize int) ([]*website.SiteEntity, int64, error)
    // 查询单个站点
    GetSite(userID, siteID string) (*website.SiteEntity, error)
    // 创建发布（校验+写release+写operation+生成上传地址）
    CreateRelease(ctx context.Context, userID, siteID string, req CreateReleaseRequest) (*CreateReleaseResult, error)
    // 查询操作状态
    GetOperation(operationID string) (*website.OperationEntity, error)
    // worker回调：操作完成
    CompleteOperation(operationID, cloudPath, publicURL string) error
    // worker回调：操作失败
    FailOperation(operationID, errorMessage string) error
    // 删除站点（事务：释放席位 + 软删site + 写operation）
    DeleteSite(ctx context.Context, userID, siteID string) (*DeleteSiteResult, error)
}
```

**返回类型**:
```go
type Capability struct {
    MaxSites            int   `json:"max_sites"`
    UsedSites           int   `json:"used_sites"`
    MonthlyTrafficBytes int64 `json:"monthly_traffic_bytes"`
    UsedTrafficBytes    int64 `json:"used_traffic_bytes"`
    StorageBytes        int64 `json:"storage_bytes"`
    MaxArtifactSize     int64 `json:"max_artifact_size"`
    MaxFiles            int   `json:"max_files"`
    DailyDeployLimit    int   `json:"daily_deploy_limit"`
}

type CreateSiteResult struct {
    SiteID      string `json:"site_id"`
    OperationID string `json:"operation_id"`
}

type CreateReleaseRequest struct {
    ArtifactHash string
    ArtifactSize int64
    FileCount    int
}

type CreateReleaseResult struct {
    ReleaseID    string `json:"release_id"`
    OperationID  string `json:"operation_id"`
    Version      int    `json:"version"`
    UploadURL    string `json:"upload_url"`  // COS预签名
    UploadMethod string `json:"upload_method"`
}

type DeleteSiteResult struct {
    OperationID string `json:"operation_id"`
}
```

**关键函数实现逻辑**:

#### `GetCapability`
1. 查用户当前有效Pass（从pass表查status=active且未过期的）
2. 从pass.bundle_id查bundle的static_site_quota
3. 如果用户在user_resource_quota中没有WEBSITE_STATIC_SITE行：
   - 事务内 INSERT IGNORE 写入 max_sites 配额行
   - 同时写入 WEBSITE_TRAFFIC 配额行
4. 查已用站点数（CountActiveByUserID）
5. 查当月已用流量（SumTrafficByUserAndDateRange，月初到今天）
6. 组装Capability返回

#### `CreateSite`
1. 校验用户有效Pass和套餐配额
2. 幂等检查：idempotencyKey 对应的 operation 是否已存在
3. 事务：
   a. `idgen.GenId("website_site")` 生成 site_id: `ws-{id}`
   b. `userresourcequota.AllocQuota(userID, "WEBSITE_STATIC_SITE", "", 1)` — 原子扣席位，失败=超限
   c. INSERT website_sites (status=creating)
   d. `idgen.GenId("website_operation")` 生成 operation_id: `wo-{id}`
   e. INSERT website_operations (type=create, status=created)
4. 返回 site_id + operation_id

#### `CreateRelease`
1. 查 site 属于当前用户且 status in (creating, active)
2. 查套餐配额限制
3. 校验 artifact_size <= max_artifact_size
4. 校验 file_count <= max_files
5. 校验今日发布次数 <= daily_deploy_limit
6. 事务：
   a. `idgen.GenId("website_release")` 生成 release_id: `wr-{id}`
   b. GetNextVersion(siteID) 得到 version
   c. INSERT website_releases (status=pending)
   d. `idgen.GenId("website_operation")` 生成 operation_id
   e. INSERT website_operations (type=deploy, status=created, release_id=release_id)
7. 生成 COS 预签名上传 URL（制品路径: `website-artifacts/{site_id}/{release_id}.zip`）
8. 返回结果

#### `CompleteOperation`（worker回调）
1. 查 operation
2. 事务：
   a. 如果 type=create: 更新 site status=active
   b. 如果 type=deploy: 更新 release status=active, site status=active, site.cloud_path/public_url
   c. 如果 type=delete: 软删 site
   d. 更新 operation status=success

#### `FailOperation`（worker回调）
1. 事务：
   a. 更新 operation status=failed, error_message
   b. 如果 type=create: 释放席位 FreeQuota, 更新 site status=deleted
   c. 如果 type=deploy: 更新 release status=failed

#### `DeleteSite`
1. 查 site 属于当前用户
2. 事务：
   a. `userresourcequota.FreeQuota(userID, "WEBSITE_STATIC_SITE", "", 1)` — 释放席位
   b. 软删 site (status=deleted, deleted_time=now)
   c. INSERT operation (type=delete, status=created)
3. 返回 operation_id（worker异步清理CloudBase制品）

---

## Phase 5: ctl HTTP handler + 路由注册

### 文件: `ctl/main/api/website_handler.go`

**结构体**: `websiteHandler`，注入 `website.Logic`

**路由映射**:
```
GET    /v1/websites/capability           → handleCapability
POST   /v1/websites                       → handleCreateSite
GET    /v1/websites                       → handleListSites
GET    /v1/websites/{siteId}              → handleGetSite
POST   /v1/websites/{siteId}/releases     → handleCreateRelease
GET    /v1/websites/{siteId}/releases     → handleListReleases
GET    /v1/websites/{siteId}/operations/{opId} → handleGetOperation
DELETE /v1/websites/{siteId}              → handleDeleteSite
POST   /internal/ctl/websites/operations/{opId}/complete → handleCompleteOperation
POST   /internal/ctl/websites/operations/{opId}/fail    → handleFailOperation
```

**每个 handler 函数**:
- 从 header `X-User-Id` 取 userID
- 解析 request body / path param
- 调 logic
- 返回 successResponse / errorResponse

### 文件: `ctl/main/api/server.go`（修改）

在 `newRouter()` 中新增:
```go
wh := &websiteHandler{logic: websitelogic.NewLogic()}
mux.HandleFunc("/v1/websites", wh.handleWebsitesRoot)     // GET list / POST create / GET capability
mux.HandleFunc("/v1/websites/", wh.handleWebsitesByID)      // 子路径分发
mux.HandleFunc("/internal/ctl/websites/operations/", wh.handleInternalOperations)
```

注意：`/v1/websites` 和 `/v1/websites/` 都需要注册，因为 Go 的 ServeMux 用最长前缀匹配。

---

## Phase 6: bundle entity 新增字段

### 文件: `ctl/pkg/model/bundle/entity.go`（修改）

在 `Entity` 结构体中新增:
```go
StaticSiteQuota *string `gorm:"column:static_site_quota"` // JSON string from DB
```

### 文件: `ctl/pkg/model/bundle/dao.go`（可能需要新增方法）

如果需要通过 bundle_id 查 static_site_quota，新增:
```go
GetStaticSiteQuota(bundleID string) (*website.BundleStaticSiteQuota, error)
```

---

## Phase 7: userresourcequota 注册新资源类型

### 文件: `ctl/pkg/logic/userresourcequota/logic.go`（修改）

在 `defaultQuotaTotalMap` 中新增:
```go
resourceNameWebsiteSite    = "WEBSITE_STATIC_SITE"
resourceNameWebsiteTraffic = "WEBSITE_TRAFFIC"
```

或在 `ValidUserResourceName` 中加入校验。

---

## Phase 8: service-gateway 路由配置

### 文件: `argocd/services/service-gateway/beijing-sandbox/config.yaml`（修改）

新增路由:
```yaml
  - name: ctl-websites
    prefix: /v1/websites
    methods: [GET, POST, DELETE, OPTIONS]
    upstream: http://ctl-api.ctl.svc.cluster.local
    access: authenticated
    auth_strategy: session
    response_header_timeout: 30s

  - name: website-public
    prefix: /s
    methods: [GET, HEAD, OPTIONS]
    upstream: http://ctl-api.ctl.svc.cluster.local
    access: public
    response_header_timeout: 30s
```

一期站点代理先指向 ctl（ctl 内部实现代理逻辑），后续可拆独立服务。

---

## Phase 9: 流量代理逻辑

### 文件: `ctl/main/api/website_proxy.go`（新建）

在 ctl 内部实现 `/s/{siteId}` 的流量代理:
1. 解析 siteId 从 path
2. 查 website_sites 获取 cloud_path 和 status
3. 如果 status != active → 返回停用页
4. 代理到 CloudBase 静态托管 URL: `{cloud_path}/{remaining_path}`
5. 响应返回后记录 Content-Length 到 Redis（原子 INCR）
6. 后台 cron 每小时汇总 Redis → website_usage_daily → 扣减 user_resource_quota

**函数**:
```go
func (h *websiteHandler) handleSiteProxy(w http.ResponseWriter, r *http.Request)
```

注册路由在 server.go:
```go
mux.HandleFunc("/s/", wh.handleSiteProxy)
```

---

## Phase 10: 部署 Worker

### 目录: `workers/cmd/website-deployer/`

### 文件: `workers/cmd/website-deployer/main.go`

入口：轮询 ctl 的 `/internal/ctl/websites/operations?status=created` 获取待执行操作。

### 文件: `workers/internal/website/deployer.go`

**接口**:
```go
type Deployer interface {
    Deploy(operation *website.OperationEntity) error
}
```

**实现**:
1. 从 COS 下载制品 zip
2. 解压到临时目录
3. 调用 CloudBase Manager SDK / CLI 部署到静态托管
4. 成功后回调 ctl `/internal/ctl/websites/operations/{id}/complete`
5. 失败后回调 ctl `/internal/ctl/websites/operations/{id}/fail`

### 文件: `workers/internal/website/cloudbase.go`

封装 CloudBase 管理 API 调用:
- 使用 `@cloudbase/manager-node` 或直接调 Tencent Cloud API
- 一期用 Go SDK: `github.com/tencentcloud/tencentcloud-sdk-go`
- 调用 `UploadFiles` / `DeleteFiles` 等静态托管管理接口

### k8s 部署:
```
workers/k8s/overlays/beijing-sandbox/website-deployer/
  deployment.yaml
  serviceaccount.yaml
  kustomization.yaml
```

---

## Phase 11: Vela 建站 Skill

### 文件: `.agents/skills/cloudbase-site-builder/SKILL.md`

**Skill 内容**:
1. 前置说明：用户不需要腾讯云账号
2. 第一步：GET /v1/websites/capability 查权益
3. 第二步：与用户澄清需求（站点类型、风格）
4. 第三步：生成 HTML/CSS/JS 静态产物
5. 第四步：本地构建和浏览器自测
6. 第五步：POST /v1/websites 创建站点
7. 第六步：POST /v1/websites/{siteId}/releases 创建发布
8. 第七步：上传制品到 COS
9. 第八步：轮询操作状态
10. 第九步：返回 Vela 域名给用户

---

## Phase 12: 编译验证

```bash
cd ctl && go build ./...
cd service-gateway && go build ./...
cd workers && go build ./...
```

修复所有编译错误。

---

## Phase 13: 北京测试环境部署

### 步骤:

1. `git push origin codex/cloudbase-static-site`
2. 构建镜像:
   ```bash
   python3 .ci/runtime/commands/build_release_image.py --service ctl --env beijing-sandbox --tag test-$(date +%Y%m%d-%H%M%S)
   ```
3. 更新 GitOps:
   - 修改 `argocd/services/ctl/beijing-sandbox/ctl-platform.env` 的 `CTL_IMAGE`
   - 修改 `argocd/services/service-gateway/beijing-sandbox/service-gateway-platform.env` 的 `SERVICE_GATEWAY_IMAGE`
   - 修改 `argocd/services/service-gateway/beijing-sandbox/config.yaml` 加路由
4. 提交到 `gitops` 分支并创建 MR
5. 等 Argo CD 同步
6. 验证 pod 状态和健康检查

---

## Phase 14: 端到端验证

### 测试脚本:
1. 用测试账号登录获取 session
2. GET /v1/websites/capability — 确认懒初始化配额
3. POST /v1/websites — 创建站点
4. GET /v1/websites/{siteId} — 确认站点信息
5. 构建一个简单的 HTML 测试页面
6. POST /v1/websites/{siteId}/releases — 创建发布
7. 上传制品到 COS
8. 轮询 GET /v1/websites/{siteId}/operations/{opId} — 等待 success
9. GET /s/{siteId}/index.html — 访问站点
10. 确认流量计量写入

### 验收标准:
- [ ] 配额懒初始化正确
- [ ] 创建站点扣席位
- [ ] 发布成功后站点可访问
- [ ] 删除站点释放席位
- [ ] Pass到期后站点被停用
