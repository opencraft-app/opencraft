# 静态建站二期交接文档（COS + 自建反代）

> 历史实测快照：下文的可变 `current/` 发布和保留 zip 语义，已被
> `docs/superpowers/specs/2026-08-09-website-production-hardening-design.md`
> 的不可变 Release 方案取代；旧数据兼容读取仍保留。

- 日期：2026-08-06
- 分支：`codex/site-cos-gateway`（已推远端，**不要合 master**）
- 设计方案：`docs/proposals/2026-08-06-cos-site-gateway.md`
- 产品试用说明：`docs/handover/2026-08-06-cos-site-gateway-test-guide.md`
- 一期存档分支：`codex/tcb-cloudbase-site-legacy`（已推远端）

## 一、这是什么

把用户静态站点从 CloudBase（TCB）托管迁到**自建 COS 桶 + 自研反代**，每个站点一个子域名。

换栈的原始动因是「TCB 做不了用户级别的数据隔离，所以自己做文件存储模拟 db」，但**产品后来决定不做数据面**（见第四节），所以最终形态是纯静态托管。换栈的收益变成：流量可控、子域名归我们、去掉 TCB 环境容量管理（删了 577 行）、到期下线和违规封禁都在自己手里。

## 二、当前状态

**已提交并推送**（6 个提交，HEAD `8fc4f79fa`）

```
8fc4f79fa  新增静态建站二期交接文档
2c8206c94  站点流量与存储计量、超额拦截、制品只留最新
c4a650cac  建站 Skill 与方案文档同步纯静态形态
31154e2f1  建站功能改名为「我的作品」
4c3d7a36c  站点网关收敛为纯静态托管
d3ee23a09  站点生命周期改为保留文件，新增死信操作恢复
```

**北京测试环境线上镜像**

| 服务 | namespace | tag | 说明 |
|---|---|---|---|
| `site-gateway` | `ctl` | `cos-site-usage-20260806-2110` | 流量计量与超额拦截已线上验证，字节级吻合（第六节） |
| `ctl-api-cloudbase` | `ctl` | `cos-site-usage-20260806-2110` | 用量入账与 capability 读出已线上验证 |
| `website-deployer` | `temporal-workers` | `cos-site-usage-20260806-2110` | 存储上报、制品只留最新已线上验证 |
| `ctl-service` | `ctl` | **master 镜像，未更新** | 由 ArgoCD 自愈托管。master 镜像里**整个 website 生命周期钩子都不存在**，不只是 `creating` 漏隔离——套餐隔离后所有站点继续对外服务。修复逻辑本次已验证有效，但镜像已换回 master，要真生效需走 GitOps |
| 前端 | Cloudflare Pages | 含「我的作品」改名 | 用量展示未做 |

回滚 tag：`site-gateway` / `ctl` / `workers` 各自的 `cos-site-lifecycle-20260806-2012`（`site-gateway` 是 `cos-gateway-20260806-static-only`）。

**北京测试库已手工改过一处**（上海生产未碰）：`website_sites.storage_bytes` 列已加，这是期望的最终状态，不需要回滚；`schema_migrations` 未动，仍是 27。

验证期间曾把 7 个 bundle 的 `monthly_traffic_bytes` 抬到 1 TiB，该改动已撤回。
北京测试库恢复为当时既有的启航 10 GiB、巡游与 AI 25 GiB。它们不是生产方案；
生产套餐值仍待产品确认，确认后直接补进合并后的单个 000028，不执行测试阶段的多轮额度迁移。

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
4. 发布后首次访问有 6–10 秒延迟（发布任务在产物上传完成前被唤醒，靠重试兜住）。可接受则维持，否则改成上传完成后显式触发（API 多一个端点、Skill 流程多一步）。同一个根因还让 deployer 每次发布都先 404 一次再重试（见第七节），将来做告警必须先把这条噪音排除掉，所以「显式触发」的收益不止是省那 10 秒。
5. 站点地址是随机 hex，要不要支持用户自定义子域名（涉及命名冲突、敏感词、抢注）。
6. 新根域申请进度与泛域名证书方案。

**工程待办**

1. **HTTPS 未收口**（为什么是上线阻断见下面阻断项第 2 条，这里只记怎么做）。Let's Encrypt 通配符证书已签发（`*.sites.lightclaw.tech`，**90 天，2026-11-04 到期**），文件在 `/tmp/sites-wildcard-cert/`（`/tmp` 会被清理，需尽快转移）。腾讯云 CLB **只认带 `qcloud_cert_id` 的 Opaque Secret**，`kubernetes.io/tls` 会报 `E4011`。平台证书自动化负责签发/续期、调用 `tccli ssl UploadCertificate` 导入腾讯云 SSL，并更新稳定 Secret `site-gateway-wildcard-tls` 的 live `qcloud_cert_id`；证书 ID 不写入 GitOps。当前 Ingress 无 TLS 段、`WEBSITE_SITE_URL_SCHEME=http`。
2. **证书自动化需完成接入验收。** 续期后可能生成新的腾讯云证书 ID，平台必须更新 live Secret 并触发 qcloud Ingress controller 重新同步；GitOps 只维护 Secret 名。
3. **销毁侧可观测性未做**：`dead` operation 数、`deleting` 超期站点数的指标告警。这是销毁侧 best-effort 的唯一兜底。
4. **测试库不再定义生产迁移历史。** 北京库的手工 DDL 与记账漂移按测试数据处理；需要继续使用时清理建站表/列后重跑合并后的 000028。生产只接受 `version=27, dirty=0` 且不存在建站表/列的前置状态，再执行一次最终态迁移。
5. **`ctl-service` 由 ArgoCD 自愈托管**，`set image` 一分钟内被拉回 master 镜像。所以 pass 隔离/销毁钩子的改动**在测试环境要等分支通过 GitOps 才长期生效**，目前长期生效的只有 `ctl-api-cloudbase` 和 `website-deployer`。但**验证不需要等 GitOps**：按第七节那套 SOP 暂停自愈（关键是先按住 ApplicationSet `sandbox-family`，只 patch leaf Application 无效），就能直接换镜像验真实发布对象，实测暂停可稳定维持 75 秒以上，本次 `creating` 隔离修复就是这么验的。
   **原先记的「临时起不受管的 sibling worker」方案应当否掉**：两个 worker 挂同一个 Redis 消费组，任务被谁抢到不可控，A/B 对照的结论无法归属；sibling 还不验证真实发布对象，且会在 ArgoCD 视野外留下游离资源。
6. **实例作用域建站凭据已实现。** CTL 签发永久 per-instance key，Redis 仅存随机 salt 与 SHA-256，TAT hidden 参数写入机器 systemd 环境。生产尚未执行真实下发；交给下发 Agent 的独立说明见 `docs/handover/2026-08-07-hermes-website-token-delivery-for-agent.md`。
7. **LLM key 后端缺陷**：平台注入的 `custom` provider（`http://10.15.226.135/v1`）在 test1/test2/test3 全部 401，走控制台「重置配置」重铸新 key 依然 401。判断是 ctl 铸的 key 不被那个数据面认，属网关/计费侧。**test1、test2 无法对话**，试用请用 test3~test6。
8. **腾讯云账号欠费**（可用余额 -73.7 万，`IsAllowArrears=false`），所有新购操作被拒，详见下面阻断项第 3 条。
9. **`pnpm check` 是空转门禁**：根 `tsconfig.json` 是 `files: []` + project references，`tsc --noEmit` 不带 `--build` 什么都不检。手动 `tsc -p tsconfig.app.json` 有约 324 条既存报错。不要把它通过当成类型没问题。
10. 前端两个小问题待修：面板副标题从未渲染（prop 名 `subtitle` vs 组件的 `description`，就是上面那 324 条之一）；英文作品列表右上角显示 `Total 1 agent(s)`（「共/个」key 与 Agent 列表共用，译文写死 agent）。
11. `frontend/src/pages/app/website-page.tsx` 是死代码（`/websites` 重定向到 `/agents/websites`），要么删要么明确定位。
12. 仓库内 Skill 已改名为 `website-builder`；机器侧必须通过正式分发通道执行“安装新目录成功后再删除旧目录”，避免两份 SKILL.md 并存。迁移清单见方案第 13.1 节。

**上线阻断项**

上面两组是「要做的事」，这一组是「不做完不能上线」。按阻断程度排序，每条先说清为什么它是阻断，而不只是「有这个问题」。

1. **生产实例 key 尚未实际签发和下发。** 代码、脚本与 Agent 交付文档已具备，但在真实生产实例收到各自的 key 前，对话建站主链路仍不可用。下发必须按 `docs/handover/2026-08-07-hermes-website-token-delivery-for-agent.md` 执行，不能复用浏览器 session。
2. **正式域名和 HTTPS 云资源尚未提供。** sgprod GitOps 已预留根域、泛域名和稳定 TLS Secret 名，但正式域名、DNS、证书与平台证书自动化未落值前禁止 sync。
3. **腾讯云欠费——挡住的是后续全部采购动作。** 所有新购被拒，付费证书当初就是因此下不了单，而 API 只报笼统的 `InvalidParam`，误导性极强，会让人顺着参数白查很久。**买正式域名之前必须先解决欠费**，否则会以同样的方式被拒、同样看不出原因。这条没有工程绕法。
4. **站点生命周期钩子未上线——到期不下线是计费口子。** 测试环境当前 master 镜像里整个 website 钩子都不存在，套餐隔离后所有站点继续对外服务（见第二节表格与第六节验证结论第 6 条）。逻辑本身已验证有效，缺的只是把 ctl 镜像滚上去这一步（见工程待办第 5 条）。
5. **生产一次性 000028 尚未执行。** 上线前必须确认目标生产库仍为 `version=27, dirty=0`、不存在建站表/列并已有快照，再通过受控 DB job 执行一次；测试库的历史漂移不进入生产迁移链。

非硬阻断但仍然缺的三项：界面没有「新建作品」入口（是设计还是缺口待产品拍，见上面确认项第 3 条）；前端用量展示未做；销毁侧指标告警未做（工程待办第 3 条，这是销毁侧 best-effort 的唯一兜底）。

## 六、第三轮：已提交并已线上验证

提交 `2c8206c94`「站点流量与存储计量、超额拦截、制品只留最新」。门禁全绿（三模块 gofmt / vet / test，site-gateway 含 `-race`），镜像已推并滚到测试环境。**2026-08-06 夜间已在北京测试环境把功能正确性逐项验掉**，结论与证据在本节末尾；下面的设计要点保留原样，是为了说明每个数字为什么该长成那样。

### 设计要点

**流量**：反代在**站点解析成功之后**才计量（内存有界的关键——随机子域名扫描解析不出站点，不会创建条目），用 `countingWriter` 累计实际写出字节，所以 HEAD 与 304 自然计 0 字节 1 次请求，不依赖 `Content-Length`。每 1 分钟 `POST /internal/ctl/websites/usage`，一个请求带该窗口全部有流量的站点；上报确定失败时整批并回内存，下窗口重试。ctl 按 `(site_id, usage_date)` upsert 累加。**已软删站点仍然入账**，否则可以靠反复建删把当月用量清零。时区 UTC+8，与 bundle 每日配额刷新口径一致。

**刻意不做幂等**：累加语义下重放会多算，没做窗口去重——多副本各自上报，服务端要去重就得再建一张「哪个副本哪个窗口已入账」的表，给一个近似值配一套精确记账不值得。`window_id` 只进日志。

**存储**：deployer 在发布成功和删除后重列 `sites/{siteID}/` 与 `_artifacts/{siteID}/` 求和，上报**绝对值**，覆盖写天然幂等。`used_storage_bytes` 只算未软删站点（与流量相反——存储是「当前占用」）。

**拦截**：在反代 `resolveSite`，与 `suspended`/`blocked` 同一处，403 且**不进 origin fetch**，超额后不再产生 COS 回源成本。生效延迟约 90 秒（上报 1 分钟 + 缓存 30 秒）。具体阈值读取套餐模板，生产值待产品确认。

测试阶段曾讨论把额度抬到 1 TiB，最终没有保留该临时值。无论产品最后给出的生产阈值是多少，闸门都会真实生效：实际拦截点可能因约 90 秒的计量收敛和多副本本地计数而略高于模板值，这一点需要在定价和用户提示中明确。

**制品只留最新一份**：本次发布的制品无条件排除在删除候选外（`LastModified` 在时钟回拨下不可靠），其余按 `LastModified` 倒序保留 `keep-1` 个。`WEBSITE_ARTIFACT_KEEP_VERSIONS` 默认 1。存量历史制品在该站点**下一次发布时一并收敛**（函数每次对整个前缀重判、不区分新旧），所以不需要一次性清理脚本；代价是从未再发布的老站点会一直留着旧 zip。**已确认无任何代码依赖历史制品回滚**：`ReleaseStatusRolledBack` 只被定义、全仓库无赋值，制品唯一被读取处是下载「当前正在部署的那个 release」。

**`creating` 缺口**：新增 `SiteDao.ListServingByUserID`（= `creating` + `active`），`OnPassIsolated` / `OnPassDestroyed` 改用它；在途 create 靠 generation 围栏变 superseded。**这段逻辑跑在 `ctl-service` 里，本次已按 SOP 暂停 ArgoCD 自愈后换镜像做过 A/B 对照，确认修复有效（见下面验证结论第 6 条）；但验证完镜像已换回 master，所以逻辑已验证有效、仍未上线。**

### 新字段

`used_traffic_bytes`、`used_storage_bytes`，snake_case，出现在 `GET /v1/websites/capability`，与已有的额度字段 `monthly_traffic_bytes` / `storage_bytes` 并列。前者也出现在内部接口 `GET /internal/ctl/websites/sites/{siteId}`，供反代做超额判定。

### 三个迁移

生产库尚未执行过建站迁移，因此测试阶段的 000028–000048 演进已压缩为单个
`000028_create_static_website_platform`：直接创建最终 COS 表结构，不包含 TCB 字段，
也不会预建用户配额行。产品确认生产套餐值后，在首次执行前把最终模板 UPDATE 直接补进
同一个 000028。用户的 `WEBSITE_STATIC_SITE` 配额仍在首次
调用建站能力时懒加载。生产执行口径见 `docs/runbooks/ctl-website-migration-shprod.md`。

上海生产可从 27 一路前滚无冲突。**北京测试库不能用 migrate 前滚**：bookkeeping 也停在 27，但 `website_usage_daily` 已因历史手工 DDL 存在（8 行数据），032 的 `CREATE TABLE` 会撞已存在的表。实测该表结构与 032 完全一致、含新 DAO 依赖的唯一键 `uk_site_date`。

### 验证结论（2026-08-06 夜间，北京测试环境）

原先列的 5 项全部验通，另外把当时判为「测试环境无法验证」的 `creating` 隔离修复也验掉了。镜像口径已核对：`site-gateway` / `ctl-api-cloudbase`（`ctl`）与 `website-deployer`（`temporal-workers`）都是 tag `cos-site-usage-20260806-2110`。

**1. 流量计量字节级精确，误差为零。** 对两个 active 站点做受控打流：`ws-a27cf43c6310cf92` 单发首页一次、下载 18481 字节，库里 `traffic_bytes=18481` / `request_count=1`；`ws-f8e9cfaab77bbfa6` 打 11 次 GET（每次 18 字节）+ 5 次 HEAD + 5 次 304 条件请求，库里 `traffic_bytes=198`、`request_count=22`。198 = 11 × 18，22 = 11 + 5 + 5 + 1（多的那 1 次是为了取 ETag 的 HEAD）。HEAD 与 304 确实按「0 字节、1 次请求」入账——用 `countingWriter` 而不是 `Content-Length` 不是洁癖，换成 `Content-Length` 这两类请求都会被算成整页字节。

**2. `used_storage_bytes` 与 COS 实际字节三次全部逐字节吻合。** 用 User 4（`usr_9703b0f011b7008ae4bfe98e`）建站 `ws-c3fac5a38380675a`，连发 3 次；产物一律 `zip -0` 不压缩，所以每个字节数都能预先算准：

- r1：`current/` 3000（a.css 2000 + index.html 1000）+ zip 3204 = 预期 6204 / 实际 6204
- r2：`current/` 12000（b.js 7000 + index.html 5000，r1 的 a.css 已被 `syncToCurrent` 清掉）+ zip 12202 = 预期 24202 / 实际 24202
- r3：`current/` 9000 + zip 9118 = 预期 18118 / 实际 18118

三次都没多算 `releases/` 暂存目录，说明上报确实发生在 prune 之后。r3 之后的 capability 完整响应：

```json
{"max_sites":1,"used_sites":1,"monthly_traffic_bytes":1099511627776,"used_traffic_bytes":0,"storage_bytes":5368709120,"used_storage_bytes":18118,"max_artifact_size":20971520,"max_files":500}
```

这是验证当时的原始响应，其中 `monthly_traffic_bytes` 是被撤回的 1 TiB 值；测试环境恢复后曾返回 `10737418240`。原样保留是因为它是实测证据，不是生产配置示例。

**3. 超额拦截生效，「不回源」也拿到了硬证据。** 把 `bundle_free_trial_01` 的 `monthly_traffic_bytes` 临时压到 100 字节（低于已用的 198），45 秒后两个站点同时 403，页面标题「本月流量已用尽」，响应体 451 字节；额度随后恢复为测试环境原值。「不回源」的验法值得记下来：那 11 次 403 打完后再等一个完整上报窗口，用量行的 `traffic_bytes` / `request_count` / `updated_time` 三个值一个都没动。计数器就挂在 `resolveSite` 之后、取候选对象之前，**计数没涨等价于压根没进 COS 回源分支**——比翻日志硬。

**4. `_artifacts/` 每次只剩最新一份，且保留的确实是最新那份**（不是随机保留）：r1 后 1 个 `wr-5512eb…` 3204、r2 后 1 个 `wr-27f7de…` 12202、r3 后 1 个 `wr-6c9c27…` 9118。日志 `pruned 1 stale artifact(s) for ws-c3fac5a38380675a, keeping the newest 1` 只在 r2 / r3 各出现一条——r1 时唯一那份就是 keepKey、没有候选，正确地没有输出。

**5. deployer → ctl 的存储上报链路实跑走通。** deployer 侧无任何 `report storage usage failed` / `compute storage usage failed`；ctl 侧四条 `website site storage usage updated`，`storage_bytes` 依次 6204 / 24202 / 18118 / 0。复用 `newInternalRequest` 的 token 与 URL 在真实环境有效，不需要新增配置。上报是**事件驱动**的：只在发布成功（prune 之后）和删除完成时各一次，没有定时扫描。端到端「上传完成 → capability 读到新值」延迟 r1 = 2 秒、r2 = 11 秒、r3 = 10 秒、删除 < 1 秒；这个抖动来自已知的「任务先于上传被唤醒、10 秒后重试」节奏，不是上报本身慢。覆盖式绝对值写入，未观察到累加或翻倍。

**存储只算未软删站点，这一条做了隔离验证。** 删站后 `used_storage_bytes` 18118 → 0、`used_sites` 1 → 0、COS 两个前缀 0 对象 0 字节、公网 404。但删站路径里「上报 0」和「行被软删」会同时把结果压成 0，光看这个证明不了 `deleted_time IS NULL` 过滤本身生效，所以额外把那条已删行的 `storage_bytes` 临时改成 6204 再查 capability，返回仍是 0，过滤确认生效（随后已改回 0）。同一次删站后 `used_traffic_bytes` 保留为 9000（那次首页访问正好 9000 字节，又一次字节级吻合）：存储归零、流量不归零，两个口径相反的设计已确认按预期工作。

**6. `creating` 站点隔离修复有效**（原先以为测试环境验不了，实际验成了；做法见第五节第 5 条与第七节，**不要走 sibling worker**）。同一份数据、同一条真实 API 触发链路，顺序跑三个镜像：

| 镜像 | 站点隔离钩子 | 停服站点数 | `creating` 站点结果 |
|---|---|---|---|
| `:cos-site-usage-20260806-2110`（含修复） | 有，`logic.go:1376` | 3 | creating → suspended，op_gen 1→2 |
| `:cos-site-lifecycle-svc-20260806-2012`（修复前） | 有但 active-only，`logic.go:1313` | 2 | 保持 creating，op_gen 保持 1 |
| 当前 master `@sha256:a32d106f` | **完全没有** | 0 | 保持 creating |

日志里 `count=3` 对 `count=2` 就是直接证据，正对应 `2c8206c94` 里 `ListActiveByUserID` → `ListServingByUserID` 那一行。`website_operations` 行数前后都是 6——隔离是纯 DB 状态迁移、不产生异步操作，与单测 `assertNoOperations` 一致。

**对照为什么可信**：`ctl-service` 只有 1 个副本、三轮顺序执行且每轮之间走完整 rollout、Redis Stream 消费组同一时刻只有一个消费者，不存在两个 worker 抢任务导致结果归属不明。

**局限如实记下**：那条 `creating` 站点行是直接 INSERT 造的（该用户配额已满，且走 API 建站会很快被推成 active、停不住）。被测代码路径是相同的（`ListServingByUserID` 查询 + 带前置状态校验的 CAS），但**没有覆盖**「真实在途 create 的成功回调被 generation 围栏挡住」那一段，它目前只有单测 `TestInFlightCreateCannotReviveIsolatedSite`。

**一条既有噪音（非本次改动引入）**：每次发布 deployer 都先 404 一次再重试，日志稳定出现 `download artifact attempt 1/6 failed: ... NoSuchKey`，靠重试兜住。见第七节与第五节确认项第 4 条。

**环境已还原**：测试站点已删（软删行的 `storage_bytes` 恢复 0），COS 桶逐字节回到验证前状态（`sites/` 4 对象 19927 字节、`_artifacts/` 4 对象 7198 字节，全属两个受保护站点），bundle 额度回到测试环境原值，无遗留 pod；`ws-5` 回 active/op_gen=1、pass 回 active/`isolated_time=NULL`、`tasks` 行清除、`ctl-service` 回 master，ArgoCD 与 ApplicationSet 恢复原状且 Synced / Healthy。

下一步做前端：`used_traffic_bytes` / `used_storage_bytes` 两个数字的展示，连带第五节工程待办第 10 条那两个小修，一次性发版。

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

**套餐隔离不是定时扫描触发的，改 `pass.expired_time` 等不来任何东西。** ctl 里没有任何定时任务去扫 pass 的到期时间。真实链路是：计费侧回调 trade → trade 反向调 `POST /internal/ctl/passes/{pass_id}/isolate`（`ctl/main/api/pass_handler.go:498`，鉴权是 `CTL_INTERNAL_TOKEN` Bearer）→ `TryAcquireSlotForIsolate` 把 `pass.status` 从 active CAS 成 isolating 并投 Redis Stream（`ctl/pkg/logic/pass/isolate.go:49`）→ ctl-service 消费执行（`ctl/pkg/pass/worker/isolate_task.go:162`，消费组 `lightglobal_service`）；站点隔离是 CAS 成 isolated **之前**的阻塞步骤（`isolate_task.go:333` → `ctl/pkg/logic/website/pass_hook.go:21` → `logic.go:1355`）。父 task `ExecuteInterval` 30 秒、`MaxExecuteCount` 1<<30。补偿扫描器 `checkTasks` 在 ctl-bypass（`ctl/pkg/bypass/check_tasks.go`，1 分钟一轮、批量 200），但它扫 `tasks` 表、不扫 pass 表。所以手动触发的正确姿势是直接调那个内部接口；只改库的话，必须同时往 `tasks` 表插一行 `IsolatePass` 的 CREATED 记录，等 ctl-bypass 重投。

**暂停 ArgoCD 自愈要先按住 ApplicationSet，否则纯属白折腾。** 两个坑叠在一起：一是 ArgoCD 控制面**不在** tke-bj8 集群，而在 DevCloud 本机 k0s 上，用 `/etc/lightclaw-ci/kubeconfig_beijing_sandbox` 执行 `kubectl -n argocd get application` 会报 `the server doesn't have a resource type "application"`，正确 kubeconfig 是 `/var/lib/k0s/pki/admin.conf`，管 `ctl-service` 的 app 叫 `ctl-beijing-sandbox`；二是只 patch leaf Application 的 `syncPolicy: null` 无效——该 app 由 ApplicationSet `sandbox-family` 生成（`ownerReferences` 可证），appset 控制器会按模板把 `syncPolicy.automated` 塞回去、selfHeal 再把镜像拉走，实测一分钟内就被改回。必须先

```bash
kubectl -n argocd patch applicationset sandbox-family --type=merge \
  -p '{"spec":{"syncPolicy":{"applicationsSync":"create-only"}}}'
```

再 patch leaf app，加上这步后暂停维持 75 秒以上没被改回。影响面很窄：窗口内 appset 只是不向已有 app 推模板变更。另外 `ctl-api-cloudbase` 和 `website-deployer` 根本不在 ArgoCD 托管范围内（无 tracking-id 注解），所以暂停 ctl 那个 app 对它们零影响。**这个坑很可能正是当初得出「只能起 sibling worker」结论的由来**——DevCloud 上还留着上一轮存的 `/root/ctl_service_original_image.txt` 和 12:17Z 被回滚的 ReplicaSet `ctl-service-8594f68864`。

**deployer 每次发布都会先 404 一次再重试**，日志稳定出现 `download artifact attempt 1/6 failed: ... NoSuchKey`。这是既有行为、不是计量那批改动引入的，靠重试兜住不影响结果，但**将来做告警必须把它排除掉**，否则每次正常发布都会报一次假警。根治办法就是第五节确认项第 4 条那个「改成上传完成后显式触发」。

**`wrangler pages deploy` 必须带 `--branch=main`**，不带会拿当前 git 分支名当 Pages branch，部署落到预览别名而 `lightclaw.pages.dev` 完全不变，且 wrangler 照样返回成功。部署后一定对比资产 hash。

**COS 的 PUT Object 不支持 `If-Match`**（官方文档只有 `x-cos-forbid-overwrite`；SDK 里的 `If-Match` 全是 `x-cos-copy-source-If-Match`，那是 Copy 的源条件）。网上说支持的是把 HEAD Object 的读侧条件请求张冠李戴了。

**测试账号：`~/.codex/skills/lightclaw-credentials/SKILL.md` 第九节里 User 5 的 token 是错的**（系统里查无此记录，当初抄错），正确的在 `docs/handover/2026-08-06-cos-site-gateway-test-guide.md`。test1/test2 因 LLM key 问题不能对话。

**几个只有踩过才知道的小陷阱**：`usage_date` 读写两侧都必须用日期字符串（`website.UsageDateLayout`），用 `time.Time` 会让 SQLite 存成带时分秒的值、同一天落到不同行、唯一键失效；`ctl/pkg/pass/worker/website_hook_test.go` 和 `pkg/logic/website/operation_lease_test.go` **各自维护一份 `website_sites` 建表 DDL**，改 entity 加列时两处都要改；`ctl/main/api` 下的测试文件是 `package main` 不是 `package api`；`kubectl set image deploy/ctl-api-cloudbase` 要用 `*=`，容器名和 deployment 名不一致；本机 crane 推 TCR 会踩 `credsStore: desktop`，需 `export DOCKER_CONFIG=/tmp/cranecfg` 用独立配置目录；DB 只在集群网络内可达，从 DevCloud 直连 `10.15.224.4:3306` 会超时，要在集群里起一次性 `mysql:8` pod（DevCloud 上留了 `/root/ctlsql.sh`，stdin 喂 SQL）。

**`ctl` 全量 `go test ./...` 在本机必然有失败**（缺 `server_conf.toml` 与 rootless Docker），与改动无关。判断是否引入回归要用 stash 在干净树上跑一遍对比，别凭直觉。

**编排教训**：不要把七件事塞进一个 subagent 任务——外部看不到中间进度，而且中途修正需要打断，打断会让当前回合作废。今天两次打断分别浪费了 40 分钟的镜像推送和一轮代码编写。非紧急修正应攒到回合自然结束时再给。
