# CloudBase 静态建站一期 — 交接文档

> 交接对象：接手本需求的下一位 AI / 工程师
> 交接时间：2026-08-05
> 分支：`codex/cloudbase-site-prod`（**所有改动尚未提交**）
> 上一份审查报告结论：从「不具备发布条件」推进到「测试环境全链路已验证通过，生产接线待外部依赖」

---

## 1. 这个需求是什么

用户在 Hermes（Vela 客户端）里说一句话，例如"帮我做个个人主页"，AI 就完成建站并返回可访问的公网地址。
**用户全程不感知 CloudBase /腾讯云 / 环境 ID / 密钥**。

链路：

```
Hermes 里的 Skill (`website-builder`)
   ↓ HTTPS /v1/websites/*
service-gateway → ctl（建站编排 + 配额 + 状态机）
   ↓ Redis 队列通知 + DB 持久重试
website-deployer worker（读取制品、上传 CloudBase COS、清理）
   ↓
用户拿到 https://{env}-{app}.tcloudbaseapp.com/sites/{siteId}/current/index.html
```

### 已由产品拍板的决策（**不要再改，也不要再问用户**）

| 决策项 | 结论 |
|---|---|
| 存储/流量限制 | **后端一期不做限制**，前端页面展示的额度只是文案。这是有意决策 |
| 配额由谁管 | 后端管（席位数），通过 `user_resource_quota` 表 |
| 启航(free) | 1 站 / 5GB 存储 / 10GB 流量 |
| 巡游(general) | 3 站 / 20GB 存储 / 25GB 流量 |
| ai 档 | **与巡游一致**（3 站 / 20GB / 25GB），已由迁移 000042 修正（原为 10 站/500MB） |
| 开通范围 | **全量开通**，含 free 档。预计每周 500 新用户，成本可接受，不需要灰度开关 |
| 套餐到期行为 | **方案 1：暂存并下线**。删除线上文件（真下线），保留制品；续费自动恢复；Pass 最终销毁时连制品一起删|
| 站点URL | **必须固定不变**，已实现（`current/` 前缀） |
| 部署方案 | **共享 COS 目录**（PRD 里的方案 B），**不回 CloudApp**。理由已论证：CloudApp 每站一个应用会撞环境应用数上限、且带构建管道拖慢部署 |
| 发布范围 | **只上国内 shprod**，不做国际 sgprod |
| Skill 下发 | 不用管，有专门同学负责。我们只需把 Skill 内容准备好 |
| 测试账号 | 腾讯云 UIN `815836472`（TCB 生产环境尚未采购，先用它验证） |

### 需求文档

- TAPD 技术需求 v2：`1010132091136767992`（短 ID `136767992`）
  https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091136767992
  ⚠️ 用户说他会去改这个单子，改完需要重新核对一遍实现与文档的一致性
- 关联单（**方案已废弃，建议关闭**）：`1010132091136766112` — TCB 子域名路由方案及证书修复。v2 已去掉反代/子域名/证书依赖
- 本地 PRD 草案：`wiki/prd-docs/2026-07-31-cloudbase-static-site-entitlement.md`
- 历史完整讨论：codex 中的「探索腾讯云 TCB」会话（用户指定的信息源，有疑问先查这里）

---

## 2. 已完成的代码改动

**全部未提交**，在 `codex/cloudbase-site-prod` 分支的工作区里。`ctl` 与 `workers` 的
`go build` / `go vet` / `go test` 全绿。

### 2.1 站点 URL 稳定化（P0 功能缺陷修复）

**问题**：原实现 public_url 是 `sites/{siteId}/releases/{releaseId}/index.html`，
每次重新部署 releaseID 变、URL 就变；且首次创建站点时写入的是 `.../releases/` 目录（无 index，404）。

**改法**（`workers/internal/website/deployer.go`）：
- 新增 `sitePublishedPrefix(siteID)` → `sites/{siteId}/current/`，作为唯一对外前缀
- 部署流程改为两阶段：先上传到`releases/{releaseId}/` 暂存区，全部成功后 `syncToCurrent()`
  用 COS CopyObject 同步到 `current/`，并删除 `current/` 下本次不存在的残留文件
- 部署中途失败不会破坏线上站点（暂存区隔离）
- 顺带解决了旧 release 目录无限堆积的问题

### 2.2 Content-Type 缺失（P0 功能缺陷修复）

**问题**：原实现 `Object.Put(ctx, key, reader, nil)` 传 nil opt，COS 缺省按
`application/octet-stream` 存储 → 浏览器**下载** index.html 而不是渲染 → 站点等于不可用。
已核对 cos-go-sdk-v5 v0.7.75 确认 SDK 不会按扩展名推断。

**改法**：新增 `contentTypeForKey(key)` 按扩展名显式设置 Content-Type。

### 2.3 上传改流式（避免 OOM）

**问题**：一版改动曾把zip 条目读进内存再上传，配合 `MAX_CONCURRENCY=10` 会导致峰值内存暴涨OOM。

**改法**：`openZipEntryForUpload()` 返回流式 reader +用 zip 头里的
`UncompressedSize64` 作为 `ContentLength`（解压流不是 LenReader，SDK 拿不到长度会退化成
COS 不接受的分块传输）。空条目单独走 `bytes.Reader`（SDK 在"拿不到长度且ContentLength=0"时会直接报错）。
同时 worker 默认 `MAX_CONCURRENCY` 从 10 降到 4，与 512Mi 内存 limit 匹配。

### 2.4 制品大小上限不一致（会导致大制品部署失败）

**问题**：套餐允许 50MB 制品，但 worker 兜底 `WEBSITE_MAX_ARTIFACT_BYTES` 默认只有 10MB
→ ctl 放行、worker 拒绝。

**改法**：默认改为 64MB（≥ 最大套餐额度），解压总量上限 256MB。精确的按套餐校验仍由 ctl 负责。

### 2.5 套餐到期暂存下线 + 续费恢复（方案 1，新功能）

原实现只改 DB 的 status 字段，CloudBase 上文件一个没动，**站点到期后仍 100% 公网可访问**。

新增：
- `OpTypeSuspend` / `OpTypeResume` 两种操作类型（`ctl/pkg/model/website/entity.go`）
- `OnPassIsolated`：站点立即转 `suspended`，推进 generation，登记 suspend 操作
- `OnPassRenewed`：找到active release，登记 resume 操作，**恢复期间保持 suspended**
  （避免"状态可用但内容还没上线"的空窗）；从未部署过内容的站点直接转 active，不登记注定失败的操作
- worker `executeSuspend`：删除 `current/` 下所有对象（真下线），**保留 `_artifacts/` 制品**
- worker `executeResume`：从保留的制品重新解压上传到 `current/`
- 部署成功后**不再删除制品 zip**（原实现会删），制品作为"暂存"的载体，
  最终在 Pass 销毁时由 `executeDelete` 清理 `sites/` + `_artifacts/` 两个前缀

⚠️ **重要事实修正**：用户以为"14 天后删除数据"是我们的逻辑，其实**不是**。
`ctl` 里没有任何"isolated 满 N 天就销毁"的扫描器或天数常量。状态机从 `isolated`
出发只有 `renewing` / `deleting` / `terminating` 三条边，全部由外部请求驱动（等jifei 的
`destroyResource` 回调）。**14 天是计费侧策略，需要去 jifei 确认实际值。**
风险：如果用户 Pass 长期停在 `isolated`，制品 zip 会长期占 TCB 存储（每站最多 50MB）。

### 2.6 幂等键语义错误（P1，会导致重复扣席位）

**问题**：DAO 的 `GetByIdempotencyKey` 拿参数去和 **`name` 字段**比对。
Agent 按常规传 UUID → 永不命中 → 网络超时重试会重复建站并重复占席位。

**改法**：迁移 000043 新增 `website_sites.idempotency_key` 列 + `uk_user_idempotency (user_id, idempotency_key)`
唯一索引，DAO 改为真正按该列查询。SKILL.md 补充了"同一次建站任务的重试必须复用同一个 key"的说明。

### 2.7 换套餐后删站配额不返还（P1）

**问题**：`CompleteOperation` 用 `resource_key = site.BundleID` 匹配配额行，
但配额行的 `resource_key` 在换套餐时会被改写成新 bundleID →匹配 0 行 → 静默失败
（原代码只检查 `result.Error`，不看 `RowsAffected`）→ 席位被永久吃掉。

**改法**：抽出 `releaseSiteQuotaTx()`，按 `(user_id, resource_name)` 定位，不再依赖 bundleID。

### 2.8 配额行重复导致超卖（**端到端实测才暴露的深层缺陷**）

**问题**：`ensureQuotaInitialized` 调用 `SelectQuota(userID, resourceName, bundleID)`
——查询带了 bundleID，用户换套餐后必然查不到既有行，于是走"首次初始化"分支**再插一行**。
**用户每换一次套餐就多一行配额**。而 2.7 改成按 `(user_id, resource_name)` 归还后，
多行会被一次性全部更新 → **一次删站归还多个席位 → 超卖**。
（原代码里那个"检测套餐变更改写 resource_key"的分支是**永远进不去的死代码**。）

**改法**：
- 新增 `findSiteQuotaRow(userID)` 按 `(user_id, resource_name)` 查既有行，命中则改写
  resource_key + 重算额度，不再新建
- `releaseSiteQuotaTx` 改为"先定位唯一一行 ID，再按ID 更新"，严格只影响一行
- 迁移 000046 清理历史重复行（每用户保留 id 最小的一行，额度按实际占用站点数重算）

### 2.9 多个 release 同时 active（P1）

**问题**：部署成功只把新版本置 active，没让旧版本退位→ 同一站点堆积多条 active
→ "当前版本"失去唯一性，续费恢复靠 `Order("version DESC")` 兜底才拿对版本。

**改法**：新增 `ReleaseStatusSuperseded` 常量；`CompleteOperation` 的 deploy 分支先让
旧 active 退位再置新版本 active。迁移 000045 回填历史数据 + 更新状态域注释。

### 2.10 worker 失败上报的语义修正

**问题**：`failOperation` 成功上报失败后返回 `nil`，主循环把它当成"操作成功"打日志，
误导排查。

**改法**：新增哨兵错误 `ErrOperationFailedAndReported`。主循环区分三种结果：
成功 / 失败但已登记 / **连失败都没上报**（后者会留在 running 直到租约过期被重新领取）。

### 2.11 其他健壮性修复

- `error_message` 入库前截断（列宽 2048，worker 的错误串可能超长→ MySQL 1406 →
  `/fail` 回调本身失败 → 租约过期 → 活锁）
- delete 操作的重试次数上限 + 死信状态 `dead`（原来无限重试、无告警）
- `WEBSITE_REQUIRE_REDIS_LIMITER` 语义与 fail-closed 行为
- `pass_hook.go` 的过时注释更新（说明席位归还时机、制品清理归属、配额行为何故意保留）

### 2.12 Skill 准备（`.agents/skills/website-builder/SKILL.md`）

- `VELA_API_BASE` 默认值从测试域名 `lightclaw.tech` 改为按站点归属取生产地址
  （国内 `https://api.lightvela.com`，国际 `https://api.lightvela.ai`），测试靠环境变量覆盖
- 补充幂等键用法说明
- 明确"站点地址固定不变，重新部署不需要换链接"
- 到期行为改为准确描述（真下线 + 内容保留 + 续费自动恢复 + 销毁时清除）
- 补充错误码：`WEBSITE_FILE_COUNT_EXCEEDED` / `WEBSITE_NOT_ACTIVE` / `WEBSITE_NOT_FOUND` / `WEBSITE_NO_AVAILABLE_ENV`
- 强调"制品大小/文件数以能力查询接口返回值为准，不要写死"
- 强调"首页必须是**根目录下**的 index.html"
- 提示"创建发布后要尽快上传"（部署任务等待制品约 60 秒）
- 已登记到 `.agents/skills/README.md`

### 2.13 新增迁移清单

| 迁移 | 作用 | 北京环境是否已执行 |
|---|---|---|
| 000039 | `website_operations.next_retry_at` + `idx_status_next_retry_at` | ✅ 已补执行|
| 000040 | DROP `website_usage_daily`（代码已不用） | ❌ 未执行 |
| 000041 | 清理无用的 id_gen seeds | ❌ 未执行 |
| 000042 | ai 档配额对齐巡游 | ✅ |
| 000043 | `idempotency_key` 列 + 唯一索引 | ✅ |
| 000044 | 扩展 status / operation_type 注释域 | ✅ |
| 000045 | release active 去重 + `superseded` 状态域 | ✅ |
| 000046 | 建站配额重复行清理 | ✅ 已执行（2026-08-05 下午，修掉 collation 缺陷后） |

### 2.14 新增单测

`ctl/pkg/logic/website/`：`pass_lifecycle_test.go`（4 个）、`quota_release_test.go`（4 个）、
`delete_retry_test.go`、`tcb_env_test.go`；`ctl/main/api/website_internal_auth_test.go`；
`workers/internal/website/tcb_env_test.go` 及 `deployer_test.go` 扩充。

---

## 3. 已完成的实测验证（北京 sandbox，真实链路）

环境：`lightclaw.tech`，TCB 测试环境 `xiamitcb-db-lab-d5fofz8t62c5140d`（UIN 815836472）
当前部署镜像：`ctl:cloudbase-v3-20260805` / `workers:cloudbase-v3-20260805`

| # | 验证项| 结果 |
|---|---|---|
| 1 | 能力查询返回正确套餐额度 | ✅ 启航 1 站 / 20MB 制品 / 500 文件 |
| 2 | 建站成功 | ✅ `ws-c748f23122d61f9e` |
| 3 | **幂等键生效** | ✅ 同 key 第二次返回同一 site_id、无新operation（修复前会重复建站） |
| 4 | 首次发布 | ✅ operation success |
| 5 | **Content-Type 正确** | ✅ html→`text/html`、css→`text/css`、js→`application/javascript`、空文件→`text/plain` 且 content-length=0 |
| 6 | 页面真实渲染（非下载） | ✅ |
| 7 | 二次发布 | ✅ |
| 8 | **URL 完全不变** | ✅ 两次发布后 public_url 完全一致 |
| 9 | **旧版残留清理** | ✅ 上一版的 `app.js`/`empty.txt` 变404，新增 `meta.json` 正常 |
| 10 | **到期真下线** | ✅ suspend 后所有文件 404（修复前仍可访问） |
| 11 | **续费恢复** | ✅从保留制品恢复，全部 200、Content-Type 正确、恢复的是最新 v2、URL 不变 |
| 12 | **换套餐后删站返还配额** | ✅ 构造 `site.bundle_id ≠ quota.resource_key` 场景，删站后 available 0→1（修复前为 0） |
| 13 | 删除后文件清理 | ✅404 |
| 14 | 席位释放后可重新建站 | ✅ capability used_sites 归0 |

### 实测中发现并已修复的两个额外缺陷

1. **`website_releases` 遗留唯一索引 `idx_website_releases_site_gen`**
   北京环境有一个 `(site_id, generation)` 唯一索引，而代码从不写 `generation` 列（恒为 0）
   → **同一站点第二次发布必然报Duplicate entry，用户无法更新网站**。
   已确认这个索引**不在仓库任何迁移文件里**，是北京环境的历史手工 DDL 遗留，**生产不受影响**。
   已在北京环境DROP 掉。
2. **配额重复行**（见 2.8），这是实测还原数据时才暴露的。

---

## 4. 待办事项（按优先级）

### P0 — 必须完成才能上线

- [x] **执行迁移 000046 并回归验证配额路径**（2026-08-05 下午完成，详见 §7）

- [ ] **等TCB 企业版采购完成**（外部依赖，卡住生产接线）
      需要拿到：env_id 列表、每环境站点容量上限、region。
      这三项是 `TCB_ENV_ALLOWLIST` / `TCB_ENV_CAPACITY_MAP` 的必需输入。
      联系人：虾米老师（TAPD 单里的采购负责人）。

- [ ] **生产 GitOps 接线（完全未做）**
      当前 `shprod` 建站链路一项都没接，即使发了 ctl 镜像也调不通：
      - `argocd/services/service-gateway/shprod/config.yaml` 加 `/v1/websites` authenticated 路由
      - ctl 注入 `TCB_ENV_ALLOWLIST`（非密）+ `TENCENT_SECRET_ID/KEY` + `WEBSITE_INTERNAL_API_TOKEN`（SOPS）
      - 新建 `website-deployer-secrets` SOPS，跑 `python3 scripts/scan_secrets.py` 校验
      - 新建 `workers/k8s/overlays/<prod>/website-deployer/`（source-facing）
        + `argocd/services/workers-website-deployer/<env>/`（deploy-facing）
        + `argocd/apps/<env>/workers-website-deployer.yaml`
      - ⚠️ **架构决策点**：worker 必须能访问 `ctl-api.ctl.svc.cluster.local`。
        `shanghai-workers` 是**独立集群**，跨集群访问不通。
        建议把 website-deployer 部署在 **shprod 集群的 ctl namespace**。
        这一点上线前必须跟运维确认。

- [x] **生产 DB 迁移的执行方案** —— 已产出 `docs/runbooks/ctl-website-migration-shprod.md`
      ⚠️ **原结论需修正**：不是"人工逐条执行 SQL"。仓库已有受控入口
      `python3 .ci/runtime/commands/run_gitops_db_job.py --service ctl --env shprod
      --operation migration --revision <sha> --apply --wait`，
      它把 `ctl/migrations/` 渲染成一次性 ConfigMap 交给 `migrate/migrate:v4.18.3` 执行。
      `delete-migration-job.yaml` 删掉的是**稳态** Job（迁移不随 Argo 自动发生），
      与这条一次性入口是两回事。
      另：区间是 000029–000046 共 **18** 条，原文写的 15 条有误。

- [x] **生产 schema 漂移校验** —— 已完成量化，结论见 runbook §5.2
      北京比迁移文件多出 3 个孤儿列 + 1 个多余索引（全部是历史手工 DDL，生产不会有），
      外加 `lease_token` 可空性差异一处（已核查代码，对现有路径无害）。
      **漂移不影响生产**，但生产执行迁移后仍需重跑一次比对。

### P1 — 建议上线前完成

- [ ] 提交代码 + 创建 MR（**用户要求：commit/MR 描述只写一句变更内容，不写验证过程，贴 TAPD 链接**）
- [x] 剥离与本需求无关的改动：`frontend/pnpm-lock.yaml`（3370 行）、
      `frontend/public/fonts/HYRuiYiSong-45J.subset.woff2`（二进制）—— 已 `git checkout` 还原。
      确认过 `frontend/package.json` 无改动，所以 lockfile 那 3370 行纯属噪声
- [x] `agent-website-panel.tsx` 的 Tab 缩进已改回空格；`pnpm check` 通过
- [x] **补齐 i18n**：本分支建站页面新增了 29 条中文文案但从未 extract，
      `pnpm i18n:check` 一直红灯（**国内站构建门禁也过不了**，与是否上国际站无关）。
      已补齐 `en-US.json` 全部 29 条英文，check 通过
- [ ] `docs/superpowers/plans/2026-08-05-cloudbase-production-readiness.md` 的 checkbox
      全是未勾选状态，与实际进度不符，需同步或删除
- [ ] TAPD 单子回写（用户说他会改，改完需重新核对）。已知 7 处实现与文档不一致：
      1. TAPD 设计里的 `POST /v1/websites/{siteId}/releases/{releaseId}/deploy` **未实现**
         （创建 release 时直接建 deploy 任务，worker 等待制品约 60 秒）
      2. 环境选择：TAPD 写 least-loaded，实现是 `rand.Intn()` 随机
      3. TAPD 写 `TCB_ENV_POOL` JSON Secret，实现改成 COS Service API 动态发现 + allowlist
      4. PRD 主路径写 CloudApp，实现走共享 COS 目录（已决策不回退，需正式回写理由）
      5. PRD 验收要求"删除全部成功后才MoveToHistory"，实现是先归档再 best-effort 删站
         （有 delete 操作持久重试兜底，一期可接受）
      6. TAPD 写"换套餐降级超额站点为suspended"，**未实现**（只把 available 夹到 0）
      7. `website_usage_daily` 在 TAPD 里说保留给二期，实际已被 000040 DROP

- [ ] **建站入口没有做国内站门控**（2026-08-05 新发现）
      发布范围已拍板"只上国内 shprod"，但前端入口是无条件挂载的：
      `agent-settings-page.tsx` 的 `settingsSections` 里 `{ id: "website", label: t("我的网站") }`
      既没引用 `isCN` 也没引用 `isGlobal`，`AgentWebsitePanel` 本身同样没有。
      `frontend` 是国内 + 国际合一构建、靠编译期常量区分，所以**国际站也会显示这个入口**，
      点进去会调 `api.lightvela.ai/v1/websites`，而国际站后端不接这条链路。
      虾米老师 2026-08-05 决定：**先不改**，等国内站流程和生产前准备完成、与产品确认后再定。
      改动本身很轻（给这一项加 `isCN` 门控即可），以后要上国际站去掉门控就行。

### P2 — 已知风险，需产品或运维确认

- [ ] **`TCB_ENV_ALLOWLIST` 收缩会导致站点永久删不掉**
      worker 拿不到 env 就 fail，delete 无限重试，站点卡在 `deleting`、配额锁死。
      虽然已加重试上限 + 死信状态，但**运维铁律必须文档化：下线某TCB 环境时，
      必须保留它在 allowlist 中直到该环境下所有站点清理完毕**。
- [ ] 制品 zip 长期占存储（Pass 停在 isolated 期间）。需要 jifei 确认宽限期实际天数。
- [ ] `ensureQuotaInitialized` 用 `resource.GormDB` 而非事务，并发首次建站可能撞唯一键
      （已Warn 不阻断，实际无害，但值得记录）
- [ ] **用户侧接口直接返回 GORM 实体**（2026-08-05 新发现，未修）
      `GET /v1/websites/{siteId}/operations/{opId}` 和 `GET /v1/websites/{siteId}`
      都是 `writeSuccess(w, r, op)` 把实体原样吐出，字段是 Go 命名（`Status`、`Id`），
      还带出 `LeaseToken` / `LeaseExpiresAt` / `NextRetryAt` 等内部字段。
      **可利用性**：低。`/complete`、`/fail` 虽然从 body 收 `lease_token`，但受
      `WEBSITE_INTERNAL_API_TOKEN` 保护，光有 lease token 用不了。
      **为何没顺手修**：前端已经依赖这套大写字段
      （`agent-website-panel.tsx` 用的是 `deleteTarget.SiteID`、`site.Status`），
      换成 snake_case DTO 是跨端契约改动，需要前后端一起改。
      Skill 那边不受影响（只依赖 created/running/success/failed 语义，没写死字段名）。

---

## 5. 环境与操作速查

### 凭据

**全部在 `~/.lightclaw/credentials.env`**（本机，不入库）。
部署 SOP 在 `.agents/skills/deploy-beijing-sandbox/SKILL.md`
（⚠️ **该 skill 含内网机器和集群拓扑，用户明确要求不入git，已在 `.gitignore` 排除，不要提交它**）。

⚠️ 排查时 `kubectl get deploy -o jsonpath='{...env...}'` 会打印出明文的 COS SecretKey、
Redis 密码、Internal API Token。**不要把这些值写进任何文档、commit、MR 或日志。**

### 构建与部署（北京 sandbox）

本机 **没有 docker**，必须在 DevCloud 上构建：

```bash
# 1. 同步工作区改动到 DevCloud（本机执行）
source ~/.lightclaw/credentials.env; export SSHPASS="${DEVCLOUD_PASS}"
tar czf - --exclude='.git' ctl workers \
  | sshpass -e ssh -p "$DEVCLOUD_PORT" "$DEVCLOUD_USER@$DEVCLOUD_HOST" \
    "cd /root/mono2 && tar xzf -"

# 2. 在 DevCloud 构建+推送
#TAG 约定 cloudbase-v<N>-<yyyymmdd>
docker build -t lightclaw-bj8.tencentcloudcr.com/lightclaw/ctl:$TAG -f ctl/Dockerfile ctl/
docker build -t lightclaw-bj8.tencentcloudcr.com/lightclaw/workers:$TAG -f workers/Dockerfile workers/
docker push ...   # DevCloud 已有 TCR 凭据缓存

# 3. 滚动更新（北京 ctl/worker 不受ArgoCD 管理，纯手工 kubectl）
K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox
kubectl --kubeconfig $K -n ctl set image deployment/ctl-api-cloudbase api=<image>
kubectl --kubeconfig $K -n temporal-workers set image deployment/website-deployer website-deployer=<image>
```

**重要**：北京环境的 `ctl-api-cloudbase` 和 `website-deployer` **没有 ArgoCD Application**
（我查过，`kubectl -n argocd get application | grep -E 'ctl|worker'` 为空），
所以不需要暂停 Argo 同步，手工 `set image` 不会被覆盖。

### DB 操作

```bash
kubectl --kubeconfig $K -n ctl run mysql-schema-patch --image=mysql:8.0 --restart=Never \
  --command -- sleep 1800
kubectl --kubeconfig $K -n ctl exec mysql-schema-patch -- \
  mysql -h $DB_HOST -P $DB_PORT -u $DB_USER -p"$DB_PASS" $DB_NAME_CTL -e "<SQL>"
```
用完记得 `kubectl delete pod mysql-schema-patch`。

### 端到端测试脚本要点

```bash
B=https://lightclaw.tech; H="Authorization: Bearer ${TOKEN_USER1}"
curl -s -H "$H" "$B/v1/websites/capability"                    # 1. 查额度
curl -s -H "$H" "$B/v1/passes"                                 # 2. 拿 bundle_id
curl -X POST ... -d '{"bundle_id":..,"name":..,"idempotency_key":..}' "$B/v1/websites"
curl -X POST ... -d '{"artifact_hash":..,"artifact_size":..,"file_count":..}' \
  "$B/v1/websites/$SID/releases"                               # 拿 upload_url
curl -X PUT -H 'Content-Type: application/zip' --data-binary @x.zip "$UPLOAD_URL"
curl -s -H "$H" "$B/v1/websites/$SID/operations/$OPID"         # 轮询
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "$PUBLIC_URL"  # 验 Content-Type
```

测试用户：`usr_dc1f8403915ba56433e50184`（启航档，token 在 credentials.env 的 `TOKEN_USER1`）

**验证 suspend/resume 的方法**：ctl 没有手动触发 Pass 隔离的接口，
用 DB 直接模拟 `OnPassIsolated` 的产物：
```sql
UPDATE website_sites SET status='suspended', operation_generation=operation_generation+1
  WHERE site_id='<sid>' AND status='active';
INSERT INTO website_operations (operation_id,site_id,release_id,user_id,operation_type,
  status,site_generation,created_time,updated_time)
  VALUES ('<opid>','<sid>','','<uid>','suspend','created',<新generation>,NOW(),NOW());
-- resume 同理，但 release_id 要填status='active' 的那条
```

### 北京环境残留数据

- 测试站点 `ws-c748f23122d61f9e` 已删除干净（DB 软删 + COS 清空）
- ~~测试用户的配额行有 2 行~~ → 已被 000046 合并为 1 行（id 775），见 §7
- 我手工插入的 `wo-e2e-susp-1` / `wo-e2e-resume-1` 两条 operation 已删除
- 临时 mysql pod 已清理（§7 又建了一次，已再次删除）
- §7 的回归测试站点 `ws-44e23428202a3a49` 已删除，配额已归还

---

## 6. 给接手者的几条提醒

1. **用户明确要求：不要再问他需求问题**。有疑问先查 codex 的「探索腾讯云 TCB」会话，
   那里有完整历史。
2. **不要提交 `.agents/skills/deploy-beijing-sandbox/`**，已在 `.gitignore` 排除。
3. **改完代码必须实测才算完成**，不接受"单测通过 + 提交"。
   本次两个最严重的缺陷（release唯一索引、配额重复行）都是端到端实测才暴露的，
   单测和代码审查都没抓到。
4. **commit/MR 描述只写一句变更内容**，详细背景放 TAPD，commit 里贴链接。
5. 前端页面上写的存储/流量限制是文案，后端一期不实现，**不要"顺手补上"**。
6. 生产接线时注意 `master` 只管源码和镜像构建，`gitops` 才是 Argo 的 live 真源，
   需要 promote MR 且**人工合并**（shprod 不自动跟随 master）。

---

## 7. 2026-08-05 下午续做记录

镜像：`ctl:cloudbase-v4-20260805` / `workers:cloudbase-v4-20260805`（均已 1/1 Ready）。
workers 内容与 v3 完全一致（本轮无 worker 代码改动），仅重打 tag 对齐。

### 7.1 迁移 000046 有一个生产必炸的缺陷，已修

第一次执行直接报错：

```
ERROR 1267 (HY000) at line 14: Illegal mix of collations
(utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='
```

根因不在环境而在迁移文件：`000003` 建 `user_resource_quota` 时**显式** pin 了
`utf8mb4_unicode_ci`，`000029` 建 `website_sites` 时只写了 `DEFAULT CHARSET=utf8mb4`、
**没写 COLLATE**，于是跟随库默认。北京 `ctl` 库默认是 `utf8mb4_0900_ai_ci`
（而该实例 `collation_server` 是 `utf8mb4_general_ci`，两者本就不一致）。
两表 JOIN `user_id` 必然报 1267。

修法：在 000046 的关联条件上显式 `COLLATE utf8mb4_unicode_ci`。

⚠️ **这条如果带着缺陷上生产，后果不止"这条没生效"**：`ctl` 走 golang-migrate，
任一条失败会把 `schema_migrations` 标记为 dirty，**之后所有 ctl 迁移全部阻塞**。

### 7.2 配额回归实测（P0 第一项，通过）

用户 `usr_dc1f8403915ba56433e50184`（`TOKEN_USER1`，启航档）。
其配额行 `resource_key` 是 `bundle_changed_after_purchase`、当前 bundle 是
`bundle_free_trial_01`，天然就是"换过套餐"的场景。

| 阶段 | 配额行 | resource_key | available | 判定 |
|---|---|---|---|---|
| 迁移前 | **2 行**（775 / 793） | 各不相同 | 各为 1 → 实际持有 2 席 | 超卖，2.8 缺陷复现 |
| 000046 后 | 1 行（775） | `bundle_changed_after_purchase` | 1 | 重复行已合并 |
| 建站后 | 1 行（775） | 被改写为 `bundle_free_trial_01` | 0 | **没有新增第 2 行**（修复前会插） |
| 删站后 | 1 行（775） | `bundle_free_trial_01` | 1 | **只返还 1 席** |

全表 `WEBSITE_STATIC_SITE` 配额行数 10 → 9，此后建站/删站均未再增长。

本轮只跑配额路径（fast）。建站/发布/Content-Type/suspend/resume 等在 v3 已验证，
且 worker 代码本轮未动，未重复跑。

### 7.3 全量迁移试跑 + schema 漂移量化

产物：**`docs/runbooks/ctl-website-migration-shprod.md`**（生产执行请以它为准）。

- 000001–000046 全 46 条在干净空库上跑通，`utf8mb4_0900_ai_ci` 与
  `utf8mb4_general_ci` 两种库默认各验一遍，都通过 → 000046 的修法与库 collation 无关
- 试跑还暴露：`mysql < file` 不带 `--default-character-set=utf8mb4` 会把中文 COMMENT
  存成乱码（`TCB环境ID` → `TCBçŽ¯å¢ƒID`）。已确认 000029–000046 无中文数据字面量，
  seed 全是数字 JSON，所以只影响注释、不损坏数据
- 漂移比对结论：北京多 3 个孤儿列 + 1 个多余索引（历史手工 DDL，生产不会有），
  外加 `lease_token` 可空性差异一处（已核查代码，对现有路径无害）
- 试跑库 `ctl_dryrun_0900` / `ctl_dryrun_gen` 已删除

### 7.4 本轮改动的文件

| 文件 | 改动 |
|---|---|
| `ctl/migrations/000046_*.up.sql` | 关联条件加显式 COLLATE + 说明注释 |
| `frontend/src/pages/marketing/agent-website-panel.tsx` | Tab 缩进改回空格（无逻辑变化） |
| `frontend/src/i18n/generated/{en-US,zh-CN,zh-to-key}.json` | 补齐 29 条建站文案的英文 |
| `frontend/src/i18n/generated/zh-Hant.json` | `pnpm i18n:zh-hant` 重新生成（zh-CN 加 key 后必须跟着跑，否则 `pnpm check` 红灯） |
| `frontend/pnpm-lock.yaml`、`HYRuiYiSong-45J.subset.woff2` | **已还原**，不进本次提交 |
| `docs/runbooks/ctl-website-migration-shprod.md` | 新增 |

门禁：`ctl` 的 `go build` + `go test ./pkg/logic/website/... ./main/api/...` 通过；
前端 `pnpm check`、`pnpm i18n:check` 通过。
