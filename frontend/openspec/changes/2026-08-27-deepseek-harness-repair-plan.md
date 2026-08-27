# DeepSeek Harness 修复操作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This S-level follow-up runs inline in the current isolated worktree.

**Goal:** 在已安装卡片中增加经过确认的“修复”操作，复用现有安装任务重新安装 DSH 与 WebUI 插件环境，同时保留模型配置、DSH 设置与存储数据。

**Architecture:** 前端维护 `install | repair` 操作类型，二者共用 `DeepSeekHarnessCommandClient.startInstall()` 和任务轮询。修复任务由 wrapper 隔离完整旧 Web profile，只保留 `cordis.patch.yml` 作为干净 profile 输入，再调用同一安装器 `install` action；失败时 wrapper 恢复完整旧 profile 和原服务状态。刷新后优先恢复轮询，失败时重新读取实际运行状态。确认弹窗拆成独立组件，不新增后端接口。

**Tech Stack:** React 19、TypeScript、Radix Dialog、lucide-react、Vitest、Testing Library、现有 `debug/exec` 命令客户端。

## Global Constraints

- 弹窗标题固定为 `修复 DeepSeek Harness`，按钮固定为 `取消`、`修复`。
- 第一条正文固定为 `修复将重新安装 DeepSeek Harness 运行环境，并在完成后重启服务。修复期间 WebUI 暂时不可用。`
- 第二条正文固定为 `模型配置、DSH 设置与存储数据将会被保留；WebUI 插件环境会重新安装，您自行安装的插件及相关自定义文件将被移除。`
- 修复继续调用现有安装器 `install` action；profile 隔离、成功清理和失败恢复均由固定 wrapper 完成，不新增后端接口或安装器 action。
- 首次安装行为、重启、WebUI 链接和模型配置保持不变。

---

### Task 1: 修复确认弹窗

**Files:**
- Create: `frontend/src/pages/marketing/agent-deepseek-harness-repair-dialog.tsx`
- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx`

**Interfaces:**
- Consumes: `open: boolean`、`onOpenChange(open: boolean)`、`onConfirm()`。
- Produces: `DeepSeekHarnessRepairDialog`，取消、关闭和 Esc 只关闭弹窗，确认只调用一次 `onConfirm()`。

- [x] **Step 1: 写弹窗失败测试。**

  在已安装用例中断言“修复”按钮位于运行操作组；点击后逐字检查标题和两条正文，取消后 `api.startInstall` 未调用。再次打开并点击弹窗中的“修复”，断言只调用一次。

- [x] **Step 2: 运行测试确认 RED。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx
  ```

  Expected: 找不到“修复”按钮或确认弹窗。

- [x] **Step 3: 实现独立弹窗和入口按钮。**

  弹窗复用 `@/components/ui/dialog`，正文使用两个段落；运行卡片按钮使用 lucide `Wrench`，置于“重启”右侧。确认按钮调用 panel 的修复处理函数后关闭弹窗。

- [x] **Step 4: 运行测试确认弹窗 GREEN。**

### Task 2: 修复任务状态与刷新恢复

**Files:**
- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx`

**Interfaces:**
- Produces: `InstallationOperation = "install" | "repair"`；任务 ID 继续存放在 `lightvela:dsh:install-task:${botId}`，操作类型存放在 `lightvela:dsh:install-task-operation:${botId}`。
- Consumes: 现有 `startInstall()`、`getInstallation()`、`getStatus()`、`finishInstallation()`。

- [x] **Step 1: 写修复编排失败测试。**

  覆盖确认后显示 `正在修复 DeepSeek Harness`、任务 ID 与 `repair` 类型持久化、刷新优先恢复 repair 轮询、失败后 `getStatus()` 返回已安装时保留运行卡片并显示任务错误。

- [x] **Step 2: 运行测试确认 RED。**

- [x] **Step 3: 实现操作类型和失败恢复。**

  `pollInstallation(taskId, operation, consecutiveErrors)` 根据 operation 选择安装或修复文案。repair 任务失败时清除持久化记录，再调用 `getStatus()`；返回 `installed: true` 时恢复已安装卡片并保留失败提示，状态读取失败时进入 error。

- [x] **Step 4: 运行 panel 全量测试确认 GREEN。**

### Task 3: 规格、i18n 与回归门禁

**Files:**
- Modify: `frontend/openspec/proposal.md`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/openspec/plan.md`
- Modify: `wiki/prd-docs/2026-08-20-deepseek-harness-lab.md`
- Generated: `frontend/src/i18n/generated/{en-US,id-ID,zh-CN,zh-Hant,zh-to-key}.json`

**Interfaces:**
- Produces: 产品文档、规格、实现和翻译字典使用同一组修复文案与数据边界。

- [x] **Step 1: 运行 i18n 提取并检查新增 key。**

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:check
  ```

- [x] **Step 2: 同步 proposal/spec/plan/PRD。**

- [x] **Step 3: 运行完整验证。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-deepseek-harness-panel.test.tsx \
    src/lib/__tests__/deepseek-harness-command.test.ts \
    scripts/generate-deepseek-harness-runtime-assets.test.ts
  pnpm check
  cd ..
  bash images/tests/test-deepseek-harness-cos-verifier.sh
  bash .ci/runtime/check_ci_runtime.sh
  git diff --check
  ```

  Result: DSH 前端与运行时资源 4 个测试文件共 51 项通过；安装器、release 复用/保留、独立脚本契约、生成器检查、Bash 语法检查和 COS 实际对象一致性校验通过；`pnpm check` 为 232 current / 276 baseline / 0 new。仓库与 COS SHA-256 均为 `1025d54f38e3c82fed6195e318ef0c9e884c447431a6984af895c3bb89f4c2bc`。
