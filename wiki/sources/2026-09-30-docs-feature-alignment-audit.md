# 2026-09-30 国内 / 国际站文档与产品能力对齐评估

## 评估范围

- 基线分支：`origin/master` / `f42e2e645`。
- 区域：国内站 `lightvela.com/docs` 与国际站 `lightvela.ai/docs`。
- 核对依据：
  - 实际控制台走查：概览、通道、技能、定时任务、人设、记忆、成就、诊断中心、高级设置、工作台、DeepSeek Harness、网页对话。
  - 源码入口：`frontend/src/pages/marketing/agent-settings-page.tsx`、`agent-achievements-panel.tsx`、`agent-routes.ts`。
  - 文档注册：`frontend/src/config/docs-sidebar.ts`、`frontend/scripts/sync-fumadocs-content.mjs`、`frontend/next-site/docs-route-manifest.ts`。

## 总结

最新 `origin/master` 已补上网页对话、钉钉、工作台、DeepSeek Harness、诊断中心、高级设置、云存储、定时任务等主要页面。本轮系统评估后，明确需要处理的差异主要有三类：

1. 新增「成就」文档：产品已有成就页，文档缺页、sidebar 缺入口、slug 和同步注册缺失。
2. 修改国内站文档导航分组：控制台实际为「成长」分组，人设 / 记忆 / 成就应聚合展示。
3. 修正国际站 Memory 文档口径：管理台当前是查看内容与容量、通过对话增删记忆，不应写成在控制台直接 edit / clear。
4. 重核国内站钉钉通道：钉钉确认为国内站 `domesticOnly` 通道，支持扫码连接与 Client ID / Secret 手动绑定；原文流程偏薄，已按实机页面重写。
5. 清理国内站其他文章的旧通道口径：将仍写成“微信、飞书、QQ”的国内站 FAQ、对比页和 Hermes Agent 长文改为当前五通道口径；群聊等未完全确认的能力改为保守表述。

## 已落地修改

| 类型 | 区域 | 文档 / 配置 | 处理方式 | 核对依据 |
| --- | --- | --- | --- | --- |
| 新增 | CN + Global | 成就 / Achievements | 新增国内站、国际站中文、英文、印尼语、西班牙语、日语、韩语源稿。 | 控制台存在「成长 → 成就」；源码有 `achievement` 路由、面板、i18n、测试。 |
| 修改 | CN | sidebar 分组 | 新增「成长」分组，并将人设、记忆、成就放入该组；同步 `cnDocs` 分组。 | 控制台设置导航分组为「成长」，包含人设、记忆、成就。 |
| 修改 | Global | Memory 文档摘要 | 去掉“console 可 edit / clear memory”的表述，改为“console 查看内容和容量，通过对话记住或忘记”。 | 实际页面显示 MEMORY.md / USER.md 内容和容量；文档内后文也写明通过对话增删。 |
| 修改 | CN | 配置通道 - 钉钉 | 按当前能力重写接入流程、验证方式、失败处理和能力边界。 | `dingtalk` 在国内通道集合存在并标记 `domesticOnly`；扫码平台支持 `dingtalk`；手动绑定使用 Client ID / Client Secret；国际站过滤 domesticOnly。 |
| 修改 | CN | 人设、记忆 | 将“微信 / 飞书 / QQ”示例改为国内站五通道口径，避免误解企业微信、钉钉不共享人格和记忆。 | 国内站通道列表为微信、QQ、企业微信、飞书、钉钉。 |
| 修改 | CN | FAQ、对比页、Hermes Agent 消息网关长文 | 统一国内站通道口径为微信、QQ、企业微信、飞书、钉钉；对群聊 / 多人场景改为“目标通道明确支持时再验证”。 | 国内站实机通道页与通道配置源码均显示五通道；本轮未确认所有通道的群聊能力。 |
| 新增图片 | CN + Global | 成就、钉钉通道 | 新增裁剪脱敏截图：`achievements-overview.webp`、`achievements-overview-en.webp`、`achievements-overview-zh-hant.webp`、`achievements-overview-id.webp`、`achievements-overview-es.webp`、`achievements-overview-ja.webp`、`achievements-overview-ko.webp`、`channels-overview-cn.webp`、`dingtalk-connect-methods-cn.webp`；成就截图已放入国内站和 global/en/id/es/ja/ko 多语言成就页，钉钉截图仅放入国内站钉钉页。 | 成就页已按用户补充截图替换为各语言高清图；截图不包含账号侧栏、浏览器地址栏、Token、二维码或个人敏感信息。 |
| 修复图片路径 | Global | 多语言源稿图片引用 | 批量修正 `global/en/id/es/ja/ko` Markdown 源稿中的图片相对路径，使其从源文件位置能真实解析到 `frontend/src/content/docs/images`。 | 走查发现多语言源稿大量沿用生成产物视角的 `../images` / `./images` 前缀，源文件侧图片检查报缺图；本轮修正 298 个文件、899 条图片引用，源文件图片缺失数降为 0。 |
| 同步 | CN + Global | sidebar / slug / fumadocs / route manifest / last-updated | 注册 `configuration/achievements`，同步生成多语言路由与更新时间。 | 文档站页面由 `.fumadocs-content` 与 route manifest 驱动。 |
| 台账 | CN + Global | `lightvela-docs-content-categories.md` | 增加「成就」内容项，状态为 CN ✓ / GLOBAL ✓。 | 新页源稿、注册和同步产物已齐备。 |

## 需要后续确认但本轮不直接改的项

| 项目 | 当前观察 | 建议 |
| --- | --- | --- |
| 定时任务「新建」按钮 | 用户确认该入口就是定时任务创建表单，不是路由问题。 | 不再列为产品 bug；后续只需在补截图时确认表单字段与文档步骤一致。 |
| 国际站正式截图 | 成就页已补 en-us、zh-hant、id-id、es、ja-jp、ko-kr 高清实机截图；zh-sg 继续使用简中截图。 | 本轮成就页多语言截图已齐。若后续其他页面也要逐页替换截图，可按同一命名规则补 `-en` / `-zh-hant` / `-id` / `-es` / `-ja` / `-ko` 变体。 |
| 国际站完整实机登录 | 本轮实机登录主要是国内站；国际站能力通过共享控制台源码、i18n 与注册表确认。 | 若上线前要求更严格，可用国际站账号补一次 lightvela.ai 控制台逐页截图。 |
| Slack 文档状态 | 复核后确认 Slack 是国际站真实通道：前端国际通道集合包含 Slack，sidebar、slug map、sync manifest 与 route manifest 均已注册；国内站通道集合会过滤 Slack。 | 本轮不再把 Slack 视为配置缺失。若后续要做 Slack 文档质量提升，可单独补实机截图和第三方平台步骤核对。 |
| 通道面板帮助链接 | 代码中通道帮助链接统一指向 `lightvela.ai/docs/...`，其中钉钉链接会指向国际站未注册页面。 | 建议前端后续按区域生成帮助链接：国内站使用相对 `/docs/configuration/channel-dingtalk` 或 `lightvela.com`。本轮仅修文档正文，不改产品代码。 |

## 已覆盖且暂不需要新增页面的能力

| 能力 | 结论 |
| --- | --- |
| 网页对话 | 最新 master 已有 `configuration/agent-chat`，国内 / 国际均注册。 |
| 管理与切换 Bot | 最新 master 已有 `configuration/bots-switching`，并与套餐 Bot 数口径对齐。 |
| 钉钉 | 国内站已有 `configuration/channel-dingtalk`，国际站不暴露，符合区域差异。 |
| 技能 / SkillHub | 最新文档已覆盖技能市场、技能包、已安装等入口；不新增页面。 |
| 人设 / Soul | 已有 `configuration/personality`，本轮仅调整国内站分组，不改正文主流程。 |
| 记忆 | 已有 `configuration/memory`，本轮修正国际站摘要误述。 |
| 诊断中心 | 已有 `configuration/diagnostics`，覆盖重置模型配置、重置 Hermes、会话修复、备份恢复、日志查询导出等方向。 |
| 高级设置 | 已有 `configuration/advanced-settings`，覆盖审批、记忆、用户画像、上下文压缩。 |
| 工作台 | 已有 `configuration/workbench`，Beta 实验功能；不新增页面。 |
| DeepSeek Harness | 已有 `configuration/deepseek-harness`，Beta 实验功能；不新增页面。 |

## 口径扫查说明

- 国内站文档正文中旧的“微信、飞书、QQ”三通道表述已清零。
- 国内站文档没有发现 `lightvela.ai/docs`、国际站 / 海外站跳转口径或 TODO / 内测类发布风险词。
- `hermes-agent/01-hermes-vs-openclaw.md` 仍出现 WhatsApp、Telegram、Slack、Discord，但该段是在解释第三方 OpenClaw Gateway 能力，不是在承诺 LightVela 国内站支持范围，按对比文章上下文保留。

## 验收建议

1. 确认国内站 docs sidebar 是否接受新增「成长」分组。
2. 单独决定是否修通道帮助链接和是否补国际站实机截图 / `-en` 图片。
