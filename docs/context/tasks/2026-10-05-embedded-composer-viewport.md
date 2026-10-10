---
id: task-2026-10-05-embedded-composer-viewport
type: task
scope: 修复 LightVela 嵌入聊天键盘可视高度约束，验证、提交、推送并正常 MR 合入 master。
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [frontend/src/pages/marketing/agent-chat-visual-viewport.ts, frontend/src/styles.css]
status: active
reviewed_at: 2026-10-05
review_due: 2026-11-05
revision: 1.1.0
derived: false
---

## goal
用户报告生产 embed 初始看不到输入框、拖动后出现；截图为 iOS Safari 键盘打开、光标可见但 Composer 外框/操作区不可见。先核对制品和几何，不凭截图归因。

## non_goals
不发布/重启生产、不修改独立 OpenCraft、不发送模型消息或创建 Bot、不使用任务卡。最新用户明确授权修复、提交、推送、合入 master；正常审核门禁不绕过。

## context_receipt
路由 `frontend opencraft embed mobile Safari input composer visual viewport keyboard production` 无命中；限定现有 viewport helper、AgentSettingsPage、Embedded Surface/元素、CSS 和相邻测试检索。已读根/frontend/opencraft AGENTS、maintenance skill 完整正文及 verification、chat-ui-architecture；前端邻接卡已在同会话读取并检查 viewport 测试邻居。错误路径 src/index.css、codex-composer src/*.css/scss、embedded-chat-canvas.tsx、components/chat* 均不存在，改按目录实际 rg --files/导入定位，不扩大无界检索。

## evidence
- 生产 `/__opencraft/version.json` source86601bb281b0、built2026-10-04T14:53:02.849Z。宿主HTML release20261004145754-86601bb281b0-cn，与embed匹配；不是刚合并!4971版本。
- mobile CSS容器height为--lv-agent-chat-viewport-height，fallback100dvh；视口helper绑定时计算，之后仅visualViewport resize/scroll/window scroll更新，没有元素位置/布局观察。
- 计算为visualViewport.pageTop+height减(elementRect.top-bodyRect.top)。这与截图的实际坐标关系是否一致待运行时取证；不得把“拖一下恢复”直接当确证。
- 生产CSS已确认包含该mobileheight规则。现有测试只模拟位置/事件，不证明真实iOS启动、自动聚焦和键盘布局。
- 用户明确确认“键盘打开后被遮住”，不是未打开键盘的首次加载缺框。
- 生产真实账号页面已读几何（隔离Chromium移动视口，真实API/TAT，不发送模型消息）：初始外层844px、输入区428–530px。诊断性仅将visualViewport.height投影为460、触发resize，不改layoutviewport；helper已写--height460px，但实际page仍844px/min-height844px，输入区仍428–530px，底部超出460px可见边界。临时浏览器inline minHeight=0后page460px，输入区253.5–355.5px全部可达。改动只存在隔离诊断浏览器，未改生产文件或用户会话数据。
- 匿名生产CSS同样可复现，无Host依赖：测试元素设置height460px但保留min-h-dvh时实际844px；移除该class后460px。CSSOM确认匹配两条规则：.lv-agent-embedded-chat-page min-height0在app layer，.min-h-dvh min-height100dvh在utilities layer；后者layer优先级胜出。这是确定的最小高度约束冲突，不再把早期“未观察布局变化”猜测当根因。
- 当前master到生产86601bb的viewport helper/styles无差异；当前AgentSettingsPage仍把min-h-dvh无条件加在chatPageRef根节点，刚合入的启动优化未修复它。
- 普通setViewportSize同时缩layout/visualviewport会让100dvh一起变小，因而隐藏这个缺陷；回归应保留layoutviewport高度，只缩visualviewport，再量真实容器/Composer按钮范围，而不是只断言CSS变量字符串。
- 两次短期审计登录均DELETE204撤销，18089自有forward/listener已关闭，未导出用户正文或凭据。诊断脚本仅在/tmp/opencraft-embed-composer-diagnostic-20261005-hLd0tb；没有真实iPhone/WebKit键盘验收，不宣称桌面合成viewport替代手机验证。

## next_action
最新授权下实现宿主最小高度选择：嵌入聊天使用 utilities layer 的 min-h-0，普通页面保留 min-h-dvh；不改已有 viewport 算法与监听，不添加延时或滚动补丁。补真实构建 CSS/DOM 回归，保留 layout viewport 仅缩 visual viewport，并验证负对照、恢复、普通页面和桌面行为，再正常 MR 合并。

## implementation_context_receipt
- 本轮路由 `frontend mobile embedded viewport gongfeng` 无命中；改用实际路径 `frontend/src/pages/marketing/agent-settings-page.tsx` 命中 frontend-product-surface/service-frontend/site-environment-routing。
- 主 Agent 完整读取根/frontend AGENTS、frontend-runtime-openspec-i18n 邻接卡、frontend 服务/domain pack、维护 skill 正文与 verification、Gongfeng skill/依赖、相邻 viewport 测试与 frontend DESIGN。未命中新规格，未改环境路由、locale 或协议。
- 工作分支 fix/lightvela-embed-keyboard-viewport-20261005 基于新鲜 origin/master；原有启动任务文档、optimization-queue 和 .kube 未纳入改动。

## verification
- `npm run check`：通过，166 current/171 baseline/0 new；已有翻译空白等47条告警不属于本改动。
- 聚焦 `agent-chat-visual-viewport`、`opencraft-embedded-workbench.cn`、`opencraft-resource-preparation`、`agent-settings-sdk-boundary`：4文件25测试通过。
- `npm run build:cn`：完整Next构建及SEO检查通过；未开启静态版本目录选项，版本目录检查按既有环境跳过，本改动不涉及缓存声明。
- `node scripts/check-agent-chat-viewport.mjs`：真实构建CSS及源码helper通过Chromium几何回归。保持layout844、visual460，修复root460/Composer fixture360–460；旧样式负对照root844/fixture744–844。pan40后root500，收起恢复844，草稿/焦点保持、解绑、普通页面、桌面行为均通过。运行需测试环境提供Playwright/Chromium，不在产品运行时新增依赖。
- 浏览器输入区为几何fixture，没有模拟模型/Host会话；不宣称真实iPhone/WebKit系统键盘验收。
- 广范围marketing执行退出1：113/133文件通过，1698测试通过、25失败、5 worker错误/OOM；没有宣称全套全绿。单独核对：旧sidebar源码正则在原origin/master同样不匹配，Tea包解析缺失；其余广范围失败未在本任务逐项归因，未借此扩大改动。
- Agent Console只读同步：130文件通过，无生成漂移；docs-impact无匹配规则；documentation检查无errors/broken links。
- 构建改写的next-env/font已恢复，不进入提交；无生产发布和账号写操作。
- Gongfeng MCP客户端及常见宿主配置均不存在；复用仓库CI已有受保护token与API helper作fallback，GET /user新鲜确认skipzhang，不复制或输出凭据。

## delivery
精确提交本任务源码、测试、浏览器回归及Task Pack；正常MR合并须由工蜂审核门禁决定，不绕过。提交前新鲜fetch确认分支基底与origin/master均为e0c1f1b373d332519cf35c19a9ce2c547ad42677，无需额外整合。
