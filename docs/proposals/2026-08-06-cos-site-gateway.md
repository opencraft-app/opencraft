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
3. **对外提供可复用的底层托管能力**：自定义域名绑定，让其他接入方（国内站）在上面搭自己的产品形态，不需要改我们的代码。
4. 违规内容的爆炸半径收敛在用户站点这一摊，不波及自有业务。

**非目标（这一期不做）**

- **任何形式的服务端数据存储。** 站点是纯静态托管，产品决定收缩到这个边界，原因见第 6 节。
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
    ├─ 全部路径  /*                → COS: sites/{siteID}/current/**
    │                                （只读，只允许 GET/HEAD，网关不具备写 COS 的能力）
    │
    └─ 站点元信息（状态/配额/域名绑定）
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
_artifacts/{siteID}/{releaseID}.zip      制品，套餐续费恢复用
```

`sites/{siteID}/data/**` 曾是数据面文档的前缀，数据面移除后不再产生新对象；
试用期遗留的对象是孤儿（网关已无任何路径能读到它们），需要单独清理，见第 6 节。

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

**不 fork 上游**，而是新写服务、参考其实现。理由：站点状态门禁（`suspended`/`blocked`）、自定义域名绑定、按 ctl 拉取的站点元信息都是 staticpages 完全没有的概念，改造量会侵入它的核心；fork 之后同步上游会长期痛苦。它是 vendored 的第三方项目，保持只读。

**Host 解析是双模式的**，这是给接入方留的口子：

1. **子域名模式** — Host 后缀匹配已配置的根域，剩下的标签就是 siteID。`site_id` 格式是 `ws-<16位hex>`（`generateID`，8 字节随机 hex），全小写字母数字加连字符，DNS 合法，可以直接当子域名，不需要映射表。根域是**配置项，支持配多个**。
2. **自定义域名模式** — 后缀不匹配任何根域时，查域名绑定表（内存缓存，从 ctl 拉）。查不到返回 404，不回落到任何默认站点。

Content-Type 由上传侧保证（`workers/internal/website/deployer.go:166 contentTypeForKey` 已实现），反代直接透传 COS 返回的头。

站点状态影响响应：

- `active` → 正常回源
- `suspended`（套餐到期） → 返回统一的「站点已下线」页面，不删文件
- `blocked`（违规封禁，新增） → 返回封禁提示页
- `deleting` / `deleted` / 不存在 → 404

## 6. 数据面：已移除（决策记录）

**结论：数据面已于 2026-08-06 整体移除，站点收缩为纯静态托管，产品层面不再有「db」这个概念。**

本节原先是整个方案里定得最细的一节（`/__vela/data/*` 的五个接口、`_id`/`_etag` 契约、
文档与集合上限、按站点令牌桶限流）。它**不是纸面设计**：实现完整落地，并在 2026-08-06 的
真实 COS 环境上通过了 62 项验证（增删改查、`x-cos-forbid-overwrite` 条件写、并发、
限流生效与恢复、跨站点隔离、配额）。

### 为什么移除

1. **产品决定把站点能力收缩为纯静态托管。** 这是首要原因。
2. **无鉴权的公开读写是它最大的遗留问题。** 数据面挂在站点公网地址下、浏览器不持凭据，
   任何人拿到站点地址就能读写该站点的全部文档。限流和文档数上限只提高了刷库成本，
   并没有解决「公开可写」这件事本身。原第 7 节的可插拔鉴权是为它准备的，但一直是 P2。
3. 保留前缀 `/__vela/` 占用了本属于用户的路径空间，纯静态托管不需要付这个代价。

### 移除了什么

| 位置 | 处理 |
|---|---|
| `site-gateway/internal/datastore/` | 整包删除 |
| `site-gateway/internal/ratelimit/` | 整包删除（只服务于数据面写/删限流，静态读不限流） |
| `site-gateway/internal/httpapi/data.go` / `data_test.go` | 删除 |
| `site-gateway/internal/httpapi/server.go` | 去掉保留前缀分发，`/__vela/*` 现在完整走静态回源（结果通常是 404） |
| `site-gateway/internal/objectkey/` | 去掉 `DataPrefix` / `DataCollectionPrefix` / `DataDocumentKey` / `DocumentIDFromKey` |
| `site-gateway/internal/origin/` | 去掉 `Store` 接口的 `Put`/`Delete`/`List` 与 `ErrAlreadyExists`，只留 `Fetcher.Get` |
| `site-gateway/internal/config/` | 去掉全部 `SITE_GATEWAY_DATA_*` 配置项 |

**去掉写能力本身就是一种加固**：网关在类型层面不再具备写 COS 的可能，
后续改动也就不可能顺手把写路径加回来。静态路径仍然只允许 GET/HEAD，其余方法返回 405。

### 备份位置

移除前的完整快照（源码、被修改文件的 diff 补丁、改写前的 Skill 与两份文档、恢复步骤）
存放在本机仓库外的目录 `~/vela-dataplane-snapshot-20260806/`，未进入 git。
内容不在此展开，需要时读该目录下的 `README.md`。

### 将来若要恢复，必须先解决

1. **鉴权。** 这是移除的核心原因之一，无鉴权的公开读写不能再上线第二次。
   至少要有站点级的写入凭据或签名，或把写路径收到登录态背后（原第 7 节的三种实现是可用的起点）。
2. 与鉴权配套的滥用治理：限流是成本控制，替代不了身份。
3. 重新确认 `/__vela/` 占用用户路径空间这个取舍。
4. `origin.Store` 的写能力恢复即意味着网关重新能写 COS，需要重新评估爆炸半径。

### 遗留数据

试用期在桶 `test-vela-user-sites-1388575217` 里产生的 `sites/{siteID}/data/**` 对象已成孤儿。
清理只针对 `data/` 前缀，**不得触碰同一站点 `current/` 下的页面本体**。

## 7. 鉴权模型（可插拔）——当前不需要，保留供将来参考

**纯静态托管下这一节暂时用不上：站点内容公开可读，没有需要鉴权的写路径。**
下面的设计原本是为数据面准备的（第 6 节），一并保留，是因为数据面若将来带鉴权回归、
或接入方要求按登录态区分访问，这是现成的起点。**当前没有实现，也不需要实现。**

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
| 站点间的租户隔离（siteID 只由 Host 推导） | 我们 |
| 站点封禁、配额 | 我们 |
| 任何数据存储 | **无人负责——平台不提供，见第 6 节** |

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

需要单独产出一份《接入方对接文档》，内容就是本节。这份文档应该能让对方在不读我们代码的前提下完成接入，
同时必须明确写清：平台只提供静态托管，不提供任何数据存储。

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
- **能力边界改写为纯静态托管**：明确写清平台存不了任何数据
- **明确禁止用 localStorage 之类糊一个假的「能存数据」版本**，并给出可用的替代方案表
  （表单转第三方问卷、留言板转留联系方式等）。这条是重点：AI 很容易用 localStorage
  做出一个在自己浏览器里测试正常、发给别人却是空的留言板，用户要等数据丢了才发现
- 保留一期已加的三条：UI 设计决策前置、禁用 History 模式路由、重试上限

2026-08-06 上午曾按「有数据面」重写并下发过一版，当日随数据面移除一并回退；
当前的纯静态版本已下发到 6 台测试账号机器并逐台校验 md5 一致。

### 13.1 改名待办：接入正式分发通道时一并做

目录名 `cloudbase-site-builder` 已经不准确（底层早就不是 CloudBase），但**这一轮刻意不改**。

**为什么先不改**：机器侧 skill 是按**目录名**做主键的（`~/.hermes/skills/<dir>/`，配套
`.bundled_manifest` / `.curator_state`）。只改仓库目录名不会让机器上的旧目录消失，结果是
同一台机器上并存两份 SKILL.md，给 agent 灌两套互相矛盾的建站指令 —— 这个风险比名字不准更难受。
要干净改名，必须**同一批操作里**删掉旧目录，而当前 skill 是人工下发的，没有能保证「新增 + 删除」
原子完成的通道。

**什么时候改**：等这个 skill 接入正式分发通道（镜像内置 bundle 或 SkillHub 注册表）之后，
借那次分发把改名一次做完。届时需要同步修改的清单：

| # | 位置 | 动作 |
|---|---|---|
| 1 | `.agents/skills/cloudbase-site-builder/` | 目录改名为 `vela-site-builder`（建议名） |
| 2 | 同目录 `SKILL.md` frontmatter `name:` | 改成与目录名一致（两者不一致会让 Hermes CLI 输出对不上） |
| 3 | `.agents/skills/README.md` | 更新索引条目，并去掉「目录名待重命名」的备注 |
| 4 | 各测试/生产机器 `~/.hermes/skills/` | **先装新目录、再删旧目录**，确保不留两份；旧目录下的 `SKILL.md.bak-*` 一并清掉 |
| 5 | `hermes_cli curator pin` | 对新目录名重新 pin（pin 也是按目录名记的，改名后旧 pin 失效） |
| 6 | SkillHub 注册表 | 若届时已注册，同步改 slug 或走「新建 + 下架旧条目」 |
| 7 | 本文件 + `docs/handover/2026-08-06-cos-site-gateway-test-guide.md` | 更新所有引用旧目录名的地方 |

**注意**：前端 Skills 页面（`/agents/skills/`）取的是 SkillHub 注册表，不是本仓库目录，
所以只改仓库不会影响页面；反过来，改名如果不同步 SkillHub，页面上会出现条目消失或重复。

## 14. 分期与未决问题

**分期**

| 阶段 | 内容 | 产出判定 |
|---|---|---|
| P0 | site-gateway 静态回源 + 泛域名（子域名模式）；deployer 换桶 | 建站后子域名可访问 |
| ~~P1~~ | ~~数据面 API（anonymous）+ 配额限流~~ | **已实现并验证通过，2026-08-06 随产品收缩为纯静态而整体移除，见第 6 节** |
| P2 | 自定义域名绑定 + 接入方对接文档 | 对方能按文档独立接入，不需要我们改代码 |
| P3 | 内容审核 + 封禁通道 + Skill 改造 + 生产上线 | — |

工作量等方案定稿后再估。

**需要验证的技术点**

1. 单桶的对象数量和 QPS 上限，以及是否需要按站点分桶。
2. COS 数据万象内容审核的接入方式、成本和延迟。

（原第 1、4 项都是数据面的技术点，随数据面移除一并作废：`If-Match` 条件写的支持程度已验证
为不支持；ListObjects 在单 collection 上万文档时的延迟不再需要测。）

**已定决策**

- 单桶，按 `sites/{siteID}/` 前缀分租户。
- 同主账号 + 独立桶（方案 A）；桶级被封导致全体用户站点受影响，是已接受的风险。
- 根域新申请，不复用 lightvela 现有域名；代码全部走配置。
- 自定义域名场景下 TLS 与备案由接入方负责。

**发布时的放量确认（不是迁移本身的风险）**

000034 / 000036 / 000042 会给全部 7 个套餐（启航 1 站点、巡游 3 站点、AI 3 站点）写入 `bundle.static_site_quota`。这是**套餐定义**，不是用户配额——用户的 `user_resource_quota` 行由 `GetCapability` 的 `ensureQuotaInitialized` 懒加载生成。

所以单独执行迁移不会给任何用户开通什么：生产 ctl 跑的是旧镜像，没有 website 路由和 COS 配置；生产前端构建自 master，也没有入口。**真正的放量发生在合入 master 并部署 ctl / workers / 前端那一刻**，届时这 7 个套餐的用户会同时获得建站能力。这是发布日需要产品确认的一项，不是迁移执行时的隐患；如果需要灰度，再考虑把配额写入拆成可单独控制时机的迁移。

已实测确认（只读）：上海生产的 `schema_migrations` 是干净的单行 `version=27, dirty=0`，库里 14 张表、无任何 `website_*` 表、无 `bundle.static_site_quota`、`WEBSITE_STATIC_SITE` 配额 0 行。000028–000047 从未在生产执行过，逐条核对后判断整串可以成功跑完；000046 的跨表 JOIN 在生产两侧排序规则不同（`utf8mb4_unicode_ci` vs `utf8mb4_0900_ai_ci`），但迁移里显式 pin 了 `COLLATE utf8mb4_unicode_ci`，不依赖库默认值，防护有效。

**北京测试环境的迁移记账已损坏，不代表生产。** 库里留着 `schema_migrations_backup_20260805_ci_fix`（内含 34–38 五行），说明记账曾被人工备份后重写为 27；`website_usage_daily` 的建表时间（7-31）早于迁移文件首次提交（8-4）；库里还有迁移文件里根本不存在的列和索引（`current_generation`、`generation`、`attempt_count`、`idx_website_operations_lease`，且 `lease_token` 可空）。成因是一个后来被废弃重写的实现曾在该环境真实落表。因此该环境当前 `migrate up` 会在 000028 撞重复列失败，且结构与生产存在漂移——**上生产前应在测试环境完整演练一遍这串迁移**，否则演练结果不可信。

**已知缺口：站点的隔离/销毁并非与实例严格同时**

站点的 pass 钩子确实接进了 ctl 内部的 pass 隔离/销毁父 task（不是假联动），但接的位置是 best-effort 尾巴，不在事务内。已实测确认（只读代码追踪）：

- **隔离**：`isolate_task.go` 里先派发实例子 task 并**等待全部到达终态**（子 task 重试窗口约 1 小时），之后才调站点钩子。所以站点下线严格滞后于机器，正常几十秒、异常可达小时级，期间过期用户的站点仍对外可访问。实例隔离一直失败时，站点钩子根本不会被调用；站点钩子自身失败只打 Warn 后进终态，不重试、不阻断，属永久不一致。
- **销毁**：`destroy_task.go` 里实例被立即摘离用户并置 Deleted（不等子 task），站点删除只是写一行 `website_operations` + Redis 通知，由 worker 异步执行。队列有 DB 兜底轮询，worker 宕机只会推迟不会丢——**前提是 operation 行已建出**。

会导致永久残留（真实 COS 成本）的分支：销毁父 task 的两处防御性 `markSuccess`（pass 不在表、状态非 terminating）会完全跳过站点钩子；单站点删除失败只打 Warn 不重试，且已处于 `deleting` 的站点会被判 NotFound 跳过（含上一轮已 `dead` 的）；操作重试 10 次转 `dead` 后需人工调 revive 接口。另有契约硬截断：`pass_hook` 固定只取第一页 1000 条站点。

**决策**：隔离侧接受现状不做兜底（后果仅为站点多在线一段时间）。销毁侧不做自动清理任务，但**必须补可观测**——`dead` operation 数、`deleting` 超期站点数的指标与告警，把「永久泄漏且无人知晓」变成「分钟级告警 + 一次 revive 修复」。自动清理本身有误删用户数据的风险，且当前连泄漏量级都未知，先量化再决定是否投入。

**需要产品/业务确认**

1. 新根域申请进度，以及泛域名证书方案。
2. 内容审核深度：全量还是抽样。
3. 是否接受「收到腾讯云第一次违规警告即启动迁独立主账号评估」这个触发条件。
4. 与国内站接入方对齐第 8 节的分工表，特别是 TLS 和备案的归属。
5. 纯静态托管下，用户要「留言板 / 表单收集」这类需求时的官方口径：是长期不做，
   还是等鉴权就位后按第 6 节的恢复条件重新评估。当前 Skill 一律按「不支持 + 给替代方案」处理。

（原第 4、5 项「数据面给哪些套餐」「站点数据总量算不算 `StorageBytes`」随数据面移除作废；
静态制品体积仍然计入 `StorageBytes`。）

**已知会撞上的边界**

纯静态托管下这一节原有的两段（ListObjects 列表倒序成本、用对象存储模拟文档数据库的
无索引/无事务）都属于数据面，已随数据面移除一并作废，不再是本方案的边界。

当前剩下的边界只有静态托管本身：没有 SPA 的 index.html 全局兜底（刻意的，见
`internal/objectkey`），所以站点必须用 hash 路由或真实 `.html` 文件；重新发布是原地覆盖
`current/`，HTML 因此强制 `no-cache` 回源校验。
