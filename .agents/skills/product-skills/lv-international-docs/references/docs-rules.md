# 国际站文档规则

## 当前目录

主要内容在：

```text
frontend/src/content/docs/
  *.md                         # 国内站文档
  configuration/*.md           # 国内站配置文档
  global/*.md                  # 国际站中文文档（zh-sg / Intl 中文）
  global/configuration/*.md
  en/*.md                      # 国际站英文文档（en-us / Intl English）
  en/configuration/*.md
  images/*                     # 中英文文档图片资源
```

## 加载规则

`frontend/src/lib/docs/docs-loader.ts` 定义了文档加载优先级：

- 国内站：只读 `frontend/src/content/docs/<file>`.
- 国际站英文：优先读 `frontend/src/content/docs/en/<file>`，缺失时 fallback 到 `frontend/src/content/docs/global/<file>`.
- 国际站中文：只读 `frontend/src/content/docs/global/<file>`.

因此，改国际站时不要依赖根目录 `docs/<file>`。根目录通常是国内站真源。

## 路由与语言

国际站 docs 主要路由：

- 默认英文裸路径：`/docs/...`
- 英文显式路径：`/en-us/docs/...`
- 国际站中文路径：`/zh-sg/docs/...`

`frontend/src/app/(site)/[lang]/docs/[[...slug]]/page.next.tsx` 中：

- global 构建支持 `en-us` 与 `zh-sg`.
- cn 构建支持 `zh-cn`.

## Sidebar 与 slug

`frontend/src/config/docs-sidebar.ts` 控制：

- 国际站 sidebar：`GLOBAL_SIDEBAR`
- 国内站 sidebar：`CN_SIDEBAR`
- 国际站 slug 到文件：`GLOBAL_SLUG_TO_FILE`
- 国内站 slug 到文件：`CN_SLUG_TO_FILE`

新增国际站页面时：

1. 在 `GLOBAL_SIDEBAR` 加菜单项。
2. 在 `GLOBAL_SLUG_TO_FILE` 加 slug -> file 映射。
3. 创建 `global/<file>` 中文稿。
4. 创建 `en/<file>` 英文稿。
5. 不要顺手加入 `CN_SIDEBAR` / `CN_SLUG_TO_FILE`，除非用户明确要求国内站也上线。

## 共享页拆分规则

当一个页面现在只有根目录文件，或英文 fallback 到 `global/`：

- 如果任务是“国际站 only”，先补齐国际站独立文件。
- 如果已有 `global/<file>` 但没有 `en/<file>`，先从 `global/<file>` 生成英文本地化版本。
- 如果根目录国内站文件和国际站内容有差异，不要通过修改根目录来服务国际站。

## 先中文后英文

推荐编辑顺序：

1. 先把国际站中文稿写在 `global/<file>`。
2. 再基于中文稿生成 `en/<file>`。
3. 英文不是逐字翻译，要符合国际用户语境：
   - WeChat 可保留，但解释使用场景。
   - Feishu 在英文文档中通常写 Lark。
   - 企业微信通常写 WeCom。
   - 国内实名认证、国内支付、国内专属入口不要进入国际站，除非页面明确说明。

保持两份文档：

- 同一信息架构。
- 同一步骤顺序。
- 同一警告/限制语义。
- 链接目标都指向国际站可用页面。

## 图片规则

图片统一放在 `frontend/src/content/docs/images/`。

`rewriteImagePaths()` 会在英文 locale 下优先寻找同名 `-en` 图片：

```text
xxx.webp      # 默认图片
xxx-en.webp   # 英文环境优先使用
```

Markdown 里可以仍引用默认名：

```markdown
![](../images/xxx.webp)
```

英文环境如果存在 `xxx-en.webp`，构建时会自动替换成英文图。

编辑图片时：

- 如果中文文档新增 `xxx.webp`，英文文档通常需要 `xxx-en.webp`。
- 如果英文文档直接引用已有中文 UI 截图，要提醒补英文截图。
- 如果图片没有 UI 文案或语言无关，可以复用，不必强行创建 `-en`。
- 如果使用 `<img src="../images/xxx.webp" width="360" />`，同样需要检查是否有 `xxx-en.webp`。
- 图片更新必须覆盖 markdown 当前引用的既有图片文件。不要新增新文件再改 markdown 引用，除非用户明确要求新增图片。
- 不要替换第三方平台或手机 App 截图，例如 BotFather、Discord Developer Portal、WhatsApp、QQ/WeCom/Lark 管理后台、系统相册、聊天 App 内界面。只有旧图明确是 LightVela 站内 UI，且能在真实 `lightvela.ai` 页面复现，才替换。

## Browser 截图替换规则

当用户要求检查、更新、替换、校正文档截图，或表达“图片不对 / 图片过期 / 图片和页面不一致”等相近含义时：

1. 先扫描目标 markdown 当前引用的图片路径，并确认 live docs 实际会使用哪个文件：
   - 中文国际站通常使用 markdown 引用的默认图。
   - 英文国际站若存在同 basename 的 `-en` 图，live docs 会优先使用 `-en` 图。
   - 替换时直接覆盖这些实际生效的既有文件，不要新建旁路图片。
2. 使用 Codex Browser 打开国际站真实页面，不要只看本地文件或旧图片。
3. 根据文档内容定位同一功能页面；涉及 Agents 时优先检查 `https://lightvela.ai/agents` 及对应详情/相似页面。
4. 对比文档中已有图片是否与真实网站同一页面一致，包括布局、文案、语言、按钮、卡片和可见状态。
5. 如果旧图不是 LightVela 站内 UI，或者真实站点没有同类页面/弹窗，不要替换该图。
6. 截图前必须等待真实内容加载完成：
   - 页面文本中不应再出现 `loading...`、`Loading...`、`加载中...`。
   - 目标卡片、表单、弹窗或列表必须可见。
   - 若页面长期停留 loading，最终说明该图未替换及原因。
7. 截图必须只包含网页页面内容，不包含 Chrome 标签栏、地址栏、书签栏、系统窗口边框等浏览器外壳。
8. 对弹窗/敏感内容截图：
   - 点击 `Connect` / `+ 连接` 后出现二维码时，截图弹窗，并用灰色方块覆盖二维码中心区域。
   - 出现 Token、AppID、AppSecret、code 等输入框时，可在 Browser 中输入随机占位值来复现状态，但落盘前必须用灰色矩形覆盖输入值。
   - 遮罩应覆盖敏感内容主体，不要只做模糊效果；优先使用不透明或半透明灰色矩形。
9. 同一文档页面的两种国际站语言都要处理：
   - 中文国际站：使用 `zh-sg` 对应页面截图，写入或替换默认图片，例如 `xxx.webp`。
   - 英文国际站：使用英文默认路径或 `en-us` 对应页面截图，写入或替换 `xxx-en.webp`。
10. 截图落地后，确认 markdown 图片路径仍指向默认名；英文环境会通过 `rewriteImagePaths()` 优先使用 `-en` 图片。
11. 如果真实页面需要登录、权限或动态状态导致无法复现，最终回复要说明阻塞点，并列出哪些图片未能替换。

## 渠道列表规则

国际站文档中凡是出现渠道、集成、社媒平台或 agent/channel 平台列表，都以国际站实际支持范围为准。

执行要求：

- 先确认国际站当前一共有多少通道，以及完整渠道名称。优先从国际站代码配置、国际站文档源文件或 `lightvela.ai` 真实页面确认，不要用国内站列表推断。
- 重点扫描括号或行文中的列表写法，例如 `Telegram / WhatsApp / ...`、`Telegram / WhatsApp / …`、`Telegram、WhatsApp、...`、`Telegram、WhatsApp、…`。
- 如果这类列表看起来在列举所有渠道但没有包含全部国际站渠道，必须基于国际站完整渠道集合补齐。
- 如果这类列表只是示例，也必须使用国际站渠道顺序，不要沿用国内站、旧文档或其他社媒平台优先的排序。
- 固定优先顺序为：`Telegram / WhatsApp / Discord / WeChat / <其他国际站已支持渠道>`。
- 任何以其他社媒平台开头，或将 Discord、WeChat 排在 WhatsApp 前面的列表，都要重排。
- 中文国际站使用中文标点时同样遵循该顺序，例如 `Telegram、WhatsApp、Discord、WeChat、...`。

## 常见验证

文档小改：

- 检查 markdown 链接是否仍是相对 `.md` 或合法外链。
- 检查图片文件是否存在。
- 检查 `global/` 和 `en/` 是否语义一致。

涉及 sidebar 或路由：

- 检查 `GLOBAL_SIDEBAR` 与 `GLOBAL_SLUG_TO_FILE` 同步。
- 检查新增文件同时有 `global/` 和 `en/`。
- 建议运行 `cd frontend && pnpm check`。
