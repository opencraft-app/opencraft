# 云存储实例容量展示 Implementation Plan

> 状态：已获用户确认，进入实现。

**Goal:** 在国内站和国际站云存储页面展示 Agent 实例磁盘容量，并在页面进入、手动刷新、上传成功和删除成功后更新。

**Architecture:** 复用 `TencentTsshFileClient.execCommand()` 运行固定只读 `statvfs` 查询，组件维护与文件列表互相独立的容量 loading/ready/error 状态。返回值只接受严格 JSON 字节字段；Agent 切换时通过请求序号忽略旧结果。UI 使用现有工作台卡片 token 和原生可访问进度条语义。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Tailwind、项目 i18n 生成脚本。

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

## Out of scope

- 新后端接口、debug/exec 或 TAT 协议变更；
- 目录用量汇总、业务配额、扩容入口、通知和历史趋势；
- 定时轮询、重命名或创建文件夹后的容量刷新；
- 文件管理器其他交互、布局或权限调整。
