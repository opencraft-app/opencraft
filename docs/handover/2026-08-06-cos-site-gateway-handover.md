# 静态建站二期交接文档（COS + 自建反代）

- 日期：2026-08-06
- 分支：`codex/site-cos-gateway`（已推远端，**不要合 master**）
- 设计方案：`docs/proposals/2026-08-06-cos-site-gateway.md`
- 产品试用说明：`docs/handover/2026-08-06-cos-site-gateway-test-guide.md`
- 一期存档分支：`codex/tcb-cloudbase-site-legacy`（已推远端）

## 一、这是什么

把用户静态站点从 CloudBase（TCB）托管迁到**自建 COS 桶 + 自研反代**，每个站点一个子域名。

换栈的原始动因是「TCB 做不了用户级别的数据隔离，所以自己做文件存储模拟 db」，但**产品后来决定不做数据面**（见第四节），所以最终形态是纯静态托管。换栈的收益变成：流量可控、子域名归我们、去掉 TCB 环境容量管理（删了 577 行）、到期下线和违规封禁都在自己手里。

## 二、当前状态

**已提交并推送**（4 个提交，HEAD `c4a650cac`）

```
c4a650cac  建站 Skill 与方案文档同步纯静态形态
31154e2f1  建站功能改名为「我的作品」
4c3d7a36c  站点网关收敛为纯静态托管
d3ee23a09  站点生命周期改为保留文件，新增死信操作恢复
```

**北京测试环境线上镜像**

| 服务 | namespace | tag | 说明 |
|---|---|---|---|
| `site-gateway` | `ctl` | `cos-site-usage-20260806-2110` | 含计量与超额拦截，**功能未端到端验证** |
| `ctl-api-cloudbase` | `ctl` | `cos-site-usage-20260806-2110` | 同上 |
| `website-deployer` | `temporal-workers` | `cos-site-usage-20260806-2110` | 同上 |
| `ctl-service` | `ctl` | **master 镜像，未更新** | 由 ArgoCD 自愈托管；`creating` 隔离修复未上线 |
| 前端 | Cloudflare Pages | 含「我的作品」改名 | 用量展示未做 |

回滚 tag：`site-gateway` / `ctl` / `workers` 各自的 `cos-site-lifecycle-20260806-2012`（`site-gateway` 是 `cos-gateway-20260806-static-only`）。

**北京测试库已手工改过两处**（上海生产未碰）：`website_sites.storage_bytes` 列已加、7 个 bundle 的 `monthly_traffic_bytes` 已抬到 1 TiB。这两项都是期望的最终状态，不需要回滚；`schema_migrations` 未动，仍是 27。

**云资源**

- COS 桶 `test-vela-user-sites-1388575217`（ap-beijing，私有读，匿名访问 403）
- 泛域名 `*.sites.lightclaw.tech` → CLB `lb-kbl26vb5`，Ingress `lightclaw-sites-public`（`ctl` ns，class `qcloud`）
- CAM 子账号（密钥 ID 前 8 位 `AKIDBF7l`），策略 `vela-site-cos-bucket-scoped` 限定到本桶 `sites/*` 与 `_artifacts/*`

## 三、架构

```
浏览器 → http://{siteID}.sites.lightclaw.tech/
       → CLB（泛域名，direct-access 直连 Pod）
       → site-gateway（ctl ns，2 副本，无状态）
            ├─ Host 推出 siteID（隔离基石，前端无法伪造）
            ├─ 查站点状态（ctl 内部接口 + 30s TTL 缓存）
            └─ COS 回源 sites/{siteID}/current/**

管控面：ctl（配额/生命周期）──Redis 队列──> website-deployer（COS 操作）
```

COS 目录布局：

```
sites/{siteID}/current/**                对外服务的稳定目录
sites/{siteID}/releases/{releaseID}/**   发布暂存，成功后同步到 current/ 并被清理（已实测）
_artifacts/{siteID}/{releaseID}.zip      上传的制品
```

## 四、关键决策与理由（改动前请先读这一节）

**数据面已移除。** 曾完整实现 `/__vela/data/*` 五个接口并通过 62 项真实 COS 验证，因产品决定「只做静态托管、不要 db」而移除。备份在 `~/vela-dataplane-snapshot-20260806/`（仓库外，带 README）。恢复前必须先解决**无鉴权的公开读写**——那是它被移除的核心技术遗留。

**到期与销毁都不删文件。** 产品决定不真实删除用户数据。到期→`suspended`、销毁→也是 `suspended`，反代按状态返 403 且不回源，COS 一个字节不动；续费→`active`，立刻恢复且无延迟。一期在 TCB 上必须删 `current/` 才能下线，是因为托管层不是我们的；现在反代自研，下线只是一次状态变更。

**唯一真删入口是用户主动删除**，清 `sites/{siteID}/` + `_artifacts/{siteID}/`。站点行**软删不硬删**——文件永久保留之后，`website_sites` 表是唯一能把桶里对象对应回归属的依据。

**阻塞语义是分裂的，这是刻意的。** 隔离侧站点钩子是 pass 隔离任务的**阻塞步骤**（失败重试，永不放弃）；销毁侧仍是 **best-effort**（产品决定，避免阻塞计费状态收敛）。销毁侧失败的后果已从「漏删 COS 持续产生成本」降级为「站点状态没跟上、可能仍对外服务」。

**站点地址是过渡形态。** `*.sites.lightclaw.tech` 只是 PoC，正式根域待申请，代码里根域全部走配置不硬编码。

## 五、待办

**需要产品/业务确认**

1. 发布日的放量节奏——迁移会给全部 7 个套餐写入建站配额，等于同时对这些套餐用户开放。
2. 销毁后的站点若用户重新买套餐，续费联动会把它转回 `active` 并恢复对外服务（因为销毁和到期共用 `suspended`）。在「文件永久保留」模型下这应是期望行为，但属默认行为需明示。
3. 建站入口：界面上没有「新建作品」按钮，只能在对话里说「帮我建个网站」。是设计还是缺口？
4. 发布后首次访问有 6–10 秒延迟（发布任务在产物上传完成前被唤醒，靠重试兜住）。可接受则维持，否则改成上传完成后显式触发（API 多一个端点、Skill 流程多一步）。
5. 站点地址是随机 hex，要不要支持用户自定义子域名（涉及命名冲突、敏感词、抢注）。
6. 新根域申请进度与泛域名证书方案。

**工程待办**

1. **HTTPS 未收口。** Let's Encrypt 通配符证书已签发（`*.sites.lightclaw.tech`，**90 天，2026-11-04 到期**），文件在 `/tmp/sites-wildcard-cert/`（`/tmp` 会被清理，需尽快转移）。腾讯云 CLB **只认带 `qcloud_cert_id` 的 Opaque secret**，`kubernetes.io/tls` 会报 `E4011`——正确做法是 `tccli ssl UploadCertificate` 导入拿 certId、secret 里只放 certId。参照 `frontend-preview` ns 里已工作 94 天的 `preview-lightclaw-tech-wildcard-tls` 照抄形式。目前 Ingress 无 TLS 段、`WEBSITE_SITE_URL_SCHEME=http`。
2. **证书续期无自动化。** 90 天到期，需要集群内 CronJob 跑 acme.sh + DNSPod API 自动更新 secret。
3. **销毁侧可观测性未做**：`dead` operation 数、`deleting` 超期站点数的指标告警。这是销毁侧 best-effort 的唯一兜底。
4. **北京测试库 schema 记账损坏**，`schema_migrations` 停在 27 但 000029+ 的表列基本都在（历史上手工跑过 SQL，还有一张 `schema_migrations_backup_20260805_ci_fix` 作证）。现在 `migrate up` 会在 000028 撞重复列失败。**上海生产是干净的**（单行 `version=27, dirty=0`，无任何 website 表）。上生产前应在测试环境完整演练一遍这批迁移，否则演练结果不可信。另有孤儿列 `attempt_count` 等漂移，建议一并清理，且**要在演练之前做**。
5. **`ctl-service` 由 ArgoCD 自愈托管**，`set image` 一分钟内被拉回 master 镜像。所以 pass 隔离/销毁钩子的改动**在测试环境要等分支通过 GitOps 才生效**，目前生效的只有 `ctl-api-cloudbase` 和 `website-deployer`。验证时需临时起不受管的 sibling worker。
6. **平台缺口：Vela token 从未注入过实例。** 全库 `VELA_AUTH_TOKEN` / `VELA_API_BASE` / `~/.vela/auth-token` 只出现在 SKILL.md 自己里，没有任何代码注入。前端拿到的 `GatewayToken` 是入站凭据，不是实例反向调 Vela API 的出站凭据。**生产用户机器同样没有**，意味着真实用户在对话里建站按现状走不通。6 台测试机器已手工补齐各自账号的 `~/.vela/auth-token` + `~/.vela/api-base`（600 权限、ext4 跨重启）。正确修法：在 `configureOnboard` 旁按实例所属环境注入 API base，并签发**实例作用域凭据**而不是复用浏览器 session。
7. **LLM key 后端缺陷**：平台注入的 `custom` provider（`http://10.15.226.135/v1`）在 test1/test2/test3 全部 401，走控制台「重置配置」重铸新 key 依然 401。判断是 ctl 铸的 key 不被那个数据面认，属网关/计费侧。**test1、test2 无法对话**，试用请用 test3~test6。
8. **腾讯云账号欠费 73.5 万**（可用余额 -73.7 万，`IsAllowArrears=false`），所有新购操作被拒。付费证书就是因此下不了单（API 报的是笼统的 `InvalidParam`）。
9. **`pnpm check` 是空转门禁**：根 `tsconfig.json` 是 `files: []` + project references，`tsc --noEmit` 不带 `--build` 什么都不检。手动 `tsc -p tsconfig.app.json` 有约 324 条既存报错。不要把它通过当成类型没问题。
10. 前端两个小问题待修：面板副标题从未渲染（prop 名 `subtitle` vs 组件的 `description`，就是上面那 324 条之一）；英文作品列表右上角显示 `Total 1 agent(s)`（「共/个」key 与 Agent 列表共用，译文写死 agent）。
11. `frontend/src/pages/app/website-page.tsx` 是死代码（`/websites` 重定向到 `/agents/websites`），要么删要么明确定位。
12. Skill 目录名 `cloudbase-site-builder` 已不准确，但**机器侧改名有风险**（要在 6 台上各建新目录再删旧目录，任一台删除失败就会两份 SKILL.md 并存、给 agent 灌矛盾指令）。免费的改名时机是接入正式分发通道那一刻，清单见方案第 13.1 节。

## 六、第三轮：已提交但未验证（接手第一优先级）

提交 `2c8206c94`「站点流量与存储计量、超额拦截、制品只留最新」。门禁全绿（三模块 gofmt / vet / test，site-gateway 含 `-race`），镜像已推并滚到测试环境，**但功能正确性完全没有线上证据，只有单测**。

### 设计要点

**流量**：反代在**站点解析成功之后**才计量（内存有界的关键——随机子域名扫描解析不出站点，不会创建条目），用 `countingWriter` 累计实际写出字节，所以 HEAD 与 304 自然计 0 字节 1 次请求，不依赖 `Content-Length`。每 1 分钟 `POST /internal/ctl/websites/usage`，一个请求带该窗口全部有流量的站点；上报确定失败时整批并回内存，下窗口重试。ctl 按 `(site_id, usage_date)` upsert 累加。**已软删站点仍然入账**，否则可以靠反复建删把当月用量清零。时区 UTC+8，与 bundle 每日配额刷新口径一致。

**刻意不做幂等**：累加语义下重放会多算，没做窗口去重——多副本各自上报，服务端要去重就得再建一张「哪个副本哪个窗口已入账」的表，给一个近似值配一套精确记账不值得。`window_id` 只进日志。

**存储**：deployer 在发布成功和删除后重列 `sites/{siteID}/` 与 `_artifacts/{siteID}/` 求和，上报**绝对值**，覆盖写天然幂等。`used_storage_bytes` 只算未软删站点（与流量相反——存储是「当前占用」）。

**拦截**：在反代 `resolveSite`，与 `suspended`/`blocked` 同一处，403 且**不进 origin fetch**，超额后不再产生 COS 回源成本。生效延迟约 90 秒（上报 1 分钟 + 缓存 30 秒）。一期额度 1 TiB。

**制品只留最新一份**：本次发布的制品无条件排除在删除候选外（`LastModified` 在时钟回拨下不可靠），其余按 `LastModified` 倒序保留 `keep-1` 个。`WEBSITE_ARTIFACT_KEEP_VERSIONS` 默认 1。存量历史制品在该站点**下一次发布时一并收敛**（函数每次对整个前缀重判、不区分新旧），所以不需要一次性清理脚本；代价是从未再发布的老站点会一直留着旧 zip。**已确认无任何代码依赖历史制品回滚**：`ReleaseStatusRolledBack` 只被定义、全仓库无赋值，制品唯一被读取处是下载「当前正在部署的那个 release」。

**`creating` 缺口**：新增 `SiteDao.ListServingByUserID`（= `creating` + `active`），`OnPassIsolated` / `OnPassDestroyed` 改用它；在途 create 靠 generation 围栏变 superseded。**这段逻辑跑在 `ctl-service` 里，而它由 ArgoCD 自愈托管、未更新，所以修复尚未上线。**

### 新字段

`used_traffic_bytes`、`used_storage_bytes`，snake_case，出现在 `GET /v1/websites/capability`，与已有的额度字段 `monthly_traffic_bytes` / `storage_bytes` 并列。前者也出现在内部接口 `GET /internal/ctl/websites/sites/{siteId}`，供反代做超额判定。

### 三个迁移

`000040` 从 `DROP TABLE website_usage_daily` 改为 `SELECT 1;`（up/down 都是）。**保留文件不删**——版本号出现 39→41 空档会让 golang-migrate 在未执行过这批迁移的库上直接 `file does not exist` 整串中断。`000048` 给 `website_sites` 加 `storage_bytes`。`000049` 用 `JSON_SET` 只改 `static_site_quota.monthly_traffic_bytes` 这一个键抬到 1 TiB（不整体重写 JSON，因为 000036/000042 已按 bundle_type 定过站点数与存储额度）。

上海生产可从 27 一路前滚无冲突。**北京测试库不能用 migrate 前滚**：bookkeeping 也停在 27，但 `website_usage_daily` 已因历史手工 DDL 存在（8 行数据），032 的 `CREATE TABLE` 会撞已存在的表。实测该表结构与 032 完全一致、含新 DAO 依赖的唯一键 `uk_site_date`。

### 接手第一件事：把这些验掉

以下**全部未验证**：

1. 真实访问后 `used_traffic_bytes` 与实际传输字节是否吻合、误差多大
2. `used_storage_bytes` 与 COS 实际对象大小之和是否吻合
3. 把某套餐额度临时调小后 403 是否真生效、是否真的不回源
4. 连发多次后 `_artifacts/` 是否真的只剩 1 份
5. deployer → ctl 的 storage 上报在真实环境是否走通（token/URL 复用现有 `newInternalRequest`，未新增配置，但没实跑）

验完再做前端：`used_traffic_bytes` / `used_storage_bytes` 两个数字的展示，连带第五节第 10 条那两个小修，一次性发版。

## 七、踩过的坑（省时间用）

**镜像推送不要用 DevCloud 的 `docker push`。** 上行只有 54 KB/s，ctl 镜像 126MB 要 40 分钟以上，今天为此浪费了一个多小时。正确做法是**本机交叉编译 + `crane append`**，实测 **5 秒级**：

```bash
cd ctl && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/l/usr/local/lightglobal/bin/api ./main/api
cd /tmp/l && tar cf /tmp/layer.tar usr/local/lightglobal/bin/api   # plain tar，不要 gzip
mkdir -p /tmp/crane-docker-config
AUTH=$(echo -n "100045199955:${TCR_TOKEN}" | base64)
printf '{"auths":{"lightclaw-bj8.tencentcloudcr.com":{"auth":"%s"}}}' "$AUTH" > /tmp/crane-docker-config/config.json
DOCKER_CONFIG=/tmp/crane-docker-config crane append --base <当前线上tag> --new_layer /tmp/layer.tar --new_tag <新tag>
```

本机有 `crane 0.21.7`，**没有 docker**。`crane auth login` 会去找 docker-credential-desktop 然后失败，必须手写 `DOCKER_CONFIG`。TCR 令牌从 K8s secret `tcr.ipsqcloudregistrykey` 取，用户名固定 `100045199955`。推完用 `crane manifest` 确认真的进了 TCR。

**腾讯云 CLB Ingress 不开 `direct-access` 就只接受 NodePort/LoadBalancer 后端**，而本集群节点端口转发不通，表现是稳定 504 且网关无任何请求日志。必须带 `direct-access: "true"` + `pass-to-target: "true"`，Service 保持 ClusterIP。改 Ingress 时**务必保留** `direct-access` / `pass-to-target` / `modification-protection` 三个注解。

**泛域名证书只覆盖一级标签。** `*.lightclaw.tech` 覆盖不了 `*.sites.lightclaw.tech`。腾讯云**免费 DV 证书不支持通配符**（官方文档明确，报错却是误导性的「当前CA机构访问繁忙」，别以为是排队）。

**`cos:prefix` 条件键的值必须 urlencode**，写 `sites/*` 会一直 403，要写 `sites%2F*`。

**内联 `env` 会覆盖 `envFrom`。** 往 secret 里加了键还不够，如果 deployment 上原本有同名内联明文，必须改成 `secretKeyRef` 才生效。今天有一对 `WEBSITE_COS_SECRET_ID/KEY` 就是挂着但代码不读、改成读之后才发现值是 CloudBase 时代抄来的、对新桶只有 `AccessDenied`。

**`wrangler pages deploy` 必须带 `--branch=main`**，不带会拿当前 git 分支名当 Pages branch，部署落到预览别名而 `lightclaw.pages.dev` 完全不变，且 wrangler 照样返回成功。部署后一定对比资产 hash。

**COS 的 PUT Object 不支持 `If-Match`**（官方文档只有 `x-cos-forbid-overwrite`；SDK 里的 `If-Match` 全是 `x-cos-copy-source-If-Match`，那是 Copy 的源条件）。网上说支持的是把 HEAD Object 的读侧条件请求张冠李戴了。

**测试账号：`~/.codex/skills/lightclaw-credentials/SKILL.md` 第九节里 User 5 的 token 是错的**（系统里查无此记录，当初抄错），正确的在 `docs/handover/2026-08-06-cos-site-gateway-test-guide.md`。test1/test2 因 LLM key 问题不能对话。

**几个只有踩过才知道的小陷阱**：`usage_date` 读写两侧都必须用日期字符串（`website.UsageDateLayout`），用 `time.Time` 会让 SQLite 存成带时分秒的值、同一天落到不同行、唯一键失效；`ctl/pkg/pass/worker/website_hook_test.go` 和 `pkg/logic/website/operation_lease_test.go` **各自维护一份 `website_sites` 建表 DDL**，改 entity 加列时两处都要改；`ctl/main/api` 下的测试文件是 `package main` 不是 `package api`；`kubectl set image deploy/ctl-api-cloudbase` 要用 `*=`，容器名和 deployment 名不一致；本机 crane 推 TCR 会踩 `credsStore: desktop`，需 `export DOCKER_CONFIG=/tmp/cranecfg` 用独立配置目录；DB 只在集群网络内可达，从 DevCloud 直连 `10.15.224.4:3306` 会超时，要在集群里起一次性 `mysql:8` pod（DevCloud 上留了 `/root/ctlsql.sh`，stdin 喂 SQL）。

**`ctl` 全量 `go test ./...` 在本机必然有失败**（缺 `server_conf.toml` 与 rootless Docker），与改动无关。判断是否引入回归要用 stash 在干净树上跑一遍对比，别凭直觉。

**编排教训**：不要把七件事塞进一个 subagent 任务——外部看不到中间进度，而且中途修正需要打断，打断会让当前回合作废。今天两次打断分别浪费了 40 分钟的镜像推送和一轮代码编写。非紧急修正应攒到回合自然结束时再给。
