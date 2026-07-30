# International Docs GEO Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independent `zh-sg` and `en-us` versions of the 36 international docs pages missing from `jasminzhao-geo-article-720`, without importing any pre-existing domestic-only docs differences.

**Architecture:** Keep the existing two international source trees (`global/` and `en/`) and register the same branch-new slugs in both the Fumadocs catalog and the legacy docs sidebar/search mapping. Generate route manifests through the existing sync script, and protect the parity contract with a focused Vitest test.

**Tech Stack:** Markdown, TypeScript 5.9, Next.js 16, Fumadocs, Vitest 4, pnpm.

## Global Constraints

- Source boundary: merge-base `dad64aff49a27962540aab2c6793050e39175ae2` through `jasminzhao-geo-article-720@71d1c08bc4b186e6ef9984d9b60d082065922020` only.
- Create independent `global/` (`zh-sg`) and `en/` (`en-us`) files; do not depend on fallback for the new pages.
- Do not modify domestic markdown under `frontend/src/content/docs/` outside `global/` and `en/`.
- Do not duplicate or rewrite the existing international `configuration/automation.md` files.
- Do not reuse `20260721-150502-8b3a.webp` in international docs because it contains Chinese UI, RMB prices, and domestic promotions.
- Preserve the 31 placeholder pages as placeholders; do not invent complete long-form articles.
- Localize the five complete pages to international login, activation, billing, and channel behavior.
- International channel order is Telegram, WhatsApp, Discord, WeChat, then QQ, WeCom, and Lark where a complete list is needed.
- Keep all pre-existing international-only pages and routes.
- Commit and push steps require explicit user confirmation under repository policy.

---

### Task 1: Add a failing international parity contract

**Files:**
- Create: `frontend/scripts/international-docs-parity.test.ts`
- Modify: `frontend/src/lib/__tests__/seo-data.page-description.test.ts`

**Interfaces:**
- Consumes: `DOCS_ROUTE_SLUGS` from `frontend/next-site/docs-route-manifest.ts` and source files under `frontend/src/content/docs/{global,en}`.
- Produces: a regression contract covering the exact 36 branch-new international slugs and four branch-new global SEO descriptions.

- [ ] **Step 1: Add the exact expected branch-parity file list**

Create `frontend/scripts/international-docs-parity.test.ts` with a constant containing exactly these files:

```ts
const BRANCH_PARITY_FILES = [
  "advanced/agent-workflow-design.md",
  "advanced/automation-fit.md",
  "advanced/models-skills-automation.md",
  "advanced/multi-channel-hermes.md",
  "advanced/reduce-model-cost.md",
  "compare/ai-agent-vs-chatbot.md",
  "compare/cloud-vs-local-agent.md",
  "compare/lightvela-vs-self-hosting-hermes.md",
  "compare/lightvela-vs-server-hosting.md",
  "compare/model-selection.md",
  "configuration/diagnostics.md",
  "configuration/files.md",
  "configuration/memory.md",
  "configuration/multiple-models.md",
  "create-first-hermes.md",
  "credits.md",
  "plans.md",
  "security/data-protection.md",
  "security/data-storage.md",
  "security/export-and-delete-data.md",
  "security/instance-isolation.md",
  "security/model-training-policy.md",
  "support/report-an-issue.md",
  "troubleshooting/agent-not-responding.md",
  "troubleshooting/automation-not-running.md",
  "troubleshooting/channel-connection-failed.md",
  "troubleshooting/model-errors.md",
  "troubleshooting/rebuild-hermes.md",
  "troubleshooting/skill-installation-failed.md",
  "use-cases/chinese-messaging-channels.md",
  "use-cases/daily-summary.md",
  "use-cases/hermes-agent-24-7.md",
  "use-cases/memory-and-knowledge.md",
  "use-cases/personal-ai-assistant.md",
  "use-cases/work-assistant.md",
  "who-is-lightvela-for.md",
] as const;
```

The test must:

1. Assert the list has length 36.
2. Assert every file exists under both `src/content/docs/global/` and `src/content/docs/en/`.
3. Convert each file to its route slug, including `configuration/index` normalization when applicable.
4. Assert every slug appears in both `DOCS_ROUTE_SLUGS["en-us"]` and `DOCS_ROUTE_SLUGS["zh-sg"]`.
5. Assert the two locales contain the same branch-parity slug set.
6. Assert `configuration/automation.md` is not part of the new parity list.
7. Assert neither `plans.md` nor `create-first-hermes.md` references `20260721-150502-8b3a.webp` in either locale.

- [ ] **Step 2: Extend the SEO description test first**

Add these paths to `globalDocPaths` in `frontend/src/lib/__tests__/seo-data.page-description.test.ts`:

```ts
"/docs/plans",
"/docs/credits",
"/docs/create-first-hermes",
"/docs/who-is-lightvela-for",
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
cd frontend
pnpm vitest run scripts/international-docs-parity.test.ts src/lib/__tests__/seo-data.page-description.test.ts
```

Expected: FAIL because the 36 international source pairs, routes, and four global SEO overrides do not exist yet.

---

### Task 2: Create the 31 localized placeholder page pairs

**Files:**
- Create: 31 files under `frontend/src/content/docs/global/`
- Create: the same 31 files under `frontend/src/content/docs/en/`

**Interfaces:**
- Consumes: the matching domestic placeholder headings and section order.
- Produces: independent `zh-sg` and `en-us` markdown sources for every branch-new placeholder route.

- [ ] **Step 1: Create configuration placeholder pairs**

Create `configuration/files.md`, `configuration/diagnostics.md`, and `configuration/multiple-models.md` in both locales. Use these localized titles:

| File | `global/` title | `en/` title |
|---|---|---|
| `configuration/files.md` | 云端文件管理 | Cloud File Management |
| `configuration/diagnostics.md` | 诊断中心 | Diagnostics |
| `configuration/multiple-models.md` | 多模型配置与切换 | Configure and Switch Between Multiple Models |

Chinese skeleton:

```md
# <中文标题>

> 内容待补充。

## 适合谁

## 前置条件

## 操作步骤 / 核心说明

## 常见问题

## 下一步
```

English skeleton:

```md
# <English title>

> Content coming soon.

## Who this is for

## Prerequisites

## Steps / key concepts

## FAQ

## Next steps
```

- [ ] **Step 2: Create use-case placeholder pairs**

Create all six files with these titles:

| File | `global/` title | `en/` title |
|---|---|---|
| `use-cases/personal-ai-assistant.md` | 如何用 LightVela 搭建个人 AI 助手？ | How to Build a Personal AI Assistant with LightVela |
| `use-cases/hermes-agent-24-7.md` | 如何让 Hermes Agent 7×24 小时在线？ | How to Keep a Hermes Agent Online 24/7 |
| `use-cases/chinese-messaging-channels.md` | 如何把 AI Agent 接入消息平台？ | How to Connect an AI Agent to Messaging Platforms |
| `use-cases/daily-summary.md` | 如何用 Hermes Agent 做每日信息总结？ | How to Create Daily Summaries with Hermes Agent |
| `use-cases/memory-and-knowledge.md` | 如何用 Agent 管理长期记忆和个人知识？ | How to Manage Long-Term Memory and Personal Knowledge with an Agent |
| `use-cases/work-assistant.md` | 如何搭建一个工作助手？ | How to Build a Work Assistant |

Use the same Chinese and English skeletons from Step 1.

- [ ] **Step 3: Create comparison placeholder pairs**

Create all five files with localized titles and preserve the domestic comparison skeleton sections (`适合谁`, `前置条件`, `核心对比`, `常见问题`, `下一步`):

| File | `global/` title | `en/` title |
|---|---|---|
| `compare/lightvela-vs-self-hosting-hermes.md` | LightVela 和自托管 Hermes Agent 有什么区别？ | LightVela vs. Self-Hosted Hermes Agent |
| `compare/cloud-vs-local-agent.md` | LightVela 和本地运行 Agent 有什么区别？ | Cloud-Hosted vs. Local AI Agents |
| `compare/ai-agent-vs-chatbot.md` | LightVela 和普通聊天机器人有什么区别？ | AI Agents vs. Traditional Chatbots |
| `compare/lightvela-vs-server-hosting.md` | 使用 LightVela 还是自己买服务器部署？ | LightVela vs. Hosting an Agent on Your Own Server |
| `compare/model-selection.md` | 如何为 Hermes Agent 选择合适的模型？ | How to Choose a Model for Hermes Agent |

English section labels are `Who this is for`, `Prerequisites`, `Key comparison`, `FAQ`, and `Next steps`.

- [ ] **Step 4: Create troubleshooting placeholder pairs**

Create all six files with localized titles:

| File | `global/` title | `en/` title |
|---|---|---|
| `troubleshooting/agent-not-responding.md` | Agent 无响应怎么办？ | Agent Not Responding |
| `troubleshooting/model-errors.md` | 模型调用失败怎么办？ | Model Request Failures |
| `troubleshooting/channel-connection-failed.md` | 消息通道连接失败怎么办？ | Messaging Channel Connection Failures |
| `troubleshooting/automation-not-running.md` | 自动任务没有执行怎么办？ | Automation Not Running |
| `troubleshooting/skill-installation-failed.md` | 技能安装失败怎么办？ | Skill Installation Failed |
| `troubleshooting/rebuild-hermes.md` | 如何重建 Hermes？ | How to Rebuild Hermes |

Preserve the domestic troubleshooting sections. English labels are `Symptoms`, `Possible causes`, `Troubleshooting steps`, `If the issue continues`, and `Next steps`.

- [ ] **Step 5: Create security, advanced, and support placeholder pairs**

Create the five `security/` files, five `advanced/` files, and `support/report-an-issue.md`. Localize titles as follows:

| File | `global/` title | `en/` title |
|---|---|---|
| `security/data-protection.md` | LightVela 如何保护我的数据？ | How LightVela Protects Your Data |
| `security/data-storage.md` | Agent 的对话、记忆和文件存储在哪里？ | Where Agent Conversations, Memory, and Files Are Stored |
| `security/instance-isolation.md` | 每个 Hermes 实例是否独立隔离？ | Is Every Hermes Instance Isolated? |
| `security/model-training-policy.md` | 是否会使用用户数据训练模型？ | Is User Data Used to Train Models? |
| `security/export-and-delete-data.md` | 数据能否导出或删除？ | Can I Export or Delete My Data? |
| `advanced/models-skills-automation.md` | 如何组合模型、技能和自动任务？ | How to Combine Models, Skills, and Automations |
| `advanced/agent-workflow-design.md` | 如何设计一个稳定的个人 Agent 工作流？ | How to Design a Reliable Personal Agent Workflow |
| `advanced/reduce-model-cost.md` | 如何降低 Agent 的模型调用成本？ | How to Reduce Agent Model Costs |
| `advanced/automation-fit.md` | 如何判断一个任务适不适合交给 Agent 自动执行？ | How to Decide Whether a Task Should Be Automated |
| `advanced/multi-channel-hermes.md` | 多通道接入时如何管理同一个 Hermes？ | How to Manage One Hermes Agent Across Multiple Channels |
| `support/report-an-issue.md` | 反馈问题时需要提供哪些信息？ | What to Include When Reporting an Issue |

Use the standard localized placeholder skeleton from Step 1.

- [ ] **Step 6: Run source-pair checks**

Run the parity test again. Expected: file-existence assertions pass; route and SEO assertions still fail until Tasks 4 and 5.

---

### Task 3: Localize the five complete page pairs

**Files:**
- Create: `frontend/src/content/docs/global/who-is-lightvela-for.md`
- Create: `frontend/src/content/docs/en/who-is-lightvela-for.md`
- Create: `frontend/src/content/docs/global/plans.md`
- Create: `frontend/src/content/docs/en/plans.md`
- Create: `frontend/src/content/docs/global/credits.md`
- Create: `frontend/src/content/docs/en/credits.md`
- Create: `frontend/src/content/docs/global/create-first-hermes.md`
- Create: `frontend/src/content/docs/en/create-first-hermes.md`
- Create: `frontend/src/content/docs/global/configuration/memory.md`
- Create: `frontend/src/content/docs/en/configuration/memory.md`

**Interfaces:**
- Consumes: the five complete domestic source pages and current international product facts in sign-in, subscribe, channel, and region code.
- Produces: complete independent localized pages with matching section order and international-safe links.

- [ ] **Step 1: Localize `who-is-lightvela-for.md`**

Keep sections `Who it is for`, `Typical use cases`, `Prerequisites`, `If you are unsure`, and `Next steps`. Replace domestic assumptions with:

- International messaging examples: Telegram, WhatsApp, Discord, and WeChat.
- International model examples: ChatGPT, Claude, Gemini, DeepSeek, Qwen, Zhipu, Hunyuan, and OpenAI-compatible endpoints.
- No China real-name verification prerequisite.
- Account access through Google or GitHub.
- Links only to pages included in this parity set or existing international routes.

- [ ] **Step 2: Localize `plans.md`**

Keep the domestic page structure and Launch / Cruise / Voyage resource comparison, but:

- Describe current international access as a limited-free beta flow.
- Avoid RMB amounts, China-only first-order discounts, China real-name verification, and domestic payment instructions.
- Direct readers to `/subscribe` for current availability and pricing.
- Omit the domestic subscription screenshot.
- Preserve links to `credits.md`, `create-first-hermes.md`, model configuration, automations, and quickstart.

- [ ] **Step 3: Localize `credits.md`**

Keep the credit definition, token relationship, monthly allocation structure, usage scenarios, FAQ, and next steps. Use international channel examples in the required order and avoid domestic billing claims that are not present in the global flow.

- [ ] **Step 4: Localize `create-first-hermes.md`**

Keep the five-step activation structure, but change it to:

1. Sign in with Google or GitHub.
2. Select an available plan from `/subscribe`; no China real-name verification step.
3. Activate the plan under the current international limited-free flow.
4. Let LightVela provision the Hermes instance automatically.
5. Configure a model and connect Telegram, WhatsApp, Discord, WeChat, or another supported channel.

Do not reference the domestic subscription screenshot.

- [ ] **Step 5: Localize `configuration/memory.md`**

Preserve the complete memory article structure and capacity values from the branch source. Replace domestic channel examples with Telegram, WhatsApp, Discord, and WeChat in that order. Translate all English sections naturally. Keep the branch's recommendation markers as editorial text because no images were committed with the source article.

- [ ] **Step 6: Check links and prohibited domestic assumptions**

Verify the ten complete files contain no references to:

- `20260721-150502-8b3a.webp`
- QQ/WeChat-only login
- mandatory China real-name verification
- RMB prices or China-only discount claims
- domestic-only channel sequences such as `微信 / QQ / 飞书`

---

### Task 4: Register international navigation and generated routes

**Files:**
- Modify: `frontend/scripts/sync-fumadocs-content.mjs`
- Modify: `frontend/src/config/docs-sidebar.ts`
- Regenerate: `frontend/next-site/docs-route-manifest.ts`

**Interfaces:**
- Consumes: the 36 new source pairs from Tasks 2 and 3.
- Produces: matching `en-us` and `zh-sg` page trees, sidebar labels, search mappings, and static route slugs.

- [ ] **Step 1: Expand `globalDocs` using international groups**

Add the 36 entries to `globalDocs` with localized title/group/description objects. Use these group pairs:

```ts
{ "en-US": "Getting Started", "zh-CN": "开始使用" }
{ "en-US": "Plans & Activation", "zh-CN": "套餐与开通" }
{ "en-US": "Features & Configuration", "zh-CN": "功能与配置" }
{ "en-US": "Use Cases", "zh-CN": "场景方案" }
{ "en-US": "Compare & Choose", "zh-CN": "对比与选型" }
{ "en-US": "Troubleshooting", "zh-CN": "问题排查" }
{ "en-US": "Security, Privacy & Data", "zh-CN": "安全、隐私与数据" }
{ "en-US": "Advanced", "zh-CN": "进阶用法" }
{ "en-US": "Support", "zh-CN": "联系与支持" }
```

Move existing global entries into the closest group without removing any. Keep channel entries ordered Telegram, WhatsApp, Discord, WeChat, QQ, WeCom, Lark.

Use non-empty descriptions only for the five complete pages; keep placeholder descriptions empty.

- [ ] **Step 2: Generate grouped international Fumadocs metadata**

Add `GLOBAL_GROUP_ORDER` with the nine English group keys above. Replace the hardcoded international root/configuration/faq meta writer with a data-driven grouped writer equivalent to the existing CN grouped writer. The output must preserve every existing international page and add the 36 new pages.

- [ ] **Step 3: Expand `GLOBAL_SIDEBAR` and `GLOBAL_SLUG_TO_FILE`**

Mirror the nine international groups in `frontend/src/config/docs-sidebar.ts`, add `titleEn` for every new item, preserve all existing international-only items, and add all 36 slug-to-file mappings. Keep channel child items ordered Telegram, WhatsApp, Discord, WeChat, QQ, WeCom, Lark.

- [ ] **Step 4: Run docs sync and regenerate routes**

Run:

```bash
cd frontend
pnpm docs:sync
```

Expected: sync succeeds and updates `next-site/docs-route-manifest.ts` so `en-us` and `zh-sg` include the same 36 new slugs.

- [ ] **Step 5: Run the parity contract**

Run:

```bash
cd frontend
pnpm vitest run scripts/international-docs-parity.test.ts
```

Expected: PASS for file and route parity; SEO assertions are covered in Task 5.

---

### Task 5: Add only the branch-new global SEO descriptions

**Files:**
- Modify: `frontend/src/lib/seo-data.ts`
- Test: `frontend/src/lib/__tests__/seo-data.page-description.test.ts`

**Interfaces:**
- Consumes: the four domestic page-description additions from the source branch.
- Produces: international page-level SEO descriptions for the same four routes.

- [ ] **Step 1: Add four global descriptions**

Add international English descriptions for:

```ts
"/docs/plans"
"/docs/credits"
"/docs/create-first-hermes"
"/docs/who-is-lightvela-for"
```

Descriptions must reflect international limited-free activation, Google/GitHub access, international channel support, and no China real-name verification requirement. Do not add SEO entries for the 31 placeholders.

- [ ] **Step 2: Run the focused SEO test**

Run:

```bash
cd frontend
pnpm vitest run src/lib/__tests__/seo-data.page-description.test.ts
```

Expected: PASS, including the four new global paths.

---

### Task 6: Verify branch scope and international builds

**Files:**
- Verify all files changed by Tasks 1–5.

**Interfaces:**
- Consumes: complete implementation diff.
- Produces: evidence that only approved international parity changes were made and both international languages build.

- [ ] **Step 1: Run all focused tests**

```bash
cd frontend
pnpm vitest run scripts/international-docs-parity.test.ts src/lib/__tests__/seo-data.page-description.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run docs sync and typecheck**

```bash
cd frontend
pnpm docs:sync
pnpm check
```

Expected: both commands exit 0.

- [ ] **Step 3: Build the international site**

```bash
cd frontend
pnpm build:global
```

Expected: build exits 0 and generates routes for both `en-us` and `zh-sg` docs.

- [ ] **Step 4: Audit the final diff**

Confirm:

- All new markdown paths are under `frontend/src/content/docs/global/` or `frontend/src/content/docs/en/`.
- No domestic source markdown changed.
- `configuration/automation.md` is unchanged in both international source trees.
- The Chinese pricing screenshot is not referenced by international docs.
- `git diff --check` reports no whitespace errors.
- The diff contains no unrelated domestic/international parity work predating the source branch.

- [ ] **Step 5: Prepare commit details for confirmation**

Prepare, but do not execute without user confirmation:

```text
同步国际站 GEO 文档结构 / docs: replicate branch-new international docs
```

The commit scope must include only the approved design/plan and international docs parity implementation.
