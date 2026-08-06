# 静态建站二期技术方案：COS + 自建反代 + 子域名

- 状态：待讨论
- 日期：2026-08-06
- 替代：`docs/superpowers/specs/2026-07-31-cloudbase-static-site-design.md`（TCB 托管方案）

## 1. 为什么要换

一期用 CloudBase（TCB）静态托管，已在北京测试环境跑通全链路。换栈的直接原因只有一个：

**TCB 做不了用户级别的数据隔离。** TCB 数据库的浏览器端凭据作用域是环境级，安全规则不支持按「站点来源」授权。也就是说只要给 AI 生成的站点接上 TCB 数据库，A 站点的页面就能读写 B 站点的数据。在「用户不感知 TCB、多个用户站点共享同一个 TCB 环境」的模型下，这是无解的。

而「页面里的按钮能存数据」是这个产品要往下走绕不开的能力，所以托管层必须换。

顺带解决的问题：

- **拿回控制权。** TCB 托管下我们看不到流量、做不了限流、下线站点只能删文件。自建反代之后，限流、计数、单站点秒级封禁全都在我们手里。
- **去掉 TCB 环境容量管理。** 一期为了绕开单环境站点数上限，写了一整套环境发现 + 容量统计 + 超限自动切换 + 随机路由（`ctl/pkg/logic/website/tcb_env.go` 361 行 + `workers/internal/website/tcb_env.go` 216 行）。换成我们自己的单桶之后，这 577 行整个删掉。
- **URL 归属。** 现在的公开 URL 是 `{env}-{appid}.tcloudbaseapp.com/sites/{siteID}/current/index.html`，又长又是腾讯的域名。

## 2. 目标与非目标

**目标**

1. 静态站点托管在我们自己的 COS 桶，经过我们的反代对外服务。
2. 每个站点一个子域名（根域待定，见第 12 节）。
3. 提供一套数据面 API，让 AI 生成的页面能存取数据，且**站点之间天然隔离**。
4. **对外提供可复用的底层托管能力**：自定义域名绑定 + 可插拔鉴权，让其他接入方（国内站）在上面搭自己的产品形态，不需要改我们的代码。
5. 违规内容的爆炸半径收敛在用户站点这一摊，不波及自有业务。

**非目标（这一期不做）**

- 关系型能力：join、聚合、事务、服务端排序。数据面是文档存储，不是数据库。
- 服务端计算 / 云函数。
- 为自定义域名签发和托管 TLS 证书（见第 8 节，这块交给接入方）。

## 3. 整体架构

```
用户浏览器
    │  https://{siteID}.{根域}/...           ← 我们自己的站点
    │  https://用户自己的域名/...             ← 接入方带来的站点
    ▼
[接入方入口] 可选：接入方自己的 CDN/网关，终结 TLS 后回源
    ▼
泛域名 Ingress（*.{根域} + 泛域名证书）
    ▼
site-gateway（新服务，无状态，多副本）
    │
    ├─ Host 解析 ──┬─ 子域名模式：{siteID}.{根域} 直接推导
    │              └─ 自定义域名模式：查绑定表
    │
    ├─ 静态路径  /*                → COS: sites/{siteID}/current/**
    ├─ 数据路径  /__vela/data/*    → COS: sites/{siteID}/data/**
    │
    └─ 站点元信息（状态/配额/鉴权模式/域名绑定）
         └─ 从 ctl internal API 拉取 + 本地 TTL 缓存

管控面（基本不变）
    ctl ──Redis队列──> website-deployer ──> COS: sites/{siteID}/current/
```

关键点：**siteID 由服务端从 Host 决定，永远不是请求参数。** 子域名模式下从 Host 直接推导，自定义域名模式下查绑定表——两种模式下前端都无法伪造自己的身份，只能碰到自己前缀下的对象。这是整个隔离模型的基石，也是相比 TCB 的核心改进。

## 4. 存储布局

单桶，按前缀分租户。`current/` 和 `_artifacts/` 这两层一期已经在用了，直接沿用：

```
sites/{siteID}/current/**                对外服务的稳定目录，公开 URL 只指向这里
sites/{siteID}/releases/{releaseID}/**   单次发布暂存，成功后同步到 current/
sites/{siteID}/data/{collection}/{docId}.json   数据面文档
_artifacts/{siteID}/{releaseID}.zip      制品，套餐续费恢复用
```

桶为私有读，所有访问必须经过 site-gateway。这点和现在的 staticpages 预览桶（`publicRead: true`）不同——预览桶公开读无所谓，用户站点桶不行，否则绕过反代就能枚举其他站点。

这个桶**专用于用户生成内容，不与任何自有业务共用**，理由见第 9 节。

## 5. 静态托管链路

反代要做的事，`third_party/staticpages` 里大部分有现成实现可以参考：

| 能力 | 参考实现 |
|---|---|
| Host → 站点解析 | `third_party/staticpages/pkg/config/domain_mapper.go` |
| COS 回源 + Director | `third_party/staticpages/pkg/proxy/proxy.go` |
| index.html 补全 / 404 兜底 | 同上，`searchPath` + `notFound` |
| 对象索引缓存 | `third_party/staticpages/pkg/s3_client/index_cache.go` |

**不 fork 上游**，而是新写服务、参考其实现。理由：数据面 API、可插拔鉴权、自定义域名绑定都是 staticpages 完全没有的概念，改造量会侵入它的核心；fork 之后同步上游会长期痛苦。它是 vendored 的第三方项目，保持只读。

**Host 解析是双模式的**，这是给接入方留的口子：

1. **子域名模式** — Host 后缀匹配已配置的根域，剩下的标签就是 siteID。`site_id` 格式是 `ws-<16位hex>`（`generateID`，8 字节随机 hex），全小写字母数字加连字符，DNS 合法，可以直接当子域名，不需要映射表。根域是**配置项，支持配多个**。
2. **自定义域名模式** — 后缀不匹配任何根域时，查域名绑定表（内存缓存，从 ctl 拉）。查不到返回 404，不回落到任何默认站点。

Content-Type 由上传侧保证（`workers/internal/website/deployer.go:166 contentTypeForKey` 已实现），反代直接透传 COS 返回的头。

站点状态影响响应：

- `active` → 正常回源
- `suspended`（套餐到期） → 返回统一的「站点已下线」页面，不删文件
- `blocked`（违规封禁，新增） → 返回封禁提示页
- `deleting` / `deleted` / 不存在 → 404

## 6. 数据面 API 契约

**这一节是整个方案里最需要现在定死的部分。** 契约一旦固定，服务端存储实现可以随时替换，前端、Skill 和接入方都不用改。

同源路径，无跨域，浏览器不持有任何凭据：

```
GET    /__vela/data/{collection}?limit=&cursor=    列表（按 _id 倒序）
POST   /__vela/data/{collection}                   新增，服务端生成 _id
GET    /__vela/data/{collection}/{id}              读单条
PUT    /__vela/data/{collection}/{id}              覆盖，需 If-Match: {etag}
DELETE /__vela/data/{collection}/{id}              删除
```

服务端注入的保留字段：`_id`、`_createdAt`、`_updatedAt`、`_owner`（鉴权模式下写入）。

**一条数据一个对象**，不是一个 collection 一个大 JSON 数组。这个选择是刻意的：对象存储没有事务，大数组模式下两个并发写会「读-改-写」互相覆盖；一条一个 key 则天然无冲突。更新同一文档时用 COS 的 ETag 条件写做乐观锁（**待验证**：COS 对 `If-Match` 的支持程度，见第 14 节）。

`_id` 用时间有序的字符串（ULID 或 `时间戳-随机`），这样 ListObjects 的字典序就是时间序，列表分页不用额外索引。

**硬性限制**（防滥用，也是把用户挡在这套东西能力边界内的手段）：

- collection 名：`[a-z0-9_-]{1,32}`
- 单文档：≤ 256 KB
- 单站点 collection 数：≤ 32
- 单 collection 文档数：≤ 10000（超过拒绝写入并提示）
- 写入速率：按站点限流
- 站点数据总量计入套餐配额（`BundleStaticSiteQuota.StorageBytes` 已有这个字段）

**能力边界必须写进文档和 Skill：** 列表查询是 ListObjects，一次最多 1000 个 key 还要逐个拉内容；没有索引，条件查询只能全量拉回内存过滤；没有事务。适合留言板、表单收集、计数器、待办清单；不适合电商、有账号体系的应用、任何需要强一致的场景。

## 7. 鉴权模型（可插拔）

定义一个接口，配置里选实现：

```go
type TokenVerifier interface {
    // 返回 userID；token 无效返回错误
    Verify(ctx context.Context, token string) (string, error)
}
```

三种实现：

1. **`anonymous`（默认）** — 不校验，任何人可读写。留言板、表单这类场景。靠速率限制和配额兜底。
2. **`jwt`（推荐给接入方）** — 双方约定签名公钥，site-gateway 离线校验，不依赖对方服务可用性，无额外 RTT。接入方签发带 `sub`（userID）和 `exp` 的 JWT，通过 `Authorization: Bearer` 带过来即可。
3. **`introspect`（备选）** — 回源调用一个 `POST {endpoint}` 接口，输入 token 输出 userID，带短 TTL 缓存。国际站接 Vela 登录态时走这条，打到 lightclaw-auth 的 `/auth/session`。`service-gateway/internal/gateway/server.go` 的 `introspect` 是现成模板。

**注意：site-gateway 是公网直连的，不能沿用 `ticket`、`trade` 那种「信任 `X-Lightclaw-User-ID` 头」的内网模型。** 那套模型的前提是服务只有 ClusterIP、请求必然经过 service-gateway；泛域名站点代理不满足这个前提，必须自己校验 token。

配合鉴权的访问规则（每个 collection 一档，站点创建时由 Skill 决定）：

- `public` — 谁都能读写
- `public-read` — 谁都能读，只有登录用户能写
- `owner` — 只能读写 `_owner` 等于自己的文档

## 8. 接入方契约（国内站怎么接）

**定位：我们做底层托管，接入方做产品形态。** 具体分工：

| 职责 | 归属 |
|---|---|
| 用户自定义域名的收集、备案、DNS 引导 | 接入方 |
| 自定义域名的 TLS 证书签发与续期 | 接入方 |
| 用户登录态、账号体系 | 接入方 |
| 域名归属校验 | 接入方（我们只信绑定 API 的调用） |
| 静态文件存储与回源 | 我们 |
| 数据面 API 与租户隔离 | 我们 |
| 站点封禁、限流、配额 | 我们 |

**TLS 交给接入方是刻意的。** 用户自定义域名意味着证书数量无上限、续期失败会直接导致站点不可用，这块运维负担很重，而且和「托管能力」本身无关。推荐接入方在自己的 CDN/网关上终结 TLS，然后回源到我们，回源时保留原始 `Host` 头（或用约定的 `X-Vela-Site-Host`）。这样我们完全不碰证书，接入方也不需要我们改代码。

如果接入方希望我们代管证书，那是后续的独立议题，不在这一期。

**我们需要对外暴露的接口（这就是「快速接入」的全部内容）：**

```
POST   /internal/sites/{siteID}/domains     绑定自定义域名
DELETE /internal/sites/{siteID}/domains/{domain}   解绑
GET    /internal/sites/{siteID}             查站点状态
POST   /internal/sites/{siteID}/block       封禁站点
```

内部接口走 HMAC 或共享密钥，不走公网泛域名入口。

绑定成功后，接入方把该域名 CNAME 或回源指向我们，Host 解析的第二模式就会命中。**同一个域名只能绑一个站点**，重复绑定拒绝，避免劫持。

需要单独产出一份《接入方对接文档》，内容就是本节 + 第 6 节 + 第 7 节。这份文档应该能让对方在不读我们代码的前提下完成接入。

## 9. 封禁与连坐隔离

用户生成内容必然会有违规的，问题不是「会不会被封」，而是「被封的时候连坐范围有多大」。

**共识：单个用户违规导致该用户站点被封是可接受的，业内普遍如此。红线是不能波及自有业务（IDE、主站、API）。**

**已定决策：同主账号 + 独立桶（方案 A）。** 所有用户站点共用一个桶，按 `sites/{siteID}/` 前缀分租户；该桶不与任何自有业务共用。

关于账号层级需要说清楚一点，避免误判防护效果：腾讯云的处罚对象是**主账号**（UIN/APPID），子账号（CAM）只隔离权限、不隔离资源归属。用子账号上传违规内容，处罚一样落在主账号头上。**所以子账号对防连坐没有任何作用**，唯一能做到云厂商层面彻底隔离的是独立主账号，但代价是独立企业实名、独立计费、可能失去大账号折扣、双份密钥与告警运维。当前业务量下不值得，故采用 A。

隔离措施，按重要性排序：

1. **独立域名。** 用户站点用单独申请的域名，绝不挂在主域下。否则一个违规站点可能导致整个主域被墙或被封，直接打死自有业务。（已确认：会新申请域名，见第 12 节。）
2. **独立 COS 桶。** 用户站点桶不与任何自有业务共用。腾讯云对违规内容的常规处置粒度是删对象/封桶/停该桶服务，共用就是自找连坐。桶级被封时全体用户站点受影响，这是**已接受**的风险。
3. **上传时内容审核。** COS 数据万象提供内容审核（图片/文本），在 deployer 上传阶段过一遍，把明显违规的挡在存储之外。这是「先于腾讯云动手」的第一道闸。
4. **我们自己的 kill switch。** 反代层能对单站点秒级封禁（新增 `blocked` 状态），不依赖删文件、不依赖云厂商。

第 3、4 条是方案 A 下最关键的两道防线：**我们比腾讯云先动手下线，是避免事态从桶级上升到主账号级的最有效手段。** 一旦上升到主账号级，自有业务就会被连坐，那是红线。

**设计约束（无论账号方案如何都必须遵守）：** 桶名、APPID、COS 凭据、根域全部走配置，代码里一个都不硬编码。这样将来若需要拆到独立主账号，是「改配置 + 一次数据迁移」，而不是重构。

**建议事先约定升级触发条件：** 收到腾讯云第一次违规警告时，立即启动迁独立主账号的评估。事先定好比事后临时决策更可靠。

内容审核这一层的深度待定：全量审核有成本和延迟，抽样审核有漏网风险。倾向**上传时做一次机器审核 + 保留人工/举报下线通道**，不追求百分之百。

## 10. 存量代码：能复用多少

**结论：管控面几乎全留，只有最底下一层要换。** 一期修过的那些 bug（配额超卖、操作租约、删除重试、发布版本唯一性）都在保留的部分里，不用重踩。

**直接复用，零改动**

- 配额分配/释放：`allocSiteQuotaTx` / `releaseSiteQuotaTx`（含刚修完的超卖修复）
- 套餐生命周期：`ctl/pkg/logic/website/pass_hook.go` 的隔离/恢复/销毁
- 操作编排：租约、重试、死信、generation 围栏
- 8 个 DB 迁移（000039–000046）
- 前端面板：删除轮询、状态徽章、i18n

**改动**

| 位置 | 改动 |
|---|---|
| `ctl/pkg/logic/website/tcb_env.go`（361行） | 整个删除。单桶不需要环境发现/容量统计/随机路由 |
| `workers/internal/website/tcb_env.go`（216行） | 整个删除，换成单桶配置 |
| `workers/internal/website/deployer.go` | `getCosForEnv` → 固定 client；`getSitePublicURL` → 子域名格式（根域从配置读）。其余 773 行里的 zip 校验、`syncToCurrent`、制品保留、suspend/resume/delete 基本不动 |
| `SiteEntity.TCBEnvID` | 停止写入（列先保留，避免迁移；后续单独清理） |
| `SiteEntity.PublicURL` | 生成规则改为 `https://{siteID}.{根域}` |
| 新增 `website_site_domains` 表 | 自定义域名绑定，`(domain)` 唯一 |
| 新增站点状态 `blocked` | 违规封禁 |
| ctl 新增 internal API | 站点元信息查询、域名绑定、封禁（见第 8 节） |

## 11. 部署形态

新建服务目录 `site-gateway/`（Go），走仓库标准发布模型：

- 源码面：`site-gateway/k8s/base/` + `site-gateway/k8s/overlays/<env>/`
- 部署面：`argocd/services/site-gateway/<env>/`，独立 Argo app
- 泛域名 Ingress + 泛域名证书（参考 `staticpages/k8s/base/manifests.yaml` 的 wildcard TLS 写法）
- COS 凭据走 SOPS：`argocd/secrets/<env>/site-gateway-secrets.sops.yaml`
- CI：`.ci/site-gateway.yml`

无状态、可水平扩展。不走 service-gateway（它是按路径路由的，这里需要 Host 路由）。

一期已经为 `website-deployer` 建好的 shprod 发布通道（`argocd/services/workers-website-deployer/`、`.ci/workers-website-deployer.yml`）继续有效，deployer 只是换了目标桶。

## 12. 域名

**根域会新申请，不复用 lightvela 现有域名。** 具体域名待定，申请完再填。

因此代码里**不允许硬编码任何根域**：根域是配置项、支持配置多个（便于测试环境和正式环境用不同域，也便于将来加第二个根域而不改代码）。`PublicURL` 的生成也从配置读。

**PoC 阶段用 `{siteID}.sites.lightclaw.tech`**，HTTP-only。选它是因为基础设施已经就位：`*.sites.lightclaw.tech` 的泛域名 DNS 解析已存在（指向 CLB `lb-kbl26vb5`），`ctl` namespace 下也已有 Ingress `lightclaw-sites-public`（腾讯云 `qcloud` class）。

关于证书，有两个容易踩的点：

1. **泛域名证书只覆盖一级标签。** `*.lightclaw.tech` 能覆盖 `preview.lightclaw.tech`，却覆盖不了 `x.preview.lightclaw.tech`——这正是 staticpages 需要单独一张 `*.preview.lightclaw.tech` 的原因。所以现有的 `*.lightclaw.tech` 证书对 `*.sites.lightclaw.tech` 无效。
2. **换用一级子域也不划算。** 改成 `{siteID}.lightclaw.tech` 虽然能复用现有证书，但根域没有泛域名 DNS 记录，补一条会兜住 `lightclaw.tech` 下所有未注册的名字，风险大于收益。

集群里现存的 `sites-lightclaw-tls` 是自签证书（issuer 等于 subject），浏览器仍会告警，不能用。免费证书通道当前排队（`FailedOperation.NetworkError 当前CA机构访问繁忙`），付费下单无法通过 `ssl CreateCertificate` API 完成（TrustAsia 12 / DNSPod 49 / Rapid 103 / Wotrus 27 四个合法 ProductId 均返回 `FailedOperation.InvalidParam`），需走控制台。

因此 PoC 走 HTTP-only，与 playground 环境「实例 wildcard 入口默认 HTTP-only」的既有约定一致。影响仅限于站点内用不了需要 secure context 的浏览器 API（地理位置、摄像头、Service Worker），这类能力不在第一版范围内。

新根域到位后，按现有泛域名证书（`*.lightvela.ai`、`*.lightvela.com` 等 DNSPod DV 通配符）的同样方式申请一张，连同 TLS 一次性配齐。
- 国内站是否需要备案——不过按第 8 节的分工，国内站走的是接入方自己的自定义域名，备案是接入方的事，我们的根域只服务国际站。这实际上把一期被否决时的备案阻塞给绕开了，需要跟接入方确认这个理解是否一致。

## 13. Skill 改动

`.agents/skills/cloudbase-site-builder/SKILL.md` 需要改（名字也该换，`cloudbase-` 前缀不再准确）：

- 产物不再打 TCB 包，改为上传到我们的 COS
- 站点 URL 格式改为子域名
- 新增数据面使用指引：需要存数据时用 `/__vela/data/*`，给出可直接抄的 fetch 代码片段
- **明确写清能力边界**，避免 AI 生成出超过文档存储能力的应用（比如带库存扣减的电商）
- 保留一期已加的三条：UI 设计决策前置、禁用 History 模式路由、重试上限

## 14. 分期与未决问题

**分期**

| 阶段 | 内容 | 产出判定 |
|---|---|---|
| P0 | site-gateway 静态回源 + 泛域名（子域名模式）；deployer 换桶 | 建站后子域名可访问 |
| P1 | 数据面 API（anonymous）+ 配额限流 | 留言板 demo 端到端可用，跨站点访问被拒 |
| P2 | 自定义域名绑定 + 鉴权插件 + 接入方对接文档 | 对方能按文档独立接入，不需要我们改代码 |
| P3 | 内容审核 + 封禁通道 + Skill 改造 + 生产上线 | — |

工作量等方案定稿后再估。

**需要验证的技术点**

1. COS 对 `If-Match` 条件写的支持程度——这决定乐观锁能不能做，做不了的话并发更新同一文档只能靠「一条一个对象、不支持原地更新」来规避。
2. 单桶的对象数量和 QPS 上限，以及是否需要按站点分桶。
3. COS 数据万象内容审核的接入方式、成本和延迟。
4. ListObjects 在单 collection 上万文档时的实际延迟。

**已定决策**

- 单桶，按 `sites/{siteID}/` 前缀分租户。
- 同主账号 + 独立桶（方案 A）；桶级被封导致全体用户站点受影响，是已接受的风险。
- 根域新申请，不复用 lightvela 现有域名；代码全部走配置。
- 自定义域名场景下 TLS 与备案由接入方负责。

**需要产品/业务确认**

1. 新根域申请进度，以及泛域名证书方案。
2. 内容审核深度：全量还是抽样。
3. 是否接受「收到腾讯云第一次违规警告即启动迁独立主账号评估」这个触发条件。
4. 数据面是否所有套餐都给，还是付费才有。
5. 站点数据总量算不算进现有的 `StorageBytes` 配额。
6. 与国内站接入方对齐第 8 节的分工表，特别是 TLS 和备案的归属。

**已知会撞上的边界**

数据面用对象存储模拟文档数据库，列表性能、无索引、无事务这三条迟早会撞。应对不是现在就上真数据库（那会引入用户数据和平台业务库的耦合、爆炸半径、容量不可控、多租户逃逸风险），而是**把 API 契约定死，把后路留在服务端**：将来某个站点真需要索引和事务，可以针对性换实现（单站点独占 SQLite on PVC，或给付费站点单独开真数据库），前端一行不用改。
