# 站点与环境路由领域

Pass 升配微信桥通过精确的 `POST /v1/passes/{pass_id}/modify/order-url` 可选认证入口转交 CTL 验证短期票据；modify 桥接请求不附带另一浏览器用户的 Bearer/cookie。建单、恢复订单和重签票据仍要求登录，不能扩大到整个 Pass 路由。前端 API 和扫码域名必须属于同一目标测试环境。

本领域覆盖国内/国际站、域名、locale、区域功能差异、环境 inventory 和对应 GitOps overlay。

## 隔离开发预览

Next 开发预览的临时域名由本地服务通过 `NEXT_DEV_ALLOWED_ORIGINS`（逗号分隔主机名）显式加入 `allowedDevOrigins`，避免隧道上的热更新连接被拒绝；该增量只在 development 生效，不进入生产配置。认证 API 可使用现有 `NEXT_PUBLIC_AUTH_API_BASE_URL=local-proxy` 与所属站点的 `NEXT_PUBLIC_LOCAL_PROXY_TARGET` 同源代理，避免浏览器直接跨域请求未放行的临时域名。预览不能以测试身份覆盖正常认证；未登录入口与真实账号功能链路分别验收。

## 管理后台内部服务路由

- Gateway Dashboard 的积分包管理页通过同源 `/admin/api/credit/*` 访问服务端 BFF；浏览器不直连 Credit，也不接触内部凭据。
- BFF 将该路径映射到当前环境 Credit 的 `/internal/credit/admin/*`，先校验 Dashboard 管理登录态，再注入仅服务端可见的 `CREDIT_INTERNAL_TOKEN`。
- `CREDIT_API_URL` 必须指向同环境 Credit Service：共享命名空间环境使用 `http://credit.credit.svc.cluster.local`，隔离 playground 使用该环境的完整 Service DNS；未部署 Credit 的环境显式留空并返回配置错误，不能跨环境回退。
- `CREDIT_INTERNAL_TOKEN` 必须通过 `gateway-dashboard-runtime-secrets` 注入，并与目标 Credit 的 `LIGHTCLAW_INTERNAL_SERVICE_TOKEN` 一致；不得放入 ConfigMap、前端构建变量或浏览器请求。
- 认证用户页的影子账号视图同样只通过 `/admin/api/shadow/*` 访问 Dashboard BFF；BFF 将请求映射到同环境 Shadow 的 `/internal/shadow/admin/*`，并在校验 Dashboard 管理登录态后注入 `SHADOW_INTERNAL_TOKEN`。
- `SHADOW_API_URL` 必须指向同环境 Shadow Service，标准集群内地址为 `http://shadow.shadow.svc.cluster.local`。未部署 Shadow 的环境保持未配置并明确返回配置错误，不允许跨环境读取影子账号。
- `SHADOW_INTERNAL_TOKEN` 只通过 Shadow 与 Dashboard 各自的 runtime secret 注入，两端值必须一致；不得复用外部 callback token，也不得进入 ConfigMap、前端构建变量或浏览器请求。

## 稳定身份

问卷反馈通过国内 `/support` 与国际本地化 `/[lang]/support` 进入，登录用户头像菜单的“用户反馈”指向站内问卷；既有腾讯问卷入口继续保留。提交使用所属站点 API 的 `/support/feedback/submit` multipart 接口，用户身份由服务端认证获取。运营后台经 BFF 访问 ticket，按 `site=cn|global` 筛选并下载 MySQL 附件。Whistle 代理站点域名时，OAuth start 使用对应 API 域名以匹配回调 Cookie 域。

- 国内生产：`lightvela.com`
- 国际生产：`lightvela.ai`
- 源码分支：`master`
- deploy-facing 分支：`gitops`

环境名称、集群地址、账号和当前 revision 会变化，必须从 `infra_pulumi` inventory、GitOps/Argo 和实时查询重新确认，不能从旧截图或文件名推断。

## 责任边界

| 层 | 权威 |
|---|---|
| 前端站点/locale 行为 | `frontend/src/lib/public-site-routing.ts` 与前端测试 |
| 公共 API 路由 | `service-gateway` 路由代码和测试 |
| 环境非敏感事实 | `infra_pulumi/envs/tencentcloud/<env>/inventory.yaml` |
| 部署期望 | `argocd/apps/<env>/`、`argocd/services/*/<env>/` |
| 真实运行 | Argo、集群、域名与浏览器 E2E 的现场证据 |

国内站与国际站共用的前端组件视觉规范由 [Frontend Design Notes](../../../frontend/DESIGN.md) 维护；同类组件在两站使用一致的圆角规则，区域差异需有明确的设计依据。

国内站与国际站复用定时任务卡片操作界面：横向省略号在桌面悬停、点击、移动端点按或键盘激活后显示纵向的图标与本地化操作名称列表；两站沿用相同任务状态门控，文案由各自 locale 提供。

OpenCraft iOS 的内置 Bot DOM runtime 同时包含国内与国际的 frontend 组件，但区域不是从生成物的构建环境推断。原生登录会话选择 `cn` 或 `intl` 后，在 DOM 脚本运行前显式设置 frontend 的 region、对应的 `api.lightvela.com` 或 `api.lightvela.ai` API base、站点 base 和 locale；Bot 仓储请求沿用 frontend 的现有实现，不跨区回退。站点账号与订阅网页只在匹配会话区域的第一方 WebView 打开。真机需分别核对两区的 DOM origin 和 API 请求；本地 HTML 打包成功不能证明跨域请求已通过。

## 产品文档区域

国际站马来语使用 `ms-MY`（Bahasa Melayu），公开路径前缀为 `/ms-my/`，语言注册表 `frontend/src/i18n/locales.json` 同时控制语言切换与公开发布。马来语文档以 `src/content/docs/ms/` 为独立源，覆盖国际站英文文档清单，不跨区域或语言回退；标题、简介与分类来自同目录 `metadata.json`，生成 `/ms-my/docs/` 页面与独立搜索索引。国内站不生成马来语公开页面。

马来语主界面字典按需装载。公共结构化文案仅收录实际消费的英文文本，保留字段绑定、内部标识和链接值；字典读取只允许自身键，避免把对象原型属性当作译文。产品对话使用嵌入式 OpenCraft 工作台，`opencraft/apps/workbench-web/src/i18n/catalogs.ts` 的 embeddedLocaleCatalogs 注册 `ms-MY`，宿主语言更新由 WorkbenchLocaleController 消费；独立 OpenCraft 的语言列表仍由独立目录管理。马来语工作台目录须通过 ICU 参数和完整条目检查。兼容 AgentChat SDK 的入口使用独立 i18next 26 运行时，`src/i18n/agentchat-locale.ts` 在面板挂载前加载 `agentchat-ms-MY.json` 并设置语言；宿主 i18next 23 不替代 SDK 的实例。SDK 升级时须同时核对所依赖的 i18next 版本与新增翻译条目。

首页结构仍由英文静态片段维护，`scripts/generate-malay-home.mjs` 配合已提交 `copy.ms-MY.json` 生成马来语片段，缺少译文会明确失败；首页导入流程包含该步骤。静态文字、无障碍属性及动态聊天/轮播数据均使用马来语；公开页面链接使用 `/ms-my/` 前缀，受保护的 `/agents` 产品路径保留原地址。

`frontend/src/content/docs/` 保留 cn/global/en/id 源；生成的 zh-cn/zh-sg/en-us/zh-hant/id-id 输出不直接编辑。区域差异必须通过 parity 测试和真实路由共同证明。

跨区域产品定义文案使用“云端 AI Agent 产品”及对应语言表达；部署与运行的云端托管能力仍按功能事实描述。

国内站 overview 的产品简介以个人 AI 助理与伙伴、云端独立运行及 7×24 小时在线为主；Hermes Agent 是当前 Agent 的实现基础，不作为 LightVela 的产品名称。

国内站文档的产品阶段口径与同区域 `llms.txt` 事实摘要保持一致。已开放订阅后，概览和套餐说明不再展示产品级公测提示；首购活动及价格以订阅页为准。单项功能的 Beta 标记仍按实际产品入口核对。

国际站文档的英文、简体中文、印尼语、西语、日语和韩语源文件不再把整站公测转段或内测延期权益描述为当前状态；生成的繁体中文版本随简体中文源同步。套餐与首购活动以国际站订阅页为准，`announcements/public-beta` 保留源稿并按下述暂时下线策略移除公开路由。单项功能的 Beta 标记及第三方产品的阶段描述按各自事实核对。

国内站新增配置指南时，`frontend/src/config/docs-sidebar.ts` 中的 `CN_SIDEBAR`、`CN_SLUG_TO_FILE` 与 `frontend/scripts/sync-fumadocs-content.mjs` 中的 `cnDocs` 必须同时注册同一 slug。钉钉指南使用 `configuration/channel-dingtalk`，仅进入国内站目录；国际站目录与映射单独维护。

国内站任务文档导航按“开始使用 → Bot 与模型 → 通道与技能 → 自动化与资料 → 管理与排障 → 实验功能”组织，场景、对比和 Hermes 原理长文继续保留独立分类。分组标题与组内顺序必须在 `CN_SIDEBAR`、`cnDocs` 和 `CN_GROUP_ORDER` 中一致；原有 slug 保持稳定。网页对话支持主 Bot 和额外 Bot，额外 Bot 创建受运行时多 Bot 开关与套餐额度约束；实验功能的 Beta 标记属于单项功能。云存储保留 `/agents/files` 路由，当前控制台侧栏没有独立菜单项，文档应提供直接入口。

## 官网首页展示产物

- 双站首页的试用展示统一为「新用户免费体验1个月，送4500 AI 积分」，用一条文案表达，不分列标准版和 AI 积分版；静态多语言片段、导入脚本、共用页脚和 `llms.txt` 摘要同步维护。前端文案不决定实际权益期限，权益仍由服务端执行。

- 国内站与国际站共享同一组 LightVela favicon 资源与浏览器页签品牌形象；`layout.next.tsx` 的 icon/shortcut/apple 声明和 `manifest.webmanifest` 必须引用同一版本化 URL。图标内容更新时应同步更换版本标识，避免任一生产域名继续命中旧 favicon 缓存。
- 国内站与国际站根路由分别以默认 `zh-CN` / `en-US` locale 直接渲染 `InternationalHomePage` 的已提交静态片段，不再静态引入旧 `PublicHomePage`；带 locale 的路由仍保留 V2 选择与旧页面 fallback。
- 国际站首页使用 `frontend/scripts/import-international-homepage.mjs` 维护导入与本地化规则，运行时消费 `frontend/public/lightvela-intl-home/index-fragment*.html` 中已提交的多语言静态片段。
- 国际站首页文案或结构变更必须同步导入脚本、所有开放 locale 的静态片段与 `international-home-page` 聚焦测试；不得只修改默认英文片段。
- 国际站英文首页主标语使用 `Your AI companion—always on, always evolving with you.`，明确表达云端 Agent 始终在线并持续成长；其他 locale 保留各自自然的同义表达。
- 首页“始终在线”能力卡在英文正文中明确使用 `24/7`，并在所有开放 locale 中使用自然的全天候表达；图文共同说明云端运行无需用户电脑持续开机。
- 国际站首页 `Memory` / `User Profile` 能力条在中等视口下必须把文案与图标约束在各自半区内：描述允许按可用宽度省略，图标保持固定尺寸，中间斜切不得遮挡标签。
- 国际站首页页脚“相关产品”按 `Tencent EdgeOne`、`Tencent CloudBase` 的顺序展示；所有开放 locale 共用该顺序，但保留各自本地化名称。
- 国际站首页页脚 Community 优先展示 `X / Twitter`，其后依次为 `Discord`、`WhatsApp`、`YouTube`；所有开放 locale 共用该顺序。
- 国内站与国际站共享产品名时仍属于两套展示产物，验证时应分别启动对应区域构建或预览，不能用单站截图替代双站边界确认。
- 国内站与国际站首页在登录态均显示直达 `/agents` 的本地化产品入口；国际站新版首页由 `InternationalHomeRuntime` 显式开启该入口，同时保留未登录态仅展示语言切换与登录动作的 `loginOnly` 规则。
- 首页顶部产品入口与头像菜单“我的智能体伙伴”共用资格判断：会话和套餐状态确认后，已有有效或历史套餐的用户无需等待 Bot 列表即可看到入口；仅靠现存 Bot 证明资格的用户需等待列表成功返回。权益未确认或失败、没有任何资格的账号继续隐藏入口。已确认有套餐资格而 Bot 列表失败时仍显示入口，由 `/agents` 展示错误和重试操作；入口仍由该页面自身门禁保护。
- 国内站 V2 首页不使用国际站的 `loginOnly` 规则：未登录 Header 与 Hero 展示“免费试用”并进入 `/subscribe`，登录态 Header 与 Hero 展示“开始使用”并进入 `/agents`；静态 Hero 默认输出未登录态，认证恢复后再同步登录态入口。
- 国内站与国际站 `/subscribe` 的未登录 Header 统一启用 `loginOnly`：隐藏创建入口，仅保留登录主动作（国际站同时保留语言切换）；套餐卡“立即订阅”继续承担转化并触发登录。
- 根首页的初始 HTML、Flight、Next 脚本数量与 raw/gzip 体积由 `pnpm check:homepage-performance` 对真实 `out/index.html` 执行预算检查，同时拒绝旧 `PublicHomePage` / `LandingPageView` chunk 回流；国内与国际构建仍须分别验证，预算通过不能替代浏览器回归或线上 Web Vitals。

## 公开营销页区域边界

- 国内站和国际站可复用同一套公开营销页组件或静态 fragment，但必须在 `frontend/next-site/international-home-routing.ts`、`frontend/src/app/(site)/page.next.tsx` 和对应测试里显式区分站点入口、locale、CTA、文档链接和合规页脚。
- 国内站 `lightvela.com/` 默认使用国内语境的 `zh-CN` 首页内容；可以复用国际站中文版的视觉结构，但链接必须落到国内裸路径，不输出国际站 locale 前缀或海外渠道主入口。
- 国际站 `lightvela.ai/` 负责默认英文和多语言公开首页；权益文案、AI companion 语境和静态图片资源需要按 locale 同步验证，不能只改默认英文。
- 国际站裸首页维持英文静态内容与现有 canonical。仅在首次访问、此前未明确选择语言且浏览器首选语言匹配已发布的非英文 locale 时，客户端以目标语言展示一次切换建议；提示已展示状态保存在浏览器，选择语言后进入对应国际站公开 URL，继续英文则保存英文选择。任何裸英文公开页为控制台语言连续性自动写入的默认英文都不算明确选择；手动切换与带语言前缀的 URL 会单独记录明确语言意图。旧存储中的非英文选择继续优先；无法辨认来源的旧版英文记录可能再收到一次建议。国内站和登录后路径不展示此建议。无痕模式关闭后可重新出现。
- 国际站首页各语言静态 fragment 与共享 Footer 恢复 Blog 入口，链接跟随界面语言；国内站继续隐藏导流入口。当前活跃文章仅包含 2026-09-28 用户提供的三篇中文和一篇英文，旧稿保存在归档模块；被替换的相同 slug 展示新稿，其余旧 slug 返回 404，并从 sitemap 与 llms.txt 移除。四篇文章现均提供完整中文（简体与繁体）、英文、印尼语、西班牙语、日语、韩语版本：国内站默认中文、国际站默认英文，国际站任一已发布语言的标题、摘要、正文与社群引导均同步切换，配图保持原语言。国际站英文文章 canonical 使用裸路径，其他语言分别使用 /zh-sg、/zh-hant、/id-id、/es、/ja-jp、/ko-kr 前缀；文章 hreflang 与 sitemap 登记国内 zh-CN 及国际站全部七种语言版本，列表继续声明界面语言。文末统一按站点展示微信或 Discord / WhatsApp 入群方式；试用链接去除追踪参数并指向当前站点首页，分享链接使用当前站点域名。缺失封面或正文图片允许留空。
- 双站 `announcements/public-beta` 以及国际站 `use-cases/telegram-whatsapp-safety-boundaries`、`use-cases/lifelike-im-agent-rhythm-social-memory`、`use-cases/im-agent-skill-scenarios`、`use-cases/whatsapp-24-7-customer-service` 暂时下线但保留源稿。下线需同时移除 sidebar、slug 映射与 Fumadocs 注册，并重新生成 route manifest、搜索与公开索引；旧 URL 返回 404，不跨语言回退，公开正文不得继续链接到这些页面。恢复时重新评审源稿并成套恢复注册和链接。
- 首页静态 fragment 的链接、图片版本参数、合规信息和客户端演示外壳属于站点路由责任面；修改后必须同步更新正式设计文档，并用静态链接检查、前端测试和本地/预览环境证明没有跨站点串链。

## 双站浏览器标题

国际站英文首页 `/` 与智能体入口 `/agents/`（含其产品路由）统一显示 `My AI Companion | LightVela`。内嵌 OpenCraft 只呈现对话内容，不写入宿主页面的 `document.title`；独立 OpenCraft Web/Electron 仍由自身 Shell 管理标题。

国内站首页 `/` 与智能体入口 `/agents/` 统一显示 `我的智能体伙伴 | LightVela`；首页的 Next metadata 和客户端 SEO 标题数据保持一致。其他语言继续沿用各自的本地化标题。

## 订阅页交互边界

- 国内站与国际站复用套餐卡的可购买状态。已有权益或 Agent 导致新购 CTA 锁定时，按钮保持禁用，并通过可悬停、可键盘聚焦的 Tooltip 解释已有套餐状态；后端确认的升级目标保持可用，售罄、即将上线、询价中和暂无报价继续由按钮自身文案说明，不叠加冲突提示。

## Agent 人设展示区域边界

- 国内站与国际站的推荐人设注入摘要复用同一状态逻辑：以当前 Agent 真实 `SOUL.md` 的 slug 判断已注入项，优先展示文件中的真实 `Name`，并提供编辑当前文件的入口；推荐人设一旦保存编辑，即写入自定义来源标记并按自定义人设展示。
- 人设页顶部说明明确引导用户设置人设文件 `SOUL.md`，并将其价值表达为赋予 Agent 独特的性格与表达方式。
- SkillHub 人设来源链接位于人设卡片容器右上角，与“人设卡片”标题垂直居中对齐，不占用页面顶部说明行。
- 自定义人设的编辑、下载等操作仍服从各站点已开放的产品能力；推荐人设摘要不得据此推断或扩大区域能力。

## Agent 模型配置区域边界

- 国际站英文控制台把通道和模型视为资源集合：左侧导航及对应页面标题使用 `Channels` / `Models`；单个模型选择器、字段标签等实体语境仍使用单数 `Model`。
- 国际站 WhatsApp 通道卡片说明同一实例同时只能连接一个 Bot。若已被同实例其他 Bot 占用，当前 Bot 显示占用 Bot 名称和管理入口，并禁用扫码连接；断开原 Bot 后方可在当前 Bot 连接。此提示与实例级占用记录同步，不代表跨实例号码唯一性。
- 国内站与国际站复用同一套模型配置交互，界面名称和操作提示通过前端 i18n 展示；持久化配置始终使用原始 Provider key 和模型 ID，不写入本地化名称。
- 预置 Provider 的可选模型由当前区域的产品配置目录提供，前端不使用用户 API Key 临时拉取模型列表；自定义 Provider 仍可按用户填写的端点探测或手动输入模型 ID。
- 主模型、备用模型和仅添加模型的角色来自 Hermes 配置快照。角色切换不得改变已添加 Provider 的展示顺序，也不得把目录候选误标为已添加模型。

## Agent 配置命令所有权

- 国内站与国际站 Agent 设置页使用的 Hermes Provider、模型、通道和 Gateway 命令由 `frontend/src/pages/marketing/agent-config/hermes-command-builder.ts` 本地生成，不在浏览器运行时加载 Tea SDK 命令工厂。
- 本地命令生成器应保持 acli 命令文本与既有行为兼容；Hermes Profile 路由属于独立能力，只有产品侧具备明确 Profile 标识与完整回归验证后才能统一增加 `--agent`。

## Skills 已安装来源边界

- 国内站 SkillHub 的搜索结果仍以 SkillHub 作为市场来源；已安装列表则必须保留 `acli skills list` 返回的实例 `source`，不能因同名技能存在于 SkillHub 而覆盖运行时来源。
- Hermes 或 SkillHub 已安装实例明确报告 `source: builtin` 时，前端统一展示为“系统预置”并禁止删除。只有非预置的市场安装记录才允许按原 registry 身份卸载。
- 同一技能同时出现在市场记录与 Hermes 已安装清单时，Hermes 的 `builtin` 判定对预置属性具有权威性；技能名称不得用作硬编码预置白名单。

## Agent 多 Bot 区域边界

- 实例内多 Bot 在国内站和国际站共用同一套产品能力。前端入口统一受运行时 `multiBotEnabled` 功能开关约束；CTL 的读取接口保留存量默认 Bot 兼容，新增 Bot 由服务端开关再次校验。`ctl-api` 从各环境的 `ctl-platform-values` 可选读取 `MULTI_BOT_ENABLED`，国际 `sgprod` 显式设为 `true`，后续可独立改为 `false` 回滚额外 Bot 能力；该开关不能阻断无实例用户首次创建 Agent。
- 国内与国际 service-gateway 环境都精确允许 `/v1/instances/{instance_id}/bots` 的列表、创建/克隆、重命名、删除、失败修复和唯一通道绑定子路由。配置策略测试必须分别断言两站放行相同 method/path 集合，并继续验证鉴权、实名、归属与相邻路径拒绝；不能用前端隐藏替代公共 API 边界。
- Agent 侧栏运行中 Bot 的“重启”使用箭头与圆弧相连的单箭头图标，与双箭头刷新区分；失败 Bot 的“修复”仍使用双箭头图标。执行中显示加载图标，操作入口和确认流程继续按当前 Bot 状态判断。
- 国内站与国际站的桌面 Agent 侧栏共用展开/收起状态：LightVela 品牌右侧的按钮切换完整导航与图标导航，使用无方向箭头的浅灰色侧栏图标，并用当前 locale 显示悬停及键盘聚焦提示。侧栏、顶部栏和内容列同步过渡；收起时为补偿文案立即隐藏的视觉速度差采用 260ms，展开采用 200ms，并遵循系统的减少动态效果设置。恢复本地保存的收起状态时先显示目标宽度，不播放首屏展开/收起动画。Bot 展示区采用圆角描边容器，收起后容器围住头像；顶部栏至总览、总览至 Bot 卡片保持相同的紧凑间距，不另加分隔线。展开导航使用「日常／探索」切换；探索依次排列成长、管理（模型、诊断中心、高级设置）和实验室，侧栏底部账号菜单保留云存储入口。收起状态保留总览、Bot 头像、导航切换、设置入口和账号头像，导航路由不变；完整会话列表与新建 Bot 入口在展开后访问。移动端导航保持原布局。
- 「探索」中的实验室上方使用与「日常」对话区一致的分隔线，保持成长、管理、实验室原有分组顺序和路由。
- 桌面侧栏的「日常」会话列表超出可用高度时在列表内纵向滚动并显示滚动条，顶部入口、对话标题和底部账户入口保持可见；移动端维持抽屉整体滚动。
- 侧栏顶部重启和删除操作、不可用的 Chat Tab 提示框通过 `document.body` Portal 固定定位并约束在视口内，避免被侧栏滚动容器裁切；按钮的操作与禁用条件不因提示框而改变。
- 侧栏的额外 Bot 创建入口是当前 Bot 圆角卡片右侧独立的细圆框“+”按钮：国内站与国际站均默认可见，不依赖浏览器控制台的 `show()`。重启与删除操作保留在卡片内；多个 Bot 时，删除图标后显示用于展开 Bot 切换列表的下拉箭头。原侧栏整行“新建 Bot”按钮不再显示，运行时多 Bot 开关和套餐额度限制仍保持不变；额度不足的原因通过可聚焦的 Portal 提示展示。
- 到期徽标的可交互续费提示从徽标下方展开，不覆盖同一 Bot 顶部的创建、重启和删除图标；徽标与提示内的续费操作保持原有入口。

## Agent 创建引导与总览区域边界

- 国内站与国际站均开启现有创建引导与总览。订阅后首次创建、已有套餐首次创建和新增 Bot 使用同一引导，完成配置后进入目标 Bot 的总览页；直接访问 `/agents` 默认进入总览，显式子页面导航保持原目的地。
- 存量 Bot 不因开放而强制重新配置；仅创建意图、新建标记或未完成配置恢复触发相应引导。套餐额度与运行时多 Bot 开关继续独立约束创建权限。
- 模板按站点区域选择，不能按界面语言替换安装源：国际站保持 skills.sh 与 Hermes 官方 GitHub 技能，国内站保持 SkillHub，`cnOnly` 模板不得进入国际站。所有配置和安装命令仍定向创建目标的 profile。
- 总览有效期由页面传入当前 locale 格式化；更新动态标题、正文、图片说明及头像辅助名称使用可静态提取的翻译字面量，并随界面语言切换重新解析。用户自定义内容与技能标识保留原文；国际模板当前仍使用成套英文配置，其他语言展示策略独立确认。
- `IS_BUDDY_ONBOARDING_ENABLED` 为双站默认开启的前端开关；关闭时保留旧创建弹窗与通道默认页回退。源码启用不证明生产已发布。

## 公共账号菜单边界

- 登录态公开页 Header 的头像图片在已有套餐或 Bot 资格确认后链接到 `/agents`，资格未确认或不存在时链接到 `/account`，旁边的箭头继续展开头像菜单。菜单提供“账号”（`/account`）与“套餐与费用”（`/account/billing`），并在底部保留退出登录。Agent 控制台沿用左侧导航底部的账号触发器与向上展开菜单；当前有效 Pass 的 `bundle_type` 严格等于 `ai` 时，该侧栏菜单额外展示“模型”（`/agents/models`），同时从 Agent 的 Use 分组移除重复入口。其他类型以及字段缺失或未知时，模型入口保留在 Use 分组。公共页 Header 保留“我的智能体伙伴”入口，且不展示该套餐专属“模型”入口。
- Agent 侧栏账号菜单在 AI 套餐下按“模型”→“套餐与费用”→“账号”→“语言”（仅国际站）排列；其他套餐下按“套餐与费用”→“账号”→“语言”（仅国际站）排列。公共页 Header 账号菜单保持“账号”先于“套餐与费用”。
- 国际站英文分别使用 `Account`、`Plans & billing` 与 `My AI Companion`。两个账号私域页面均要求登录、保持 noindex/nofollow；账号页承载资料与身份管理，套餐与费用页承载订阅和国际站支付方式，购买入口仍为 `/subscribe`。
- 订阅失败后的套餐管理/续费引导进入 `/account/billing`；创建前的实名认证引导与邮箱绑定回调仍进入 `/account`，仅账号视图消费对应 query。国内续费的实名子流程由 `RenewPassModal` 自己承载，不依赖账号页资料卡的认证入口。

## 邀请返利环境边界

- 新邀请链接使用当前环境前端首页 `/?ref=<code>`，由现有公共 Header 打开统一登录弹窗。
  旧 `/auth/sign-in?ref=<code>` 保留兼容跳转，不再让被邀请用户进入旧版独立登录 UI。
  统一登录弹窗必须先校验返利码并完成 Auth HttpOnly Cookie 写入，成功前不得展示 OAuth、手机号或
  微信复制引导；失败仅提示错误并允许重试，不能静默丢弃邀请归因。账号切换不捕获邀请上下文。
- 邀请返利在 `beijing-sandbox` 与 `shprod` 分别配置独立 Campaign。前端入口消费 CTL runtime flag，默认关闭；
  只有 Referral API/worker、Pulsar、数据库、VelaGW 直接送积分能力和 Gateway 全部就绪后才显式开启。
  即使 runtime flag 已开启，账号页返利区域仍默认隐藏，只在当前页面执行 console `show()` 后揭示，
  页面重新挂载后恢复隐藏；该 UI 灰度门禁不得阻断带 `?ref=` 的邀请注册与服务端归因。
  上海使用自己的路由与 Token，新加坡保持关闭，任何环境都不继承北京 Campaign。
- 每个后续环境在自己的 inventory 中声明集群、namespace、角色和 SSM 目标，并通过参数化 bootstrap
  交付独立 Token。跨环境复制北京 Token、根据 Region 猜 Secret 名或用 UI 隐藏代替 Gateway 边界均不允许。

## Agent 高级设置展示边界

- 高级设置初次读取使用面向用户的加载文案：中文为“正在加载设置…”，英文为 `Loading settings...`；加载结果、错误和重试逻辑保持不变。
- Agent 设置页切换非 Tea SDK 分区时，懒加载占位文案复用通用翻译：中文为“加载中...”，英文为 `Loading...`；不显示“正在加载页面…”或 `Loading page…`。

## Agent 定时任务区域边界

- 国内站和国际站复用同一套 Agent 任务、0 Token 固定通知与脚本任务交互；任务类型、无模型 Token 消耗说明、主机执行风险提示和运行状态都必须经过 i18n，不得只完成单站文案。
- 调度表达式、时区、生效时段和通知渠道继续使用现有 Agent 定时任务能力；渠道列表及可用性仍由当前 Agent 和区域运行时决定，0 Token 任务不建立第二套渠道配置。
- 0 Token 创建入口由前端在国内站、国际站和 EdgeOne 预览中默认开启，不依赖 CTL 下发字段；远端 runtime config 不可用、缺少字段或字段异常时继续使用前端默认值。显式构建期关闭、本地紧急关闭或远端布尔 `false` 只控制新建入口，不能让已存在的 Hermes `no_agent` 任务在任一站点消失或失去管理入口。
- 双站验收须分别覆盖新建、任务卡片、详情和最近执行；国内站通过不能替代国际站英文与区域渠道验证。

## Agent 记忆展示区域边界

- 国内站与国际站复用同一套 `MEMORY.md` / `USER.md` 展示组件；内容按 Hermes 的 `§` 分隔符分条，每条保留文件中的原始换行，并在页面容器内自动折行。
- 页面说明将 `MEMORY.md` 表达为“持久记忆”，与页面标题及文件用途保持一致。
- 该页面只负责忠实展示文本，不把 Markdown 语法转换为富文本，也不改变 Agent 运行时记忆文件的读写格式。

相关 Journey：[双站请求路由](../journeys/dual-site-request-routing.md)。Agent 摘要：[site-environment-routing Context](../../context/domains/site-environment-routing.md)。

## 前端网络错误展示边界

- 双站 HTTP Repository 的网络错误 message 保持产品友好文案，供页面与 toast 展示；原始 fetch 异常仅保留在 Error.cause 供诊断，不能把 TypeError、CORS 或底层连接详情拼进用户可见消息。命令执行超时仍由原有 debug_exec_timeout 语义区分。

### 双站控制台 Chat

国内站和国际站的 Chat 入口均默认可见，对话页使用 OpenCraft 内嵌工作台；执行浏览器控制台 `show()` 不改变 Chat 的可见性。两站主 Bot 与其他 Bot 的对话均进入 OpenCraft，且不请求旧 AgentChat 启动 token。准备阶段只呈现中性聊天加载态，不挂载旧 AgentChat；就绪后显示 OpenCraft，连接异常保留同一会话并提供重试，首次资源加载失败提供重新加载入口。其他隐藏工具仍由 `show()` 控制；站点选择不替代服务端认证或资源归属校验。控制台认证 repository 在 token 替换/清除后广播不含 token 的 `lightclaw:auth-session-changed`，供同页内嵌消费者释放旧身份，跨标签仍由 storage 事件通知。制品复用同源 `/__opencraft/` 的现有发布链路。内嵌 Chat 不展示独立模型选择器，发送前读取当前 Bot/Profile 的 Hermes 默认模型；旧草稿模型与思考设置不得覆盖宿主配置，缺少可用默认模型时在发送前报错。

双站 OpenCraft 会话侧栏为绝对定位的更多按钮预留独立空间，长标题在按钮前 8px 截断；该样式随 OpenCraft 启用条件生效。

内嵌 Chat 新会话的伙伴标题与输入占位文案覆盖控制台八套字典（en-US、zh-CN、zh-Hant、id-ID、ms-MY、es、ja-JP、ko-KR）；zh-SG 复用简体中文。额外语言由内嵌专用 catalog 注入，宿主以当前路由语言配置工作台并在切换语言时调用 `setLocalization()`，保留会话和草稿；独立工作台语言列表不变。未翻译的通用工作台文案回落英文。

双站启用内嵌 Chat 时，加载、新会话和已有会话均不呈现宿主圆角外框。工作台保留已有会话标题、重命名入口和输入框，移除主内容表面的阴影。草稿状态仍由工作台拥有。

### 双站会话连接恢复

启用内嵌会话后，连接失败不再自动退回 AgentChat；由同一个 Host runtime 继续自动重连。
宿主通过 opencraft-connection 投影连接状态，超过 30 秒显示网络/重试提示，提供重新连接按钮。
已展示的会话组件不因连接错误卸载，保留当前页面内文字与附件；不承诺刷新/退出登录后的草稿恢复。
首次资源加载失败允许重新加载组件，Bot/账号切换撤销旧回调。固定 Profile 连接尝试 90 秒超时并清理资源。
这些变更不构成线上发布。

双站 OpenCraft Chat 同时提供默认收起的右侧预览面板：网页标签和会话文件只读预览。网页受目标站点 iframe 策略约束，可使用外部打开入口；此能力不是 Hermes 远端浏览器画面。Bot/账号切换销毁整个内嵌 Application 及其内存网页元数据，文件读取沿当前 Host 归属执行；不新增实例文件系统权限隔离保证。
