# 文档站规则（国内站 + 国际站）

## 目录结构

```text
frontend/src/content/docs/
  *.md                         # 国内站文档（zh-cn）
  configuration/*.md           # 国内站配置文档
  global/*.md                  # 国际站中文文档（zh-sg）
  global/configuration/*.md
  en/*.md                      # 国际站英文文档（en-us）
  en/configuration/*.md
  images/*                     # 中英文共用文档图片资源
```

根目录是国内站真源，`global/` 与 `en/` 是国际站真源。

## 加载规则

`frontend/src/lib/docs/docs-loader.ts` 定义加载优先级，**区域严格隔离，不跨区域 fallback**：

- 国内站：只读 `frontend/src/content/docs/<file>`。
- 国际站英文：优先读 `en/<file>`，缺失时降级 `global/<file>`。
- 国际站中文：只读 `global/<file>`。

因此：改国际站不要依赖根目录文件；改国内站不要去改 `global/` / `en/`。

## 路由与语言

- 国内站：`/docs/...`（`zh-cn`）
- 国际站默认英文裸路径：`/docs/...`
- 国际站英文显式路径：`/en-us/docs/...`
- 国际站中文路径：`/zh-sg/docs/...`

`frontend/src/app/(site)/[lang]/docs/[[...slug]]/page.next.tsx` 中：global 构建支持 `en-us` 与 `zh-sg`，cn 构建支持 `zh-cn`。

## 渲染产物与同步机制

**页面渲染的不是源文件。** 这是最容易踩的坑，务必先理解这条链路：

```text
src/content/docs/**/*.md          # 你编辑的源文件
        ↓  node scripts/sync-fumadocs-content.mjs
.fumadocs-content/docs/<locale>/**/*.mdx   # 页面实际渲染的生成产物
        ↓  fumadocs-mdx
.source/                          # 索引与加载入口
```

locale 目录映射：

| 区域与语言 | 生成产物目录 |
| --- | --- |
| 国内站中文 | `.fumadocs-content/docs/zh-cn/` |
| 国际站中文 | `.fumadocs-content/docs/zh-sg/` |
| 国际站英文 | `.fumadocs-content/docs/en-us/` |
| 国际站繁体 | `.fumadocs-content/docs/zh-hant/` |

因此：

- **只改 `src/content/docs/` 下的 `.md` 而不同步，页面会继续显示旧内容**，很容易被误判为“改动没生效”。
- 改完 markdown 后必须运行 `cd frontend && pnpm docs:sync`。
- 同步后建议对比源文件与生成产物的体量或关键段落，确认内容确实更新。
- dev server 已在运行时，同步后需重启或触发重新编译。
- `pnpm dev` / `pnpm dev:global` / `pnpm check` / `pnpm build` 内部已包含同步步骤；只改文档时用 `pnpm docs:sync` 最快。
- 生成产物属于构建输出，不要直接编辑 `.fumadocs-content/` 里的 `.mdx`——下次同步会被覆盖。

## Sidebar、slug 与注册

新增或调整页面时涉及**三处**配置，缺一处页面就可能不可访问或标题缺失。

### 1. `frontend/src/config/docs-sidebar.ts`

- 国内站 sidebar：`CN_SIDEBAR`
- 国际站 sidebar：`GLOBAL_SIDEBAR`
- 国内站 slug→文件：`CN_SLUG_TO_FILE`
- 国际站 slug→文件：`GLOBAL_SLUG_TO_FILE`
- 运行时通过 `isGlobal` 二选一导出 `SIDEBAR` 与 `SLUG_TO_FILE`

### 2. `frontend/scripts/sync-fumadocs-content.mjs`

`cnDocs` / `globalDocs` 数组注册页面标题、描述、分组与顺序。新增页面必须在对应区域数组里补一项，否则标题、描述与分组不会生效。

### 3. `frontend/next-site/docs-route-manifest.ts`

路由清单。配合 `frontend/scripts/international-docs-parity.test.ts` 校验双站文件与路由一致性。改动 sidebar 或新增页面后建议运行该测试。

### 常见陷阱：三个注册源互不一致

`docs-sidebar.ts` 的 slug 映射与 `sync-fumadocs-content.mjs` 的注册数组**范围不同**，不能只查一处就下结论。已知不一致（快照）：

| 页面 | `CN_SLUG_TO_FILE` | `cnDocs` | 说明 |
| --- | --- | --- | --- |
| `hermes-agent/*` 01–05 | 无 | 有 | 国内站**确实有**这 5 篇，只查 slug 映射会误判为“国际站独有” |
| `contact-us` | 有 | 无 | 映射存在但 fumadocs 未注册 |
| `configuration/channel-slack` | 有 | 无 | 映射存在但 `CN_SIDEBAR` 也未暴露 |

判断某页面在某区域是否真的上线，必须**同时**查三处：`<REGION>_SIDEBAR`、`<REGION>_SLUG_TO_FILE`、`sync-fumadocs-content.mjs` 的 `cnDocs` / `globalDocs`。以 sidebar 是否暴露作为「用户可见」的判据，以 fumadocs 注册作为「标题/描述/分组生效」的判据。

### 新增国际站页面步骤

1. 在 `GLOBAL_SIDEBAR` 加菜单项（含 `titleEn`）。
2. 在 `GLOBAL_SLUG_TO_FILE` 加 slug → file 映射。
3. 在 `sync-fumadocs-content.mjs` 的 `globalDocs` 注册标题、描述、分组。
4. 创建 `global/<file>` 中文稿。
5. 创建 `en/<file>` 英文稿。
6. 不要顺手加入 `CN_SIDEBAR` / `CN_SLUG_TO_FILE` / `cnDocs`，除非用户明确要求国内站也上线。

### 新增国内站页面步骤

1. 在 `CN_SIDEBAR` 加菜单项。
2. 在 `CN_SLUG_TO_FILE` 加 slug → file 映射。
3. 在 `sync-fumadocs-content.mjs` 的 `cnDocs` 注册标题、描述、分组。
4. 创建 `frontend/src/content/docs/<file>` 中文稿。
5. 不要顺手加入国际站配置与 `global/` / `en/` 文件。

## 区域能力差异清单

以下为 `docs-sidebar.ts` slug 映射与 `sync-fumadocs-content.mjs` 注册数组的并集比对快照，**仅供参考，冲突时以代码为准**。

### 两站都有（20）

- 入门：`overview`、`quickstart`、`core-concepts`、`who-is-lightvela-for`
- 套餐开通：`announcements/public-beta`、`plans`、`credits`、`create-first-hermes`
- 配置：`configuration`、`configuration/model`、`configuration/channel-wechat`、`configuration/channel-feishu`、`configuration/channel-qq`、`configuration/skill`
- Hermes Agent 解读前 5 篇：`hermes-agent/hermes-vs-openclaw`、`why-hermes-remembers-you`、`user-md-vs-memory-md`、`hermes-memory-curation`、`memory-vs-skill`
- 支持：`contact-us`（国内站仅在 slug 映射中，未在 `cnDocs` 注册）

### 仅国内站有（3）

- `account`（账号与实名认证，国内专属，不进国际站）
- `faq`（常见问题 FAQ）
- `configuration/channel-slack`（仅存在于 `CN_SLUG_TO_FILE`，`CN_SIDEBAR` 与 `cnDocs` 均未暴露）

### 仅国际站有（37）

- 渠道（4）：`configuration/channel-telegram`、`channel-whatsapp`、`channel-discord`、`channel-wecom`
- 功能（6）：`configuration/memory`、`configuration/automation`、`configuration/files`、`configuration/agent-chat`、`configuration/diagnostics`、`configuration/multiple-models`
- 场景方案（14）：`use-cases/*`（personal-ai-assistant、chinese-messaging-channels、telegram-persona-agent、whatsapp-persona-agent、im-agent-persona-soul-md、im-agent-skill-scenarios、multi-channel-personality-memory、telegram-group-community-assistant、whatsapp-24-7-customer-service、lifelike-im-agent-rhythm-social-memory、telegram-whatsapp-safety-boundaries、daily-summary、hermes-agent-24-7、memory-and-knowledge）
- Hermes Agent 解读后 7 篇（7）：`hermes-agent/model-vs-agent-layer`、`message-gateway`、`automation-scheduling`、`model-switching-memory`、`persona-user-memory`、`workspace-context-storage`、`skills-self-improvement`
- 产品对比（5）：`compare/lightvela-vs-manus`、`vs-hostinger`、`vs-localhost-ai-agent`、`vs-chatgpt`、`vs-genspark`
- 安全（1）：`faq/using-lightvela-safely`

### 区分“功能缺失”与“文档待补”

上面「仅国际站有」的项目分两类，提醒用户时必须区分：

- **功能缺失（国内站产品不支持）**：Telegram / WhatsApp / Discord / 企业微信等国际站独有渠道，以及依赖这些渠道的场景方案。这类内容写国内站文档没有意义，应建议用户不写。
- **文档待补（功能可能已有，只是没写文档）**：Hermes Agent 解读后 7 篇、产品对比、安全等纯内容型页面，以及记忆管理、自动任务、云存储、对话、诊断、模型切换等功能页。这类要先核对国内站产品是否已支持该功能，再决定是否补文档。

无法从代码判断国内站产品是否支持某功能时，明确告知用户“无法从文档配置判断该功能在国内站是否已上线”，并请用户确认，不要擅自断言。

### 使用方式

- 用户要求给某功能写**国内站**文档时，若该 slug 只出现在国际站列表里，先提醒用户「国内站当前无此功能」，并给出判断依据（`CN_SIDEBAR` / `CN_SLUG_TO_FILE` / `cnDocs` 均无对应项），等用户确认后再决定是否落盘。
- 用户要求写**国际站**文档时，若该 slug 只出现在国内站列表里（例如实名认证），同样先提醒。
- `region: both` 且功能只有单侧存在时，明确告知只能单侧上线，并让用户选择处理方式。

## 按提示语言起草并自动补齐本地化

国际站模板不固定先写中文或英文：

1. 用户明确要求哪种语言，就先用该语言完成内容底稿。
2. 用户未明确语言时，按要求的输出语言或提示词主语言起草。
3. 在同一任务中自动补齐两份国际站源稿：简体中文写入 `global/<file>`，英文写入 `en/<file>`。
4. 运行 `pnpm docs:sync`，由现有 OpenCC 链路从简体中文源稿生成 `zh-hant` 产物。
5. 本地化不是逐字翻译，要符合对应用户语境：
   - WeChat 可保留，但需解释使用场景。
   - 飞书在英文文档中写 Lark。
   - 企业微信在英文文档中写 WeCom。
   - 国内实名认证、国内支付、国内专属入口不进国际站，除非页面明确说明。

两份源稿必须保持同一信息架构、步骤顺序、表格、图片位置、事实、警告、限制语义与链接目标。

同步后还要检查 `en-us`、`zh-sg` 与 `zh-hant` 三个生成目录，不能只确认源文件存在。

## 写作规范落地要点

`SKILL.md` 的写作标准在文件层面的具体落法：

- 开篇摘要板块位于正文最前（有 hero 图时紧随其后），标题固定 `## 摘要` / `## Summary`，1–2 段加粗、可独立引用、点名具体对象与结论。
- 体裁分档按 sidebar 分类判定：
  - **A 档工具型**（`开始使用`、`套餐与开通`、`功能与配置`、`问题排查`、`联系与支持`）：客观中性、精简可执行，不设字数门槛，必须覆盖前置条件、完整步骤、结果校验、常见失败处理。
  - **B 档可读型**（`场景方案`、`对比与选型`、`Hermes Agent 解读`）：国内站正文不少于 3000 字（约 6 KB）；国际站三类模板以结构完整、事实密度和搜索意图为准，不设固定字数门槛。结构需要有明确推进，鼓励表格、清单、示例与边界条件，允许自有分析框架但需正文事实支撑。Hermes Agent Deep Dive 可按主题使用多个表格，以及带语言标识的 Markdown、JSON、YAML、slash command、Bash、预期输出或错误代码块，但每一项都必须有官方来源和附近解释。
- 事实密度：必须有可核查的机制细节、具体字段/文件名/数字或可追溯来源，禁止通篇概念定义与同义反复。
- 两档都不写传播导语、社媒 CTA、Community Ending，与 `lv-longform-content` 的营销体裁区分。
- 立场声明：第三方机制以其官方文档为准；产品对比只谈公开可见的能力与定位差异，不做优劣评价；LightVela 自家视角段落明确标注「LightVela 的做法 / 方向」。
- 禁止连载导航（「下一篇预告」「上一篇」「本系列」「in the next post」「this series」）；交叉引用需指名目标文章标题，任意阅读顺序都成立。
- 禁止独立的「延伸阅读」板块（`## 延伸阅读` / `## Related reading` / `## 相关阅读`）；侧边栏已承担导航职责，集中罗列会造成重复与批量死链。交叉引用一律内联在正文相关段落，在读者需要该背景的位置指名目标文章标题。
- 禁止在示例中出现真实内部仓库名、服务名、主机名、端口、分支名；统一用 `agent-demo` 等中性占位名。

## 图片规则

图片统一放在 `frontend/src/content/docs/images/`。

`rewriteImagePaths()` 在英文 locale 下优先寻找同名 `-en` 图片：

```text
xxx.webp      # 默认图片
xxx-en.webp   # 英文环境优先使用
```

Markdown 里仍引用默认名即可：

```markdown
![](../images/xxx.webp)
```

编辑图片时：

- 中文文档新增 `xxx.webp` 时，英文文档通常需要 `xxx-en.webp`。
- 英文文档直接引用中文 UI 截图时，要提醒补英文截图。
- 图片无 UI 文案或语言无关时可复用，不必强行创建 `-en`。
- 使用 `<img src="../images/xxx.webp" width="360" />` 时同样要检查 `-en` 版本。
- 图片更新必须覆盖 markdown 当前引用的既有文件，不要新增文件再改引用，除非用户明确要求新增。
- 不要替换第三方平台或手机 App 截图（BotFather、Discord Developer Portal、WhatsApp、QQ/WeCom/Lark 管理后台、系统相册、聊天 App 内界面）。只有确属 LightVela 站内 UI 且能在真实站点复现才替换。

## Browser 截图替换规则

当用户要求检查、更新、替换、校正文档截图，或表达「图片不对 / 图片过期 / 图片和页面不一致」时：

1. 先扫描目标 markdown 当前引用的图片路径，确认 live docs 实际使用哪个文件：
   - 国内站与国际站中文使用 markdown 引用的默认图。
   - 国际站英文若存在同 basename 的 `-en` 图，live docs 优先使用 `-en` 图。
   - 替换时直接覆盖实际生效的既有文件，不要新建旁路图片。
2. 用 Browser 打开**对应区域**的真实页面，不要只看本地文件或旧图：国内站用 `lightvela.com`，国际站用 `lightvela.ai`。
3. 根据文档内容定位同一功能页面；涉及 Agents 时优先检查 `/agents` 及对应详情页。
4. 对比布局、文案、语言、按钮、卡片与可见状态是否一致。
5. 旧图不是 LightVela 站内 UI，或真实站点没有同类页面/弹窗时，不替换。
6. 截图前必须等真实内容加载完成：
   - 页面文本中不应出现 `loading...`、`Loading...`、`加载中...`。
   - 目标卡片、表单、弹窗或列表必须可见。
   - 若长期停留 loading，最终说明该图未替换及原因。
7. 截图只含网页页面内容，不含浏览器标签栏、地址栏、书签栏、系统窗口边框。
8. 弹窗与敏感内容：
   - 点击 `Connect` / `+ 连接` 后出现二维码时，截图弹窗并用灰色方块覆盖二维码中心区域。
   - 出现 Token、AppID、AppSecret、code 等输入框时，可输入随机占位值复现状态，但落盘前必须用灰色矩形覆盖输入值。
   - 遮罩覆盖敏感内容主体，不要只做模糊；优先不透明或半透明灰色矩形。
9. 国际站两种语言都要处理：
   - 中文国际站用 `zh-sg` 页面截图，写入或替换默认图（如 `xxx.webp`）。
   - 英文国际站用英文默认路径或 `en-us` 页面截图，写入或替换 `xxx-en.webp`。
10. 截图落地后确认 markdown 图片路径仍指向默认名；英文环境通过 `rewriteImagePaths()` 自动优先使用 `-en` 图。
11. 若真实页面需登录、权限或动态状态导致无法复现，最终回复说明阻塞点并列出未替换的图片。

## 渠道列表规则

凡出现渠道、集成、社媒平台或 agent/channel 平台列表，都以**目标区域**实际支持范围为准。

- 先确认该区域当前有多少通道及完整名称。优先从区域代码配置、区域文档源文件或真实站点确认，不要跨区域推断。
- 重点扫描 `Telegram / WhatsApp / ...`、`Telegram / WhatsApp / …`、`Telegram、WhatsApp、...`、`Telegram、WhatsApp、…` 这类写法。
- 列表看似列举全部渠道但不完整时，按该区域完整渠道集合补齐。
- 列表仅为示例时，也要使用该区域的渠道顺序，不沿用另一区域、旧文档或其他平台优先的排序。
- 国际站固定优先顺序：`Telegram / WhatsApp / Discord / WeChat / <其他国际站已支持渠道>`。任何以其他平台开头，或把 Discord、WeChat 排在 WhatsApp 前面的列表都要重排。
- 中文国际站使用中文标点时同样遵循该顺序，例如 `Telegram、WhatsApp、Discord、WeChat、...`。
- 国内站按国内站实际渠道列举，不要写入国内站未支持的渠道。

## 常见验证

文档小改：

- 检查 markdown 链接是否仍是相对 `.md` 或合法外链。
- 检查图片文件是否存在。
- 检查同区域各语言文件是否语义一致。
- 检查开篇摘要板块、字数门槛、事实密度、禁止事项是否满足。

涉及 sidebar、注册或路由：

- 检查 sidebar 与 slug 映射是否同步。
- 检查 `sync-fumadocs-content.mjs` 对应区域数组是否已注册。
- 检查国际站新增文件是否同时有 `global/` 与 `en/`。
- 建议运行 `cd frontend && pnpm check`，以及 `frontend/scripts/international-docs-parity.test.ts`。
