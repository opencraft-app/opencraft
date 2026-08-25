# Agent Approval Mode CR Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This S-level follow-up runs inline in the current isolated worktree; no subagent dispatch.

**Goal:** 修复 MR !3288 事后评审确认的审批模式兼容性与安全提示问题，并补齐关键保护测试。

**Architecture:** 保留现有 `approvals.mode` 命令、即时生效与 reset/save 边界，只收窄 Python reader 的未知枚举失败半径，并在现有 panel 状态上增加安全组专属文案和 `off` 状态提示。测试直接锁定生成 reader、reset 命令序列和 panel 用户行为，不引入新抽象或依赖。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Radix Select、i18next、嵌入式 Python reader。

## Global Constraints

- 仅国内站既有 Agent 高级设置入口可见，国际站边界不变。
- `approvalMode` 保存与恢复仍不重启 Gateway。
- 未知审批模式不得显示为 `smart`、`manual` 或 `off`，也不得阻塞其他设置。
- 不修改镜像出厂 `approvals.mode: off`，不接入其他 `approvals.*` 字段。
- 生产代码修改前先确认对应测试按预期失败；既有保护测试用定向 mutation 证明有牙齿。

---

### Task 1: 未知审批模式局部降级

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-common-settings.test.ts`
- Modify: `frontend/src/pages/marketing/agent-common-settings.ts:144-169`

**Interfaces:**
- Consumes: `buildHermesCommonSettingsReadCommand()` 与 `HermesCommonSettingsSnapshot.unsupportedKeys`。
- Produces: 未知 `approvals.mode` 返回可解析快照，`approvalMode` 只读降级，其他字段保持可用。

- [x] **Step 1: 写真实 reader 失败测试。**

  在临时目录放置 fake `hermes`，让 `config get approvals.mode --json` 返回 `"auto"`，其他字段返回合法 JSON；执行 `buildHermesCommonSettingsReadCommand()` 并断言：

  ```ts
  expect(parseHermesCommonSettingsSnapshot(output)).toMatchObject({
    values: { approvalMode: "smart", persistentMemory: true },
    unsupportedKeys: ["approvalMode"],
  });
  ```

  `smart` 仅是内部结构兜底，panel 因 unsupported 不展示它。

- [x] **Step 2: 运行测试确认 RED。**

  ```bash
  cd frontend
  pnpm vitest run src/pages/marketing/__tests__/agent-common-settings.test.ts
  ```

  Expected: reader 因 `ValueError: Hermes approvals.mode returned an invalid value` 退出，测试失败。

- [x] **Step 3: 实现最小降级。**

  将审批模式特判删除，统一执行：

  ```python
  if not valid_value(field, resolved_value):
      unsupported_keys.append(field)
      continue
  ```

- [x] **Step 4: 运行核心测试确认 GREEN。**

  ```bash
  cd frontend
  pnpm vitest run src/pages/marketing/__tests__/agent-common-settings.test.ts
  ```

  Expected: 核心测试全部通过，未知模式只降级单字段。

### Task 2: 安全组结果文案与关闭状态提示

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-common-settings-panel.tsx:407-462,613-626`
- Generated: `frontend/src/i18n/generated/{en-US,id-ID,zh-CN,zh-Hant,zh-to-key}.json`

**Interfaces:**
- Consumes: `snapshot.values.approvalMode`、`pendingResetGroup`、现有 i18n `t()`。
- Produces: `off` 状态的非阻断提示，以及安全组恢复前的明确结果说明。

- [x] **Step 1: 写 panel 失败测试。**

  扩展既有 `off` 用例：

  ```ts
  expect(screen.getByText("当前不会请求危险命令审批")).toBeTruthy();
  ```

  扩展安全组恢复用例：

  ```ts
  await user.click(within(securityGroup!).getByRole("button", { name: "恢复默认" }));
  expect(screen.getByText("恢复后审批模式将变为「智能审批」（当前为「关闭审批」）。")).toBeTruthy();
  ```

  同时断言 `smart` 不显示风险提示，记忆/上下文仍显示通用恢复说明。

- [x] **Step 2: 运行 panel 测试确认 RED。**

  ```bash
  cd frontend
  pnpm vitest run src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx
  ```

  Expected: 两条新增中文文案尚未渲染而失败。

- [x] **Step 3: 实现最小 UI。**

  在受支持的审批模式行增加：

  ```tsx
  {setting.key === "approvalMode" && snapshot.values.approvalMode === "off" && (
    <span className="text-xs text-amber-700">{t("当前不会请求危险命令审批")}</span>
  )}
  ```

  reset dialog 对安全组使用专属说明，其他组保留原文案。

- [x] **Step 4: 运行 panel 测试确认 GREEN。**

  ```bash
  cd frontend
  pnpm vitest run src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx
  ```

  Expected: panel 测试全部通过。

### Task 3: 锁定 reset 过滤与同步保存互斥

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-common-settings-reset.test.ts`
- Modify: `frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx`

**Interfaces:**
- Consumes: `snapshot.unsupportedKeys`、`saveInFlightRef`。
- Produces: 两个既有 load-bearing guard 的可执行回归证据。

- [x] **Step 1: 添加混合支持 reset 测试。**

  构造 `persistentMemory` 可恢复、`userProfile` unsupported 的快照，断言只调用：

  ```ts
  expect(execDebugCommand.mock.calls.map(([, command]) => command)).toEqual([
    "hermes config unset memory.memory_enabled",
    "hermes gateway restart",
    expect.stringContaining("HERMES_ROOT="),
  ]);
  expect(result).toMatchObject({ status: "success" });
  ```

- [x] **Step 2: 添加同步双确认保存测试。**

  对同一个保存按钮同步调用原生 `click()` 两次，在首个保存 Promise 未完成时断言：

  ```ts
  expect(saveSetting).toHaveBeenCalledTimes(1);
  ```

- [x] **Step 3: 用定向 mutation 证明测试有牙齿。**

  临时删除 `unsupportedKeys` filter 和 `saveInFlightRef.current` guard，各运行对应单测并确认失败；随后恢复生产代码。mutation 不进入最终 diff。

- [x] **Step 4: 运行 reset 与 panel 测试确认 GREEN。**

  ```bash
  cd frontend
  pnpm vitest run \
    src/pages/marketing/__tests__/agent-common-settings-reset.test.ts \
    src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx
  ```

  Expected: 两个文件全部通过。

### Task 4: i18n 与完整验证

**Files:**
- Update generated dictionaries only through `pnpm i18n:extract`.
- Verify all changed production, test, OpenSpec, and generated i18n files.

**Interfaces:**
- Consumes: Tasks 1-3 的最终 diff。
- Produces: 可提交的国内站修复分支和完整验证证据。

- [x] **Step 1: 提取并补齐四语种翻译。**

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:check
  pnpm i18n:zh-hant:check
  ```

  新文案需提供 en-US、id-ID、zh-Hant 翻译，不手改无关历史键。

- [x] **Step 2: 运行焦点回归与静态检查。**

  ```bash
  cd frontend
  pnpm vitest run \
    src/pages/marketing/__tests__/agent-common-settings.test.ts \
    src/pages/marketing/__tests__/agent-common-settings-save.test.ts \
    src/pages/marketing/__tests__/agent-common-settings-reset.test.ts \
    src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx \
    src/pages/marketing/__tests__/agent-common-settings-page-boundary.test.ts
  pnpm typecheck
  pnpm check
  ```

- [x] **Step 3: 运行双区域构建和 diff 门禁。**

  ```bash
  cd frontend
  pnpm build:cn
  pnpm build:global
  cd ..
  git diff --check origin/master...HEAD
  git status --short
  ```

  Expected: 所有命令退出 0；若构建重写字体子集，仅恢复该生成二进制，不修改用户文件。

- [x] **Step 4: 展示最终范围并等待提交/MR确认。**

  展示改动文件、测试结果、commit message、MR 标题和描述；确认前不提交实现、不推送、不创建 MR。

### Task 5: 审批说明改为高风险操作

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-common-settings-panel.tsx:116-128`
- Generated: `frontend/src/i18n/generated/{en-US,id-ID,zh-CN,zh-Hant,zh-to-key}.json`

**Interfaces:**
- Consumes: `SETTING_GROUPS` 中安全分组和 `approvalMode` 设置项的 `description`。
- Produces: 两句中性说明与关闭审批弹窗正文统一使用「高风险操作」，不改变 `off` 常驻提示、弹窗标题或操作按钮。

- [x] **Step 1: 写文案失败测试。**

  在 panel 首屏测试中断言：

  ```ts
  expect(screen.getByText("管理 Agent 执行高风险操作时的审批方式。")).toBeTruthy();
  expect(screen.getByText("设置 Agent 执行高风险操作时的审批方式。")).toBeTruthy();
  expect(screen.getByText("关闭后，Agent 执行高风险操作时将不再请求你的批准。请仅在可信环境中使用。")).toBeTruthy();
  expect(screen.queryByText("管理 Agent 执行危险命令时的审批方式。")).toBeNull();
  expect(screen.queryByText("设置 Agent 遇到危险命令时如何请求审批。")).toBeNull();
  expect(screen.queryByText("关闭后，Agent 执行危险命令时将不再请求你的批准。请仅在可信环境中使用。")).toBeNull();
  ```

- [x] **Step 2: 运行 panel 测试确认 RED。**

  ```bash
  cd frontend
  pnpm vitest run src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx -t "uses high-risk operation copy"
  ```

  Expected: 两句新文案尚未渲染，测试失败。

- [x] **Step 3: 最小替换两句源文案。**

  ```tsx
  description: t("管理 Agent 执行高风险操作时的审批方式。")
  description: t("设置 Agent 执行高风险操作时的审批方式。")
  t("关闭后，Agent 执行高风险操作时将不再请求你的批准。请仅在可信环境中使用。")
  ```

  不修改「当前不会请求危险命令审批」、弹窗标题或操作按钮。

- [x] **Step 4: 提取翻译并完成回归。**

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:check
  pnpm i18n:zh-hant:check
  pnpm vitest run src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx
  pnpm typecheck
  pnpm check
  cd ..
  git diff --check
  ```

  Expected: panel 全部通过，i18n 与静态门禁退出 0，生成字典仅替换两句本需求文案。

- [x] **Step 5: 展示增量提交范围并等待确认。**

  提交信息建议：`优化审批模式说明文案 / copy(frontend): refine approval mode descriptions`。确认前不提交、不推送。
