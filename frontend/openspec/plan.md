# DeepSeek Harness 实验室入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `test-driven-development` before implementation and `verification-before-completion` before claiming completion. This FE-AI plan is the execution source for the DeepSeek Harness lab entry; do not commit, push, create MR, or archive until user acceptance.

**Status:** 真实接入、方案 A、运行态卡片高度收紧及模型配置覆盖反馈均已完成并通过本地验证，等待用户验收。未安装远端实例、未提交、未推送、未创建 MR。

**Goal:** 在 `/agents` 控制台中新增“管理 > 实验室 > DeepSeek Harness”二级入口，并提供真实安装、运行状态、WebUI 访问和 Provider 配置体验。

**Architecture:** 安装、状态查询、安装进度、重启和模型配置全部复用现有 `BotRepository.execDebugCommand` 与 `/v1/instances/:id/debug/exec`，不新增 DeepSeek Harness 专用 ctl 或 gateway 接口。实例侧固定管理脚本负责版本、目录、Provider 白名单和 DSH 回环 RPC；dsh 以系统级 `deepseek-harness.service` 运行并监听 `127.0.0.1:3080`。API Key 只写、不回显、不进入 URL 或前端持久化。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript 5.9、Tailwind CSS v4、lucide-react、Vitest 4、Testing Library。

## Global Constraints

- 入口固定为左侧导航“管理 > 实验室 > DeepSeek Harness”，DeepSeek Harness 不作为一级左导航出现。
- 路由采用 `/agents/labs/deepseek-harness`；不新增 `/agents/deepseek-harness` 旁路。
- 两条抢先体验公告位于 DeepSeek Harness 卡片上方，不嵌入卡片。
- 未安装态必须展示 DeepSeek Harness Logo、标题后的 `Beta`、指定简介，以及简介下方的“即刻安装体验”按钮。
- 安装中态在简介下方展示真实任务进度和“请稍等片刻，安装大约需要 1-3 分钟”，完成后通过淡出/淡入切换卡片内容。
- 已安装态移除简介，不展示静态 WebUI 地址，只展示 Logo、标题、`Beta`、运行状态，以及右侧“访问 WebUI”和“重启”。
- 不展示安装时间、最近启动时间、异常态主按钮置灰或查看诊断。
- 当前接入现有 `debug/exec`、TAT 同源代理与回环健康检查；真实 `xxxxx.dsh.lightvela.site` 域名仍不在本期范围。
- 本阶段只开发代码与本地测试；不得安装目标实例、重启远端服务或接入真实凭据。
- 模型配置按 Provider + API Key 实现；本期不提供具体 model ID 选择。
- LightVela `deepseek` 固定映射到 DSH 原生 `deepseek-official`。
- 固定版本为 `@deepseek-ai/dsh@0.1.0-rc.7`、`@cocofhu/skillhub@0.2.13`、`deepseek-harness-qqbot@0.1.5`、`deepseek-harness-weixin@0.2.5`、`deepseek-harness-wecom@0.1.5` 与 `deepseek-harness-lark@0.1.5`，真实安装前必须完成北京 Sandbox 组合冒烟。
- 首批真实安装只进入北京 Sandbox；`debug/exec` 已是现有通道，本需求不新增 service-gateway allowlist。
- `*.dsh.lightvela.site` 就绪前，WebUI 使用登录态下的同源 TAT 虚拟代理。
- Logo 使用产品提供的 SVG：`https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/ae53bb41-9387-4f31-b264-0e4fd747e20b.svg`。
- UI 保持 Agent 控制台工具型风格：页面卡片使用 `rounded-md`、轻边框和 `0 10px 30px rgba(15,23,42,0.04)` 级别阴影；不做营销 hero、不嵌套卡片。
- 新增用户可见中文需走 `useT()`，实现后按影响范围运行 i18n 检查。

## Scope And Decision

### 采用方案：独立 Lab section + 独立 Panel

- 在 `agent-routes.ts` 中增加 DeepSeek Harness section id 与 lab slug 解析。
- 新增 `agents/labs/[lab]` App Router 页面，避免污染现有 `/agents/[section]` 单段 section 路由。
- 在 `AgentSettingsPage` 内把“实验室”作为“管理”分组下的可展开导航项，子项 DeepSeek Harness 指向 `/agents/labs/deepseek-harness`。
- 页面主体抽到 `agent-deepseek-harness-panel.tsx`，减少继续膨胀 `agent-settings-page.tsx`。

### 备选方案与取舍

- 备选 A：把 DeepSeek Harness 直接作为“管理”下普通平级项。实现最短，但不满足用户明确要求的“实验室可展开二级导航”，不采用。
- 备选 B（第一版记录）：复用现有 `browser` / `TatHermesWebPanel` 代理链路直接嵌入 WebUI。当时未采用；Task 7 已在不嵌入页面的前提下复用并扩展该链路。
- 备选 C（第一版记录）：先做后端安装接口再上前端入口。当时未采用；Task 7 已在入口验证后补齐真实安装接口。

## File Map

- Modify: `frontend/src/lib/agent-routes.ts`
  增加 DeepSeek Harness section id、`/agents/labs/deepseek-harness` path、lab slug helper。
- Create: `frontend/src/app/(site)/agents/labs/[lab]/page.next.tsx`
  承接 `/agents/labs/deepseek-harness`，非法 lab 返回 `notFound()`。
- Modify: `frontend/src/observability/datong-page-map.ts`
  为新增 section 补齐 pgid 映射，当前无独立 pgid 时归到 `agents_home`，避免类型和上报断层。
- Create: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
  承载状态查询、安装轮询、失败恢复、重启、同源 WebUI 链接与模型配置入口。
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
  接入 panel；导航模型支持“实验室”二级展开；引入合适 lucide 图标。
- Modify: `frontend/src/styles.css`
  补充二级导航样式、移动端布局、激活态和 focus 样式。
- Test: `frontend/src/lib/__tests__/agent-routes.test.ts`
  锁定 lab path 与 slug helper。
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
  锁定“实验室”位于“管理”分组，DeepSeek Harness 是其二级项。
- Test: `frontend/src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx`
  覆盖三态文案、Logo、按钮和 WebUI 链接。
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx`
  覆盖“实验室”展开/收起、选中态和 DeepSeek Harness 页面渲染。

---

### Task 1: 路由与 Section 模型

**Role:** Developer

**Files:**
- Modify: `frontend/src/lib/agent-routes.ts`
- Create: `frontend/src/app/(site)/agents/labs/[lab]/page.next.tsx`
- Modify: `frontend/src/observability/datong-page-map.ts`
- Test: `frontend/src/lib/__tests__/agent-routes.test.ts`

**Interfaces:**
- Produces: `AgentSettingsSectionId` 新增 `"deepseek-harness"`。
- Produces: `AGENT_SECTION_PATH_BY_ID["deepseek-harness"] === "/agents/labs/deepseek-harness"`。
- Produces: `AGENT_LAB_SECTION_ID_BY_SLUG["deepseek-harness"] === "deepseek-harness"` or `getAgentLabSectionFromSlug("deepseek-harness") === "deepseek-harness"`。
- Preserves: `getAgentSectionFromSlug("deepseek-harness") === null`，防止 `/agents/deepseek-harness` 成为旁路。

**Acceptance:**
- `/agents/labs/deepseek-harness` 可以渲染 `AgentsPageClient` 并传入 DeepSeek Harness section。
- `/agents/[section]` 原有 channel/model/skills 等路径不受影响。
- 未知 lab slug 返回 `notFound()`。
- Datong 页面解析不因新增 section type 编译失败；无独立 pgid 前按 `agents_home` 兜底。

- [x] 增加 `agent-routes.test.ts` 失败用例，断言 lab path、lab slug helper、无单段旁路。
- [x] 更新 `agent-routes.ts` 的类型、path map 和 lab slug helper。
- [x] 新增 `agents/labs/[lab]/page.next.tsx`，复用 `AgentsPageClient`。
- [x] 补齐 `datong-page-map.ts` 的新增 section 映射或显式兜底。
- [x] 运行 `cd frontend && pnpm exec vitest run src/lib/__tests__/agent-routes.test.ts`。

### Task 2: DeepSeek Harness Panel

> 第一版历史实现记录；真实接口与模型配置由 Task 7 替代。

**Role:** Developer

**Files:**
- Create: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx`

**Interfaces:**
- Produces: `<AgentDeepSeekHarnessPanel />` 第一版三态组件。
- Logo: `DEEPSEEK_HARNESS_LOGO_URL` 使用产品提供的 SVG。

**Acceptance:**
- 初始未安装态展示 Logo、`DeepSeek Harness`、标题后的 `Beta`、用户确认的简介、两条公告和右上角“即刻安装体验”。
- 点击“即刻安装体验”后进入安装中态，按钮 loading 且不重复提交。
- 演示安装完成后切到已安装态，保持产品信息区不变并展示 `运行中`、“访问 WebUI”和“重启”。
- “访问 WebUI”是带 `target="_blank"`、`rel="noopener noreferrer"` 的主按钮链接。
- “重启”是次按钮，本阶段使用本地 loading 状态演示并阻止重复提交。
- 页面不出现“安装时间”“最近启动时间”“查看诊断”。

- [x] 先写 panel 失败测试，覆盖未安装态、安装中态、已安装态和禁用文案缺失。
- [x] 创建 `AgentDeepSeekHarnessPanel`，复用 `AgentSectionHeader` 与本地轻量状态机。
- [x] 使用 lucide `ExternalLink` / `Loader2` 等图标，按钮文字不被图标替代。
- [x] 运行 `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx`。

### Task 3: 左侧导航二级实验室入口

**Role:** Developer

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx`

**Interfaces:**
- Consumes: `AGENT_SECTION_PATH_BY_ID["deepseek-harness"]`。
- Produces: Manage group 中的 expandable item：`实验室 -> DeepSeek Harness`。
- Produces: `activeSection === "deepseek-harness"` 时，实验室自动展开，子项 `aria-current="page"`。

**Acceptance:**
- “实验室”出现在“管理”分组内，且不是一级导航分组。
- 点击“实验室”只展开/收起，不直接跳转。
- 点击二级项“DeepSeek Harness”跳转 `/agents/labs/deepseek-harness`。
- 选中 DeepSeek Harness 时，“实验室”保持展开。
- 桌面端二级项缩进清晰；移动端不溢出、不挤压、不横向滚动。
- 导航具有可访问语义：展开按钮有 `aria-expanded`、`aria-controls`，当前页有 `aria-current="page"`。

- [x] 扩展 `agent-settings-nav-order.test.ts`，用源码结构锁定“管理”内 `files -> diagnostics -> labs -> deepseek-harness`。
- [x] 新增 `agent-settings-labs-nav.test.tsx`，渲染 `AgentSettingsPage sectionId="deepseek-harness"` 并断言展开态、选中态与链接。
- [x] 调整 `SettingsSection` 导航数据结构，使其支持普通 section 和 expandable labs item。
- [x] 接入 `AgentDeepSeekHarnessPanel` 到 section 分发。
- [x] 补充 `.lv-agents-nav-subitems`、`.lv-agents-nav-expand-toggle`、移动端 grid span 样式。
- [x] 运行 `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-order.test.ts src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx`。

### Task 4: i18n、质量门禁与人工验收

**Role:** Developer + Reviewer

**Files:**
- Modify as generated if needed: `frontend/src/i18n/generated/*.json`
- Verify: `frontend/openspec/plan.md`

**Acceptance:**
- 新增中文文案已被 i18n 生成与检查覆盖。
- TypeScript 检查通过。
- 相关 Vitest 通过。
- 本地预览确认 `/agents/labs/deepseek-harness` 可以进入、安装演示可切换、WebUI 外链可打开。
- 不提交、不推送、不创建 MR；等待用户验收。

- [x] 运行 `cd frontend && pnpm i18n:extract`，如生成字典变化则检查中文/英文 key 是否合理。
- [x] 运行定向测试：
  - `cd frontend && pnpm exec vitest run src/lib/__tests__/agent-routes.test.ts src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx src/pages/marketing/__tests__/agent-settings-nav-order.test.ts src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx`
- [x] 运行质量门禁：
  - `cd frontend && pnpm check`
  - `cd frontend && pnpm i18n:check`
  - `git diff --check`
- [x] 启动本地预览并检查桌面/移动端：
  - `cd frontend && pnpm exec next dev -H 127.0.0.1 -p 5175`
  - 访问 `/agents/labs/deepseek-harness`
  - 验证左导“管理 > 实验室 > DeepSeek Harness”、未安装态、安装中态、已安装态和“打开 WebUI”。
- [x] 汇总变更、验证结果、截图/观察结论与剩余风险，停在用户验收确认点。

### Task 5: 用户验收反馈调整

**Role:** Developer + Reviewer

**Files:**
- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx`
- Modify: `wiki/prd-docs/2026-08-20-deepseek-harness-lab.md`
- Modify as generated: `frontend/src/i18n/generated/*.json`

**Acceptance:**
- `Beta` 紧跟 `DeepSeek Harness` 标题；“即刻安装体验”位于卡片右上角操作位。
- 描述下方持续展示同环境说明与抢先体验风险公告。
- 安装完成后产品信息区不变，分割线下展示运行状态、静态地址、主按钮“访问 WebUI”和次按钮“重启”。
- 重启在演示阶段提供 loading、完成播报和重复提交保护，不触发后端请求。

- [x] 先调整 Panel 测试并确认旧实现 RED。
- [x] 实现新布局、公告条和本地重启状态并确认 Panel 测试 GREEN。
- [x] 同步更新 PRD 与实现计划，撤销旧版“无重启操作”约束。
- [x] 重新生成并补齐 i18n 字典，运行定向测试和质量门禁。
- [x] 在桌面端和 390px 移动端复验未安装、安装完成、重启和无溢出状态。
- [x] 完成独立复审并停在用户验收确认点。

### Task 6: 第二轮用户验收反馈调整

**Role:** Developer + Reviewer

**Files:**
- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx`
- Modify: `wiki/prd-docs/2026-08-20-deepseek-harness-lab.md`
- Modify as generated: `frontend/src/i18n/generated/*.json`

**Acceptance:**
- 公告位于卡片上方；卡片内不重复展示公告。
- 未安装态的安装按钮位于简介下方。
- 安装中态展示可访问的模拟进度条、百分比和 1-3 分钟等待提示。
- 安装完成时先淡出引导卡片，再切换并淡入运行卡片。
- 运行卡片不展示简介和静态 URL，左侧展示状态，右侧展示“访问 WebUI”和“重启”。

- [x] 先调整 Panel 测试并确认旧实现 RED。
- [x] 重构卡片外公告、安装进度和双卡片淡出/淡入切换，确认 Panel 测试 GREEN。
- [x] 重新生成 i18n 字典并补齐本次新增英文、印尼语文案。
- [x] 同步 PRD，运行定向测试与质量门禁。
- [x] 复验桌面端和 390px 移动端的三态、动画、操作及无溢出。
- [x] 修正复审发现的安装焦点断档、动画完成时序和进度条布局动画问题。
- [x] 完成独立复审并停在用户验收确认点。

### Task 7: 模型配置与真实安装接入（历史方案，已由 Task 8 纠偏）

**Role:** Planner + Developer + Reviewer

**Planning Evidence:**
- 已只读检查 DSH WebUI 的 Models / Add provider 交互和 Provider 目录。
- 已核对 DSH 官方 `settings.mutate`、`credentials.set`、`llm.providers` 契约及只写凭据语义。
- 已核对 `@cocofhu/skillhub@0.2.13` 的安装命令、Node 要求和重启要求。
- 已只读检查参考机的 systemd、回环监听、Caddy 代理与运行版本，未修改远端状态。
- 已更新 `wiki/prd-docs/2026-08-20-deepseek-harness-lab.md`，等待用户确认五项产品与版本边界。

**Proposed Files:**
- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
- Create: `frontend/src/lib/dsh-config-client.ts`
- Create: `frontend/src/lib/dsh-provider-catalog.ts`
- Modify: `frontend/src/lib/tat-http-virtual-client.ts` or add a DSH-specific wrapper
- Modify: `frontend/src/repositories/types.ts` and `frontend/src/repositories/http-repositories.ts`
- Modify backend service selected during implementation planning for typed status/install/restart APIs
- Create a checked-in, idempotent instance installer under the Hermes image/helper ownership boundary
- Add focused frontend, backend, installer and proxy tests

**Acceptance:**
- 已安装主卡片下方展示模型配置卡片，支持当前站点白名单内的多 Provider 添加和 API Key 更新。
- 国内站 Provider：`deepseek`、`minimax-cn`、`moonshotai-cn`、`qwen-token-plan-cn`、`openrouter`。
- 国际站 Provider：`deepseek`、`minimax`、`minimax-cn`、`moonshotai`、`moonshotai-cn`、`openrouter`、`anthropic`、`groq`、`openai`。
- LightVela `deepseek` 映射到 DSH 原生 `deepseek-official`。
- API Key 只写、不回显，不进入日志、URL、埋点或浏览器持久化；Task 8 改为经 `debug/exec` 的 base64 shell 安全编码传输。
- 安装固定版本的 dsh 和 SkillHub；Task 8 改为系统级 `deepseek-harness.service`，通过 `User=agentuser` 降权并监听回环 3080。
- Task 8 将安装、状态查询、重启和模型配置统一改走现有 `debug/exec`，安装任务仍幂等且支持失败回滚。
- WebUI 访问地址由受鉴权链路返回，页面不展示静态 IP。

- [x] 用户确认“模型选择”按 Provider + API Key 理解，本期不提供具体 model ID 选择。
- [x] 用户确认 `deepseek -> deepseek-official`、`dsh@0.1.0-rc.7`、`skillhub@0.2.13` 与北京 Sandbox 首批灰度。
- [x] 用户确认真实域名前使用登录态下的同源 TAT 虚拟代理。
- [x] **历史批次 A：实例安装与状态接口。** 曾新增 DSH 专用 ctl 与 gateway 路由；用户评审后判定为重复设计，已在 Task 8 全部删除。
- [x] **历史批次 B：DSH 配置与 WebUI 传输。** WebUI 的 3080 TAT broker 保留；前端直连 DSH 配置 RPC 已在 Task 8 替换为实例 helper + `debug/exec`。
- [x] **批次 C：页面真实状态与模型卡片。** 页面交互保留，底层调用由 Task 8 统一切换为 `BotRepository.execDebugCommand`。

### Task 8: 统一复用 debug/exec（用户架构纠偏）

**Goal:** 删除 DeepSeek Harness 专用后端协议，让页面内所有实例操作统一通过现有 `debug/exec` 下发固定命令。

**Files:**

- Create: `frontend/src/lib/deepseek-harness-command.ts`
- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-model-card.tsx`
- Add: `frontend/src/pages/marketing/agent-deepseek-harness-provider-controls.tsx`
- Add: `frontend/src/pages/marketing/agent-deepseek-harness-configured-provider-list.tsx`
- Add: `frontend/src/pages/marketing/agent-deepseek-harness-provider-delete-dialog.tsx`
- Modify: `images/helpers/install-deepseek-harness.sh`
- Delete: `frontend/src/lib/deepseek-harness-api.ts`
- Delete: `frontend/src/lib/deepseek-harness-client.ts`
- Delete: `ctl/pkg/instance/deepseek_harness.go`
- Delete: `ctl/pkg/errcode/deepseek_harness.go`
- Revert scoped DSH additions: `ctl/main/api/server.go`、`ctl/pkg/instance/logic.go`、`ctl/pkg/transport/instance.go`、`argocd/services/service-gateway/beijing-sandbox/config.yaml`、`service-gateway/internal/gateway/config_policy_test.go`

**Interfaces:**

- Consumes: `BotRepository.execDebugCommand(botId, command, options?)`。
- Produces: 固定命令构造与 JSON 结果解析；页面不能提交包名、版本、目录、端口或任意 Provider。
- Produces: 系统级 `/etc/systemd/system/deepseek-harness.service`，运行用户仍为 `agentuser`。

- [x] 先改测试，断言状态使用 `sudo systemctl status deepseek-harness.service --no-pager`，安装、任务轮询、重启和 Provider 配置全部调用 `execDebugCommand`。
- [x] 运行聚焦测试并确认因旧 API/RPC 调用而失败。
- [x] 新增命令构造与解析模块；Provider 白名单、任务 ID、输出 JSON 和 API Key 编码在浏览器侧校验。
- [x] 安装器切换为系统服务，并增加只接受白名单 Provider 的 `providers` / `configure` 动作；密钥从 stdin 读取且不回显。
- [x] 页面改用 Repository；删除 TAT 直连模型 RPC 和 DeepSeek Harness 专用 API 客户端。
- [x] 删除 ctl、transport、errcode、server route 和 gateway allowlist 中仅为本需求新增的内容。
- [x] 更新 PRD、proposal、spec 和安装脚本测试，确保文档不再声称存在专用接口或 systemd 用户服务。
- [x] 运行 DSH 聚焦 Vitest、`pnpm check`、i18n、shell 测试、`git diff --check` 和浏览器桌面/移动端验收。

## Planning Gate

**规模判定：** M 级。Task 8 只保留 frontend、Hermes 镜像 helper 和现有 WebUI broker；不再修改 ctl 或 service-gateway。

**Capability：** 不需要启用 `figma-fidelity`。本需求无 Figma 还原；浏览器 smoke 已通过本地预览执行。

**规划门禁结论：** 通过。用户已确认所有 DSH 操作统一走 `debug/exec`；Task 8 代码、文档、自动化测试和浏览器桌面/移动端验收已完成，等待用户验收后再决定提交和 Sandbox 联调。
**交付边界：** 用户验收前不提交、不推送、不创建 MR、不归档。

### Task 9: 已配置模型供应商的修改与删除

**Goal:** 将模型配置卡片升级为 DSH WebUI 风格的“已配置列表 + 单项展开编辑区 + 未配置供应商添加区”，并让添加、修改、删除全部通过固定命令复用 `debug/exec`。

**Role:** Developer

**Confirmed Design:**

- 卡片上方持续展示 `configured=true` 的模型供应商，每行显示名称、绿色状态、编辑和删除操作。
- 同一时间只展开一个编辑区；API Key 始终为空，留空保存保留原密钥，输入新值执行替换。
- 添加区只展示尚未配置的站点白名单供应商；字段文案由 `Provider` 改为“模型供应商”。
- 删除前二次确认；DeepSeek 只清除 LightVela 写入的 `DEEPSEEK_API_KEY`，其他供应商删除 profile，并只清理由 LightVela 派生且可写的凭据。
- 环境变量密钥、自定义引用和不可识别凭据不删除；环境管理的 DeepSeek 凭据明确拒绝删除，部分失败保留确认弹窗并允许重试。

**Planned Files:**

- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-model-card.tsx`
- Modify: `frontend/src/lib/deepseek-harness-command.ts`
- Modify: `frontend/src/repositories/fake-repositories.ts`
- Modify: `images/helpers/configure-deepseek-harness.py`
- Modify: `images/helpers/install-deepseek-harness.sh`
- Modify focused frontend, command-client, fake-repository, Python helper and installer tests

**Out of Scope:**

- 不新增 DSH 专用后端接口，不让浏览器直接访问 DSH RPC。
- 不读取、回显或持久化现有 API Key；编辑区始终以空输入开始。
- 不删除环境变量、自定义凭据引用或无法证明由 LightVela 创建的凭据。

**Implementation Batches:**

- [x] Batch 1（固定命令与实例 helper）：先补 `remove-provider` 的命令客户端、Python helper 和安装器失败测试，再实现白名单校验、凭据归属判断、幂等删除与非零退出码识别。验收信号为未知供应商无法下发命令，DeepSeek 仅清可写凭据，目录供应商按“凭据后 profile”顺序删除，外部凭据保持不变。
- [x] Batch 2（模型配置交互与 Mock）：先补已配置列表、单项编辑、添加过滤、删除确认和失败重试测试，再实现紧凑列表、一次只展开一个编辑区、删除弹窗及 Fake Repository 状态变更。验收信号为已配置供应商持续可见，添加区只出现未配置项，删除失败时弹窗保留且可重试。
- [x] Batch 3（规格与验收）：同步 PRD、proposal、spec 与 TAPD，运行聚焦测试、类型检查、i18n、shell/Python 测试和浏览器桌面/移动端 smoke。验收信号为页面无横向溢出、无控制台错误，且全部 DSH 操作仍只经 `debug/exec`。

**TDD Checklist:**

- [x] 前端组件测试先覆盖已配置列表、单项编辑、添加过滤、删除确认、删除失败重试与“模型供应商”文案。
- [x] 命令客户端测试先覆盖白名单 `remove-provider` 命令，并拒绝未知 Provider ID。
- [x] Python helper 测试先覆盖 DeepSeek 仅清凭据、目录供应商清凭据后 unset profile、外部凭据不清理和幂等重试。
- [x] 安装器测试先覆盖 `remove-provider --provider <id>` 的参数校验与 helper 委托。
- [x] 完成最小实现并运行聚焦测试、类型检查、i18n、shell/Python 测试和浏览器桌面/移动端验收。

**Planning Gate:** M 级增量需求；方案 A、删除语义、影响文件、空态/错误态/加载态和验收标准均已确认，不新增依赖或专用接口。规划门禁通过，可进入 TDD 实现。

**Status:** 方案 A 实现与验证完成，等待用户验收。

---

### Task 10: 收紧已安装运行态卡片高度

**Goal:** 取消 DeepSeek Harness 已安装运行态不必要的固定最小高度，使卡片随单行运行信息自然收紧，同时保持加载、错误、未安装和安装中状态的稳定高度。

**Files:**

- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx`

**Interfaces:**

- Preserves: 状态查询、安装动画、运行状态、WebUI 和重启操作不变。
- Produces: `status === "installed"` 时主卡片不包含 `min-h-52`；其他状态继续包含 `min-h-52`。

**Out of Scope:**

- 不调整公告、模型配置卡片、按钮尺寸、移动端堆叠或安装状态内容。
- 不新增高度动画，避免动画布局属性。

- [x] 先扩展 Panel 测试，断言未安装态保留 `min-h-52`、已安装态移除 `min-h-52`，并确认旧实现 RED。
- [x] 使用 `cn()` 按状态组合卡片 class，仅在非 installed 状态应用 `min-h-52`。
- [x] 运行 Panel 定向测试、`pnpm check`、`git diff --check`，并复验桌面与 390x844 移动端无溢出。

**Status:** 实现与验证完成，等待用户验收。

---

### Task 11: 模型配置保存反馈与覆盖更新

**Goal:** 让模型供应商配置在等待 `debug/exec` 返回期间提供明确加载反馈，并允许从完整供应商列表重复选择同一 Provider 进行覆盖更新。

**Confirmed Design:**

- 点击“保存配置”后，按钮显示加载图标与“保存中...”，供应商选择、密钥输入和其他配置操作保持禁用，直到 `debug/exec` 成功或失败。
- 保存成功或失败统一复用全局顶部居中 Toast，约 3 秒自动消失；删除失败仍保留在确认弹窗内，便于直接重试。
- 配置区下拉始终展示当前站点全部白名单供应商，不再过滤已配置项；再次保存已配置 Provider 等价于覆盖更新其配置。
- 区块文案由“添加模型供应商 / 添加配置”调整为“配置模型供应商 / 保存配置”。
- 保存成功后保留当前 Provider 选择并清空 API 密钥输入；保存失败时保留输入，方便用户重试。

**Files:**

- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-model-card.tsx`
- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-provider-controls.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-deepseek-harness-model-card.test.tsx`
- Modify: `frontend/openspec/proposal.md`, `frontend/openspec/spec.md`, `wiki/prd-docs/2026-08-20-deepseek-harness-lab.md`

**Out of Scope:**

- 不新增接口或改变固定命令，模型配置仍只通过 `BotRepository.execDebugCommand` 下发。
- 不回显、持久化或读取现有 API Key。
- 不改变删除失败弹窗及其重试行为。

- [x] 先补充模型卡片失败测试，覆盖等待态、顶部 Toast、完整供应商下拉与同 Provider 覆盖保存。
- [x] 实现最小交互调整，保存成功清空密钥、失败保留密钥，并确认测试 GREEN。
- [x] 同步 proposal、spec 与 PRD，更新 i18n 生成字典。
- [x] 运行定向测试、类型检查、i18n、diff 检查和浏览器桌面/移动端验收。

**Planning Gate:** 用户已确认复用现有全局 Toast 的方案；交互状态、覆盖语义、反馈位置和错误边界均明确。规划门禁通过，可进入 TDD 实现。

**Status:** 实现与验证完成，等待用户验收。

---

### Task 12: SkillHub 安装后明确重启 DSH

**Goal:** 确保首次安装及重复安装/升级 SkillHub 后，`deepseek-harness.service` 都会重新启动并立即加载最新插件。

**Files:**

- Modify: `images/helpers/install-deepseek-harness.sh`
- Modify: `images/tests/test-deepseek-harness-installer.sh`
- Modify: `frontend/openspec/spec.md`, `wiki/prd-docs/2026-08-20-deepseek-harness-lab.md`

**Interfaces:**

- Preserves: DSH、SkillHub 固定版本、安装任务进度、健康检查、失败回滚和系统级服务结构。
- Produces: SkillHub 安装或版本确认完成后，服务注册阶段执行 `systemctl enable deepseek-harness.service`，随后明确执行 `systemctl restart deepseek-harness.service`。

**Out of Scope:**

- 不新增独立重启任务或前端步骤。
- 不改变模型配置后的生效策略；本次只处理插件安装/升级。

- [x] 先修改安装器测试，断言 SkillHub 安装之后明确重启 DSH，并确认旧实现 RED。
- [x] 调整服务注册命令并确认安装器测试 GREEN。
- [x] 同步规格与 PRD，运行安装器、镜像脚本和差异检查。

**Planning Gate:** 用户明确说明 SkillHub 安装后通常需要重启；现有 `enable --now` 在服务已运行时不保证重启，问题和修正边界已确认。规划门禁通过。

**Status:** 实现与验证完成，等待用户验收。

---

### Task 13: 在线冻结依赖与五插件原子安装

**Goal:** 保留用户点击后的在线安装方式，使用冻结依赖和校验清单安装 DSH runtime，并为 DSH `web` profile 全量安装 SkillHub、QQBot、微信、企业微信和 Lark；全部验证成功后才完成任务。

**Role:** Developer + Reviewer

**Files:**

- Create: `images/runtime/deepseek-harness/manifest.json`
- Create: `images/runtime/deepseek-harness/runtime/package.json`, `images/runtime/deepseek-harness/runtime/pnpm-lock.yaml`, `images/runtime/deepseek-harness/runtime/.pnpmfile.cjs`
- Create: `images/runtime/deepseek-harness/web-profile/package.json`, `images/runtime/deepseek-harness/web-profile/pnpm-lock.yaml`, `images/runtime/deepseek-harness/web-profile/.pnpmfile.cjs`, `images/runtime/deepseek-harness/web-profile/pnpm-workspace.yaml`
- Modify: `images/build.sh`
- Modify: `images/helpers/install-deepseek-harness.sh`
- Modify: `images/tests/test-deepseek-harness-installer.sh`, `images/tests/test-hermes-build-script.sh`
- Modify: `frontend/openspec/proposal.md`, `frontend/openspec/spec.md`, `wiki/prd-docs/2026-08-20-deepseek-harness-lab.md`

**Interfaces:**

- Preserves: 前端三态交互、`debug/exec` 异步任务、`agentuser`、系统级 `deepseek-harness.service`、回环 3080、Provider helper 和 TAT WebUI 代理。
- Produces: root-owned 冻结清单；固定 `pnpm@10.33.0`；DSH runtime 和 `web` profile 的 `--frozen-lockfile` 在线安装；四个渠道插件的固定 COS revision/SHA256；SkillHub 与 registry 依赖的 lockfile integrity；最多 5 次下载重试和有界超时。
- Produces: 五插件准确版本、bundle 声明、profile bundle 列表、`dsh plugin ... list`、`dsh --profile web --dump-config`、systemd active 和 HTTP 200 的分层验收。

**Atomicity and Error Handling:**

- 网络下载、依赖安装和静态验证全部在任务临时目录完成，有限重试耗尽或任一校验失败时不触碰正式目录。
- 正式切换前记录并复核旧 `web` profile 指纹；若安装期间被外部修改，则安全失败并保留现场。
- 切换前备份旧 runtime、完整旧 `web` profile 和旧 unit；切换后明确 restart。任何后置验证失败都恢复三者和旧服务，首次安装失败清理半成品。
- 已存在非 LightVela 管理的额外 profile 依赖或 bundle 时保持原状并失败，不删除未知插件、不降级为非冻结安装。
- 保留原 `web/cordis.patch.yml` 和 `$DSH_HOME` 下 credentials/settings/storage；禁止宽泛执行 `pnpm approve-builds --all`，依赖构建脚本只能使用冻结清单中的精确白名单。

**Out of Scope:**

- 不安装 `dsh-auth`、Caddy 或独立 SkillHub CLI。
- 不把 DSH runtime 和插件包体离线预置进镜像，不新增独立 COS bundle 发布链路。
- 不修改 Hermes 自身的 SkillHub CLI、QQBot、微信、企业微信或 Lark 插件配置。
- 不修改前端页面、ctl、service-gateway 或数据库接口。

- [x] Batch 1 / RED：扩展 `images/tests/test-hermes-build-script.sh`，先断言镜像固定安装 `pnpm@10.33.0`，并把 `manifest.json`、runtime/web-profile 的 `package.json` 与 `pnpm-lock.yaml` 以 root-owned、只读方式复制到 `/usr/local/share/lightvela/deepseek-harness`；运行 `bash images/tests/test-hermes-build-script.sh`，确认旧实现因缺少冻结输入复制而失败。
- [x] Batch 1 / RED：重构 `images/tests/test-deepseek-harness-installer.sh` 的 fake `pnpm/curl/systemctl/dsh`，断言安装器只使用 `pnpm install --frozen-lockfile`，四个渠道包执行最多 5 次、有连接/单次请求超时的下载及 SHA256 校验，SkillHub 走锁文件完整性；同时断言五插件版本、`dsh.bundle`、profile bundle 列表、`plugin list` 和 `dump-config` 全部通过后才重启服务。运行测试并确认旧实现 RED。
- [x] Batch 2 / frozen inputs：新增冻结 manifest；runtime package 固定 `@deepseek-ai/dsh@0.1.0-rc.7`，两份 `.pnpmfile.cjs` 将整个 `@deepseek-ai/dsh-*` 依赖族保持在 `rc.7`，避免主包与新发布 `rc.8` 子包混装；web profile 复用官方 `nodeLinker: hoisted`、`autoInstallPeers: false` workspace 约定，只直接安装 SkillHub `0.2.13` 与 QQBot/微信/企业微信/Lark 的固定 revision、包版本和 SHA256，base/web-app bundles 由 runtime fallback 提供；使用 `pnpm@10.33.0 install --lockfile-only --ignore-scripts` 生成两份 lockfile，并以独立临时安装验证 `--frozen-lockfile` 不产生差异。
- [x] Batch 2 / image wiring：为 `images/build.sh` 增加冻结输入 source/target，复制后校验文件集合、权限和所有者；将 Hermes WhatsApp bridge 的全局 pnpm 安装固定为 `pnpm@${PNPM_VERSION}`。运行镜像脚本测试转 GREEN。
- [x] Batch 3 / candidate install：安装器读取 root-owned manifest，在 task 私有目录下载四个渠道包并校验 SHA256，将 SkillHub 交给 lockfile integrity；把 runtime 和完整 `web` profile 安装到候选目录，保留旧 `cordis.patch.yml`，拒绝未知依赖或 bundle，候选校验失败时只清理 task 目录并记录失败。
- [x] Batch 3 / atomic switch：记录旧 profile 指纹，候选验证后再次比对；停服前备份 current symlink、完整旧 profile 和 unit，再一次性切换 runtime/profile/unit。后置的五插件清单、配置解析、systemd active、回环端口和 HTTP 200 任一失败时恢复三者并重启旧服务；首次安装失败不残留 release/profile/unit。
- [x] Batch 4 / GREEN and regression：覆盖首次安装、重复安装、未知插件、下载校验失败、插件验证失败、profile 并发修改、切换中途失败、服务健康失败、服务 enable 状态恢复和成功清理；运行 `bash images/tests/test-deepseek-harness-installer.sh`、`bash images/tests/test-hermes-build-script.sh`、lockfile 再生成差异检查、`bash -n` 与 `git diff --check`。
- [x] Batch 4 / docs：同步规格、PRD 和当前任务摘要，记录本地验证证据。北京 Sandbox 真实组合冒烟仍需用户另行确认后执行，不在本批次自动触发。

**Planning Gate:** M 级安装可靠性增强。用户已选择在线冻结方案，并确认五个 `web` profile 插件全量成功才算完成；方案不新增后端接口或 UI，不启用额外 capability。书面规格和原子切换边界已经用户确认，按上述四个批次进入 TDD 实现。

**Status:** 本地实现与验证完成，等待用户验收；确认前不 commit / push / MR，也不执行北京 Sandbox 远端安装。

---

# Agent 导航 CR 修正 Implementation Plan

**Status:** 实现与验证完成，等待用户确认提交和推送。

**Goal:** 修正隐藏高级工具与分组导航的布局结构、测试耦合及分组命名语义。

**Scope:** 仅调整 Agent 左侧导航组件、对应样式和定向测试；不改变四个可见一级分类、菜单顺序、路由或隐藏工具的开启方式。

### Task 1: 统一导航结构与可访问语义

**Role:** Developer

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
- Modify: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

**Acceptance:**
- 隐藏的终端、浏览器入口与普通分组使用同一 items 容器，桌面缩进和窄屏栅格一致。
- 可见分组通过 `aria-labelledby` 引用可见标题；导航项使用列表语义。
- 删除颜色、间距和高度的 CSS 精确字符串断言，改由渲染测试验证结构与归属。

- [x] 先补充渲染失败测试并确认 RED。
- [x] 实现最小组件和样式调整并确认 GREEN。
- [x] 运行定向测试、类型检查、i18n 检查和 diff 检查。

---

# 已安装技能实例展开 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 修复 `/agents/skills` 已安装列表在 SkillHub 返回同名聚合技能时漏展示 `instances[]` 子实例的问题。

**Architecture:** SkillHub installed parser 将 `skills[].instances[]` 展开为独立 `InstalledSkill` 行；实例 `rawId` 保持为命令目标，`slug` 优先使用 `relative_path` 供展示和搜索；已安装列表搜索纳入 `slug` 与 `nativeAliases`。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library。

## Global Constraints

- 仅调整 `/agents/skills` 已安装清单的数据解析、展示标识和搜索匹配。
- 不修改安装、卸载命令格式；SkillHub 实例卸载仍使用实例 `id/rawId` 作为命令目标。
- 不新增 API、依赖、区域分支、视觉结构或 i18n 资源。

---

### Task 1: 展开 SkillHub installed instances 并验证

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Test: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Test: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

**Interfaces:**
- Consumes: `acli skills list` JSON 中的 `skills[].instances[]`、`id`、`name`、`display_name`、`relative_path`、`version`。
- Produces: 每个 instance 对应一条 `InstalledSkill`；`rawId` 用于命令，`slug/nativeAliases` 用于展示、搜索和合并匹配。

- [x] **Step 1 — 增加失败回归测试**
  - 解析器测试覆盖 `humanizer.instances[]`，断言 `unclecheng-reduce-ai-perception-v2` 被展开为独立行。
  - UI 测试覆盖已安装搜索可按 instance `relative_path` 命中，列表展示路径但卸载仍携带实例 `rawId`。

- [x] **Step 2 — 运行测试并确认 RED**
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
  - Expected: FAIL，旧实现只展示 top-level `humanizer` 且搜索不到 `unclecheng-reduce-ai-perception-v2`。

- [x] **Step 3 — 实现最小修复**
  - 展开 SkillHub `instances[]`，保留父级分类/展示名兜底。
  - 让已安装列表展示 `skill.slug`，搜索匹配 `slug/nativeAliases`。

- [x] **Step 4 — 运行定向测试与质量门禁**
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
  - Run: `cd frontend && pnpm check && cd .. && git diff --check`

- [x] **Step 5 — 修复已安装搜索框双清除按钮**
  - 在已安装搜索框有值时保留自定义清除按钮，禁用 Chromium/WebKit 原生 search cancel 和 decoration。
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

- [x] **Step 6 — 统一三个 Tab 搜索框聚焦样式**
  - 技能、技能包、已安装搜索框统一使用 `lv-agent-search-box`、`lv-agent-search-box-icon`、`lv-agent-search-box-input`。
  - 已安装搜索框保留自定义清除按钮和原生 search cancel 禁用，外层固定宽度不受共享 `width: 100%` 影响。
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx --testNamePattern "uses the skill package search field styling|suppresses the native search clear"`

- [ ] **Step 7 — 验收确认**
  - 汇总 diff、验证结果和剩余风险；等待用户确认后再提交、推送或 MR。

---

# 即将到期 Tooltip 视觉修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 增量实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 将 `/agents` 左侧“即将到期”标签的浏览器原生灰色提示框替换为符合 `DESIGN.md` 的自定义 hover/focus Tooltip。

**Architecture:** 在续费提醒按钮外增加无布局副作用的 `group relative inline-flex` 包装层，Tooltip 作为同级绝对定位元素显示在按钮上方。该位置没有裁剪祖先，因此采用 `DESIGN.md` 推荐的内联方案，不引入 Portal 定位状态；按钮点击续费逻辑保持不变。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- 移除续费提醒按钮的原生 `title`，避免系统灰色提示框。
- Tooltip 使用白底深色字、细边框、6px 圆角（Tailwind 默认 `rounded-md` 的视觉值）、`px-3 py-1.5`、`text-[11px] font-medium` 与 `0 8px 24px rgba(15,23,42,0.12)` 轻阴影。
- Tooltip 位于触发器上方居中，带白底小三角，支持 hover、focus、鼠标进入与文本选择。
- 不修改“即将到期”标签本身、剩余时间计算、点击续费逻辑、文案或 i18n 资源。
- 国内站和国际站共用同一实现，不增加区域条件分支。

---

### Task 1: 用自定义 Tooltip 替换原生 title 并验证

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx:4989-5008`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx:180-195`

**Interfaces:**
- Consumes: `passExpiryReminder.tooltip` 现有剩余时间文案与续费提醒按钮。
- Produces: `role="tooltip"` 的可选择自定义浮层；不新增导出或公共接口。

- [x] **Step 1 — 增加失败回归测试**

  更新现有续费提醒用例，断言按钮不再包含 `title`，页面存在对应 `role="tooltip"`，并锁定白底、细边框、6px 圆角、11px 字号、轻阴影、可交互和可选择样式。

- [x] **Step 2 — 运行测试并确认 RED**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: FAIL，旧实现仍有原生 `title` 且没有自定义 Tooltip。

- [x] **Step 3 — 实现最小 Tooltip 调整**

  用 `group relative inline-flex` 包裹提醒按钮，删除 `title`，增加位于上方居中的自定义 Tooltip 与小三角；通过透明 `pb-2` hover 桥接按钮和气泡。

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: 该测试文件全部通过。

- [x] **Step 5 — 运行质量门禁并本地预览**

  Run: `cd frontend && pnpm check && pnpm i18n:check && cd .. && git diff --check`

  Expected: 全部以退出码 `0` 完成；在已登录本地预览中 hover/focus “即将到期”时显示新 Tooltip，点击仍打开续费弹窗。

- [x] **Step 6 — 验收门禁**

  展示改动与验证结果；仅在用户明确确认后提交、推送或创建 MR。

---

### Task 2: 在 Tooltip 内增加续费入口并验证

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx:5007-5024`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx:187-220`

**Interfaces:**
- Consumes: `passExpiryReminder.tooltip` 与现有 `setRenewPassModalOpen(true)`。
- Produces: Tooltip 内原生文字按钮“续费套餐”；不新增状态、组件、导出或公共接口。

- [x] **Step 1 — 增加失败回归测试**

  在现有 Tooltip 用例中查询 Tooltip 内的“续费套餐”按钮，断言其可聚焦，并点击后出现续费弹窗；原提醒标签打开续费弹窗的行为继续由实名认证用例覆盖。

- [x] **Step 2 — 运行测试并确认 RED**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: FAIL，Tooltip 内尚不存在“续费套餐”按钮。

- [x] **Step 3 — 实现最小文字按钮**

  在剩余时间文案后增加原生 `<button type="button">续费套餐</button>`，使用当前提醒橙色、hover 下划线和可见焦点样式；点击时阻止冒泡并复用 `setRenewPassModalOpen(true)`。

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: 该测试文件全部通过。

- [x] **Step 5 — 运行质量门禁并本地交互回验**

  Run: `cd frontend && pnpm check && pnpm i18n:check && cd .. && git diff --check`

  Expected: 全部以退出码 `0` 完成；本地 hover 后点击“续费套餐”能打开续费弹窗，Tooltip 在按钮 hover/focus 时保持可见。

- [x] **Step 6 — 验收门禁**

  展示本地效果与验证结果；仅在用户明确确认后提交、推送或创建 MR。

- [x] **Step 7 — 补充可点击鼠标样式并回验**

  为 Tooltip 内“续费套餐”文字按钮增加 `cursor-pointer`，扩展现有测试断言，并在本地预览确认计算样式为 `cursor: pointer`。

- [x] **Step 8 — 补充提醒标签可点击鼠标样式并回验**

  为外层“即将到期 / 临近到期”按钮增加 `cursor-pointer`，扩展现有测试断言，并在本地预览确认计算样式为 `cursor: pointer`；不改变 hover 颜色、焦点样式或点击逻辑。

- [x] **Step 9 — 更新 Tooltip 续费入口文案**

  将 Tooltip 内入口从“续费套餐”调整为“立即续费”，保留弹窗标题“续费套餐”和现有点击、焦点、cursor 行为；更新定向测试并回验。

---

# 自动任务最近执行空状态去灰底 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，等待用户验收；不自动提交实现、推送或创建 MR。

**Goal:** 去掉 `/agents/automations/` 最近执行空状态行的浅灰色背景与圆角，同时保留外层白色卡片和其余视觉属性。

**Architecture:** 沿用 `RecentCronRunsPanel` 的现有结构，只删除空状态行上的两个 Tailwind class。扩展现有组件测试直接渲染空记录状态，锁定内层背景/圆角移除且外层卡片仍存在，不新增组件、导出或依赖。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- 仅调整空状态行，不修改有记录列表、加载态、错误态、页签、刷新交互或 Hermes Cron 逻辑。
- 删除 `bg-black/[0.02]` 和 `rounded-lg`，保留空状态行的间距、图标、字号和颜色。
- 保留外层白色卡片的边框、阴影和 `rounded-md`。
- 国内站和国际站共用同一组件，不增加区域条件分支。
- 不新增依赖、文案或 i18n 生成文件。

---

### Task 1: 移除最近执行空状态灰底并验证

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx:1109-1115`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts:45-105`
- Design: `frontend/openspec/changes/2026-08-13-frontsandbox-automation-empty-state-transparent-design.md`

**Interfaces:**
- Consumes: `RecentCronRunsPanel` 现有 `runs` 与 `skillLoadState` props。
- Produces: 不新增导出；国内站和国际站继续渲染同一空状态 JSX。

- [x] **Step 1 — 增加失败回归测试**

  在 `recent run limit hint` 测试组中增加空状态用例：

  ```tsx
  it("renders the empty recent-runs message without a nested gray container", () => {
    const { container } = render(createElement(RecentCronRunsPanel, {
      runs: [],
      skillLoadState: { status: "ready", slugs: [], error: null },
    }));
    const message = screen.getByText("暂无执行记录");
    const emptyState = message.closest("div");
    const panel = container.querySelector("section");

    expect(emptyState).not.toBeNull();
    expect(emptyState).toHaveClass("m-4", "px-3", "py-2", "text-xs", "text-black/45");
    expect(emptyState).not.toHaveClass("bg-black/[0.02]", "rounded-lg");
    expect(panel).toHaveClass("rounded-md", "bg-white");
    expect(panel).toHaveStyle({ background: "#ffffff" });
  });
  ```

- [x] **Step 2 — 运行测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts
  ```

  Expected: FAIL，空状态行仍包含 `bg-black/[0.02]` 和 `rounded-lg`。

- [x] **Step 3 — 实现最小样式调整**

  将空状态行改为：

  ```tsx
  <div className="m-4 flex items-center gap-2 px-3 py-2 text-xs text-black/45">
  ```

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts
  ```

  Expected: 该测试文件全部通过，现有最近执行详情测试保持不变。

- [x] **Step 5 — 运行质量门禁**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  cd ..
  git diff --check
  ```

  Expected: TypeScript、i18n 和 diff 检查均以退出码 `0` 完成；不产生生成资源变更。

- [x] **Step 6 — 验收门禁**

  展示 diff 与验证结果；只有用户明确确认后才执行实现提交、推送或创建 MR。

---

# 2026-08-12 首页 Hero 浅色化

**Status:** 前端实现与基础检查已完成，待用户视觉验收后再提交 / MR。

**Goal:** 参考 `lightvela-next.zip` 的浅色首屏方向，重做首页 Hero 视觉层，去掉视频背景，提升整体轻盈感和顶部导航可读性。

**Scope:** 仅调整首页 Hero 区视觉实现；保留现有首页业务链路、CTA 跳转、i18n 文案、Header 组件和后续内容区。

## Tasks

- [x] 移除首页 Hero 的视频背景和对应加载状态。
- [x] 用浅色静态背景与现有装饰素材重组 Hero 首屏。
- [x] 完成 TypeScript / i18n / diff 检查，并用本地预览截图验证桌面与移动端可读性。
- [x] 移除 Hero 外层最大/最小高度限制，确保常见浏览器缩放 25%～125% 下 Hero 仍占满首屏。

---

# 更新日志左侧日期样式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，用户已确认 commit / push / MR。

**Goal:** 参考 Viktor Changelog，将 `/changelog` 左侧月份改成带日历勾选图标的紫色日期标签，同时保持页面其他部分不变。

**Architecture:** 继续使用 `ChangelogMonthGroup` 和现有双列网格，只在月份标签的 JSX 中复用 `lucide-react` 的 `CalendarCheck` 并替换局部样式。通过现有国内站 Changelog 渲染测试锁定图标、尺寸、间距和颜色，不新增组件、数据字段或依赖。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Lucide React、Vitest 4、Testing Library。

## Global Constraints

- 仅修改左侧月份标签及其回归测试，不修改日期数据、正文、配图、右侧时间线、页头、页脚或滚动行为。
- 使用 `#6E47FF` 前景色，不增加背景、边框、圆角或额外水平内边距。
- 标签固定 `48px` 高，图文间距 `16px`，图标 `20px`。
- 不新增依赖、组件、翻译文案或 i18n 生成文件。

---

### Task 1: 更新月份标签并验证

**Files:**
- Modify: `frontend/src/pages/marketing/changelog-page.tsx:8-12,404-421`
- Test: `frontend/src/pages/marketing/__tests__/channel-copy.test.tsx:69-99`
- Design: `frontend/openspec/changes/2026-08-12-frontsandbox-changelog-date-style-design.md`

**Interfaces:**
- Consumes: `ChangelogMonthGroup.month` 现有本地化月份字符串；`lucide-react` 的 `CalendarCheck`。
- Produces: 不新增导出；所有月份分组共用同一日期标签 JSX。

- [x] **Step 1 — 增加失败回归断言**

  在现有 `announces reliable Skill invocation for automations in the July changelog` 用例中，把月份存在性断言扩展为：

  ```tsx
  const monthText = screen.getByText("2026 年 7 月");
  const monthLabel = monthText.closest("p");

  expect(monthLabel).not.toBeNull();
  expect(monthLabel).toHaveClass(
    "inline-flex",
    "h-12",
    "items-center",
    "gap-4",
  );
  expect(monthLabel).not.toHaveClass("rounded-full", "px-6");
  expect(monthLabel).toHaveStyle({ color: "#6E47FF" });
  expect(monthLabel).not.toHaveStyle({
    backgroundColor: "rgba(110, 71, 255, 0.16)",
  });
  expect(monthLabel?.querySelector(".lucide-calendar-check")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  ```

- [x] **Step 2 — 运行测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/channel-copy.test.tsx
  ```

  Expected: FAIL，现有月份 `<p>` 仍带有 `rounded-full px-6` 和淡紫色背景。

- [x] **Step 3 — 实现最小日期标签样式**

  在 `changelog-page.tsx` 导入图标：

  ```tsx
  import { CalendarCheck } from "lucide-react";
  ```

  将左列月份 JSX 替换为：

  ```tsx
  <div className="pt-1">
    <p
      className="inline-flex h-12 items-center gap-4"
      style={{
        color: "#6E47FF",
        fontSize: "16px",
        fontWeight: 400,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
      }}
    >
      <CalendarCheck className="size-5 shrink-0" aria-hidden="true" />
      <span>{group.month}</span>
    </p>
  </div>
  ```

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx
  ```

  Expected: 两个测试文件全部通过，国内站和国际站现有 Changelog 内容断言保持不变。

- [x] **Step 5 — 运行质量门禁**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  cd ..
  git diff --check
  ```

  Expected: TypeScript、i18n 和 diff 检查均以退出码 `0` 完成；不产生 i18n 文件变更。

- [x] **Step 6 — 浏览器验证**

  启动本地前端并检查 `/changelog`：

  ```bash
  cd frontend
  pnpm dev:cn
  ```

  Expected:

  - 桌面端：月份标签位于左列，图标和文字垂直居中，不显示底框。
  - 移动端：月份标签按内容宽度左对齐，标签自身不增加横向溢出。
  - 右侧标题、描述、配图和点线时间轴与修改前一致。

  Verification evidence:

  - 用户标注的 `888 × 933` 视口：标签 `131.14 × 48px`，计算样式为透明背景、`0px` 边框、`0px` 圆角、`0px` 左右内边距。
  - 移动端：日期标签位于单列内容区内；页面既有页头说明文本使用 `white-space: nowrap`，会产生原有横向溢出，本次遵循范围约束未修改。
  - 浏览器控制台无 error。
  - 完整 `pnpm test` 仍有 1 条既有失败：`scripts/docs-image-assets.test.ts` 检出 9 个超出 `512 KiB` 的文档 PNG（被中英文文档重复引用为 18 条）；本分支未修改这些图片、文档或测试。

- [x] **Step 7 — 等待提交确认**

  展示 diff、测试结果和浏览器验证截图；只有用户明确确认后才执行 `git commit`、`git push` 或创建 MR。

---

# 2026-08-11 国际站首页默认英文一致性修复

**Status:** 实现中；确认前不 commit / push / MR。

**Goal:** `lightvela.ai/` 裸首页在浏览器残留中文语言偏好时仍默认全页英文，只有访问中文 locale 路径或用户显式切换中文时展示中文。

**Scope:** 仅收敛公开首页 locale 判定、公告条 locale 注入、首页导入区翻译调用和回归测试；不改视觉布局、路由 SEO 输出、后端接口或订阅/登录逻辑。

## Tasks

- [x] 修复国际站裸 `/` 的 i18n 初始语言，避免被 `localStorage.lw-locale=zh-CN` 覆盖。
- [x] 修复首页公告条与 FeatureSection 对全局 i18n 单例的依赖，统一跟随公开路由 locale。
- [x] 补充回归测试并运行定向测试、i18n 检查、类型检查和 diff 检查。

---

# 国际站 Skills 搜索结果来源链接 Implementation Plan

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 国际站所有 Skills 搜索结果都在技能标题和 slug 下方单独展示文字型 `Source` 链接；ClawHub 统一链接到 `https://clawhub.ai/`。

**Architecture:** `SearchSkillRow` 继续使用 skills.sh 的技能详情链接，但对 ClawHub 直接使用固定官网地址。
链接只由前端渲染，不查询 ClawHub 作者或技能详情，因此不会新增 ClawHub 请求或增加限流风险。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS、Vitest 4、React Testing Library。

## Global Constraints

- 仅影响国际站的 ClawHub 与 skills.sh 搜索结果。
- 国内 SkillHub 搜索结果不展示新来源行。
- 所有 ClawHub 搜索结果都显示来源链接，固定 URL 为 `https://clawhub.ai/`。
- 标签通过现有 i18n `t("来源")` 渲染，样式与 skills.sh 的文字型来源链接一致。
- 不新增依赖、动画或新的交互原语。

## Tasks

- [x] **Task 1: 固定 ClawHub 搜索结果来源链接。**
  - 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`，先断言 ClawHub 搜索结果的 `来源` 链接固定为 `https://clawhub.ai/`。
  - 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`，仅在 global mode 的 `SearchSkillRow` 中为 ClawHub 使用固定官网链接，skills.sh 与国内站逻辑保持不变。
  - 运行 `pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`。

- [x] **Task 2: 运行质量门禁并记录验证。**
  - 运行 `pnpm i18n:check`。
  - 运行 `pnpm check`。
  - 检查 `git diff --check` 与最终 diff，确认未修改国内站分支逻辑。

---
# Agents 左侧导航顺序调整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，用户已确认提交、推送与创建 MR。

**Goal:** 将 `/agents` 左侧导航中的“自动任务”移动到“人设”上方，并保持其余导航行为不变。

**Architecture:** 沿用 `AgentSettingsPage` 内现有 `settingsSections` 数组作为唯一顺序来源，只交换两个相邻配置项。用独立静态回归测试锁定两项顺序，避免为了单一展示顺序抽离新公共接口。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4。

## Global Constraints

- 仅修改导航顺序及其回归测试，不修改路由、图标、文案、权限或页面内容。
- 桌面和移动端继续共用同一导航配置。
- 不新增依赖或配置抽象。

## Tasks

- [x] **Task 1 — Developer / Reviewer：交换导航项并验证**
  - **Files:**
    - Create: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
    - Modify: `frontend/src/pages/marketing/agent-settings-page.tsx:4909-4915`
  - **Interfaces:** 不新增导出；测试只读取页面源码中的 `settingsSections` 配置片段。
  - **Step 1 — 写失败测试：** 新测试读取 `agent-settings-page.tsx`，截取 `const settingsSections` 到 `const isRestartDisabled` 之间的文本，并断言 `id: "automations"` 的索引小于 `id: "buddy"`：

    ```ts
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    import { describe, expect, it } from "vitest";

    describe("Agent settings navigation order", () => {
      it("places automations before persona", () => {
        const page = readFileSync(
          join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
          "utf8",
        );
        const settingsSectionsStart = page.indexOf("const settingsSections");
        const settingsSectionsEnd = page.indexOf("const isRestartDisabled");

        expect(settingsSectionsStart).toBeGreaterThanOrEqual(0);
        expect(settingsSectionsEnd).toBeGreaterThan(settingsSectionsStart);

        const settingsSections = page.slice(settingsSectionsStart, settingsSectionsEnd);
        const automationsIndex = settingsSections.indexOf('id: "automations"');
        const personaIndex = settingsSections.indexOf('id: "buddy"');

        expect(automationsIndex).toBeGreaterThanOrEqual(0);
        expect(personaIndex).toBeGreaterThanOrEqual(0);
        expect(automationsIndex).toBeLessThan(personaIndex);
      });
    });
    ```
  - **Step 2 — 确认 RED：** 在 `frontend/` 运行 `pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`；预期当前顺序下断言失败。
  - **Step 3 — 最小实现：** 在 `settingsSections` 中把完整的 `automations` 配置项移动到完整的 `buddy` 配置项之前，不改动两项内容：

    ```tsx
    { id: "automations", label: t("自动任务"), icon: <CalendarClock className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.automations },
    { id: "buddy" as const, label: t("人设"), icon: <UserRound className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.buddy },
    ```
  - **Step 4 — 确认 GREEN：** 重新运行同一定向 Vitest，预期 1 个测试通过。
  - **Step 5 — 完整验证：** 在 `frontend/` 运行 `pnpm check`，再在仓库根运行 `git diff --check`；检查 diff 仅包含计划、测试和两项顺序调整。
  - **Step 6 — 验收门禁：** 展示改动与验证结果，等待用户确认后才允许提交实现、推送或创建 MR。

---

# 2026-08-07 批量安装汇总结果对齐修复

**Status:** 实现与验证完成；等待用户确认后再 commit / push / MR。

**Goal:** ACLI 同时返回逐项 `progress` 和完整 `summary.results` 时，避免重复汇总结果错配到下一个未完成技能，确保部分失败状态准确展示。

**Scope:** 仅修正 Skills 批量安装结果匹配逻辑并补回归测试；不改变 ACLI 命令、SSE 协议、取消粒度或页面交互。

## Tasks

- [x] 增加“progress 后返回完整 summary.results”的失败回归测试并确认 RED。
- [x] 修正已完成结果的去重与无标识结果的顺序降级逻辑。
- [x] 运行 Skills 定向测试、类型检查、i18n 检查和 diff 检查。

---

# 2026-08-09 EdgeOne Pages 裸根路径 404 修复

**Status:** 实现与 Preview 验证完成，用户已确认提交、推送并创建 MR。

**Goal:** 让 EdgeOne Pages 的裸根路径 `/` 直接由 Build Output 的 filesystem 路由提供静态首页，避免显式重写 `/index.html` 触发 Pages 路由缓存分裂和概率性平台 404。

**Scope:** 仅调整 EdgeOne Build Output 路由生成及其回归测试；不修改页面运行时代码、外层加速域名配置或生产发布配置。

## Tasks

- [x] 先补充失败测试，禁止生成 `^/$ -> /index.html` 显式根路由。
- [x] 删除显式根路由，保留 filesystem 与普通目录 HTML fallback 的顺序。
- [x] 运行定向测试、frontend 检查并验证生成配置。
- [x] 发布 Preview，连续验证不带查询参数的裸 `/`。
- [x] 用户确认后提交、推送并创建 MR。

## Verification

- `pnpm exec vitest run scripts/fix-next-static-html-lang.test.ts`
- `pnpm check`
- `git diff --check`

---

# 2026-08-07 国际站 Skills 来源说明对齐国内站

**Status:** 实现与验证完成，等待用户手动验收；不自动 commit / push / MR。

**Goal:** 将国际站搜索来源说明从搜索栏移到搜索结果底部，复用国内站“查看更多居中、来源说明靠右”的蓝色布局，并恢复搜索框宽度及来源筛选器右对齐。

**Scope:** 仅调整国际站 Skills 搜索区域布局和对应组件测试；保留 Skills.sh、ClawHub 链接、搜索过滤与展开逻辑，不改变国内站行为。

## Tasks

- [x] **Developer / Test:** 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`，断言国际站搜索栏不再包含来源说明、结果底栏展示蓝色 Skills.sh 与 ClawHub 链接，并确认测试按预期失败。
- [x] **Developer / UI:** 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`，复用国内站三列结果底栏，删除搜索栏旧说明；验收时搜索框占满剩余宽度、来源筛选器靠右。
- [x] **Reviewer / Verification:** 运行 Skills 定向测试、`pnpm i18n:check`、`pnpm check` 和 `git diff --check`，确认国内站布局断言保持通过且无新增依赖或生成资源。

---

# 2026-08-07 国际站合并技能卸载降级

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 删除同时标记为 ClawHub 与 skills.sh 的单个运行时技能时，不重复执行两个卸载命令导致 `SKILLS_SH_NOT_INSTALLED`。

**Scope:** 合并行的来源标识作为候选卸载命令；任一候选成功后停止，明确未安装时尝试下一候选，其他错误继续正常失败。

## Tasks

- [x] 增加“首个来源成功即停止”和“首个来源未安装则降级”的失败回归测试。
- [x] 调整国际站卸载候选执行与错误处理逻辑。
- [x] 运行 Skills 定向测试、i18n、类型检查和 diff 检查。

---

# 2026-08-07 国际站已安装技能跨来源去重

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 国际站同一 Hermes 运行时技能同时出现在 ClawHub 与 skills.sh 已安装清单时，仅展示一行，并同时展示两个来源标签。

**Scope:** 仅调整国际站已安装技能归并逻辑与回归测试；保留各 registry 的真实卸载目标，不按短 slug 盲目合并无 Hermes 证据的记录。

## Tasks

- [x] 增加跨来源重复安装记录的回归测试，并确认当前实现失败。
- [x] 以 Hermes 运行时记录为归并证据，合并 ClawHub 与 skills.sh 展示记录并保留双来源卸载目标。
- [x] 运行定向测试、类型检查和 diff 检查。

---

# 2026-08-06 前端预览图片体积优化

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 将分支预览压缩包从约 60 MiB 降到 45-50 MiB，避免接近 StaticPages 上传链路的疑似 64 MiB 边界。

**Scope:** 仅优化文档中超过 512 KiB 的 PNG/JPEG 源图及其 Markdown 引用，并增加资源体积回归测试；不调整页面布局、搜索、视频或生产发布逻辑。

## Tasks

- [x] 增加文档大图格式与体积回归测试，并确认现有资源会触发失败。
- [x] 将超预算文档图片转换为 WebP，更新中英文 Markdown 引用和公开资源副本。
- [x] 运行定向测试、类型检查和 global 预览构建，核验压缩包体积为 43.50 MiB。

---

# 2026-08-04 QQ Bot 群聊策略自动开启

**Status:** 实现与验证完成，待用户验收；确认前不 commit / push / MR。

**Goal:** 在 LightVela 通道配置 SDK 的 QQ 卡片中，用户通过扫码或 AppID / Secret 绑定 QQ Bot 时，自动在同一次 debug/exec 命令里先执行 `hermes config set platforms.qqbot.extra.group_policy open`，再执行 SDK 原始 QQ 绑定命令，避免额外触发第二次 gateway restart。

**Scope:** 仅修改前端 SDK debug/exec 适配链路、QQ group policy helper、相关单测和 QQ 通道文档；不修改 SDK 包版本、不修改后端接口、不提交远端代码。

## Tasks

- [x] 新增 QQ group policy 命令识别与包装 helper，覆盖 AppID / Secret 与扫码两条 QQ 绑定命令。
- [x] 扩展 debug/exec lifecycle 支持 `transformCommand`，并提供 lifecycle 组合 helper，保证模型切换自动任务同步不被覆盖。
- [x] 在 `/agents` 设置页接入 QQ lifecycle，使 SDK QQ 配置卡片下发命令前完成 group_policy 注入。
- [x] 更新 QQ 通道中英文文档，说明绑定后默认开启群聊 @ 对话及 `open` 权限边界。
- [x] 运行相关 Vitest、类型检查和 diff 检查，停在用户验收确认点。

## Verification

- `pnpm exec vitest run src/pages/marketing/__tests__/agent-qqbot-group-policy.test.ts src/pages/marketing/__tests__/agent-debug-exec-lifecycle.test.ts src/pages/marketing/__tests__/agent-tat-adapter.test.ts src/pages/marketing/__tests__/agent-settings-sdk-boundary.test.ts`
- `pnpm check`
- `git diff --check`

---

# 2026-07-31 Hermes 版本升级公告

**Status:** 前端实现完成，待用户验收后再提交 / MR；关联 Vitest 受当前 jsdom 依赖链阻塞。

**Goal:** 基于最新 `master` 在首页公告条挂今晚 Hermes 版本升级提醒，国内站与国际站均展示对应时区文案。

**Scope:** 仅更新首页公告条、对应中英文 i18n 字典和本计划；不调整公告视觉结构、路由、登录态、后端接口或其他公告轮播逻辑。

## Tasks

- [x] 将 Hermes 升级公告切换到 2026-07-31 22:00 至 2026-08-01 02:00。
  - 国内站文案使用北京时间。
  - 国际站文案使用新加坡时间。
  - 公告 ID 更新，避免复用上一次关闭记忆。
  - 过期时间为 UTC 2026-07-31 18:00。
- [x] 更新 i18n 生成字典并补齐英文翻译。
- [x] 完成基础验证：`pnpm i18n:check`、`pnpm check`、global 环境 `pnpm check`、`git diff --check`、公告静态 smoke。
- [ ] 关联 Vitest 复跑：当前 `vitest related src/components/site/maintenance-announcement-banner.tsx` 被 `jsdom@28.1.0 -> html-encoding-sniffer@6.0.0 -> @exodus/bytes` 的 `ERR_REQUIRE_ESM` 阻塞，未进入业务断言。

---

# 国内站登录弹窗交互优化 Implementation Plan

**Status:** 前端实现已完成，待用户验收后再提交 / MR / 归档。

**Goal:** 国内站登录弹窗默认微信登录，手机号与 QQ 作为底部其他登录方式；手机号登录成为正式入口；不引入后端改动。

## Constraints

- 仅国内站生效，国际站登录方式保持不变。
- 不新增后端接口。
- 不修改 `user/auth`。
- 不修改 `service-gateway`。
- 微信和 QQ 均复用现有 OAuth start URL 跳转；不调用不存在的 `modal-config` 接口。
- 手机号登录复用现有 `PhoneLoginForm`。

## Current Implementation

### 国内站弹窗

- `LoginModal` 维护 `DomesticLoginMethod = "wechat" | "phone" | "qq"`。
- 弹窗打开时默认重置为微信登录。
- 当前选中的登录方式展示在主体区域；另外两种登录方式展示在底部“其他登录方式”。
- 国际站仍走原有 Google / GitHub 登录逻辑，不进入国内站三方式状态机。

### 微信 / QQ

- 微信主体展示“微信账号登录”按钮，QQ 主体展示“QQ账号登录”按钮。
- 两者均复用 `repositories.auth.getOAuthStartUrl(...)` 和 `redirectToOAuthStart(...)`。
- 微信按 user agent 选择现有 OAuth target：
  - 桌面浏览器：`website`
  - 微信内浏览器：`official_account`
  - 普通移动浏览器：提示“请在微信中打开当前页面后继续登录。”
- 不嵌入二维码、不加载微信 JS、不新增后端配置接口；如果后端不支持扫码弹窗，按 QQ 的按钮跳转方式回退。

### 手机登录

- 手机主体复用 `PhoneLoginForm` 的 `variant="modal"`。
- 手机登录标题保留为“手机登录”，副标题“使用手机号和短信验证码登录”已删除。
- 表单可访问 label 保留，但视觉上使用 `sr-only` 隐藏，不再显示“手机号 / 短信验证码”字段标题。
- 输入框文字使用普通字重；输入框、验证码按钮使用 `rounded-md` 和轻边框，聚焦态保持浅色 1px ring。
- 未输入手机号或验证码时，登录按钮禁用。
- 手机号 / 验证码校验错误分别显示在对应输入框下方，并同步将对应输入框边框置为红色。
- 手机登录的协议勾选放在登录按钮上方；微信 / QQ 的协议勾选位于主体按钮下方、“其他登录方式”上方。

### 其他登录方式

- 底部按钮为 logo + 文案，无按钮框线。
- 微信、QQ、手机 icon 使用固定 icon slot，统一视觉大小；两个其他登录方式之间使用竖线分隔。
- 国内站内容容器底部保留 `pb-6`，避免底部登录选项贴近弹窗下边框。

## Tasks

- [x] 更新登录弹窗国内站状态机：`wechat | phone | qq`。
- [x] 默认方式设置为微信，弹窗打开时重置到微信。
- [x] 微信主体改为 OAuth 跳转按钮，保留微信 logo。
- [x] 手机主体展示手机号验证码登录表单。
- [x] QQ 主体展示 OAuth 跳转按钮，保留 QQ logo。
- [x] 协议勾选移动到“其他登录方式”上方。
- [x] 底部其他方式按钮改为无边框、logo + 文案、竖线分隔。
- [x] 回退微信扫码 / 快捷登录嵌入方案，不新增 `modal-config` 后端接口。
- [x] 统一底部微信 / QQ / 手机 icon 视觉尺寸。
- [x] 手机登录删除副标题和视觉字段标题，改为轻量表单结构。
- [x] 手机登录协议勾选移动到登录按钮上方。
- [x] 手机登录输入框样式按 `DESIGN.md` 调整为轻边框、`rounded-md`、普通字重、浅聚焦态。
- [x] 手机登录错误提示改为字段下方红字，并同步红色边框。
- [x] 手机登录未填手机号或验证码时禁用登录按钮。
- [x] 增加弹窗底部空间，避免其他登录方式贴近下边框。
- [x] 更新国内站登录弹窗单测。
- [x] 更新手机号登录表单单测。
- [x] 更新 i18n 文案。
- [x] 修复 review 发现的动态创建失败文案 i18n 字典回退问题。
- [x] 补充微信移动端 fallback 与手机登录协议 gate 的 LoginModal 回归测试。
- [x] 更新认证模块长期规格，区分 `/auth/sign-in` 手机主路径和共享登录弹窗微信默认状态机。
- [ ] 用户验收后再进入提交 / MR / 归档流程。

## Verification

- `pnpm --dir frontend exec vitest run src/components/site/__tests__/login-modal.test.tsx src/components/site/__tests__/login-modal.global.test.tsx src/components/auth/__tests__/phone-login-form.test.tsx src/pages/marketing/__tests__/agent-create-error.test.ts`
- `pnpm --dir frontend i18n:check`
- `pnpm --dir frontend check`
# 2026-08-06 Frontend release Docker monorepo context fix

**Status:** 实现与验证完成，等待用户确认提交。

**Goal:** 修复 frontend 正式镜像构建无法解析仓库内 `file:../velalink` 依赖的问题，同时保持 Docker build context 最小化。

**Scope:** 仅调整 frontend release bundle、Dockerfile、Dockerfile 专属 ignore 和构建契约测试；不修改 frontend 或 velalink 运行时代码。

## Tasks

- [x] 将 frontend release bundle 的 build context 切换为仓库根，并把 `velalink` 纳入变更触发范围。
- [x] 更新 Dockerfile 的根目录相对 COPY 路径，显式复制 `/velalink`。
- [x] 用 Dockerfile 专属 ignore 仅放行 `frontend/` 与 `velalink/`。
- [x] 运行契约测试、diff 检查和真实 Tokyo `linux/amd64` 构建推送验证。

## Verification

- `python3 .ci/runtime/tests/contract_tests/test_build_release_image.py`
- `python3 .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py ReleaseBundleContractTests.test_frontend_playground_release_uses_beijing_registry`
- 国内构建机真实执行 `build_release_image.py --service frontend --env sandbox-jp-1 --platform linux/amd64 --push --reuse-existing`
- JP TCR manifest：`frontend-6cf545e930d2`，`linux/amd64`
- `git diff --check`

---
# My creations show() reveal Implementation Plan

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 国际站“我的作品”和账号页支付方式入口默认隐藏，仅在当前页面调用 `show()` 后展示，同时保持直接 URL 与订阅支付可用。

**Scope:** 仅调整头像菜单、Agent 导航、账号页支付方式区块及定向测试；不修改 `/agents/websites/` 路由、订阅下单、API 或后端。

### Task 1: 使用现有 show() 彩蛋控制“我的作品”入口

**Role:** Developer

**Files:**
- Modify: `frontend/src/components/site/user-avatar-menu.tsx`
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Test: `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`

**Acceptance:**
- 头像菜单和 Agent “使用”分组默认不显示“我的作品”。
- 调用 `window.show()` 后，两处入口按其所在组件生命周期展示。
- 直接访问 `/agents/websites/` 仍可渲染作品面板。
- 不修改网站 API、路由和后端能力。

- [x] 先补充失败测试并确认 RED。
- [x] 复用现有 `show()` 链式回调实现最小展示开关并确认 GREEN。
- [x] 运行定向测试、类型检查、i18n 检查和 diff 检查。

**Verification:**
- `pnpm exec vitest run src/components/site/__tests__/user-avatar-menu.test.tsx src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`（12 tests passed）
- `pnpm i18n:check`
- `pnpm check`
- `git diff --check`

### Task 2: 使用 show() 控制账号页支付方式区块

**Role:** Developer

**Files:**
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Test: `frontend/src/pages/marketing/__tests__/account-page-payment-visibility.test.ts`

**Acceptance:**
- 国际站账号页默认不挂载“支付方式”区块。
- 在账号页调用 `window.show()` 后挂载“支付方式”区块。
- `show()` 继续调用页面上原有的同名 helper。
- 订阅页下单与信用卡支付流程不变。

- [x] 先补充失败测试并确认 RED。
- [x] 实现账号页局部展示状态并确认 GREEN。
- [x] 运行支付方式相关测试、类型检查、i18n 检查和 diff 检查。

**Verification:**
- `pnpm exec vitest run src/pages/marketing/__tests__/account-page-payment-visibility.test.ts src/pages/marketing/__tests__/saved-cards-section.test.tsx src/components/site/__tests__/user-avatar-menu.test.tsx src/pages/marketing/__tests__/agent-settings-nav-order.test.ts src/pages/marketing/__tests__/agent-console-helpers.test.ts`（34 tests passed）
- `pnpm i18n:check`
- `pnpm check`
- `git diff --check`

---
