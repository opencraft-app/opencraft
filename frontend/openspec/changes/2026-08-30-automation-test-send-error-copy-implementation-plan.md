# 自动任务测试消息错误提示精简 Implementation Plan

**Goal:** 未识别的 Hermes 原始错误不再出现在发送测试消息失败 Toast 中。

**Architecture:** 保持 `formatTestSendError` 的签名和按通道 fallback 不变，只将未知错误详情视为不可展示；已识别错误继续走现有本地化分支。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4。

## Global Constraints

- 不修改 Hermes 命令、通道检测、错误抛出或日志。
- 国内站与国际站行为一致。
- 不新增依赖或 i18n 文案。
- 先 RED、再最小实现、再 GREEN。
- 提交前运行定向测试、`pnpm check` 和 `git diff --check`。

---

### Task 1: 隐藏未知原始错误详情

**Files:**
- Modify: `src/pages/marketing/agent-automations-panel.tsx`
- Test: `src/pages/marketing/__tests__/agent-automations-panel.test.ts`

**Interfaces:**
- Consumes: `formatTestSendError(error, fallback, t?)`。
- Produces: 已知错误返回本地化详情；未知错误只返回 fallback。

- [x] **Step 1: 写入失败回归测试**
- [x] **Step 2: 运行目标用例并确认当前会拼接原始英文**
- [x] **Step 3: 将 `formatKnownTestSendError` 的未知错误兜底改为空字符串**
- [x] **Step 4: 运行国内/国际定向测试、`pnpm check` 和差异检查**

## Result

截图对应用例先 RED，确认当前会在中文 fallback 后拼接 `hermes send: Weixin ...`；最小修改后 GREEN。国内/国际自动任务面板测试 149/149 通过；`pnpm check` 通过，TypeScript diagnostics 为 207 current / 276 baseline / 0 new / 69 resolved；目标文件 `git diff --check` 通过。
