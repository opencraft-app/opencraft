# Coding Plan 七彩石模型目录 Implementation Plan

> **For agentic workers:** Use test-driven-development task by task and keep each checkbox current.

**Goal:** 让所有 Coding Plan 直接使用七彩石模型目录，保留多模型选择、独立检测和添加前自动检测。

**Architecture:** 在 Provider 适配层按 `category` 统一声明 Coding Plan 行为；面板层复用目录模型作为可选项，并将“独立检测”和“添加前检测”解耦。API 与自定义 Provider 保持现状。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library。

### Task 1: Provider 行为适配

**Files:**
- Modify: `src/pages/marketing/agent-config/utils/model-provider-parser.ts`
- Test: `src/pages/marketing/agent-config/utils/__tests__/model-provider-parser.test.ts`
- Modify: `src/pages/marketing/agent-model-config/product-provider-adapter.ts`
- Test: `src/pages/marketing/agent-model-config/__tests__/product-provider-adapter.test.ts`

- [x] 写入所有 Coding Plan 使用目录、自动检测且空目录隐藏的失败测试。
- [x] 运行聚焦测试并确认 RED。
- [x] 按 `category === "coding_plan"` 实现统一行为，删除 Provider 白名单。
- [x] 校验七彩石 Provider 必要结构，整组无效时返回 `null`，并清洗畸形模型项。
- [x] 运行聚焦测试并确认 GREEN。

### Task 2: 多模型选择与双重检测

**Files:**
- Modify: `src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- Test: `src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

- [x] 写入默认首项、多模型切换、保留独立检测、添加前自动检测的失败测试。
- [x] 运行聚焦测试并确认 RED。
- [x] 让目录选择受本地状态控制，并始终渲染独立检测按钮。
- [x] 将添加前检测绑定到 Provider 与模型 ID，忽略目录刷新后的旧检测结果。
- [x] 运行聚焦测试并确认 GREEN。

### Task 3: 回归与质量门禁

- [x] 运行模型配置目录完整测试。
- [x] 运行 `pnpm check`。
- [x] 运行国内站和国际站构建。
- [x] 运行 `git diff --check`，检查最终范围与风险。
