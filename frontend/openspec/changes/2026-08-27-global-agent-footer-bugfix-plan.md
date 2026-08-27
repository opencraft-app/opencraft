# 国际站 Agent 与页脚问题修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复国际站英文 Agent 页标题、双站 Agent 侧栏底部留白，并在国际站页脚增加 Tencent EdgeOne。

**Architecture:** 保持现有 Next.js route metadata、Agent 侧栏 CSS 和 FooterSection 数据结构，只做三个局部修正。所有行为先由现有 Vitest 文件中的失败断言锁定，再写最小实现。

**Tech Stack:** Next.js 16、React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- 分支固定为 `jasmin-bugfix-827`，不执行 commit、push 或 MR。
- 不新增依赖，不重构 Agent 页面，不修改国内站页脚产品项。
- Tencent EdgeOne 链接固定为 `https://edgeone.ai/`，并使用既有安全外链属性。

---

### Task 1: 三项页面回归与最小修复

**Files:**
- Create: `frontend/src/pages/marketing/__tests__/agent-page-metadata.test.ts`
- Modify: `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts`
- Modify: `frontend/src/components/site/__tests__/lightvela-footer.test.tsx`
- Modify: `frontend/src/app/(site)/agents/page.next.tsx`
- Modify: `frontend/src/app/(site)/agents/[section]/page.next.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/components/site/lightvela-footer.tsx`

**Interfaces:**
- Consumes: 编译期 `isGlobal`、现有 `.lv-agents-sidebar`、`FooterSection.links`。
- Produces: global `My Agent` 默认 metadata、跟随运行时语言的唯一 title、双站 24px 侧栏底部空间、国际站 Tencent EdgeOne 外链。

- [x] **Step 1: 写入失败回归测试**

  metadata 测试分别 mock global/cn 构建，断言 `/agents` 与 `/agents/[section]` 的默认标题为 `My Agent` / `我的智能体伙伴`；应用壳测试断言英文与中文运行时切换会更新唯一 title；间距测试断言 `.lv-agents-sidebar` 含 `padding-bottom: 24px;`；页脚测试断言 `Tencent EdgeOne` 的 `href`、`target` 和 `rel`。

- [x] **Step 2: 运行测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run \
    src/pages/marketing/__tests__/agent-page-metadata.test.ts \
    src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts \
    src/components/site/__tests__/lightvela-footer.test.tsx
  ```

  Expected: metadata 仍为中文、侧栏缺少 24px 底部空间、页脚找不到 Tencent EdgeOne，测试失败。

- [x] **Step 3: 写入最小实现**

  两个 Agent route 复用区域默认的 Agent metadata；应用壳按运行时 locale 同步既有 title 并清理重复节点；`.lv-agents-sidebar` 增加 `padding-bottom: 24px;`；国际站相关产品 links 追加 `{ label: "Tencent EdgeOne", href: "https://edgeone.ai/", external: true }`。

- [x] **Step 4: 运行定向测试并确认 GREEN**

  重跑 Step 2 命令，Expected: 全部通过。

- [x] **Step 5: 完成质量门禁和国际站 smoke**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  cd ..
  git diff --check
  ```

  启动国际站本地开发服务，检查 `/agents` 的浏览器标题与侧栏底部空间，并检查站点页脚 Tencent EdgeOne 外链。
