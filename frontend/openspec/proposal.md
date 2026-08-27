# 国际站西语端到端上线 Proposal
# DeepSeek Harness 真实接入 Proposal

**状态：** npm-only 六插件方案已通过本地验证与用户授权 Ubuntu 24.04 主机的首次安装、同快照重装和服务健康复验；仓库安装器已与 COS 对象逐字节对齐并通过发布一致性门禁；北京 Hermes Sandbox 与 TAT 链路仍待复验。

## 背景与目标

在现有独立“实验室 > DeepSeek Harness”能力页基础上，接入真实实例状态、幂等安装、重启、确认后修复、实例专属 WebUI 访问和页面内模型供应商配置。配置卡片采用“已配置列表 + 单项展开编辑 + 完整白名单配置区”，支持 API Key 新增、覆盖修改和删除。保存期间锁定配置交互并等待 `debug/exec` 返回，结果通过顶部居中 Toast 即时反馈。DSH 与 Hermes 运行在同一台实例、同一 `agentuser` 环境中，但使用独立版本目录、`DSH_HOME` 和系统级 `deepseek-harness.service`；DSH 依赖不写入 Hermes runtime 包树，安装任务使用固定 pnpm 版本且不修改实例全局 pnpm。

## 范围

- frontend 复用 `BotRepository.execDebugCommand`，经现有 `/v1/instances/:id/debug/exec` 完成状态、安装、任务查询、重启和模型配置。
- 用户点击安装后，前端经 `debug/exec` 下发固定的 `systemd-run` 命令，由实例从 `https://vela-installer-1388575217.cos.accelerate.myqcloud.com/dsh/install-deepseek-harness.sh` 下载完整单文件安装器；wrapper 校验构建期从仓库安装器生成的 SHA-256 后才执行。依赖快照由脚本在实例内从 npm 解析，不依赖镜像预置安装器或前端安装 payload。
- 实时脚本在任务开始时从 npm 解析 DSH、SkillHub、QQBot、微信、企业微信、Lark 和钉钉的 `latest` 元数据，将精确版本与 integrity 固化为本次安装快照；SkillHub 与五个渠道插件全部验证成功后才允许任务完成。
- 模型供应商 helper 同样以内联脚本经 `debug/exec` 实时执行，不依赖实例预置文件。
- Provider helper 在实例回环访问 DSH 固定 RPC；WebUI 按当前 `botId` 跳转实例专属域名，国内站使用 `https://${botId}.dsh.lightvela.tech`，国际站使用 `https://${botId}.dsh.lightvela.site`。
- 国内站和国际站使用已确认的不同 Provider 白名单；DeepSeek 产品标识映射到 `deepseek-official`。
- 配置下拉始终展示当前站点完整 Provider 白名单；重复保存已配置 Provider 等价于覆盖更新。
- 配置保存使用同步 single-flight 锁，避免同一 React 提交批次内的重复点击发出多条凭据命令；DeepSeek Harness Logo 随前端静态资源发布，不依赖第三方图片域名。
- 已安装卡片提供“修复”操作。用户确认后，wrapper 原子隔离完整旧 Web profile，只将 `web/cordis.patch.yml` 带入干净 profile，再复用同一安装任务；模型配置、DSH settings 与 storage 保留，标准 WebUI 插件环境重装，用户自行安装的插件及 profile 自定义文件移除。
- 首批真实安装只进入北京 Sandbox；本需求不新增 service-gateway 路由。

## 非目标

- 不提供具体 model ID 选择、自定义 Provider、Base URL、协议或模型参数。
- 不公开实例 3080，不复用参考机的公网 IP/路径配置。
- 不把 API Key 明文写入 shell、URL、日志、埋点、localStorage 或后端业务数据库；实例通过首个 `debug/exec` 命令生成一次性 RSA 密钥，浏览器使用 RSA-OAEP 加密后，第二个命令只携带密文并在实例内经 stdin 解密。
- 不新增 DeepSeek Harness 专用 ctl、transport、errcode 或 service-gateway 接口。
- 不安装 `dsh-auth`、实例内 Caddy 或另一套 SkillHub CLI；WebUI 域名的代理与鉴权由独立基础设施承接，Hermes 已有工具和渠道插件保持不变。
- 本轮不改为镜像内离线预置，也不新增离线 runtime bundle；COS 只托管可独立运行的最新单文件安装器。

## 关键决策

- DSH、SkillHub 与五个渠道插件均请求 npm `@latest`；这是产品明确接受的可复现性取舍。每次任务先解析并校验 `version`、`dist.integrity` 和 HTTPS tarball，再以本次解析出的精确版本生成 package/lockfile，确保单次任务内部可复现，安装过程中不再次跟随 `latest`。
- DSH runtime 与 `web` profile 分别先生成 lockfile、再执行 `--frozen-lockfile` 安装；固定 `pnpm@10.33.0` 在候选阶段引导并于校验后持久化到 root-owned tooling，不替换实例全局 pnpm。LightVela 管理的六个 profile 插件均来自 npm registry，基础安装不依赖 GitHub；每个托管包的 registry integrity 均必须出现在对应 lockfile 中。
- 安装在 root-owned 任务目录完成下载、依赖安装和配置组合检查后再原子切换；已有 profile 的可变内容仅以 `agentuser` 身份复制，控制文件使用 no-follow 读取和原子重建；任一插件失败即恢复旧 runtime、完整旧 `web` profile 和旧 service unit。
- 已安装 profile 中由 SkillHub 管理的额外 DSH 插件，在依赖、bundle patch、workspace build policy 和编译产物通过校验后随 profile 保留。安装器迁移删除旧 Web profile 的 `pnpm.onlyBuiltDependencies`，避免与 SkillHub 在 pnpm 10.33 写入的 build policy 冲突；完整 profile 在停服后再次校验指纹，并发变化时不切换。
- 用户在确认弹窗中发起“修复”后，wrapper 先隔离完整旧 profile，以仅包含 `cordis.patch.yml` 的干净 profile 调用同一安装器 `install` action；任务失败时恢复完整旧 profile 和原服务状态，成功后才清理备份。
- COS 发布流水线逐字节比较远端对象与仓库安装器，SHA-256 不一致时阻止继续构建。
- 包名、版本、目录、用户、端口和 Provider 白名单由实例侧 helper 固定；前端只选择固定动作与白名单 Provider ID。
- API Key 使用实例一次性 RSA-4096 公钥与 RSA-OAEP/SHA-256 加密，密文经 `debug/exec` 传输，在实例内解密到 helper stdin 后由 DSH `credentials.set` 单向写入；生成私钥时同步创建 15 分钟 systemd 清理 timer，创建失败时立即删除，第二条命令退出时也会主动删除；设置写入携带 `expectedRevision`。
- 删除经同一 `debug/exec` 通道调用固定 `remove-provider` 动作；只清理可确认由 LightVela 创建且当前可写的凭据，环境变量密钥和自定义引用保持不变。
- WebUI 链接直接由现有 `botId` 生成，不新增 URL 查询接口：国内站 `https://${botId}.dsh.lightvela.tech`，国际站 `https://${botId}.dsh.lightvela.site`。
- 页面运行状态同时检查 systemd active、`NRestarts` 与 `127.0.0.1:3080` 回环 HTTP；active 但出现自动重启或 HTTP 不可达时展示“运行异常”，保留 WebUI 与重启操作。探测依赖 `curl` 缺失时状态命令整体失败，不把工具缺失误报为服务异常。所有 sudo 命令使用 `sudo -n`，权限错误不得回落为未安装；重启必须先确认 `debug/exec` 退出码为零，再刷新组合健康状态。

---

# Agent 人设 Markdown 上传 Proposal

**状态：** Task 1–8 已完成；双区域构建、浏览器验收与独立只读复审全部通过，等待提交审批。

**规模：** L。需求跨国际站公开页、路由、i18n、文档、SEO、字体和控制台多个业务模块，并包含灰度开放与双区域回归门禁。

**发布区域：** 仅国际站 `lightvela.ai`。国内站 `lightvela.com` 必须保持用户可见行为零变化。

## 背景

`jasminzhao-821-language` 已建立 locale 注册表、三语种字典骨架和翻译工具链，但 `es`、`ja-JP`、`ko-KR` 仍全部隐藏。合并最新 `master` 后，中文基准已从 2325 条变化为 2403 条，三份新字典各缺 85 个当前 key、残留 7 个旧 key；新校验器还暴露了既有占位符不一致。

本次只完成西语交付。日语和韩语保留注册但继续隐藏，避免扩大翻译、字体和内容范围。

## 目标

1. 在国际站开放 `/es`，使用户可从语言切换器进入并在刷新、站内跳转和文档跳转后保持西语。
2. 补齐国际站自有 UI 的西语字典，并让字典完整性、占位符、HTML 标签和换行结构通过构建门禁。
3. 为公开页、文档导航与 metadata、SEO、sitemap、canonical、hreflang、`html lang` 和 Open Graph locale 提供一致的西语输出。
4. 为西语扩展字符提供可靠字体回退，避免 `ñ/Ñ/¿/¡` 等字符显示为缺字方块。
5. 以编译期区域分支和负向测试证明国内站没有新增西语入口、路由或用户可见文案。

## 范围

### 本次包含

- 国际站 locale 注册表中的 `es` 正式启用；URL 前缀固定为 `/es`。
- 国际站语言切换器、初始 locale 解析、`localStorage('lw-locale')`、公开页与控制台站内跳转。
- 当前中文基准全部 2403 条国际站自有 UI 文案的西语字典对齐与翻译。
- 国际站公开页导航、页头、页脚、状态文案和控制台自有模块的西语覆盖。
- 文档侧栏分组、页面 title/description、搜索注册、manifest 与路由 metadata 的西语覆盖；正文继续回退英文。
- 公开页与文档页的 title、description、canonical、Open Graph、hreflang、`html lang` 和 sitemap。
- 西语字体回退与构建期字符覆盖检查。
- 国际站定向测试、完整构建和浏览器 smoke；国内站负向测试与构建回归。

### 本次不包含

- 国内站任何西语入口、locale 切换或内容变化。
- `ja-JP`、`ko-KR` 的翻译或开放。
- 三语种文档正文全量翻译；西语正文继续使用英文 fallback。
- 法务正文的西语翻译。
- `@tencent/tea-sdk-lightclaw` 内嵌区域的西语语言包；该区域允许沿用英文 fallback。
- Models 模块整体本地化、账号级语言同步、首次访问自动语言识别和控制台免刷新切换。
- 新后端接口、数据迁移或第三方翻译服务依赖。

## 方案比较

### 方案 A：注册表驱动，全部验证后统一开放（采用）

- 先同步字典基线与门禁，再补路由、切换器、SEO、文档和字体，最后翻译全量字典并打开开关。
- 优点：开发期间西语始终隐藏；所有链路在开放前一起验收，回滚只需关闭注册表入口。
- 代价：最后开放前没有用户可见的中间交付。

### 方案 B：翻译优先

- 先完成字典，再补静态站和路由。
- 优点：翻译进度直观。
- 缺点：`master` 新增文案会持续造成字典漂移，结构问题发现较晚。

### 方案 C：公开站与控制台分阶段开放

- 先开放营销页，再补控制台。
- 优点：可以较早发布公开页。
- 缺点：产生明显语言断层，不符合本次端到端完成口径。

## 主要设计

1. `locales.json` 继续作为 Node/TypeScript 共享数据真源；`locales.config.ts` 保留联合类型和穷举保护。
2. `es` 在实现期间保持 `switcherVisible: false`、`translationRequired: false`；字典、路由、Docs、SEO 与字体门禁通过后已一次性切为 `true`，日语和韩语保持 `false`。
3. 国际站语言切换器改为从注册表生成；国内站继续使用原有区域分支，不消费西语可见项。
4. 西语字典先与当前中文基准做 key 集合同步，再使用 `i18n-apply.mjs` 分批写入，禁止直接对 hash key 盲改；每批运行结构校验。
5. 文档不复制英文正文。西语 locale 使用既有 fallback source，只新增导航、分组、title/description、搜索和 metadata 所需配置。
6. SEO 输出必须保证 title、description、canonical 与 `og:url` 一致，且只为真实存在的 `/es` 页面输出 alternate。
7. 字体按西语 locale 使用拉丁系统字体回退，并区分“源字体无字形”和“subset 漏采集”两类构建错误。
8. 所有共享表改动都保留 `Record<Locale, T>` 穷举；禁止用三元 fallback 或 `startsWith` 猜测掩盖漏配。

## 依赖与风险

- 翻译质量需要统一采用自然的拉美西语表达；产品名、渠道名、模型名和命令保持原名。
- SDK 内嵌区域只有中英文包，本次明确接受英文 fallback。
- 文档正文回退英文必须在切换器与页面中可预期，不得错误回退中文。
- 现有 master 的 `{{discount}}` / `{{percent}}` 占位符不一致必须在本需求门禁中修正，否则 `pnpm check` 无法通过。
- 现有 `openspec/plan.md` 含其他历史未勾选项；本需求计划将置于文件顶部并明确为当前 active change，不删除历史记录。

## 用户验收标准

1. 国际站语言切换器显示 `Español`，选择后进入 `/es`，刷新和站内跳转后保持西语。
2. 国内站不显示西语选项，既有中文行为与构建产物无本需求引入的用户可见变化。
3. `es.json` 与当前中文基准 key 集完全一致，国际站自有 UI 无大段中文或英文残留；SDK 区域英文 fallback 除外。
4. `/es` 公开页和 `/es/docs/...` 可访问；文档导航与 metadata 为西语，正文稳定回退英文。
5. 西语页面的 title、description、canonical、Open Graph、hreflang、`html lang` 和 sitemap 相互一致。
6. 标题与正文中的 `ñ/Ñ/á/é/í/ó/ú/ü/¿/¡` 无缺字方块。
7. locale、字典、公开站、文档、SEO、字体和区域隔离测试通过。
8. `pnpm check`、分别以 `NEXT_PUBLIC_REGION=global VITE_REGION=global` 与 `NEXT_PUBLIC_REGION=cn VITE_REGION=cn` 执行的 `pnpm build`，以及 `git diff --check` 通过。

---

# 国际站西语代码可控内容全面收口（增量提案）

**确认日期：** 2026-08-24

**目标区域：** 仅国际站 `lightvela.ai` 的 `es` locale。国内站用户可见行为必须保持不变。

## 背景

首轮西语上线已经覆盖公开路由、基础 UI 字典、Docs 导航与 metadata、SEO、字体、套餐选择、国际支付成功态和部分 Agent provider locale。残留审计仍发现产品壳 metadata、内置人设与测试内容、curated Skills 内容、AgentChat/内嵌面板 locale、日期格式和本地开发态 `html lang` 存在英语或中文回退。

用户确认将本轮目标收紧为：除 Docs 正文和法务正文外，全部代码可控的第一方内容都必须适配西语。截图内烘焙文字和第三方托管页采用分批方案，本轮不阻塞代码侧收口。

## 本轮包含

1. 国际站产品壳的浏览器标题、页面 metadata 和无 locale 前缀控制台页面标题。
2. 第一方 UI 的按钮、提示、空状态、错误、辅助说明和无障碍标签。
3. 第一方内置人设、测试题、推荐内容及 curated Skills 的结构化西语数据。
4. AgentChat 与内嵌面板的公开 locale 接口适配；若当前消费包缺少 `es`，必须在真实源包或公开接口层修复，不在宿主页面复制或临时 patch 内部配置。
5. 成就、活动等第一方时间展示使用西语 `Intl` locale。
6. 本地开发态和生产静态产物中的 `/es` 页面统一输出 `html lang="es"`。
7. 覆盖公开页、账户、套餐、Agent 各板块和内置内容的残留审计、自动测试与浏览器验收。

## 明确排除

- Docs 正文；导航、搜索、页面壳和 metadata 仍必须为西语。
- 隐私政策、服务条款、Cookie 政策和开源声明的法务正文；标题、提示、导航和页面壳仍必须为西语。
- 更新日志、教程或产品截图中已经烘焙进图片的英文，单独进入后续图片资产批次。
- 第三方支付绑卡等托管页；本地发起页、跳转前后提示和错误文案仍必须为西语。
- 用户输入、实例返回内容、第三方动态数据，以及品牌名、模型名、协议名、代码、命令和文件名。

## 采用方案

采用“模块化西语数据 + 统一 locale 映射”：普通界面沿用中文原文 `useT()` key；结构化内置数据为现有 locale map 增加显式 `es` 分支；日期、文档语言和外部组件 locale 统一通过经过测试的 helper 映射。禁止运行时机器翻译，禁止用 `es -> en` 静默 fallback 掩盖第一方缺失。

## 完成定义

1. 除明确排除项外，国际站西语路由和登录后产品壳不再出现第一方中文或英文回退。
2. 所有新增或修改行为都先有能稳定失败的回归测试，再做最小实现。
3. 西语字典保持全量、占位符一致、0 error、0 warning。
4. 国际站与国内站定向测试、`pnpm check`、`pnpm build:global`、`pnpm build:cn` 和 `git diff --check` 通过。
5. 浏览器验收覆盖公开页、产品壳和可到达的 Agent 板块；登录态不可得的页面使用组件级行为测试兜底，不把登录门禁当作功能验收通过。

---

# 国际站西语 Docs 正文全量适配（增量提案）

**确认日期：** 2026-08-26
**目标区域：** 仅国际站 `lightvela.ai/es/docs/**`

用户已解除上一轮对 Docs 正文的排除，要求在不修改图片的前提下完成全部国际站文档正文西语适配。当前 61 篇西语 Docs 仅有西语导航与 metadata，正文通过 `en/` 回退英文。

采用显式 `src/content/docs/es/**` 源文件方案，按工具型文档 28 篇、Use Cases 16 篇、Compare 与 Hermes Agent Deep Dive 17 篇分三批完成。最终移除西语正文的英文/中文 fallback；不修改英文、中文、国内站、法务正文或图片资源。

完成条件是 61 篇路径对等、正文源均为 `es/**`、图片目标和代码块保持、内部链接落到 `/es/docs/**`，并通过 Docs 同步、parity、图片、last-updated、类型和 diff 门禁。

---

# 国内建站临时分享码 Proposal

**状态：** 用户于 2026-08-27 批准从 MySQL 持久化方案改为 Redis 临时分享并授权后端实现；前端管理 UI 后续移交前端同学，本次不包含生产发布或 GitOps 变更。

## 背景与目标

国内 `site-gateway` 当前在 `required` 模式下只允许站点所有者通过 OIDC 访问。分享需求的产品语义是“临时开放 1 天、7 天或 30 天”，到期自动恢复仅所有者访问，而不是为站点永久保存一份分享策略。

目标是在不改变国际站 `public` 行为、不复制 COS 回源链路的前提下，让所有者选择有效期并生成一次性可见的分享码；Redis TTL 是临时分享状态的唯一真源。

## 范围

- 撤销本功能新增的 `website_sites` 字段与 `000029` migration，不在 MySQL 保存分享策略、摘要或版本。
- CTL 在 Redis 保存 bcrypt 分享码摘要、随机 `generation` 和绝对到期时间，TTL 只允许 1/7/30 天。
- CTL 提供所有者开启/停止、重置和内部校验接口；重置保留原绝对到期时间，停止分享直接删除 Redis key。
- CTL 继续使用 Redis 对分享码尝试做站点全局与站点+客户端 IP 的分布式限制。
- site-gateway 在国内 `required` 模式下使用 `generation + expires_at` 校验分享会话；自动到期不能被站点元数据缓存延长。
- 前端管理入口、工作台分享按钮、Dialog、测试与 i18n 资源不在本分支实现，后续按接口契约由前端同学接入。
- 增加 CTL 与 site-gateway 聚焦测试，并运行 Go 和差异门禁。

## 非目标

- 不修改国际站 `SITE_GATEWAY_AUTH_MODE=public` 的公开访问行为。
- 不新增 DNS、证书、域名、独立分享服务或带签名分享 URL。
- 不把明文分享码写入 MySQL、Redis、日志、URL、localStorage 或可持久化前端状态。
- 不保存永久分享历史、访问者列表、审计记录或找回旧分享码能力。
- 不执行生产 Redis/数据库操作、镜像构建、GitOps promote、Argo 同步或真实环境发布。
- 不修改国内工作台路由、菜单、页面样式或管理交互。

## 方案与取舍

采用“Redis 临时状态 + site-gateway 门禁”：Redis key 的存在表示分享有效，TTL 到期即恢复 `owner_only`；gateway 继续作为静态内容唯一入口，复用现有 Owner OIDC 和 COS 回源。

- 不再采用 MySQL 持久化：1/7/30 天分享是有明确生命周期的临时凭证，DB 字段和 migration 会把临时状态错误建模成站点永久属性。
- 不只信任签名 Cookie：停止或重置后必须废除旧会话，因此 Redis 状态包含随机 `generation`，Cookie 必须与当前 generation 匹配。
- 不采用带签名分享 URL：链接泄露即可绕过输入，并可能进入历史记录、Referer 和日志。
- 不保存 Redis 明文：6 位码仍只保存 bcrypt hash；Redis dump 或只读泄露不应直接得到可用分享码。

## 用户验收标准

1. Redis key 缺失、过期、损坏或不可读时按 `owner_only`；国际站 public 模式行为不变。
2. 所有者可选择 1 天、7 天或 30 天开启分享，拿到一次性 6 位无歧义分享码，并看到准确到期时间。
3. `PUT .../access` 仅接受 `duration_days=1|7|30`；停止分享删除 key；重置生成新码和新 generation，但保留原绝对到期时间。
4. 访客输入正确分享码后获得 Host-only 安全 Cookie；Cookie 的到期时间不晚于分享状态的 `expires_at`。
5. Cookie 绑定 site、host 和 generation；重置/停止后旧 Cookie 最多在现有 30 秒元数据缓存收敛后失效，自动到期不额外延迟。
6. Redis 写入、校验或状态损坏时访客不得绕过；所有者 OIDC 仍然可用。
7. 分享码尝试受站点+IP 5 次/10 分钟与站点全局 50 次/10 分钟限制；真实 IP 只接受显式配置的受信代理头。
8. 前端接入时先选择“使用分享码访问”再展示 1/7/30 天，并用单个按钮复制包含说明、地址、分享码和有效期的完整分享信息；该 UI 不在本分支实现。
9. CTL/site-gateway 聚焦测试和 `git diff --check` 给出最新命令证据；真实 Redis 和线上请求未执行时必须明确标注。
