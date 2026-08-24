# 自定义人设来源标记 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `test-driven-development` and execute this single S-level task inline.

**Goal:** 使用独立顶层来源字段识别上传人设，保留用户原始 Slug，并修复缺少 `## Content` 时的双层 Soul 包装。

**Architecture:** 标准化纯函数负责写入 `LightVela-Source` 并保留人设 Slug；轻量身份命令和解析器回传该字段；面板优先用来源字段识别新格式，并保留旧 Slug 哨兵兼容。下载仍读取实际文件全文，不增加转换层。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Hermes `debug/exec` Shell 命令。

## Global Constraints

- 只修改自定义人设标准化、身份读取、状态识别及对应长期规格和测试。
- 不新增依赖，不修改 UI、文案、全文读取或下载实现。
- 新格式保留用户 Slug；旧 `Slug: custom-upload` 必须继续兼容。
- 所有生产代码修改必须先有能够复现问题的失败测试。

---

### Task 1: 独立来源标记与兼容读取

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload.ts`
- Modify: `frontend/src/pages/marketing/agent-buddy-command.ts`
- Modify: `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload.test.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-buddy-command.test.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- Modify: `frontend/openspec/specs/buddy.md`

**Interfaces:**
- Produces: `CUSTOM_PERSONA_SOURCE_FIELD = "LightVela-Source"`
- Produces: `CUSTOM_PERSONA_SOURCE = "custom-upload"`
- Extends: `HermesSoulIdentity` with `source: string | null`
- Consumes: existing `buildCustomSoulMarkdown()`、`buildHermesSoulReadCommand()`、`parseHermesSoulIdentity()` and `BuddyPanel` identity refresh.

- [x] **Step 1: Write failing normalization tests**

Add a regression case using the reported file shape and assert that `Slug: focused-project-guide` is preserved, `LightVela-Source: custom-upload` is inserted, only one `# Soul` remains, and no `## Content\n# Soul` wrapper is produced. Update existing arbitrary-Markdown and standard-Soul expectations so they require the source field and no generated custom Slug.

- [x] **Step 2: Write failing identity and panel compatibility tests**

Require the lightweight read command and `parseHermesSoulIdentity()` to expose `source: "custom-upload"`. Add one panel test for source-based recognition and retain one legacy `Slug: custom-upload` case.

- [x] **Step 3: Run focused tests and verify RED**

Run:

```bash
cd frontend
corepack pnpm@10.20.0 vitest run \
  src/pages/marketing/__tests__/agent-persona-upload.test.ts \
  src/pages/marketing/__tests__/agent-buddy-command.test.ts \
  src/pages/marketing/__tests__/agent-buddy-panel.test.tsx
```

Expected: assertions fail because source metadata is not emitted/read and the reported file is double wrapped.

- [x] **Step 4: Implement the minimal contract**

- Treat a top-level `# Soul` as structured input even without `## Content`.
- Preserve an existing Slug; do not create `Slug: custom-upload` for new uploads.
- Insert or replace one top-level `LightVela-Source: custom-upload` before the first level-two section.
- Extend the lightweight read protocol and parser with `LightVela-Source`.
- Recognize custom persona when `identity.source === "custom-upload"`, with `identity.slug === "custom-upload"` as legacy fallback.

- [x] **Step 5: Run focused tests and verify GREEN**

Run the Step 3 command again. Expected: all focused tests pass with zero failures.

- [x] **Step 6: Update long-term spec and run quality gates**

Update `frontend/openspec/specs/buddy.md` to document source metadata, preserved Slug, legacy compatibility and unchanged download behavior.

Run:

```bash
cd frontend
corepack pnpm@10.20.0 check
corepack pnpm@10.20.0 i18n:check
git diff --check
```

Expected: all commands exit 0.

- [x] **Step 7: Hand off without committing**

Show the exact diff and validation results. Do not commit, push or create an MR until the user explicitly authorizes it.
