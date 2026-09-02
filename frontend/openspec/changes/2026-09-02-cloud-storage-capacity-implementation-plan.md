# 云存储实例容量展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 状态：实现与自动化验证完成；交付状态以 MR !3499 为准。

**Goal:** 在国内站和国际站云存储页面展示 Agent 实例磁盘容量，并在页面进入、手动刷新、上传成功和删除成功后更新。

**Architecture:** 复用 `TencentTsshFileClient.execCommand()` 运行固定只读 `statvfs` 查询，组件维护与文件列表互相独立的容量 loading/ready/error 状态。返回值只接受严格 JSON 字节字段；Agent 切换时通过请求序号忽略旧结果。UI 使用现有工作台卡片 token 和原生可访问进度条语义。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Tailwind、项目 i18n 生成脚本。

## Global Constraints

- “已用”采用用户视角口径，必须包含文件系统预留空间。
- “可用”必须使用 `f_bavail * f_frsize`，不得把普通 Agent 用户不可写的预留空间计入可用容量。
- 必须满足 `总容量 = 已用容量 + 可用容量`，进度条使用相同的“已用”口径。
- 查询命令保持固定只读，不拼接用户输入，不新增后端接口、依赖或轮询。

## Task 1：用组件测试锁定容量展示与刷新契约

**Files:**

- Modify: `src/components/domain/__tests__/tat-file-manager-panel.test.tsx`

**Steps:**

1. 给 `execCommand` mock 增加固定容量查询返回值，避免影响既有重命名断言。
2. 新增成功态测试，断言标题、已用/总量、剩余值和 `progressbar` 语义。
3. 新增失败隔离测试，断言容量错误态与文件列表可同时显示。
4. 新增刷新链路测试，断言手动刷新、上传成功和删除成功会再次执行容量命令。
5. 运行聚焦测试，确认新增断言在生产代码修改前按预期失败。

## Task 2：最小实现固定命令、状态刷新和容量卡片

**Files:**

- Modify: `src/components/domain/tat-file-manager-panel.tsx`
- Generated: `src/i18n/generated/*.json`

**Steps:**

1. 增加固定 `statvfs` 命令和严格的容量 JSON 解析，拒绝非有限、负数、总量为 0 的结果。
2. 增加独立容量状态和请求序号，在 Agent 切换时重置并忽略过期结果。
3. 在页面进入、手动刷新、上传成功和删除成功后触发查询，不把容量错误写入文件列表错误状态。
4. 在标题下方渲染 `rounded-md` 轻阴影卡片，覆盖加载、成功和错误状态；进度条提供完整 ARIA 数值。
5. 运行 i18n 提取生成所有 locale 资源，再运行聚焦测试直至通过。

## Task 3：完成风险驱动验证与本地页面验收

**Files:**

- Verify: `src/components/domain/tat-file-manager-panel.tsx`
- Verify: `src/components/domain/__tests__/tat-file-manager-panel.test.tsx`
- Update: `.workflow/runtime/verification-ledger.md`

**Steps:**

1. 运行文件管理器聚焦测试、i18n 检查、繁中检查和 `pnpm check`。
2. 运行国内站与国际站构建，确认共享页面在两种区域均可编译。
3. 启动本地预览并完成 `/agents/files` 浏览器 smoke；若本地账号没有可用 Agent，则记录真实阻塞边界，不创建云端资源。
4. 运行 `git diff --check`、检查改动范围和敏感信息，更新验证账本。

## Task 4：把文件系统预留空间计入“已用”

**Files:**

- Modify: `src/components/domain/__tests__/tat-file-manager-panel.test.tsx`
- Modify: `src/components/domain/tat-file-manager-panel.tsx`
- Generated: `src/i18n/generated/*.json`
- Modify: `../wiki/prd-docs/2026-09-02-cloud-storage-capacity.md`

**Interfaces:**

- Consumes: TAT 命令返回的 `total_bytes`、`used_bytes`、`available_bytes` JSON 数值字段。
- Produces: `used_bytes = total_bytes - available_bytes`；容量卡片展示“可用 {available}”，进度条继续计算 `used_bytes / total_bytes`。

- [x] **Step 1：写入能够复现口径问题的失败测试**

  将测试容量固定为 50 GiB 总量、28 GiB 普通用户可用量、22 GiB 用户视角已用量，并将关键断言改为：

  ```tsx
  const STORAGE_TOTAL_BYTES = 50 * 1024 * 1024 * 1024;
  const STORAGE_USED_BYTES = 22 * 1024 * 1024 * 1024;
  const STORAGE_AVAILABLE_BYTES = 28 * 1024 * 1024 * 1024;

  expect(await screen.findByText("已用 22 GB / 50 GB")).toBeInTheDocument();
  expect(screen.getByText("可用 28 GB")).toBeInTheDocument();
  expect(screen.getByText("包含 Agent 运行环境、系统预留和云存储文件。")).toBeInTheDocument();
  expect(progressbar).toHaveAttribute("aria-valuenow", "44");
  expect(capacityCommand).toContain('"used_bytes": max(0, total - available)');
  expect(capacityCommand).not.toContain("total - free");
  ```

- [x] **Step 2：运行测试并确认按预期失败**

  Run: `cd frontend && corepack pnpm@10.23.0 vitest run src/components/domain/__tests__/tat-file-manager-panel.test.tsx`

  Expected: FAIL；旧实现仍展示“剩余”，辅助说明未提系统预留，且命令仍使用 `total - free`。

- [x] **Step 3：最小修改固定查询命令和展示文案**

  将固定命令中的 `used_bytes` 改为基于普通用户可用空间计算：

  ```ts
  const STORAGE_CAPACITY_COMMAND = `python3 -c 'import json, os; stats = os.statvfs("/home/agentuser"); block_size = stats.f_frsize; total = stats.f_blocks * block_size; available = stats.f_bavail * block_size; print(json.dumps({"total_bytes": total, "used_bytes": max(0, total - available), "available_bytes": available}, separators=(",", ":")))'`;
  ```

  展示文案改为：

  ```tsx
  {t("包含 Agent 运行环境、系统预留和云存储文件。")}
  {t("可用 {{available}}", { available: formatBytes(storageCapacity.availableBytes) })}
  ```

- [x] **Step 4：生成本地化资源并确认聚焦测试恢复通过**

  Run: `cd frontend && corepack pnpm@10.23.0 i18n:extract && corepack pnpm@10.23.0 i18n:zh-hant`

  Expected: 生成字典包含两条新中文源文案，繁中资源同步完成。

  Run: `cd frontend && corepack pnpm@10.23.0 vitest run src/components/domain/__tests__/tat-file-manager-panel.test.tsx`

  Expected: PASS，文件内 29 个测试全部通过。

- [x] **Step 5：完成质量门禁和差异检查**

  Run: `cd frontend && corepack pnpm@10.23.0 check`

  Expected: PASS，i18n、繁中一致性及 TypeScript 无新增错误。

  Run: `git diff --check`

  Expected: 无输出。

## Task 5：处理 TAT 输出健壮性 CR

**Files:**

- Modify: `src/components/domain/__tests__/tat-file-manager-panel.test.tsx`
- Modify: `src/components/domain/tat-file-manager-panel.tsx`
- Modify: `openspec/plan.md`

**Interfaces:**

- Consumes: `TencentTsshFileClient.execCommand()` 返回的 `{ exitCode: number | null; output: string }`。
- Produces: 仅接受双哨兵之间的容量 JSON；有效 JSON 可在 `exitCode === null` 时成功，明确的非零退出码仍失败。

- [x] **Step 1：补失败测试**

  - 容量命令必须输出 `__LIGHTVELA_STORAGE_CAPACITY_START__` 与 `__LIGHTVELA_STORAGE_CAPACITY_END__`。
  - `exitCode: null` 且哨兵载荷有效时展示容量。
  - 哨兵前后存在 PTY 噪声时仍展示容量。
  - 查询失败时调用 `console.warn("[storage-capacity] lookup failed", <脱敏消息>)`，界面仍只显示统一错误态。
  - 重命名测试按命令内容筛选 `mv` 调用，并同时断言恰好一次及完整参数。

- [x] **Step 2：运行聚焦测试确认 RED**

  Run: `cd frontend && corepack pnpm@10.23.0 vitest run src/components/domain/__tests__/tat-file-manager-panel.test.tsx`

  Expected: 新增的退出码、哨兵噪声与日志断言失败，既有文件管理行为保持通过。

- [x] **Step 3：最小实现**

  - 固定命令把 JSON 包在双哨兵之间。
  - `parseStorageCapacity()` 使用最后一个开始哨兵和其后的结束哨兵截取载荷，再复用既有 JSON 字段校验。
  - 退出码判断改为仅拒绝明确非零值。
  - `catch` 只记录错误消息，不记录命令输出、实例信息或凭据。

- [x] **Step 4：运行 GREEN 与质量门禁**

  Run: `cd frontend && corepack pnpm@10.23.0 vitest run src/components/domain/__tests__/tat-file-manager-panel.test.tsx && corepack pnpm@10.23.0 check`

  Expected: 聚焦测试全部通过，i18n / TypeScript 无新增错误。

- [ ] **Step 5：合并最新目标分支并验证**

  在获得 commit / push 确认后合并 `origin/master`，只手工合并 `frontend/openspec/plan.md` 的双方顶部条目；随后重新运行聚焦测试、`pnpm check`、`build:cn`、`build:global` 和 `git diff --check`。

## Out of scope

- 新后端接口、debug/exec 或 TAT 协议变更；
- 目录用量汇总、业务配额、扩容入口、通知和历史趋势；
- 定时轮询、重命名或创建文件夹后的容量刷新；
- 文件管理器其他交互、布局或权限调整。
