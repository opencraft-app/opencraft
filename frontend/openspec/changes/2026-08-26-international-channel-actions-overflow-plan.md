# 国际站渠道卡片操作按钮防溢出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The repository remains single-agent unless the user explicitly authorizes subagents.

**Goal:** 修复国际站西语 Slack 已连接卡片的“配置教程 / 断开 / 重新连接”按钮越界，同时保持其他站点与通道行为不变。

**Architecture:** ChannelPanel 根节点通过现有 `ops.productConfig.isI18n` 增加国际站样式作用域。仅在该作用域的已连接卡片上启用可换行操作布局，让教程按钮和右侧操作组按可用宽度分配空间，并在空间不足时把右侧操作组整体换行。

**Tech Stack:** React 19、TypeScript 5.9、CSS Flexbox、Vitest 4、Next.js 16。

## Global Constraints

- 仅改变国际站已连接渠道卡片的操作布局；国内站不进入新样式作用域。
- 保留 `Tutorial de configuración`、`Desconectar`、`Reconectar` 等完整译文。
- 不修改通道列表、Slack 状态、教程链接、连接、断开或重连逻辑。
- 不修改卡片网格列数、卡片宽度或未连接卡片布局。
- 未经用户另行确认，不执行 `git commit`、`git push` 或创建 MR。

---

### Task 1: 锁定国际站已连接卡片的响应式布局契约

**Files:**
- Create: `frontend/src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`
- Modify: `frontend/src/pages/marketing/agent-channel-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-config/standard-panel.css`

**Interfaces:**
- Consumes: `ops.productConfig.isI18n`、`lh-std-channel-panel__card--bound`、现有三个操作元素。
- Produces: `lh-std-channel-panel--i18n` 样式作用域和国际站已连接卡片防溢出规则。

- [x] **Step 1: 添加失败测试，锁定国际站作用域与防溢出属性。**

  新测试读取 ChannelPanel 源码和标准面板 CSS，断言：

  ```ts
  expect(channelPanelSource).toContain(
    "ops.productConfig.isI18n ? `${CLS}--i18n` : ''",
  );
  expect(connectedActionRule).toContain("flex-wrap: wrap;");
  expect(connectedGuideRule).toContain("flex: 1 1 112px;");
  expect(connectedGuideRule).toContain("min-width: 112px;");
  expect(connectedActionGroupRule).toContain("flex: 1 0 220px;");
  expect(connectedActionGroupRule).toContain("min-width: min(220px, 100%);");
  ```

  测试选择器必须以 `.lh-std-channel-panel--i18n .lh-std-channel-panel__card--bound` 开头，避免国内站误用。

- [x] **Step 2: 运行焦点测试并确认 RED。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-channel-action-layout.test.ts
  ```

  Expected: FAIL，原因是国际站 modifier class 和对应 CSS 规则尚不存在。

- [x] **Step 3: 为国际站 ChannelPanel 增加样式作用域。**

  将非 loading 状态根节点改为：

  ```tsx
  <div
    className={`${CLS} ${ops.productConfig.isI18n ? `${CLS}--i18n` : ''} ${className || ''}`}
  >
  ```

  loading 状态不渲染卡片，无需添加 modifier。

- [x] **Step 4: 添加国际站已连接卡片的最小响应式 CSS。**

  在现有 ChannelPanel 操作按钮规则后增加：

  ```css
  .lh-std-channel-panel--i18n
    .lh-std-channel-panel__card--bound
    .lh-std-channel-panel__card-action {
    flex-wrap: wrap;
    min-width: 0;
  }

  .lh-std-channel-panel--i18n
    .lh-std-channel-panel__card--bound
    .lh-std-channel-panel__guide-btn {
    flex: 1 1 112px;
    min-width: 112px;
    justify-content: center;
    padding-inline: 10px;
    text-align: center;
  }

  .lh-std-channel-panel--i18n
    .lh-std-channel-panel__card--bound
    .lh-std-channel-panel__card-action-right {
    flex: 1 0 220px;
    min-width: min(220px, 100%);
    justify-content: flex-end;
    margin-left: 0;
  }

  .lh-std-channel-panel--i18n
    .lh-std-channel-panel__card--bound
    :is(.lh-std-channel-panel__card-unbind, .lh-std-channel-panel__connect-btn) {
    flex: 1 1 0;
    min-width: 0;
    padding-inline: 10px;
    white-space: nowrap;
  }
  ```

  右侧操作组在单行时靠右；达到最小组合宽度后整体换到下一行，两个操作按钮继续保持同一组。

- [x] **Step 5: 重跑焦点测试确认 GREEN。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-channel-action-layout.test.ts \
    src/pages/marketing/__tests__/agent-channel-hint-style.test.ts \
    src/pages/marketing/__tests__/agent-settings-channel-slack.test.ts
  ```

  Expected: 三份测试全部 PASS。

### Task 2: 验证西语 Slack 与周边渠道无回归

**Files:**
- Modify: `frontend/openspec/plan.md`
- Verify: `frontend/src/pages/marketing/agent-channel-panel.tsx`
- Verify: `frontend/src/pages/marketing/agent-config/standard-panel.css`

**Interfaces:**
- Consumes: Task 1 的国际站 modifier class 和 CSS 规则。
- Produces: 测试、类型检查、文件边界和浏览器验收证据。

- [x] **Step 1: 运行相关测试与基础门禁。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-channel-action-layout.test.ts \
    src/pages/marketing/__tests__/agent-channel-hint-style.test.ts \
    src/pages/marketing/__tests__/agent-settings-channel-slack.test.ts \
    src/pages/marketing/__tests__/agent-channel-dingtalk.test.ts
  pnpm check
  cd ..
  git diff --check
  ```

  Expected: 测试、i18n、TypeScript 和 diff 检查退出码均为 0；西语字典继续保持 0 error / 0 warning。

- [x] **Step 2: 浏览器验证国际站西语已连接态。**

  在 `http://localhost:5174/es/agents/channels` 或实际 Agent 渠道入口检查：

  - Slack 卡片三个按钮的右边界不大于卡片内容右边界。
  - 当前桌面三列宽度下按钮优先同一行；缩窄视口后右侧操作组整体换行。
  - 未连接 Telegram、Discord 等卡片仍为“教程 + 连接”布局。
  - 浏览器控制台无新增 hydration、布局或运行时错误。

- [x] **Step 3: 更新计划证据并展示最终差异，等待提交确认。**

  展示修改文件、验证结果和建议提交信息；不执行提交或推送。

## Verification Evidence

- TDD RED：新增 2 个布局契约断言均因国际站 modifier 和作用域 CSS 缺失而失败。
- TDD GREEN：布局、通道提示、Slack 和钉钉相关 4 个测试文件 / 10 个断言通过。
- `pnpm check` 退出码 0；西语 2589/2589，0 error / 0 warning；TypeScript 221 current / 276 baseline / 0 new。
- 浏览器实测 Slack 已连接卡片按钮最右边界距卡片右边界 21px；窄卡片下教程占第一行、断开与重连保持同组第二行；无相关控制台告警。
- `git diff --check` 退出码 0；国内站未进入 `lh-std-channel-panel--i18n` 作用域。
