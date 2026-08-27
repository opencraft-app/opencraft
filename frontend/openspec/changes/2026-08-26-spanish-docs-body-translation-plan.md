# 国际站西语 Docs 正文全量适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development. The repository remains single-agent unless the user explicitly authorizes subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为国际站 61 篇 Docs 增加完整拉美西语正文源，并让 `/es/docs/**` 不再回退英文。

**Architecture:** 以 `src/content/docs/en/**` 为内容底稿，在 `src/content/docs/es/**` 创建同路径 Markdown；先用 parity 测试锁定文件集合、图片目标、代码块和结构，再按 28 / 16 / 17 篇三批翻译。最后移除西语 docSet fallback，通过 Fumadocs 同步生成 `/es/docs/**`。

**Tech Stack:** Markdown、Node.js ESM、Fumadocs MDX、Vitest、Next.js static export。

## Global Constraints

- 区域固定为 `global`；不修改国内站正文。
- 使用自然拉美西语，不使用 `vosotros`。
- 图片文件、图片字节和图片引用路径完全不变；只翻译 alt 文本。
- fenced code block 的语言标识和内容逐字保持。
- 法务正文继续使用英文，不在本计划内。
- 不修订英文或中文原文，不新增文档 slug，不调整 sidebar 顺序。
- 每批最多一个内容任务和一个验证任务，符合 M 级每批不超过 3 个任务的限制。

---

### Task 1: 西语正文完整性与结构门禁

**Files:**
- Modify: `frontend/scripts/international-docs-parity.test.ts`
- Modify: `frontend/scripts/sync-fumadocs-content.mjs`
- Modify: `frontend/src/content/docs/last-updated.json`

- [x] 为 `en/**` 与 `es/**` 路径集合一致、图片目标一致、代码块一致和结构一致增加失败测试。
- [x] 运行 `pnpm exec vitest run --config vitest.config.ts scripts/international-docs-parity.test.ts`，确认因 `es/**` 缺失而失败。
- [x] 保留构建期间的现有 fallback，直至三批源文件全部存在；第三批完成后删除 `fallbackSourcePrefixes: ['en', 'global']`。
- [x] 每批新增源文件时同步 `src/content/docs/last-updated.json`，日期使用 `2026-08-26`。

### Task 2: 第一批 28 篇工具型文档

**Create:**
- `frontend/src/content/docs/es/01-overview.md`
- `frontend/src/content/docs/es/02-quickstart.md`
- `frontend/src/content/docs/es/04-core-concepts.md`
- `frontend/src/content/docs/es/who-is-lightvela-for.md`
- `frontend/src/content/docs/es/plans.md`
- `frontend/src/content/docs/es/announcements/public-beta.md`
- `frontend/src/content/docs/es/credits.md`
- `frontend/src/content/docs/es/create-first-hermes.md`
- `frontend/src/content/docs/es/05-configuration.md`
- `frontend/src/content/docs/es/configuration/model.md`
- `frontend/src/content/docs/es/configuration/channel-telegram.md`
- `frontend/src/content/docs/es/configuration/channel-whatsapp.md`
- `frontend/src/content/docs/es/configuration/channel-discord.md`
- `frontend/src/content/docs/es/configuration/channel-slack.md`
- `frontend/src/content/docs/es/configuration/channel-wechat.md`
- `frontend/src/content/docs/es/configuration/channel-qq.md`
- `frontend/src/content/docs/es/configuration/channel-wecom.md`
- `frontend/src/content/docs/es/configuration/channel-feishu.md`
- `frontend/src/content/docs/es/configuration/skill.md`
- `frontend/src/content/docs/es/configuration/personality.md`
- `frontend/src/content/docs/es/configuration/memory.md`
- `frontend/src/content/docs/es/configuration/automation.md`
- `frontend/src/content/docs/es/configuration/files.md`
- `frontend/src/content/docs/es/configuration/agent-chat.md`
- `frontend/src/content/docs/es/configuration/diagnostics.md`
- `frontend/src/content/docs/es/configuration/advanced-settings.md`
- `frontend/src/content/docs/es/configuration/multiple-models.md`
- `frontend/src/content/docs/es/contact-us.md`

- [x] 按英文源逐篇翻译，保留步骤、结果校验、失败处理、表格、链接和能力边界。
- [x] 运行 `pnpm docs:sync`，确认 28 篇西语产物的 `source_path` 指向 `src/content/docs/es/`，其余 33 篇仍临时回退英文。
- [x] 运行 Docs parity 定向测试；只允许“剩余 33 篇尚未创建”这一阶段性缺口。

### Task 3: 第二批 16 篇 Use Cases

**Create:**
- `frontend/src/content/docs/es/use-cases/personal-ai-assistant.md`
- `frontend/src/content/docs/es/use-cases/chinese-messaging-channels.md`
- `frontend/src/content/docs/es/use-cases/telegram-persona-agent.md`
- `frontend/src/content/docs/es/use-cases/whatsapp-persona-agent.md`
- `frontend/src/content/docs/es/use-cases/im-agent-persona-soul-md.md`
- `frontend/src/content/docs/es/use-cases/im-agent-skill-scenarios.md`
- `frontend/src/content/docs/es/use-cases/multi-channel-personality-memory.md`
- `frontend/src/content/docs/es/use-cases/telegram-group-community-assistant.md`
- `frontend/src/content/docs/es/use-cases/whatsapp-24-7-customer-service.md`
- `frontend/src/content/docs/es/use-cases/lifelike-im-agent-rhythm-social-memory.md`
- `frontend/src/content/docs/es/use-cases/telegram-whatsapp-safety-boundaries.md`
- `frontend/src/content/docs/es/use-cases/daily-summary.md`
- `frontend/src/content/docs/es/use-cases/hermes-agent-24-7.md`
- `frontend/src/content/docs/es/use-cases/memory-and-knowledge.md`
- `frontend/src/content/docs/es/use-cases/discord-community-agent.md`
- `frontend/src/content/docs/es/use-cases/discord-event-agent.md`

- [x] 按英文源逐篇翻译，保持模板顺序、实用表格、FAQ、内链和限制说明。
- [x] 运行 `pnpm docs:sync` 与 Docs parity 定向测试；只允许“剩余 17 篇尚未创建”这一阶段性缺口。

### Task 4: 第三批 17 篇 Compare 与 Hermes Agent Deep Dive

**Create:**
- `frontend/src/content/docs/es/compare/lightvela-vs-localhost-ai-agent.md`
- `frontend/src/content/docs/es/compare/lightvela-vs-hostinger.md`
- `frontend/src/content/docs/es/compare/lightvela-vs-manus.md`
- `frontend/src/content/docs/es/compare/lightvela-vs-chatgpt.md`
- `frontend/src/content/docs/es/compare/lightvela-vs-genspark.md`
- `frontend/src/content/docs/es/hermes-agent/01-hermes-vs-openclaw.md`
- `frontend/src/content/docs/es/hermes-agent/02-why-hermes-remembers-you.md`
- `frontend/src/content/docs/es/hermes-agent/03-user-md-vs-memory-md.md`
- `frontend/src/content/docs/es/hermes-agent/04-hermes-memory-curation.md`
- `frontend/src/content/docs/es/hermes-agent/05-memory-vs-skill.md`
- `frontend/src/content/docs/es/hermes-agent/06-model-vs-agent-layer.md`
- `frontend/src/content/docs/es/hermes-agent/07-message-gateway.md`
- `frontend/src/content/docs/es/hermes-agent/08-automation-scheduling.md`
- `frontend/src/content/docs/es/hermes-agent/09-model-switching-memory.md`
- `frontend/src/content/docs/es/hermes-agent/10-persona-user-memory.md`
- `frontend/src/content/docs/es/hermes-agent/11-workspace-context-storage.md`
- `frontend/src/content/docs/es/hermes-agent/12-skills-self-improvement.md`

- [x] 按英文源逐篇翻译，保持主对比表、机制表、代码块、事实细节、立场声明和能力边界。
- [x] 删除西语 docSet 的英文/中文 fallback；缺少西语源必须让同步失败。
- [x] 运行 `pnpm docs:sync` 两次并比较 `next-site/docs-route-manifest.ts`，确认生成结果稳定。
- [x] 运行 `pnpm exec vitest run --config vitest.config.ts scripts/international-docs-parity.test.ts scripts/docs-image-assets.test.ts scripts/docs-last-updated.test.ts`。
- [x] 运行 `pnpm check`、`git diff --check`，并确认图片目录相对 `dfa3536c9` 无差异。
