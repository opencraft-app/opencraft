# 站点与环境路由领域

Pass 升配微信桥通过精确的 `POST /v1/passes/{pass_id}/modify/order-url` 可选认证入口转交 CTL 验证短期票据；modify 桥接请求不附带另一浏览器用户的 Bearer/cookie。建单、恢复订单和重签票据仍要求登录，不能扩大到整个 Pass 路由。前端 API 和扫码域名必须属于同一目标测试环境。

本领域覆盖国内/国际站、域名、locale、区域功能差异、环境 inventory 和对应 GitOps overlay。

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

## 产品文档区域

`frontend/src/content/docs/` 保留 cn/global/en/id 源；生成的 zh-cn/zh-sg/en-us/zh-hant/id-id 输出不直接编辑。区域差异必须通过 parity 测试和真实路由共同证明。

国内站文档的产品阶段口径与同区域 `llms.txt` 事实摘要保持一致。已开放订阅后，概览和套餐说明不再展示产品级公测提示；首购活动及价格以订阅页为准。单项功能的 Beta 标记仍按实际产品入口核对。

国际站文档的英文、简体中文、印尼语、西语、日语和韩语源文件不再把整站公测转段或内测延期权益描述为当前状态；生成的繁体中文版本随简体中文源同步。套餐与首购活动以国际站订阅页为准，`announcements/public-beta` 保留源稿并按下述暂时下线策略移除公开路由。单项功能的 Beta 标记及第三方产品的阶段描述按各自事实核对。

国内站新增配置指南时，`frontend/src/config/docs-sidebar.ts` 中的 `CN_SIDEBAR`、`CN_SLUG_TO_FILE` 与 `frontend/scripts/sync-fumadocs-content.mjs` 中的 `cnDocs` 必须同时注册同一 slug。钉钉指南使用 `configuration/channel-dingtalk`，仅进入国内站目录；国际站目录与映射单独维护。

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
- 国内站 V2 首页不使用国际站的 `loginOnly` 规则：未登录 Header 与 Hero 展示“免费试用”并进入 `/subscribe`，登录态 Header 与 Hero 展示“开始使用”并进入 `/agents`；静态 Hero 默认输出未登录态，认证恢复后再同步登录态入口。
- 国内站与国际站 `/subscribe` 的未登录 Header 统一启用 `loginOnly`：隐藏创建入口，仅保留登录主动作（国际站同时保留语言切换）；套餐卡“立即订阅”继续承担转化并触发登录。
- 根首页的初始 HTML、Flight、Next 脚本数量与 raw/gzip 体积由 `pnpm check:homepage-performance` 对真实 `out/index.html` 执行预算检查，同时拒绝旧 `PublicHomePage` / `LandingPageView` chunk 回流；国内与国际构建仍须分别验证，预算通过不能替代浏览器回归或线上 Web Vitals。

## 公开营销页区域边界

- 国内站和国际站可复用同一套公开营销页组件或静态 fragment，但必须在 `frontend/next-site/international-home-routing.ts`、`frontend/src/app/(site)/page.next.tsx` 和对应测试里显式区分站点入口、locale、CTA、文档链接和合规页脚。
- 国内站 `lightvela.com/` 默认使用国内语境的 `zh-CN` 首页内容；可以复用国际站中文版的视觉结构，但链接必须落到国内裸路径，不输出国际站 locale 前缀或海外渠道主入口。
- 国际站 `lightvela.ai/` 负责默认英文和多语言公开首页；权益文案、AI companion 语境和静态图片资源需要按 locale 同步验证，不能只改默认英文。
- 国际站裸首页维持英文静态内容与现有 canonical。仅在首次访问、此前未明确选择语言且浏览器首选语言匹配已发布的非英文 locale 时，客户端以目标语言展示一次切换建议；提示已展示状态保存在浏览器，选择语言后进入对应国际站公开 URL，继续英文则保存英文选择。任何裸英文公开页为控制台语言连续性自动写入的默认英文都不算明确选择；手动切换与带语言前缀的 URL 会单独记录明确语言意图。旧存储中的非英文选择继续优先；无法辨认来源的旧版英文记录可能再收到一次建议。国内站和登录后路径不展示此建议。无痕模式关闭后可重新出现。
- 双站暂时隐藏 Blog 的站内导航、页脚和推广入口，包括共享 Footer 与首页各语言静态 fragment；现有 Blog 页面、文章和直接访问能力保持不变，不因入口隐藏调整其索引策略。
- 双站 `announcements/public-beta` 以及国际站 `use-cases/telegram-whatsapp-safety-boundaries`、`use-cases/lifelike-im-agent-rhythm-social-memory`、`use-cases/im-agent-skill-scenarios`、`use-cases/whatsapp-24-7-customer-service` 暂时下线但保留源稿。下线需同时移除 sidebar、slug 映射与 Fumadocs 注册，并重新生成 route manifest、搜索与公开索引；旧 URL 返回 404，不跨语言回退，公开正文不得继续链接到这些页面。恢复时重新评审源稿并成套恢复注册和链接。
- 首页静态 fragment 的链接、图片版本参数、合规信息和客户端演示外壳属于站点路由责任面；修改后必须同步更新正式设计文档，并用静态链接检查、前端测试和本地/预览环境证明没有跨站点串链。

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
- 侧栏顶部重启和删除操作、不可用的 Chat Tab 提示框通过 `document.body` Portal 固定定位并约束在视口内，避免被侧栏滚动容器裁切；按钮的操作与禁用条件不因提示框而改变。
- 侧栏的额外 Bot 创建入口是重启图标左侧的“+”按钮：国内站与国际站均默认可见，不依赖浏览器控制台的 `show()`。多个 Bot 时，删除图标后显示用于展开 Bot 切换列表的下拉箭头。原侧栏整行“新建 Bot”按钮不再显示，运行时多 Bot 开关和套餐额度限制仍保持不变；额度不足的原因通过可聚焦的 Portal 提示展示。
- 到期徽标的可交互续费提示从徽标下方展开，不覆盖同一 Bot 顶部的创建、重启和删除图标；徽标与提示内的续费操作保持原有入口。

## Agent 创建引导与总览区域边界

- 国内站与国际站均开启现有创建引导与总览。订阅后首次创建、已有套餐首次创建和新增 Bot 使用同一引导，完成配置后进入目标 Bot 的总览页；直接访问 `/agents` 默认进入总览，显式子页面导航保持原目的地。
- 存量 Bot 不因开放而强制重新配置；仅创建意图、新建标记或未完成配置恢复触发相应引导。套餐额度与运行时多 Bot 开关继续独立约束创建权限。
- 模板按站点区域选择，不能按界面语言替换安装源：国际站保持 skills.sh 与 Hermes 官方 GitHub 技能，国内站保持 SkillHub，`cnOnly` 模板不得进入国际站。所有配置和安装命令仍定向创建目标的 profile。
- 总览有效期由页面传入当前 locale 格式化；更新动态标题、正文、图片说明及头像辅助名称使用可静态提取的翻译字面量，并随界面语言切换重新解析。用户自定义内容与技能标识保留原文；国际模板当前仍使用成套英文配置，其他语言展示策略独立确认。
- `IS_BUDDY_ONBOARDING_ENABLED` 为双站默认开启的前端开关；关闭时保留旧创建弹窗与通道默认页回退。源码启用不证明生产已发布。

## 公共账号菜单边界

- 登录态头像菜单提供“账号”（`/account`）与“套餐与费用”（`/account/billing`），并在底部保留退出登录。Agent 控制台沿用左侧导航底部的账号触发器与向上展开菜单；当前有效 Pass 的 `bundle_type` 严格等于 `ai` 时，该侧栏菜单额外展示“模型”（`/agents/models`），同时从 Agent 的 Use 分组移除重复入口。其他类型以及字段缺失或未知时，模型入口保留在 Use 分组。公共页 Header 保留“我的智能体伙伴”入口，且不展示该套餐专属“模型”入口。
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
