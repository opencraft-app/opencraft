# Advanced Settings 审批模式文档补充 Implementation Plan

**Goal:** 让国内站和国际站的高级设置文档准确说明安全分组、审批模式、恢复默认和保存行为。

**Scope:** 更新国内中文、国际中文、英文、印尼语源文档与既有文档元描述，并同步生成 Fumadocs 产物。

- [x] 文档内容：补充审批模式和安全分组，并修正保存与恢复默认说明。
- [x] 文档同步与验证：更新最后更新时间、生成各语言 Fumadocs 产物，并验证图片和文档链接。

---

# MR !3248 CR 国际化补强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 MR !3248 评审确认的繁中 / 印尼语结构误报、中文默认名泄漏和一处国际站测试空过，并如实记录国际站整文件既有失败。

**Architecture:** 保持单一、区域无关的 Persona 解析链路；为结构识别补充明确的繁中 / 印尼语关键词，并把调用方本地化兜底名作为参数传入现有纯函数。测试先证明现状失败，再做最小实现；推荐人设 slug、读取失败重试和仓库级类型脚本不在本计划内。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、现有 `useT` i18n。

## Global Constraints

- 不改变 `SOUL.md` 的来源标记、Slug、正文、备份或原子写入协议。
- 结构建议仍是软提示，不阻止上传或注入。
- 不增加语言检测、区域分支、翻译服务、配置词库或依赖。
- 不修改推荐人设 / 抽卡逻辑、`equippedStatus` 重试策略或 `pnpm check` 脚本。
- 国内站默认名继续使用 `t("自定义人设")`，国际站按当前语言使用同一词条。
- 未经用户再次确认，不执行 `git commit` 或 `git push`；MR !3248 更新前必须展示差异和验证结果。

---

### Task 1: 多语言结构识别与本地化默认名

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-persona-upload.test.ts`
- Modify: `frontend/src/pages/marketing/agent-persona-upload.ts`

**Interfaces:**
- Consumes: `getPersonaStructureWarnings(markdown)`、`getPersonaDisplayName(markdown, fileName, fallbackDisplayName?)`。
- Produces: `buildCustomSoulMarkdown(markdown, fileName, fallbackDisplayName?)` 与 `validateCustomSoulMarkdown(markdown, fileName, fallbackDisplayName?)` 向下传递相同兜底名。

- [x] **Step 1: 添加繁中 / 印尼语结构识别失败测试**

在 `agent-persona-upload.test.ts` 添加两个完整 Markdown 用例：

```ts
it.each([
  ["繁體中文", ["## 角色定位", "## 溝通風格", "## 工作原則", "## 行為邊界"]],
  ["印尼语", ["## Identitas", "## Gaya Komunikasi", "## Prinsip Kerja", "## Batasan Perilaku"]],
])("recognizes complete %s persona structure", (_language, headings) => {
  expect(getPersonaStructureWarnings([
    "# Soul",
    "Name: Project Partner",
    headings[0]!,
    "Identity content.",
    headings[1]!,
    "Tone content.",
    headings[2]!,
    "Principles content.",
    headings[3]!,
    "Boundary content that is intentionally long enough to avoid the short-content warning.",
  ].join("\n"))).toEqual([]);
});
```

- [x] **Step 2: 添加可传入默认展示名的失败测试**

```ts
it("uses the caller-provided localized display-name fallback", () => {
  expect(getPersonaDisplayName("Keep answers short.", ".md", "Persona kustom"))
    .toBe("Persona kustom");

  const result = buildCustomSoulMarkdown(
    "Keep answers short.",
    ".md",
    "Custom persona",
  );
  expect(result.displayName).toBe("Custom persona");
  expect(result.markdown).toContain("Name: Custom persona");
});
```

- [x] **Step 3: 运行纯函数测试并确认 RED**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-persona-upload.test.ts \
  -t 'recognizes complete|caller-provided localized'
```

Expected: 繁中 / 印尼语用例因 `missing_*` 提示失败，默认名用例因函数尚不接受第三个参数而失败；不得出现测试环境或语法错误。

- [x] **Step 4: 最小扩充结构关键词**

只在 `getPersonaStructureWarnings` 的四组现有正则中增加已确认词：

```ts
// identity: Identitas | Posisi Peran
// tone: 溝通風格 | 語氣 | 表達 | Gaya Komunikasi | Nada
// principles: 工作原則 | 原則 | 優先級 | Prinsip Kerja | Prioritas
// boundaries: 行為邊界 | 邊界 | Batasan Perilaku | Batasan；正文兼容 Jangan
```

不得重写为语言分支或新增配置表。

- [x] **Step 5: 最小传递本地化兜底名**

签名统一为：

```ts
export function getPersonaDisplayName(
  markdown: string,
  fileName: string,
  fallbackDisplayName = "Custom persona",
): string;

export function buildCustomSoulMarkdown(
  markdown: string,
  fileName: string,
  fallbackDisplayName = "Custom persona",
): { markdown: string; displayName: string };

export function validateCustomSoulMarkdown(
  markdown: string,
  fileName: string,
  fallbackDisplayName = "Custom persona",
): CustomSoulMarkdownValidation;
```

名称优先级保持 `Name:` → 文件名 → `fallbackDisplayName`，并继续执行控制字符清理和 80 字节截断。

- [x] **Step 6: 运行纯函数测试并确认 GREEN**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-persona-upload.test.ts
```

Expected: 该测试文件全部 PASS，现有简中 / 英文识别和 `SOUL.md` 标准化行为不回归。

---

### Task 2: 弹窗调用方与国际站真实测试覆盖

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Modify: `frontend/src/pages/marketing/agent-custom-persona-file-modal.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `validateCustomSoulMarkdown(markdown, fileName, fallbackDisplayName?)`。
- Produces: 两个弹窗始终传入 `t("自定义人设")`；`shows inject only after selecting a persona` 在 global 环境真实执行。

- [x] **Step 1: 添加上传弹窗本地化兜底失败测试**

把测试中的 `useT` mock 对“自定义人设”返回 `Persona kustom`，从而与纯函数的语言中立默认值区分：

```tsx
vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) => (
    text === "自定义人设"
      ? "Persona kustom"
      : text.replace(
          /\{\{\s*([\w$]+)\s*\}\}/g,
          (raw, key: string) => options?.[key] === undefined ? raw : String(options[key]),
        )
  ),
}));
```

再添加完整上传用例：

```tsx
it("uses the localized display-name fallback", async () => {
  const onInject = vi.fn().mockResolvedValue(undefined);
  render(
    <PersonaUploadModal
      disabled={false}
      hasExistingSoul={false}
      onInject={onInject}
    />,
  );

  selectFile(new File(["Keep answers short."], ".md"));
  fireEvent.click(await screen.findByRole("button", { name: "注入人设" }));

  await waitFor(() => expect(onInject).toHaveBeenCalledWith({
    displayName: "Persona kustom",
    markdown: expect.stringContaining("Name: Persona kustom"),
  }));
});
```

- [x] **Step 2: 运行弹窗测试并确认 RED**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx \
  -t 'localized display-name fallback'
```

Expected: FAIL，收到的 `displayName` / `Name:` 仍为现有中文兜底。

- [x] **Step 3: 两个弹窗显式传入翻译兜底**

`agent-persona-upload-modal.tsx` 的预览校验与注入时校验都改为：

```ts
validateCustomSoulMarkdown(markdown, fileName, t("自定义人设"));
```

`agent-custom-persona-file-modal.tsx` 改为：

```ts
validateCustomSoulMarkdown(markdown, "SOUL.md", t("自定义人设"));
```

同步补齐 `useMemo` 依赖，不改变弹窗状态机。

- [x] **Step 4: 删除纯遗留国际站测试守卫**

仅删除以下用例开头的早退：

```ts
it("shows inject only after selecting a persona", async () => {
  // 删除：if (isGlobal) return;
```

保留另外两处依赖推荐人设 global-ready 的早退。

- [x] **Step 5: 运行弹窗和区域测试并确认 GREEN**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx \
  src/pages/marketing/__tests__/agent-custom-persona-file-modal.test.tsx

NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
  -t 'shows inject only after selecting a persona|renders the upload entry in both regions|uploads a custom persona'
```

Expected: 两条命令全部 PASS；global 下 `shows inject...` 不再空过。

---

### Task 3: 文档、全量门禁与 MR 更新检查点

**Files:**
- Modify: `frontend/openspec/changes/2026-08-24-global-custom-persona-upload-design.md`
- Modify: `frontend/openspec/plan.md`

**Interfaces:**
- Consumes: Tasks 1–2 的实现和验证证据。
- Produces: 如实的验证边界与可提交差异。

- [x] **Step 1: 更新设计状态与验证边界**

把状态改为“CR 增量已实施并通过定向双区域验证，待提交”，并明确：自定义人设定向链路通过；`agent-buddy-panel.test.tsx` 的 8 个推荐人设 global 失败来自 `master` 既有基线，本 MR 未触碰。

- [x] **Step 2: 运行双区域 Persona 回归**

Run:

```bash
cd frontend
NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-persona-upload.test.ts \
  src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx \
  src/pages/marketing/__tests__/agent-custom-persona-file-modal.test.tsx \
  src/pages/marketing/__tests__/agent-buddy-command.test.ts

NEXT_PUBLIC_REGION=cn VITE_REGION=cn pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
  src/pages/marketing/__tests__/agent-persona-upload.test.ts \
  src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx \
  src/pages/marketing/__tests__/agent-custom-persona-file-modal.test.tsx \
  src/pages/marketing/__tests__/agent-buddy-command.test.ts
```

Expected: 两组命令全部 PASS；jsdom 下载导航提示不计为失败。

- [x] **Step 3: 运行静态与区域构建门禁**

Run:

```bash
cd frontend
pnpm i18n:check
pnpm check
pnpm build:cn
pnpm build:global
cd ..
git diff --check
git status --short
```

Expected: 全部 exit 0；构建生成的字体子集恢复到 `HEAD`，最终只保留规格、计划、纯函数、两个弹窗和对应测试的预期变更。

- [x] **Step 4: 展示提交检查点并等待确认**

建议追加 commit message：

```text
补齐国际站人设语言边界 / fix(persona): localize global persona validation
```

展示 `git status --short`、`git diff --stat`、完整业务 diff 和验证结果；未经确认不得 commit / push。推送后通过工蜂 API 回查 MR !3248 的 source commit、文件列表和 commit check。

---

# 国际站开放自定义人设文件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 LightVela 国际站完整开放现有自定义人设 Markdown 的上传、编辑和下载能力，同时保持国内站行为不变。

**Architecture:** 继续复用 `BuddyPanel`、Persona 上传/编辑弹窗、Markdown 校验和 Hermes `SOUL.md` 安全读写链路。只移除 `agent-buddy-panel.tsx` 中三个国际站展示门禁，并把自定义人设生命周期测试改为在 `cn` 与 `global` 环境下共同执行；不新增接口、组件副本或 capability flag。国际站整文件测试在 `origin/master` 上已有与预设人设英文 slug mock 相关的基线失败，因此本需求使用自定义人设定向用例作为国际站门禁，预设人设用例保持原区域策略。

**Tech Stack:** React 19、TypeScript 5.9、Next.js 16、Vitest 4、Testing Library、现有 Hermes `debug/exec` Repository。

## Global Constraints

- 国内站行为保持不变；国际站新增完整的自定义人设上传、编辑和下载能力。
- 不改变 `SOUL.md` 格式、`LightVela-Source: custom-upload` 来源标记、备份目录或安全写入协议。
- 不新增 API、运行时命令、组件副本、依赖或区域 capability flag。
- 不调整预设人设、抽卡、答题测试或 `/new` 生效提示。
- 不新增或修改用户可见文案；复用现有中英文字典。
- 必须先在国际站环境观察到测试因现有 `!isGlobal` 门禁失败，再修改生产代码。
- 未经用户明确确认，不执行 `git commit`、`git push` 或创建 MR。

---

### Task 1: 国际站开放自定义人设完整生命周期

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- Modify: `frontend/openspec/plan.md`
- Reference: `frontend/openspec/changes/2026-08-24-global-custom-persona-upload-design.md`

**Interfaces:**
- Consumes: `PersonaUploadModal`, `CustomPersonaFileModal`, `handleCustomPersonaInject`, `handleEditCustomPersona`, `handleDownloadCustomPersona`, `handleCustomPersonaSave` 的现有签名和行为。
- Produces: `BuddyPanel` 在 `isGlobal === true` 与 `isGlobal === false` 时统一暴露上传入口、编辑/下载操作和编辑弹窗；不产生新导出接口。

- [x] **Step 1: 把区域可见性测试改成双区域共同要求**

在 `agent-buddy-panel.test.tsx` 中保留 `isGlobal` 导入（仍用于预设人设相关测试），并把“仅国内站显示上传入口”的条件断言改为两个区域都必须显示：

```tsx
it("renders the upload entry in both regions", async () => {
  mockedLoadBuddyState.mockResolvedValue({
    drawnSouls: [fixtures.agentA],
    appliedSlug: null,
  });
  repositoryMocks.execDebugCommand.mockResolvedValue(successResult("Exists: no"));

  render(<BuddyPanel botId="agent-a" />);
  await screen.findByText("Agent A Soul");

  expect(await screen.findByRole("button", { name: "上传人设文件" })).toBeEnabled();
});
```

把自定义人设状态测试中的区域分支改为统一断言：

```tsx
const editButton = screen.getByRole("button", { name: "编辑自定义人设" });
expect(editButton).toBeInTheDocument();
expect(screen.getByRole("button", { name: "下载自定义人设" })).toBeInTheDocument();
expect(editButton.parentElement?.parentElement).toHaveClass("gap-0");
```

删除以下自定义人设测试开头的 `if (isGlobal) return;`，让它们在国际站环境真实执行：

- `reads the current Soul, edits it, and saves through the safe write command`
- `downloads the exact current Soul directly without opening the editor`
- `reports an actionable error for an unreadable current Soul: %s`
- `reports a network error while reading the current Soul`
- `disables both file actions and ignores an old content read after switching Agents`
- `cancels a pending current-persona download when the panel unmounts`
- `clears a pending file action when a new persona write supersedes its read`
- `keeps Agent B editor open when Agent A save finishes stale`
- `uploads a custom persona through the existing Hermes command`

以下用例依赖预设人设选择和国际站英文 slug 映射，保持现有 `if (isGlobal) return;`，不纳入本需求：

- `shows inject only after selecting a persona`
- `discards an old custom-persona read when a recommended persona is injected`
- `keeps the real custom status when a recommended persona write falls back`

- [x] **Step 2: 运行国际站测试并确认 RED**

Run:

```bash
cd frontend
NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
  -t 'renders the upload entry in both regions|restores a custom uploaded persona|reads the current Soul|downloads the exact current Soul|reports an actionable error|reports a network error|disables both file actions|cancels a pending current-persona download|clears a pending file action|keeps Agent B editor open|uploads a custom persona'
```

Expected:

- FAIL。
- 首个业务失败明确指出找不到“上传人设文件”按钮，或找不到“编辑自定义人设”/“下载自定义人设”按钮。
- 失败原因来自 `agent-buddy-panel.tsx` 的现有 `!isGlobal` 展示门禁，不是语法错误、测试环境错误或 mock 缺失。

- [x] **Step 3: 最小移除编辑与下载操作的国际站门禁**

在 `customPersonaName` 状态区域保留现有按钮、loading、disabled 和 tooltip 内容，只移除外层 `!isGlobal` 条件：

```tsx
<div className="inline-flex items-center gap-0">
  <div className="group relative inline-flex">
    <button
      type="button"
      aria-label={t("编辑自定义人设")}
      disabled={customPersonaFileAction !== "idle"}
      onClick={() => void handleEditCustomPersona()}
      className="inline-flex size-7 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-black/[0.05] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {customPersonaFileAction === "editing" ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Pencil className="size-3.5" aria-hidden="true" />
      )}
    </button>
    <div className={ACTION_TOOLTIP_CLASS} role="tooltip">
      {t("编辑自定义人设")}
      <span className={ACTION_TOOLTIP_ARROW_CLASS} aria-hidden />
    </div>
  </div>
  <div className="group relative inline-flex">
    <button
      type="button"
      aria-label={t("下载自定义人设")}
      disabled={customPersonaFileAction !== "idle"}
      onClick={() => void handleDownloadCustomPersona()}
      className="inline-flex size-7 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-black/[0.05] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {customPersonaFileAction === "downloading" ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-3.5" aria-hidden="true" />
      )}
    </button>
    <div className={ACTION_TOOLTIP_CLASS} role="tooltip">
      {t("下载自定义人设")}
      <span className={ACTION_TOOLTIP_ARROW_CLASS} aria-hidden />
    </div>
  </div>
</div>
```

不得修改 `handleEditCustomPersona`、`handleDownloadCustomPersona`、读文件命令或下载文件名。

- [x] **Step 4: 最小移除上传与编辑弹窗的国际站门禁**

把操作区的上传弹窗直接渲染，保留原 disabled 条件：

```tsx
<PersonaUploadModal
  key={botId ?? "no-agent"}
  disabled={
    !botId
    || loadStatus !== "loaded"
    || equippedStatus !== "ready"
  }
  hasExistingSoul={hasExistingSoul}
  onInject={handleCustomPersonaInject}
/>
```

把页面尾部的编辑弹窗直接渲染：

```tsx
<CustomPersonaFileModal
  open={customPersonaEditorMarkdown !== null}
  initialMarkdown={customPersonaEditorMarkdown ?? ""}
  onClose={() => setCustomPersonaEditorMarkdown(null)}
  onSave={handleCustomPersonaSave}
/>
```

不得修改两个弹窗组件、Markdown 校验函数、Hermes 写入命令或状态回读逻辑。

- [x] **Step 5: 运行国际站 Persona 回归并确认 GREEN**

Run:

```bash
cd frontend
NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
  -t 'renders the upload entry in both regions|restores a custom uploaded persona|reads the current Soul|downloads the exact current Soul|reports an actionable error|reports a network error|disables both file actions|cancels a pending current-persona download|clears a pending file action|keeps Agent B editor open|uploads a custom persona'

NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-persona-upload.test.ts \
  src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx \
  src/pages/marketing/__tests__/agent-custom-persona-file-modal.test.tsx \
  src/pages/marketing/__tests__/agent-buddy-command.test.ts
```

Expected: 两条命令全部 PASS，0 个失败；`agent-buddy-panel.test.tsx` 不再因为 `isGlobal` 跳过自定义人设生命周期。整文件国际站基线中的预设人设 slug mock 失败不属于本需求，不作为此处门禁。

- [x] **Step 6: 运行国内站 Persona 回归并确认无回归**

Run:

```bash
cd frontend
NEXT_PUBLIC_REGION=cn VITE_REGION=cn pnpm exec vitest run --config vitest.config.ts \
  src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
  src/pages/marketing/__tests__/agent-persona-upload.test.ts \
  src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx \
  src/pages/marketing/__tests__/agent-custom-persona-file-modal.test.tsx \
  src/pages/marketing/__tests__/agent-buddy-command.test.ts
```

Expected: 5 个测试文件全部 PASS，0 个失败；国内站上传、编辑、下载和安全写入行为保持不变。

- [x] **Step 7: 运行静态、i18n 和差异门禁**

Run:

```bash
cd frontend
pnpm i18n:check
pnpm check
cd ..
git diff --check
git status --short
```

Expected:

- `pnpm i18n:check` exit 0，英文缺失 0 条。
- `pnpm check` exit 0，TypeScript 无错误，繁体字典一致。
- `git diff --check` 无输出。
- 变更范围仅包含设计文档、`frontend/openspec/plan.md`、`agent-buddy-panel.tsx` 和对应测试；构建产生的文件不得混入差异。

- [x] **Step 8: 运行国内与国际区域构建**

Run:

```bash
cd frontend
pnpm build:cn
pnpm build:global
```

Expected: 两个命令均 exit 0，Next 静态导出、SEO 和静态资产检查全部完成。

构建后运行：

```bash
cd ..
git status --short
git diff --check
```

Expected: 没有新增需要提交的构建产物；若 `frontend/next-env.d.ts` 或字体子集等生成文件发生变化，恢复到 `HEAD` 后重新检查差异。

- [x] **Step 9: 准备提交检查点并等待用户确认**

展示以下内容，未经确认不得执行命令：

```bash
git status --short
git diff --stat
git diff -- frontend/src/pages/marketing/agent-buddy-panel.tsx \
  frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
  frontend/openspec/plan.md \
  frontend/openspec/changes/2026-08-24-global-custom-persona-upload-design.md
```

建议 commit message：

```text
国际站开放自定义人设文件 / feat(persona): enable custom persona files globally
```

只有用户明确确认后，才能执行 `git add` 和 `git commit`；push 与 MR 仍需单独展示并确认。

---

# 人设页标题与说明文案调整 Implementation Plan

**Status:** 按用户视觉反馈增量调整完成，已验证。

**Size:** S。单一页面内的标题与文案层级调整，不改变人设数据、抽卡、注入、自定义上传或公共接口。

**Goal:** 在人设内容卡片上方展示“人设”页面标题和“为你的 Agent 解锁独特灵魂，让它从此与众不同”说明文案。

**Architecture:** 仅调整 `BuddyPanel` 的展示层级：新增页面级标题区，移除卡片内部原有的渐变 slogan；继续复用现有人设卡片及其状态逻辑，不抽取新的共享组件。

**Scope:**
- 标题固定为「人设」，18px、600 字重、24px 行高，标题与说明间距 4px。
- 说明固定为「为你的 Agent 解锁独特灵魂，让它从此与众不同」，14px、500 字重、24px 行高，内容卡片上间距 12px。
- “灵感来自 SkillHub”入口与说明文案放在同一行并靠右，不再占用卡片内部顶部位置。
- 卡片内部原 slogan 位置新增三级标题「人设卡片」，使用 16px 字号并复用历史 slogan 的字重、字距和渐变文字色，不恢复图标或动画。
- Agent 设置页主内容增加 24px 底部留白，避免高内容面板的下边框与产品 footer 顶部分隔线贴合。
- 标题与说明使用普通文本色，不保留旧的 Sparkles 图标、动画或渐变文字。
- 人设卡片、SkillHub 来源入口、抽卡、测试、上传、注入和删除行为保持不变。

### Task 1: 调整人设页顶部层级

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/openspec/plan.md`

**Acceptance:**
- 页面存在一个二级标题「人设」，说明文案紧随其后且只出现一次。
- 说明文案与“灵感来自 SkillHub”入口位于同一个布局容器，入口靠右。
- 人设卡片内部顶部存在三级标题「人设卡片」，字体和颜色与历史 slogan 一致。
- 设置页主内容与产品 footer 之间保留 24px 间距，卡片边框不与 footer 分隔线重合。
- 标题、说明和卡片按文档流从上到下排列；说明与卡片间距为 12px。
- 标题和说明应用上述明确字号、字重、行高及文本色。
- 原卡片内的渐变 slogan 与 Sparkles 图标不再渲染。

- [x] **Developer：按用户反馈补失败测试，确认来源入口移至说明行右侧且卡片标题为「人设卡片」并复用历史 slogan 字体与颜色；最小调整 `BuddyPanel`，再运行定向回归、i18n、TypeScript、差异检查和页面 smoke。**

**Test-first target:**

```tsx
expect(screen.getByRole("heading", { level: 2, name: "人设" })).toBeInTheDocument();
expect(screen.getByText("为你的 Agent 解锁独特灵魂，让它从此与众不同")).toHaveClass(
  "text-sm",
  "font-medium",
  "leading-6",
);
```

**Minimal implementation shape:**

```tsx
<>
  <header>
    <h2>{t("人设")}</h2>
    <p>{t("为你的 Agent 解锁独特灵魂，让它从此与众不同")}</p>
  </header>
  <div className="lv-buddy-panel">...</div>
</>
```

**Verification:**
- RED：新增用例因找不到二级标题「人设」而失败，并确认旧说明仍是卡片内渐变 `h2`。
- GREEN：`agent-buddy-panel.test.tsx` 共 30 个用例通过。
- `pnpm i18n:extract`、`pnpm i18n:zh-hant`、`pnpm i18n:check`、`pnpm check` 与 `git diff --check` 通过；新增「人设卡片」的简中、繁中、英文和印尼语字典项。
- 本地 `/agents/persona/` 返回 200，页面有内容、无 Next/Vite 错误浮层和浏览器错误；当前本地及 Chrome 均无可复用登录态，因此未把登录前页面截图冒充成人设面板视觉验收。

---

# 统一 OIDC 站点鉴权 Active Plan

**Status:** 实现中。

**Confirmed callbacks:**

- `https://sites-auth.lightvela.tech/auth/lightvela/callback`
- `https://sites-auth.lightvela.site/auth/lightvela/callback`

- [x] 完成 `changes/2026-08-24-oidc-site-auth-plan.md` 的 UserAuth、frontend、site-gateway、CTL 实现和验证。

---

# 移动端微信登录复制链接引导 Implementation Plan

**Status:** 实现与验证完成，已提交 MR。

**Size:** S。单一目标、局部登录交互调整，不改变 OAuth 后端、公共 API、鉴权或发布流程。

**Goal:** 普通移动浏览器打开登录弹窗后默认展示明确的微信打开提示和复制链接按钮，并保持微信内与桌面端既有 OAuth 行为。

**Architecture:** 新增一个供登录弹窗与 `/auth/sign-in` 共用的展示组件；两个入口继续使用现有 UA 分类和 Repository URL 生成逻辑，仅把普通移动浏览器分支从错误提示改为复制 `official_account` URL 的引导态。

**Scope:**
- 修改 `frontend/src/components/site/login-modal.tsx` 和 `frontend/src/pages/auth/sign-in-page.tsx` 的普通移动浏览器分支。
- 新增 `frontend/src/components/site/wechat-mobile-browser-guide.tsx`，负责图标、复制动作及可访问状态播报。
- 更新对应 Vitest，并按生成流程同步 i18n 字典。
- 不修改 OAuth 后端、Repository 接口、桌面扫码、微信内授权及其他登录方式。

- [x] 先补登录弹窗与登录页的移动端复制引导测试，并确认 RED。
- [x] 实现共用引导组件和两个入口的最小状态接入，让定向测试 GREEN。
- [x] 完成第一版 i18n、类型检查、差异检查和 390 x 844 浏览器交互验收。
- [x] 按用户验收反馈移除移动端二次点击，统一复制按钮圆角、字号、字重及弹窗标题间距。
- [x] 完成调整后的全量检查和移动视口浏览器复验。
- [x] 按 MR review 补齐协议待确认态的视觉与 `aria-disabled` 语义，并同步最终文案和验证记录。

**Acceptance:**
- 普通移动浏览器打开登录弹窗即展示 `复制链接，前往「微信」打开` 和 `复制链接`，不需要再次点击微信登录按钮且不发生重定向。
- 复制的是 `wechatMode: "official_account"` 生成的 OAuth start URL；切换账号时保留 `switchAccount: true`。
- 引导默认可见；未勾选协议时复制按钮显示待确认样式并设置 `aria-disabled="true"`，点击仍提示 `请先勾选同意服务协议`，且不写入剪贴板。
- 复制按钮和引导提示统一使用弹窗主按钮的 `text-sm font-medium`，按钮使用 `rounded-full`；标题区显式承担底部间距。
- 成功显示 `已复制，请打开微信粘贴访问`；Clipboard API 和兼容复制均失败时显示 `复制失败，请长按复制下方链接` 并展示可选中的原始链接。
- 微信内使用 `official_account` 直接跳转，桌面使用 `website` 直接跳转，QQ/手机入口保持不变。

**Verification:**
- RED：两个入口先因缺少复制引导失败；失败复制与取消协议用例也按预期失败。
- GREEN：登录弹窗、登录页、国际站入口和 Repository 共 5 个测试文件、86 个用例通过；移动端弹窗默认展示引导，复制按钮接收焦点并关联操作提示，从引导切换到手机号时清除旧状态。
- `pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过；新增英文文案无空翻译，繁体字典与简体字典一致。
- Chrome 在 390 x 844 移动模拟环境从首页点击一次登录后直接进入真实引导，无横向溢出或遮挡；复制按钮和提示计算样式均为 14px/500，按钮为 42px 高胶囊圆角。iPhone/Android User-Agent 分流、协议门禁和 OAuth URL 由组件集成测试闭环。

---

# 国内站上传人设文件产品动态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在国内站 2026 年 8 月更新日志中发布“上传自定义人设文件”动态，并确保国际站不展示该条目。

**Status:** 实现与验证完成，等待提交与 MR 授权。

**Architecture:** 沿用 `changelog-page.tsx` 的静态月份数据与 `VisualCard` 图片映射，在 `!isGlobal` 的 2026 年 8 月条目首位增加国内专属动态。使用真实的初始上传弹窗截图作为独立图片资源，通过国内和国际站组件测试锁定展示边界。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、现有 i18n 与静态图片资源。

## Global Constraints

- 标题固定为 `LightVela 支持上传自定义人设文件`。
- 描述固定为 `上传 Markdown 人设文件后，可继续编辑或直接注入 Agent；已注入的人设文件也支持随时编辑和下载。`。
- 仅国内站展示，国际站所有语言均不新增该条目。
- 使用“上传人设文件”初始弹窗真实截图，不包含账号、Agent 名称、文件内容或其他用户数据。
- 不调整 changelog 页面布局、其他条目顺序或其他月份内容。

---

### Task 1: 发布国内站上传人设文件动态

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/channel-copy.test.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/global-changelog.test.tsx`
- Modify: `frontend/src/pages/marketing/changelog-page.tsx`
- Create: `frontend/public/assets/changelog/lightvela-persona-upload.png`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Modify: `frontend/src/i18n/generated/zh-CN.json`
- Modify: `frontend/src/i18n/generated/zh-Hant.json`
- Modify: `frontend/src/i18n/generated/zh-to-key.json`
- Create: `frontend/openspec/changes/2026-08-23-domestic-persona-upload-changelog-design.md`
- Modify: `frontend/openspec/plan.md`

**Interfaces:**
- Consumes: `ChangelogEntry`、国内站 `2026-08` 分组、`VisualCard` 和编译期 `isGlobal` 分支。
- Produces: `personaUpload` 图片 variant，以及仅国内站可见的 `persona-file-upload` 更新条目。

- [x] **Step 1: 写失败测试锁定国内展示和国际排除**

  国内站测试增加：

  ```tsx
  expect(screen.getByRole("heading", { name: "LightVela 支持上传自定义人设文件" })).toBeInTheDocument();
  expect(
    screen.getByText(
      "上传 Markdown 人设文件后，可继续编辑或直接注入 Agent；已注入的人设文件也支持随时编辑和下载。",
    ),
  ).toBeInTheDocument();
  expect(screen.getByAltText("LightVela 支持上传自定义人设文件")).toHaveAttribute(
    "src",
    expect.stringContaining("/assets/changelog/lightvela-persona-upload.png"),
  );
  ```

  国际站测试增加：

  ```tsx
  expect(
    screen.queryByRole("heading", { name: "LightVela 支持上传自定义人设文件" }),
  ).not.toBeInTheDocument();
  ```

- [x] **Step 2: 运行测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run --api.host 127.0.0.1 \
    src/pages/marketing/__tests__/channel-copy.test.tsx \
    src/pages/marketing/__tests__/global-changelog.test.tsx
  ```

  Expected: 国内站新增标题、描述和图片断言失败；国际站排除断言保持通过。

- [x] **Step 3: 接入真实截图和最小页面实现**

  - 从已合入功能的国内站本地页面打开“上传人设文件”初始弹窗，截取不含用户数据的真实 UI。
  - 将截图保存为 `frontend/public/assets/changelog/lightvela-persona-upload.png`。
  - 为 `ChangelogEntry.visual` 和 `VisualCard` 增加 `personaUpload`，配置图片路径、alt 和截图真实宽高比。
  - 将 `persona-file-upload` 放在国内站 2026 年 8 月分组首位，使用固定标题与描述。

- [x] **Step 4: 生成 i18n 并确认 GREEN**

  Run:

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:zh-hant
  pnpm exec vitest run --api.host 127.0.0.1 \
    src/pages/marketing/__tests__/channel-copy.test.tsx \
    src/pages/marketing/__tests__/global-changelog.test.tsx
  ```

  Expected: 国内和国际站相关测试全部通过。

- [x] **Step 5: 完成静态与页面验证**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  git diff --check
  ```

  浏览器检查国内站 `/changelog/` 的月份、顺序、文案和图片比例；检查国际站 `/en-us/changelog/` 不出现该条目。

- [ ] **Step 6: 等待提交和 MR 授权**

  展示 staged diff、验证结果、拟提交信息和拟 MR 信息；用户确认后再执行 `git commit`、`git push` 和创建 MR。
---

# 自定义人设来源标记修复 Implementation Plan

**Status:** 实现与验证完成，等待提交确认。

**Goal:** 顶层写入 `LightVela-Source: custom-upload`，保留用户原始 Slug，并修复缺少 `## Content` 时的双层 Soul 包装。

**Scope:**
- 页面刷新通过来源字段恢复自定义状态，并兼容旧 `Slug: custom-upload`。
- 下载继续返回 Agent 当前实际 `SOUL.md` 原文；其他交互不调整。
- 不新增依赖，不修改 UI 或文案。

- [x] **Developer：按 TDD 完成来源字段写入、轻量身份读取、状态识别与旧格式兼容；修改 `agent-persona-upload.ts`、`agent-buddy-command.ts`、`agent-buddy-panel.tsx`、相关测试及 `openspec/specs/buddy.md`；以聚焦 Vitest、`pnpm check`、`pnpm i18n:check`、`git diff --check` 验收。**

详细设计与执行步骤：
- `openspec/changes/2026-08-23-custom-persona-source-marker-design.md`
- `openspec/changes/2026-08-23-custom-persona-source-marker-plan.md`

---

# 通道页标题与提示样式对齐 Implementation Plan

**Status:** 实现与验证完成。

**Goal:** 为通道页补齐“通道”标题，并将顶部提示从蓝底 Info 提示条调整为明确的轻量说明规格。

**Architecture:** 继续使用 `agent-channel-panel.tsx` 和 `standard-panel.css` 的标准面板样式体系；在现有提示 DOM 前增加语义化 `h2`，让标题与提示应用下述明确视觉数值，不改变文案、卡片或连接行为。

**Scope:**
- 标题固定为「通道」，18px、600 字重、24px 行高，标题与提示间距 4px。
- 提示原文案保持不变；透明背景、隐藏 Info 图标、14px、500 字重、24px 行高，卡片上间距 12px。
- 模型页提示和通道连接行为保持不变。

- [x] 先补标题与提示样式回归测试并确认 RED。
- [x] 新增语义化标题，让通道提示应用明确轻量样式并确认 GREEN。
- [x] 完成定向回归、TypeScript 与差异检查。
- [x] CR：将间接的技能页对齐措辞改为明确数值，并让样式测试不依赖共享选择器的顺序或格式。

**Verification:**
- 标题测试先因缺少 `h2` 失败，最小实现后通过。
- 通道相关 2 个测试文件共 5 个用例通过。
- `pnpm check` 与定向 `git diff --check` 通过。
- 登录后本地页面无可复用 Agent 登录态；使用真实 DOM class 和当前 CSS 的只读预览确认计算样式符合上述规格。

---

# 8 月 22 日 Hermes Agent 版本升级公告 Implementation Plan

**Status:** 实现与验证完成，等待用户确认提交和推送。

**Goal:** 国内站和国际站首页展示 2026 年 8 月 22 日 22:00 至次日 06:00 的 Hermes Agent 版本升级公告，并在维护窗口结束时自动撤下。

**Architecture:** 复用现有首页维护公告项，刷新公告 ID、失效时间和双站时区文案；保持国际站公测计费公告及轮播、关闭记忆、路径白名单逻辑不变。

- [x] 先补国内站、国际站公告文案和到期撤下测试并确认 RED。
- [x] 最小更新公告源与多语言字典，让定向测试 GREEN。
- [x] 完成 i18n、类型检查和差异校验。

**Verification:**
- RED：新增的国内、国际公告文案与到期撤下断言共 3 条按预期失败。
- GREEN：公告相关 2 个测试文件共 4 个用例通过。
- `pnpm check`、`pnpm i18n:check`、四语言公告翻译完整性检查与 `git diff --check` 通过。
---

# Agent 人设 Markdown 上传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:executing-plans. This repository is configured for single-agent execution.

**Status:** Task 21 实现、相关回归和本地冒烟完成，等待用户验收与提交确认。

**Goal:** 在国内站已有 Agent 的人设页提供“上传人设文件”，支持本地 Markdown 校验、预览编辑、安全覆盖和刷新后状态恢复。

**Architecture:** 浏览器本地读取和严格校验 `.md`，通过独立上传弹窗编辑；标准化为带固定自定义 slug 的 `SOUL.md` 后复用现有 `execDebugCommand` 注入。现有写命令升级为备份加临时文件原子替换，读取命令只回传存在性、slug 与名称。BuddyPanel 将自定义状态与推荐人设卡片状态分离。

**Tech Stack:** React 19、TypeScript 5.9、Radix Dialog、Tailwind CSS 4、Vitest 4、Testing Library、现有 BotRepository/Hermes 命令。

## Global Constraints

- 只开放国内站已有 Agent 页面；国际站和新建 Agent 流程不变。
- 只支持 UTF-8 `.md`，实际字节不超过 20 KB；软结构问题不阻止注入。
- 不新增后端 API、npm 依赖、原始文件存储或自定义抽卡卡片。
- 覆盖现有人设前必须确认并备份；失败不得破坏旧 `SOUL.md`。
- 所有新增中文源文案纳入现有 i18n；不得绕过翻译检查。

### Task 1: 用纯函数和命令测试锁定文件与写入契约

**Role:** Developer / Reviewer

**Files:**
- Add: `frontend/src/pages/marketing/agent-persona-upload.ts`
- Add: `frontend/src/pages/marketing/__tests__/agent-persona-upload.test.ts`
- Modify: `frontend/src/pages/marketing/agent-buddy-command.ts`
- Modify: `frontend/src/pages/marketing/__tests__/agent-buddy-command.test.ts`

**Acceptance:**
- 严格覆盖扩展名、UTF-8、20 KB 字节边界、空内容、控制字符和编辑后再校验。
- 名称、软提示和标准化输出符合 Spec，原始文件不被另存。
- 写命令先备份、再写临时文件并原子替换；读取命令只输出并解析身份字段。
- 先新增失败测试并确认 RED，再做最小实现让定向测试 GREEN。

- [x] 完成校验/标准化纯函数与 Hermes 命令的 RED → GREEN。

### Task 2: 接入上传弹窗和自定义已注入状态

**Role:** Developer / Reviewer

**Files:**
- Add: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Add: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`

**Acceptance:**
- 国内站显示“上传人设文件”，选择合法文件后可预览、编辑并看到实时字节数和软提示。
- 无人设时直接注入；已有人设时必须确认覆盖，取消不丢内容。
- 注入失败保留内容并可重试；成功显示自定义名称和 `/new` 提示。
- 刷新可从真实 `SOUL.md` 恢复自定义状态；自定义不生成卡片，推荐人设流程不回归。
- 切换 Agent 时忽略旧读取/注入结果。

- [x] 完成上传交互、状态接入及组件级 RED → GREEN。

### Task 3: 完成区域、翻译、文档与端到端质量门禁

**Role:** Developer / Reviewer

**Files:**
- Modify: `frontend/src/i18n/generated/en-US.json`
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Modify: `frontend/src/i18n/generated/zh-Hant.json`
- Modify: `frontend/openspec/specs/buddy.md`
- Modify: `frontend/openspec/plan.md`
- Add: `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md`

**Acceptance:**
- 国际站不显示上传入口；国内站文案与交互完整。
- PRD、当前 OpenSpec 和 Buddy 长期规格与真实实现一致。
- 定向测试、`pnpm check`、`pnpm i18n:check`、国内站构建、区域回归和 `git diff --check` 通过。
- 本地浏览器验证桌面、移动端、键盘、非法文件、编辑超限、覆盖确认、失败重试与成功状态；无法完成的外部条件必须留证说明。

- [x] 补齐 i18n / 长期规格并完成全套验证与用户验收交接。

### Task 4: 抽卡结果支持直接注入

**Files:**
- Modify: `frontend/src/pages/marketing/agent-buddy-draw-modal.tsx`
- Modify: `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-buddy-draw-modal.test.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Acceptance:**
- 揭晓卡片并列提供左侧“注入此人设”和右侧“添加，暂不注入”，两侧按钮字号统一为 14px，处理中防止重复操作。
- 直接注入复用推荐人设详情获取、标准化、备份和原子写入链路，不复制第二套命令。
- 只有 Agent 写入成功才入盘、选中、标记已注入并关闭抽卡弹窗；失败或下载兜底时弹窗与人设盘保持不变。
- 普通抽卡追加卡片，重抽时仍替换原槽位；“添加，暂不注入”和操作区注入流程不回归。

- [x] 先新增按钮回调和成功/失败状态测试并确认 RED。
- [x] 提取最小可复用注入函数，接入抽卡结果动作并让定向测试 GREEN。
- [x] 更新 i18n，完成相关测试、`pnpm check`、`pnpm i18n:check` 与 `git diff --check`。

### Task 5: 对齐上传弹窗文案与操作布局

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Modify: `frontend/src/pages/marketing/agent-buddy-draw-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-buddy-draw-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Interfaces:**
- Consumes: 现有 `PersonaUploadModal` 的文件选择、编辑、覆盖确认和注入回调；现有 `DrawSoulModal` 的添加与直接注入回调。
- Produces: 用户可见入口和标题“上传人设文件”、固定编辑态说明、与自动任务一致的编辑框样式、右下角上传操作区，以及左注入/右添加的抽卡操作区。

- [x] **Step 1 — 写失败测试锁定文案、编辑框和按钮顺序**

  在上传弹窗测试中断言：

  ```tsx
  const dialog = await screen.findByRole("dialog", { name: "上传人设文件" });
  expect(within(dialog).getByText(
    "说明：仅支持 UTF-8 Markdown 文件，最大 20 KB。上传后可以在此处进行编辑。",
  )).toBeInTheDocument();
  const editor = within(dialog).getByLabelText("人设内容");
  expect(editor).toHaveClass("mt-1.5", "rounded-md", "border-black/10", "focus:border-black/30", "focus:outline-none");
  const reselect = within(dialog).getByRole("button", { name: "重新上传文件" });
  const inject = within(dialog).getByRole("button", { name: "注入人设" });
  expect(reselect.parentElement).toHaveClass("justify-end");
  expect(reselect.nextElementSibling).toBe(inject);
  ```

  在抽卡弹窗测试中断言：

  ```tsx
  expect(injectButton.nextElementSibling).toBe(addButton);
  ```

- [x] **Step 2 — 运行定向测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run --api.host 127.0.0.1 \
    src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx \
    src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
    src/pages/marketing/__tests__/agent-buddy-draw-modal.test.tsx
  ```

  Expected: FAIL，旧实现仍显示“上传人设”、旧说明、编辑框聚焦 ring，以及左添加/右注入。

- [x] **Step 3 — 实现最小文案与样式调整**

  - 入口和弹窗标题统一使用 `t("上传人设文件")`。
  - 编辑态说明使用 `t("说明：仅支持 UTF-8 Markdown 文件，最大 20 KB。上传后可以在此处进行编辑。")`。
  - 编辑框保留 `h-64`、`resize-y` 和等宽字体，仅将视觉 token 对齐为 `mt-1.5 rounded-md border-black/10 focus:border-black/30 focus:outline-none`，移除聚焦 ring。
  - 编辑态与覆盖确认态操作区均使用 `flex items-center justify-end gap-2`，次操作在左、主操作在右。
  - 抽卡结果 JSX 调整为左侧“注入此人设”、右侧“添加，暂不注入”，事件、禁用态和 14px 字号保持不变。

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run: Step 2 相同命令。

  Expected: 相关测试全部 PASS。

- [x] **Step 5 — 更新翻译并运行完整质量门禁**

  Run:

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:zh-hant
  pnpm check
  pnpm i18n:check
  git diff --check
  ```

  补齐英文 `Upload persona file` 和 `Note: Only UTF-8 Markdown files up to 20 KB are supported. You can edit the content here after uploading.`，以及对应印尼语；最终相关 5 个测试文件、49 个用例保持通过。

- [x] **Step 6 — 等待提交授权**

  展示变更文件、验证结果和拟提交信息；只有用户明确确认后才执行 `git commit`。

### Task 6: 精简操作区注入按钮文案

**Files:**
- Modify: `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Interfaces:**
- Consumes: 已选中推荐人设时显示的操作区注入按钮。
- Produces: 未注入状态显示“注入”；处理中“注入中…”、已注入状态“重新注入”、抽卡弹窗“注入此人设”和上传弹窗“注入人设”均保持不变。

- [x] **Step 1 — 将操作区组件测试期望改为“注入”**

  ```tsx
  expect(screen.queryByRole("button", { name: "注入" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选中此人设" }));
  fireEvent.click(screen.getByRole("button", { name: "注入" }));
  ```

- [x] **Step 2 — 运行面板测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run --api.host 127.0.0.1 \
    src/pages/marketing/__tests__/agent-buddy-panel.test.tsx
  ```

  Expected: 3 个用例因旧按钮仍显示“注入人设”而失败。

- [x] **Step 3 — 最小替换操作区按钮文案**

  ```tsx
  {toast.kind === "applying"
    ? t("注入中…")
    : isApplied
      ? t("重新注入")
      : t("注入")}
  ```

- [x] **Step 4 — 运行面板测试并确认 GREEN**

  Run: Step 2 相同命令。

  Expected: 15 个用例全部 PASS。

- [x] **Step 5 — 更新翻译并运行完整质量门禁**

  Run:

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:zh-hant
  pnpm exec vitest run --api.host 127.0.0.1 \
    src/pages/marketing/__tests__/agent-buddy-draw-modal.test.tsx \
    src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
    src/pages/marketing/__tests__/agent-buddy-command.test.ts \
    src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx \
    src/pages/marketing/__tests__/agent-persona-upload.test.ts
  pnpm check
  pnpm i18n:check
  git diff --check
  ```

  补齐英文 `Inject` 和印尼语 `Terapkan`；最终保持 5 个测试文件、49 个用例通过。

### Task 7: 精简上传弹窗文件重选文案

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Interfaces:**
- Consumes: 上传弹窗中重新打开隐藏文件选择器的次操作按钮。
- Produces: 按钮显示“重新上传文件”，点击行为、禁用状态和右下角位置保持不变。

- [x] **Step 1 — 将上传弹窗测试期望改为“重新上传文件”**

  ```tsx
  const reuploadButton = within(dialog).getByRole("button", { name: "重新上传文件" });
  const injectButton = within(dialog).getByRole("button", { name: "注入人设" });
  expect(reuploadButton.parentElement).toHaveClass("justify-end");
  expect(reuploadButton.nextElementSibling).toBe(injectButton);
  ```

- [x] **Step 2 — 运行上传弹窗测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run --api.host 127.0.0.1 \
    src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx
  ```

  Expected: 预览编辑用例因旧按钮仍显示“重新选择文件”而失败。

- [x] **Step 3 — 最小替换次按钮文案**

  ```tsx
  {t("重新上传文件")}
  ```

- [x] **Step 4 — 运行上传弹窗测试并确认 GREEN**

  Run: Step 2 相同命令。

  Expected: 7 个用例全部 PASS。

- [x] **Step 5 — 更新翻译并运行完整质量门禁**

  补齐英文 `Upload another file` 和印尼语 `Unggah ulang file`，然后执行：

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:zh-hant
  pnpm exec vitest run --api.host 127.0.0.1 \
    src/pages/marketing/__tests__/agent-buddy-draw-modal.test.tsx \
    src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
    src/pages/marketing/__tests__/agent-buddy-command.test.ts \
    src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx \
    src/pages/marketing/__tests__/agent-persona-upload.test.ts
  pnpm check
  pnpm i18n:check
  git diff --check
  ```

  Expected: 5 个测试文件、49 个用例及全部质量门禁通过。

### Task 8: 精简人设结构建议提示

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Interfaces:**
- Consumes: 上传人设编辑态已有的 `warnings` 弱结构校验结果。
- Produces: 提示区顶部统一显示“提示：”，每条建议移除“（仍可继续注入）”，注入行为保持不变。

- [x] **Step 1 — 增加提示标题与精简建议文案断言**

  ```tsx
  expect(within(dialog).getByText("提示：")).toBeInTheDocument();
  expect(within(dialog).getByText("建议补充 Name 字段")).toBeInTheDocument();
  expect(within(dialog).queryByText(/仍可继续注入/)).not.toBeInTheDocument();
  ```

- [x] **Step 2 — 运行上传弹窗测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run --api.host 127.0.0.1 \
    src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx
  ```

  Expected: 因缺少“提示：”且旧建议仍含“仍可继续注入”而失败。

- [x] **Step 3 — 最小调整提示区渲染和 6 条建议文案**

  ```tsx
  <p className="mb-1 text-sm font-medium text-amber-900">{t("提示：")}</p>
  <ul className="space-y-1 text-sm text-amber-900">
    {warnings.map((warning) => (
      <li key={warning}>• {warningMessage(t, warning)}</li>
    ))}
  </ul>
  ```

- [x] **Step 4 — 运行上传弹窗测试并确认 GREEN**

  Run: Step 2 相同命令。

  Expected: 7 个用例全部 PASS。

- [x] **Step 5 — 更新翻译并运行完整质量门禁**

  执行 i18n 提取并补齐新文案翻译，然后运行相关 5 个测试文件、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。

### Task 9: 增加上传弹窗初始空白态

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Interfaces:**
- Consumes: 页面操作区“上传人设文件”入口、隐藏 `input[type=file]` 和现有文件读取/校验函数。
- Produces: `view` 扩展为 `"upload" | "edit" | "confirm"`；入口只打开 `upload` 视图，弹窗内“选择文件”才调用 `inputRef.current?.click()`，有效文件进入 `edit`，无效文件留在 `upload`。

- [x] **Step 1 — 增加入口与初始上传态组件测试**

  ```tsx
  const fileInput = screen.getByLabelText("选择 Markdown 人设文件");
  const inputClick = vi.spyOn(fileInput, "click");

  fireEvent.click(screen.getByRole("button", { name: "上传人设文件" }));

  const dialog = await screen.findByRole("dialog", { name: "上传人设文件" });
  expect(inputClick).not.toHaveBeenCalled();
  expect(within(dialog).getByText("选择 Markdown 人设文件")).toBeInTheDocument();
  expect(within(dialog).getByText("仅支持 UTF-8 Markdown 文件，最大 20 KB。")).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("人设内容")).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "注入人设" })).not.toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole("button", { name: "选择文件" }));
  expect(inputClick).toHaveBeenCalledTimes(1);
  ```

- [x] **Step 2 — 增加失败留在上传态、成功进入编辑态断言**

  ```tsx
  selectFile(new File(["hello"], "persona.txt"));
  expect(await within(dialog).findByText("仅支持 .md 文件")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "重新上传文件" })).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("人设内容")).not.toBeInTheDocument();

  selectFile(new File(["# 我的助手"], "persona.md"));
  expect(await within(dialog).findByLabelText("人设内容")).toHaveValue("# 我的助手");
  ```

- [x] **Step 3 — 运行上传弹窗测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run --api.host 127.0.0.1 \
    src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx
  ```

  Expected: 入口仍直接调用文件选择器，无法找到初始上传弹窗和“选择文件”。

- [x] **Step 4 — 最小实现三态视图与初始上传 UI**

  ```tsx
  const [view, setView] = useState<"upload" | "edit" | "confirm">("upload");

  view === "upload" ? (
    <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-black/10 bg-black/[0.02] px-6 py-10 text-center">
      <Upload className="size-8 text-[var(--text-tertiary)]" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">{t("选择 Markdown 人设文件")}</p>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">{t("仅支持 UTF-8 Markdown 文件，最大 20 KB。")}</p>
      {selectionError && (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{errorMessage(t, selectionError)}</span>
        </div>
      )}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="mt-4 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white"
      >
        {selectionError ? t("重新上传文件") : t("选择文件")}
      </button>
    </div>
  )
  ```

  页面入口 `onClick` 仅执行 `setOpen(true)`；文件读取成功后执行 `setView("edit")`，失败则保持 `setView("upload")`。

- [x] **Step 5 — 运行上传弹窗测试并确认 GREEN**

  Run: Step 3 相同命令。

  Expected: 新增用例与现有 7 个用例全部 PASS。

- [x] **Step 6 — 更新翻译并运行完整质量门禁**

  执行 `pnpm i18n:extract`、`pnpm i18n:zh-hant`，补齐英文和印尼语新文案；随后运行相关 5 个测试文件、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。

### Task 10: 精简上传弹窗说明文案

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Interfaces:**
- Consumes: 上传弹窗非覆盖确认态的 `DialogDescription`。
- Produces: 初始上传态与编辑态统一显示“上传人设文件后，你可以在此处继续编辑。”；覆盖确认态说明不变。

- [x] **Step 1 — 将组件测试期望改为新说明文案**

  ```tsx
  expect(await within(dialog).findByText(
    "上传人设文件后，你可以在此处继续编辑。",
  )).toBeInTheDocument();
  ```

- [x] **Step 2 — 运行上传弹窗测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run --api.host 127.0.0.1 \
    src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx
  ```

  Expected: 编辑态用例因弹窗仍显示旧说明文案而失败。

- [x] **Step 3 — 最小替换非覆盖确认态说明文案**

  ```tsx
  {view === "confirm"
    ? t("确认后会替换 Agent 当前人设，旧文件会自动备份。")
    : t("上传人设文件后，你可以在此处继续编辑。")}
  ```

- [x] **Step 4 — 运行上传弹窗测试并确认 GREEN**

  Run: Step 2 相同命令。

  Expected: 8 个上传弹窗用例全部 PASS。

- [x] **Step 5 — 更新翻译并运行完整质量门禁**

  执行 `pnpm i18n:extract`、`pnpm i18n:zh-hant`，补齐英文和印尼语翻译；随后运行相关 5 个测试文件、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。

### Task 11: 区分上传态与编辑态弹窗标题

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Acceptance:**
- 页面入口与初始上传态标题保持“上传人设文件”。
- 合法文件读取成功进入编辑态后，标题显示“编辑人设文件”。
- 覆盖确认态标题保持现有文案不变。
- 无效文件与读取失败仍停留在上传态，标题保持“上传人设文件”。

- [x] 先增加状态标题断言并确认 RED。
- [x] 最小实现条件标题并确认 GREEN。
- [x] 更新 i18n，运行定向测试、类型检查、i18n 检查和差异检查。

### Task 12: 移除上传与编辑态可见说明文案

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Acceptance:**
- 初始上传态和编辑态不再显示“上传人设文件后，你可以在此处继续编辑。”。
- 弹窗保留随状态变化的隐藏无障碍描述，不产生 Radix 描述缺失警告。
- 覆盖确认态原有说明保持不变。

- [x] 先增加说明缺失断言并确认 RED。
- [x] 最小实现可见说明移除与隐藏无障碍描述并确认 GREEN。
- [x] 清理未使用 i18n 文案，运行定向测试、类型检查、i18n 检查和差异检查。

### Task 13: 明确人设建议区标题

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**Interfaces:**
- Consumes: 编辑态现有 `warnings` 建议列表与黄色提示区样式。
- Produces: 建议区标题显示“人设完善建议”，不带冒号；建议条目、触发规则、视觉样式和注入行为保持不变。

- [x] **Step 1: 将组件测试标题期望改为“人设完善建议”并确认 RED**
- [x] **Step 2: 最小替换建议区标题并确认 GREEN**
- [x] **Step 3: 更新 i18n，运行相关测试、类型检查、i18n 检查和差异检查**

### Task 14: 统一沟通风格建议与结构识别

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload.ts`
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload.test.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/openspec/specs/buddy.md`
- Modify: `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md`

**Acceptance:**
- 缺少相关内容时，建议文案显示“建议补充沟通风格”。
- `## 沟通风格` 与 `## Communication Style` 均可满足沟通风格结构建议，不再触发 `missing_tone`。
- 现有 `语气`、`表达`、`Tone`、`Voice`、`Style` 识别保持不变；软建议仍不阻止注入。

- [x] **Step 1: 先增加沟通风格文案与中英文标题识别测试，并确认 RED**
- [x] **Step 2: 最小更新提示文案与 `missing_tone` 匹配规则，并确认 GREEN**
- [x] **Step 3: 同步 i18n、OpenSpec 与 PRD，完成相关测试和质量门禁**

### Task 15: 调整人设建议区标题

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/openspec/specs/buddy.md`
- Modify: `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md`

**Acceptance:**
- 编辑态建议区标题显示“人设内容建议”，不带冒号。
- 建议条目、触发规则、视觉样式和注入行为保持不变。

- [x] **Step 1: 先将组件测试标题期望改为“人设内容建议”并确认 RED**
- [x] **Step 2: 最小替换建议区标题并确认 GREEN**
- [x] **Step 3: 同步 i18n、OpenSpec 与 PRD，完成相关测试和质量门禁**

### Task 16: 为专业建议增加英文对照并补齐英文标题识别

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload.ts`
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload.test.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/openspec/specs/buddy.md`
- Modify: `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md`

**Acceptance:**
- 四条专业建议显示为“建议补充角色定位（Identity）”“建议补充沟通风格（Communication Style）”“建议补充工作原则（Working Principles）”“建议补充行为边界（Behavioral Boundaries）”。
- `## Working Principles` 不再触发 `missing_principles`。
- `## Behavior Boundaries` 与 `## Behavioral Boundaries` 均不再触发 `missing_boundaries`。
- 现有中文与英文短标题识别、非阻断语义和注入行为保持不变。

- [x] **Step 1: 先增加四条新文案与英文标题识别测试，并确认 RED**
- [x] **Step 2: 最小更新建议文案与结构匹配规则，并确认 GREEN**
- [x] **Step 3: 同步 i18n、OpenSpec 与 PRD，完成相关测试和质量门禁**

### Task 17: 精简覆盖确认弹窗

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/openspec/specs/buddy.md`
- Modify: `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md`

**Acceptance:**
- 仅当前 Agent 存在非空 `SOUL.md` 时进入覆盖确认态；无人设时仍直接注入。
- 覆盖确认态标题显示“覆盖当前人设？”。
- 可见说明仅保留“旧人设会自动备份，然后注入新内容。”，移除重复黄色提示框。
- 操作按钮保持右下角布局，文案为“返回编辑”和“覆盖并注入”。

- [x] **Step 1: 先更新组件测试锁定标题、单行说明和按钮文案，并确认 RED**
- [x] **Step 2: 最小精简覆盖确认态并确认 GREEN**
- [x] **Step 3: 同步 i18n、OpenSpec 与 PRD，完成相关测试和质量门禁**

### Task 18: 调整覆盖确认说明文案

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/openspec/specs/buddy.md`
- Modify: `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md`

**Acceptance:**
- 覆盖确认说明由“旧人设会自动备份，然后注入新内容。”改为“旧人设会自动备份，然后注入新人设。”。
- 标题、按钮、覆盖条件与备份注入行为保持不变。

- [x] **Step 1: 先更新组件测试并确认 RED**
- [x] **Step 2: 最小替换说明文案并确认 GREEN**
- [x] **Step 3: 同步 i18n、OpenSpec 与 PRD，完成质量门禁**

### Task 19: 明确上传文件的写入目标

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/openspec/specs/buddy.md`
- Modify: `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md`

**Acceptance:**
- 初始上传态中央文案由“选择 Markdown 人设文件”改为“选择 Markdown 人设文件，将其内容填入 SOUL.md”。
- 弹窗标题、文件选择按钮、格式限制和文件输入无障碍名称保持不变。

- [x] **Step 1: 先更新组件测试并确认 RED**
- [x] **Step 2: 最小替换中央文案并确认 GREEN**
- [x] **Step 3: 同步 i18n、OpenSpec 与 PRD，完成质量门禁**

### Task 20: 精简上传限制说明并优化编码错误提示

**Files:**
- Modify: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/openspec/specs/buddy.md`
- Modify: `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md`

**Acceptance:**
- 初始上传态限制说明显示“仅支持 Markdown 文件，文件名不限，扩展名须为 .md，大小不超过 20 KB。”。
- 非 UTF-8 文件显示“文件编码需为 UTF-8，请转换后重新上传。”。
- 文件校验规则、20 KB 上限和其他错误提示保持不变。

- [x] **Step 1: 先更新提示与错误测试并确认 RED**
- [x] **Step 2: 最小替换两处文案并确认 GREEN**
- [x] **Step 3: 同步 i18n、OpenSpec 与 PRD，完成质量门禁**

### Task 21: 增加当前自定义人设文件编辑与下载

**Role:** Developer / Reviewer（single-agent）

**Detailed Plan:** `frontend/openspec/changes/2026-08-23-custom-persona-file-actions-plan.md`

**Files:**
- Modify: `frontend/src/pages/marketing/agent-buddy-command.ts`
- Add: `frontend/src/pages/marketing/agent-custom-persona-file-modal.tsx`
- Modify: `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-buddy-command.test.ts`
- Add test: `frontend/src/pages/marketing/__tests__/agent-custom-persona-file-modal.test.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- Modify: `frontend/src/i18n/generated/*.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/openspec/specs/buddy.md`
- Modify: `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md`

**Acceptance:**
- 自定义人设已注入状态文字后显示编辑和下载图标，状态文字本身不可点击；推荐人设和国际站不显示。
- 编辑图标按需读取当前 Agent 实际 `SOUL.md`，在“编辑人设文件”弹窗中修改，并复用备份加原子替换链路安全保存。
- 下载图标直接下载当前 Agent 实际原文为 `soul.md`，不打开编辑弹窗，也不改写内容。
- 页面初始化仍只读取身份字段；文件缺失、超限、格式异常、网络失败和 Agent 切换竞态均有明确且安全的处理。
- 保存成功刷新真实名称并提示发送 `/new`；相关测试、类型、i18n 和差异检查通过。

- [x] **Step 1: TDD 新增全文读取命令、严格解析器与编辑弹窗**
- [x] **Step 2: 接入状态图标、直接下载、安全保存和 Agent 切换竞态保护**
- [x] **Step 3: 同步 i18n / OpenSpec / PRD，完成相关回归、质量门禁与本地验收**

## Verification

- 相关 Vitest：5 个文件、58 个用例通过；包含入口和初始上传态标题“上传人设文件”、初始限制说明及非 UTF-8 恢复提示、成功读取后的编辑态标题“编辑人设文件”、覆盖确认态标题“覆盖当前人设？”及单行说明/“覆盖并注入”按钮、无人设直接注入、初始上传态与编辑态不显示额外说明行、弹窗内选择文件、失败留在上传态、“重新上传文件”文案、结构建议区“人设内容建议”标题、四条中英文对照建议及角色定位/沟通风格/工作原则/行为边界中英文标题识别、编辑框和右下角按钮布局、操作区“注入”文案、抽卡按钮顺序/条件显示、直接注入成功/失败、重抽替换、切 Agent 竞态、处理中锁定和真实 Bash 解码失败时旧 `SOUL.md` 与备份保护。
- 国际站区域定向测试：1 个用例通过，确认不渲染“上传人设文件”。
- `pnpm check`、`pnpm i18n:check`、`git diff --check` 通过。
- Task 21 相关 Vitest：6 个文件、73 个用例通过；包含全文读取协议、严格解析、编辑弹窗、直接下载、安全保存、失败提示、读取锁定、Agent 切换竞态和原上传/抽卡回归。
- Task 21 国际站隔离定向测试：1 个用例通过，确认自定义状态不渲染编辑与下载图标。
- Task 21 本地服务返回 `200`，但浏览器会话未登录且认证服务暂时不可用，未在真实 Agent 上执行远端编辑和下载；对应链路由组件与命令测试覆盖。
- `pnpm build:cn` 生成 118 个静态页面，`pnpm build:global` 生成 378 个静态页面。
- 独立代码复审：Critical 0、Important 0，结论 Ready。
- 本地浏览器成功打开 `/agents/persona/` 且无构建错误；该账号没有已有 Agent，只显示创建 Agent 空态，因此无法在浏览器完成真实上传和远端写入。文件交互、失败重试、覆盖确认与状态恢复由组件/命令测试覆盖，未伪造线上写入结果。
---

# 通道连接弹窗按钮圆角修复 Implementation Plan

**Status:** 实现、验证与用户验收完成，等待提交并创建 MR。

**Goal:** 通道连接方式弹窗的取消、确认按钮复用产品控制台弹窗的 `rounded-lg` 圆角 token，避免因引用 Skills 面板私有变量而退化为直角。

- [x] 补充样式回归测试并确认现有实现失败。
- [x] 最小修复通道弹窗按钮圆角，保持 Skills 面板按钮样式不变。
- [x] 完成定向测试、类型检查与差异检查。

---

# 点石零元下单并支付 Implementation Plan

**Status:** 实现与定向验证完成，用户已授权直接提交并推送新远程分支。

**Goal:** 询价为零元的活动套餐通过独立点石 `do_goods_and_pay` 链路完成下单与发货，不展示绑卡或自动续费。

- [x] 新增 Trade 点石 `do_goods_and_pay` 客户端、业务方法和内部路由。
- [x] 新增 CTL 点石专用 adapter、逻辑方法和用户 API。
- [x] 新增前端 repository 方法并锁定请求路径。
- [x] 以 `real_total_cost === 0` 分流确认交互，并复用 Pass 发货轮询。
- [x] 完成定向测试、类型检查与 i18n 检查；全量前端测试因 Node 2 GB 堆内存耗尽中断。
- [ ] 提交并推送新远程分支。

---

# 国际站自动任务上游 Context Implementation Plan

**Status:** MR !3162 CR 修复与验证完成，等待用户确认提交和推送。

**Goal:** 将已经在国内站上线的自动任务上游 Context 能力同步到国际站，并保持其他既有区域差异不变。

**Architecture:** 复用现有 Hermes `context_from` 探测、关系水合、单上游表单、关系展示和带回滚删除链路；仅移除这些能力上的 `isGlobal` 隔离，不改终止任务、场景任务、通知渠道或技能选择器的区域行为。

### Task 1: 用国际站测试锁定能力对齐

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-automations-panel.global.test.ts`

**Acceptance:**
- 国际站加载自动任务时探测 `context_from` 并水合任务关系。
- 卡片、详情和创建/编辑表单展示英文上游任务信息。
- 选择上游时走结构化创建/编辑；删除被引用任务时走依赖解绑与回滚链路。
- 国际站既有终止任务行为不变。

- [x] 先补国际站失败测试并确认 RED。

### Task 2: 移除上游 Context 的国际站隔离

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`

**Acceptance:**
- 国际站与国内站共用上游任务读写、展示、能力探测和安全删除逻辑。
- 只移除 `context_from` 相关区域判断；保留其他 `isGlobal` 产品差异。

- [x] 完成最小实现并让定向测试 GREEN。

### Task 3: 同步产品范围并完成质量门禁

**Files:**
- Modify: `wiki/prd-docs/2026-08-13-自动任务支持获取上游任务的Context.md`
- Modify: `frontend/openspec/plan.md`

**Acceptance:**
- PRD 将发布范围更新为国内站与国际站，并保留技能选择器的区域差异说明。
- 定向测试、TypeScript 检查、i18n 检查、国际站构建和 `git diff --check` 通过；浏览器冒烟在登录态允许时执行，否则记录阻塞。

- [x] 同步文档、完成验证并展示证据。

**Verification:**
- RED：国际站专属测试先出现 3 个预期失败，分别命中关系水合、详情/安全删除和结构化创建隔离。
- GREEN：相关 4 个测试文件共 226 个用例通过，包含国际站创建、编辑、展示、删除和既有终止任务回归。
- `pnpm check`、`pnpm i18n:check`、`pnpm build:global`、`git diff --check` 通过。
- 已登录浏览器确认当前线上国际站尚未展示 `Upstream task`；本地新版本因 `localhost` 无登录态无法完成同一页面的交互式截图，改由国际站组件集成测试留证。

### Task 4: 补齐印尼语上游任务文案

**Files:**
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Add: `frontend/src/pages/marketing/__tests__/automation-upstream-picker.id-ID.test.tsx`
- Modify: `frontend/openspec/plan.md`

**Acceptance:**
- `id-ID` 下上游任务能力状态、选择器标签与空状态均渲染为非空印尼语。
- 当前创建、展示、校验与安全删除链路涉及的上游/下游关系文案均有非空印尼语翻译。
- 不修改全局 `returnEmptyString`、fallback 或 `i18n:check` 规则，不扩大本 MR 范围。

- [x] 先补印尼语渲染与字典完整性测试并确认 RED。
- [x] 只补本功能实际使用的印尼语 key，让定向测试 GREEN。
- [x] 运行相关回归、类型检查、i18n 检查、国际站构建和 `git diff --check`。

**Verification:**
- 新增测试先确认 RED：31/31 失败；补齐翻译后 31/31 通过。
- 上游 Context 相关 5 个测试文件共 257 个测试通过。
- `pnpm check`、`pnpm i18n:check`、`pnpm build:global` 通过。
- 印尼语空翻译由 208 条降至 178 条，本次实际使用的 30 条文案全部补齐。

---

# 国际站通知空态隐藏后台运行说明 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，用户已确认提交并创建 CR。

**Goal:** 国际站没有任何已配置通知通道时，将空态文案精简为 `No channels configured.`，并隐藏不适用的后台运行说明及其占位高度。

**Architecture:** `AutomationFormModal` 继续使用现有国际站通道清单和配置判定，新增一个与空态共用的“存在可用通知通道”布尔值。该值只控制空态与说明行的互斥渲染，不改变通道加载、选择、提交或测试发送链路。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、react-i18next。

## Global Constraints

- 仅影响国际站自动任务弹窗的通知空态和英文翻译。
- 无通道时保留 `Configure channels`，不展示后台运行说明，也不保留 spacer/占位行。
- 有已配置通道但未选择时，继续展示后台运行说明。
- 国内站、通知通道范围、Hermes 命令、任务提交和后端接口保持不变。
- 不同步 MR !2961 的“展示全部未配置国际站通道”行为。

---

### Task 1: 条件隐藏国际站通知空态说明

**Role:** Developer / Reviewer

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx:2956-2963,3477-3506,3671-3682`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts:1302-1328`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Reference: `frontend/openspec/changes/2026-08-21-hide-empty-notification-hint-design.md`

**Interfaces:**
- Consumes: `GLOBAL_NOTIFICATION_CHANNELS`、`isGlobal`、`enabledChannels`、`channelStatus`、`isHermesNotificationChannelConfigured(...)`。
- Produces: 组件内布尔值 `hasAvailableNotificationChannel: boolean`；不新增导出、公共类型或 API。

- [x] **Step 1 — 写失败回归测试**

  将现有国际站空态测试改为锁定新文案和说明隐藏，并增加“已有通道但未选择”正向用例：

  ```tsx
  it("hides the background-only hint in the global channel empty state", () => {
    if (!isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(),
      channelStatus: "ready",
    });

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("No channels configured.")).toBeTruthy();
    expect(screen.queryByText("No notification channels are configured yet.")).toBeNull();
    expect(screen.queryByText(
      "If none are selected, the agent will only run the task in the background without sending notifications.",
    )).toBeNull();
    expect(screen.getByRole("link", { name: "Configure channels" })).toHaveAttribute("href", "/agents/channels/");
  });

  it("keeps the background-only hint when a global channel is available", () => {
    if (!isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(["telegram"]),
      channelStatus: "ready",
    });

    expect(screen.getByRole("checkbox", { name: "Telegram" })).toBeEnabled();
    expect(screen.getByText(
      "If none are selected, the agent will only run the task in the background without sending notifications.",
    )).toBeTruthy();
  });
  ```

- [x] **Step 2 — 运行测试并确认 RED**

  Run:

  ```bash
  cd frontend
  VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    -t "hides the background-only hint in the global channel empty state|keeps the background-only hint when a global channel is available" \
    --api.host 127.0.0.1
  ```

  Expected: 新空态测试失败，旧实现仍渲染长文案和后台运行说明；正向用例通过。

- [x] **Step 3 — 完成最小实现与英文翻译**

  在现有派生状态附近增加单一判断：

  ```tsx
  const hasAvailableNotificationChannel = !isGlobal || GLOBAL_NOTIFICATION_CHANNELS.some(
    ({ key, comingSoon }) => isHermesNotificationChannelConfigured(enabledChannels, key, comingSoon),
  );
  ```

  用 `!hasAvailableNotificationChannel` 进入现有国际站空态，并仅在该值为 `true` 时渲染 spacer 与后台运行说明/等高占位：

  ```tsx
  {hasAvailableNotificationChannel ? (
    <>
      <div aria-hidden="true" style={{ height: 4 }} />
      {deliverPlatforms.length === 0 ? (
        <p className="text-xs text-black/40" style={MODAL_HELP_TEXT_STYLE}>
          {t("如不选，智能体只会在后台执行任务，不发通知。")}
        </p>
      ) : (
        <p aria-hidden="true" className="text-xs text-black/40" style={MODAL_HELP_TEXT_STYLE}>
          {"\u00A0"}
        </p>
      )}
    </>
  ) : null}
  ```

  将 `k_2efe0742` 的英文翻译更新为：

  ```json
  "k_2efe0742": "No channels configured."
  ```

- [x] **Step 4 — 运行精准双区域回归**

  Run:

  ```bash
  cd frontend
  VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    -t "hides the background-only hint in the global channel empty state|keeps the background-only hint when a global channel is available" \
    --api.host 127.0.0.1
  VITE_REGION=cn pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    -t "keeps unconfigured domestic channels visible and disables their checkboxes" \
    --api.host 127.0.0.1
  ```

  Expected: 国际站 2 个用例、国内站 1 个用例全部通过。

- [x] **Step 5 — 运行质量门禁**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  pnpm build:global
  cd ..
  git diff --check
  git status --short
  ```

  Expected: 类型检查、i18n 检查、国际站构建与 diff 检查通过；最终范围仅包含计划、组件、测试和英文翻译，不包含构建生成物。

  Evidence:

  - RED：国际站精准用例首次运行 `1 failed / 1 passed`，失败点为新短文案尚未渲染。
  - GREEN：国际站 `2 passed`；国内站保护用例 `1 passed`。
  - `pnpm check`：通过，包含繁中一致性、Fumadocs 同步与 TypeScript 检查。
  - `pnpm i18n:check`：通过，英文 `2323/2323`，无缺失；印尼语 `208` 条既有待翻译项。
  - `pnpm build:global`：通过，完成 TypeScript、369 个静态页面生成及 SEO 检查。
  - 浏览器冒烟：本地国际站 `/agents/` 可加载；未登录环境停在 `Please sign in first`，无法进入自动任务弹窗，因此不作为弹窗验收证据。
  - `git diff --check`：通过；构建生成文件已清理。

- [x] **Step 6 — 验收与提交门禁**

  汇总 RED/GREEN、双区域回归、构建和最终 diff；等待用户明确确认后才允许 `git commit`、`git push` 或创建 MR。

---

# 技能包 ACLI 原生批量安装 Implementation Plan

**Status:** MR !3125 CR 修复与验证完成，等待用户确认提交和推送。

**Goal:** 技能包安装优先通过单次 ACLI `batch-install` 执行，减少多次 `/debug/exec` 与进程启动；在旧 ACLI、不完整批量结果、CLI 升级提示或单项失败时保留可靠兜底。

**Architecture:** 复用 Skills 页已有的流式批量结果解析与去重逻辑，为技能包注入带国内 SkillHub 下载模板的批量命令；批量命令不可用时回落到现有逐个安装，批量中的失败项仅逐项重试。组件从现有 repository 向 Experts 面板透传流式执行能力。

**Scope:** 国内站技能包安装链路；不改变单技能安装、国际站 registry、套餐定义、安装状态存储或后端接口。

### Task 1: 以测试锁定批量优先和兜底契约

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-experts-panel.test.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`

**Acceptance:**
- 技能包默认只发起一次带 `SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE` 的 `acli skills batch-install --wait=true`。
- 原生命令不支持时执行现有逐个安装；批量部分失败时只逐个重试失败 slug。
- CLI 升级提示仍只触发一次 `skillhub self-upgrade`，随后重试批量命令。

- [x] 先补失败测试并确认 RED，覆盖批量成功、旧 ACLI 回退、部分失败重试和升级后重试。

### Task 2: 接入原生批量执行并保留恢复策略

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/agent-experts-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-skills-panel.tsx`

**Acceptance:**
- 复用既有批量事件解析，避免 `progress` 与完整 `summary.results` 重复事件导致结果错配。
- 包级进度持续更新；仅全部技能最终成功时记录套餐为已安装。
- 无流式执行能力时兼容现有逐个安装路径。

- [x] 完成最小实现并让定向测试 GREEN。

### Task 3: 验证范围和质量门禁

**Files:**
- Modify: `frontend/openspec/plan.md`
- Add: `frontend/openspec/changes/2026-08-20-skill-package-native-batch-design.md`

**Acceptance:**
- 定向测试、TypeScript 检查、i18n 检查和 `git diff --check` 通过。
- 展示真实改动与验证证据，等待用户确认后才提交、推送或创建 MR。

- [x] 完成验证并输出验收摘要。

### Task 4: 修正 CR 中的进度与诊断问题

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-experts-panel.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-experts-panel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/openspec/changes/2026-08-20-skill-package-native-batch-design.md`

**Acceptance:**
- 批量阶段进入 `3/3` 后，补装早期失败项不会让用户可见进度回退。
- ACLI 批量结果少于请求项时，诊断日志明确记录未覆盖并进入逐项补装的 slug。
- 保留“所有失败结果均提示升级”才重跑 batch 的严格条件，并在设计文档中写清。

- [x] 先补失败测试并确认 RED，再完成最小修复和定向验证。

---

# Cruise placeholder paid gate fix

**Status:** Implemented and verified; approved for commit and push.

**Goal:** Keep the international Cruise placeholder disabled when paid billing is off, while preserving the real CTL-backed Cruise purchase path when paid billing is on.

### Task: Remove the global placeholder release override

**Role:** Developer

**Files:**
- Modify: `frontend/next-site/subscribe-page.tsx`
- Test: `frontend/next-site/__tests__/subscribe-page.global.test.tsx`

**Acceptance:**
- Paid billing off: the frontend Cruise placeholder remains `comingSoon` and cannot enter checkout.
- Paid billing on: backend Cruise bundles remain purchasable through the existing CTL payment flow.
- No backend, bundle mapping, or domestic-site behavior changes.

- [x] Add a failing international-site regression test for the disabled placeholder.
- [x] Remove the Cruise `releasedOnGlobal` override and make the test pass.
- [x] Run targeted tests, type checking, i18n checking, and diff checks.

**Verification:**
- `pnpm exec vitest run next-site/__tests__/subscribe-page.test.tsx next-site/__tests__/subscribe-page.global.test.tsx` (7 tests passed)
- `pnpm check`
- `pnpm i18n:check`
- `git diff --check`

---

# 国际站续费入口 Coming Soon Implementation Plan

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 国际站账号页的续费按钮置灰，不触发续费弹窗；hover/focus 时显示符合 `DESIGN.md` 的自定义 Tooltip，英文为 `Coming Soon`，中文为 `敬请期待`。

**Scope:** 仅调整账号页订阅卡片续费入口和对应定向测试；国内站续费逻辑、续费弹窗、销毁套餐逻辑不变。

### Task 1: 国际站续费入口置灰并增加自定义 Tooltip

**Files:**
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Test: `frontend/src/pages/marketing/__tests__/account-page-renewal.global.test.tsx`

**Acceptance:**
- 国际站有可续费 pass 时仍展示续费入口，但按钮为置灰不可操作状态。
- 国际站续费入口 hover/focus 显示自定义 Tooltip，文案随 i18n 对应为 `Coming Soon` / `敬请期待`，不使用浏览器原生 `title`。
- 点击国际站置灰续费入口不会打开续费弹窗或发起续费请求。
- 国内站现有“立即续费”按钮和弹窗行为保持不变。

- [x] Step 1 — 增加国际站失败回归测试并确认 RED。
- [x] Step 2 — 实现国际站置灰续费按钮与 Tooltip。
- [x] Step 3 — 运行定向测试、类型检查、i18n 检查和 diff 检查。

### Task 2: 补齐印尼语续费文案

**Files:**
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Test: `frontend/src/pages/marketing/__tests__/renewal-id-ID.test.ts`

**Acceptance:**
- 新增续费、到期标签、倒计时和账号页不可续费状态文案在 `id-ID` 下均为非空印尼语。
- 插值文案保留 `{{days}}` / `{{hours}}` / `{{time}}` 占位符，运行时能渲染 `/agents` 到期 aria-label。
- 不修改全局 i18n fallback、`returnEmptyString` 或其他语言资源。

- [x] Step 1 — 增加印尼语字典完整性和运行时插值失败测试并确认 RED。
- [x] Step 2 — 补齐本次续费相关 9 条 `id-ID` 文案并确认 GREEN。
- [x] Step 3 — 运行续费相关回归、类型检查、i18n 检查和 diff 检查。

---

# 首页计费公告下线 Implementation Plan

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 下线首页顶部 public beta / billing 公告条，不再在公共站点 provider 中挂载该公告。

**Scope:** 仅移除全站公告挂载和对应 provider 测试；保留公告文档页面及 SEO/docs 链接，不删除历史公告组件文件。

### Task 1: 移除 PublicSiteAppProviders 中的公告挂载

**Files:**
- Modify: `frontend/next-site/public-site-providers.tsx`
- Modify: `frontend/next-site/__tests__/public-site-providers.test.tsx`

**Acceptance:**
- 首页和公共站点 provider 不再渲染 `MaintenanceAnnouncementBanner`。
- Cookie consent、locale bridge 和业务 children 仍正常挂载。
- 不修改文档公告页、不删除 i18n 资源、不影响订阅页详情链接。

- [x] Step 1 — 增加失败回归测试并确认 RED。
- [x] Step 2 — 移除公告挂载。
- [x] Step 3 — 运行定向测试、类型检查、i18n 检查和 diff 检查。

---

# Agent 导航 CR 修正 Implementation Plan

**Status:** 实现与验证完成，等待用户确认提交和推送。

**Goal:** 修正隐藏高级工具与分组导航的布局结构、测试耦合及分组命名语义。

**Scope:** 仅调整 Agent 左侧导航组件、对应样式和定向测试；不改变四个可见一级分类、菜单顺序、路由或隐藏工具的开启方式。

### Task 1: 统一导航结构与可访问语义

**Role:** Developer

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
- Modify: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

**Acceptance:**
- 隐藏的终端、浏览器入口与普通分组使用同一 items 容器，桌面缩进和窄屏栅格一致。
- 可见分组通过 `aria-labelledby` 引用可见标题；导航项使用列表语义。
- 删除颜色、间距和高度的 CSS 精确字符串断言，改由渲染测试验证结构与归属。

- [x] 先补充渲染失败测试并确认 RED。
- [x] 实现最小组件和样式调整并确认 GREEN。
- [x] 运行定向测试、类型检查、i18n 检查和 diff 检查。

---

# 已安装技能实例展开 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 修复 `/agents/skills` 已安装列表在 SkillHub 返回同名聚合技能时漏展示 `instances[]` 子实例的问题。

**Architecture:** SkillHub installed parser 将 `skills[].instances[]` 展开为独立 `InstalledSkill` 行；实例 `rawId` 保持为命令目标，`slug` 优先使用 `relative_path` 供展示和搜索；已安装列表搜索纳入 `slug` 与 `nativeAliases`。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library。

## Global Constraints

- 仅调整 `/agents/skills` 已安装清单的数据解析、展示标识和搜索匹配。
- 不修改安装、卸载命令格式；SkillHub 实例卸载仍使用实例 `id/rawId` 作为命令目标。
- 不新增 API、依赖、区域分支、视觉结构或 i18n 资源。

---

### Task 1: 展开 SkillHub installed instances 并验证

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Test: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Test: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

**Interfaces:**
- Consumes: `acli skills list` JSON 中的 `skills[].instances[]`、`id`、`name`、`display_name`、`relative_path`、`version`。
- Produces: 每个 instance 对应一条 `InstalledSkill`；`rawId` 用于命令，`slug/nativeAliases` 用于展示、搜索和合并匹配。

- [x] **Step 1 — 增加失败回归测试**
  - 解析器测试覆盖 `humanizer.instances[]`，断言 `unclecheng-reduce-ai-perception-v2` 被展开为独立行。
  - UI 测试覆盖已安装搜索可按 instance `relative_path` 命中，列表展示路径但卸载仍携带实例 `rawId`。

- [x] **Step 2 — 运行测试并确认 RED**
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
  - Expected: FAIL，旧实现只展示 top-level `humanizer` 且搜索不到 `unclecheng-reduce-ai-perception-v2`。

- [x] **Step 3 — 实现最小修复**
  - 展开 SkillHub `instances[]`，保留父级分类/展示名兜底。
  - 让已安装列表展示 `skill.slug`，搜索匹配 `slug/nativeAliases`。

- [x] **Step 4 — 运行定向测试与质量门禁**
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
  - Run: `cd frontend && pnpm check && cd .. && git diff --check`

- [x] **Step 5 — 修复已安装搜索框双清除按钮**
  - 在已安装搜索框有值时保留自定义清除按钮，禁用 Chromium/WebKit 原生 search cancel 和 decoration。
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

- [x] **Step 6 — 统一三个 Tab 搜索框聚焦样式**
  - 技能、技能包、已安装搜索框统一使用 `lv-agent-search-box`、`lv-agent-search-box-icon`、`lv-agent-search-box-input`。
  - 已安装搜索框保留自定义清除按钮和原生 search cancel 禁用，外层固定宽度不受共享 `width: 100%` 影响。
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx --testNamePattern "uses the skill package search field styling|suppresses the native search clear"`

- [ ] **Step 7 — 验收确认**
  - 汇总 diff、验证结果和剩余风险；等待用户确认后再提交、推送或 MR。

---

# 即将到期 Tooltip 视觉修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 增量实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 将 `/agents` 左侧“即将到期”标签的浏览器原生灰色提示框替换为符合 `DESIGN.md` 的自定义 hover/focus Tooltip。

**Architecture:** 在续费提醒按钮外增加无布局副作用的 `group relative inline-flex` 包装层，Tooltip 作为同级绝对定位元素显示在按钮上方。该位置没有裁剪祖先，因此采用 `DESIGN.md` 推荐的内联方案，不引入 Portal 定位状态；按钮点击续费逻辑保持不变。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- 移除续费提醒按钮的原生 `title`，避免系统灰色提示框。
- Tooltip 使用白底深色字、细边框、6px 圆角（Tailwind 默认 `rounded-md` 的视觉值）、`px-3 py-1.5`、`text-[11px] font-medium` 与 `0 8px 24px rgba(15,23,42,0.12)` 轻阴影。
- Tooltip 位于触发器上方居中，带白底小三角，支持 hover、focus、鼠标进入与文本选择。
- 不修改“即将到期”标签本身、剩余时间计算、点击续费逻辑、文案或 i18n 资源。
- 国内站和国际站共用同一实现，不增加区域条件分支。

---

### Task 1: 用自定义 Tooltip 替换原生 title 并验证

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx:4989-5008`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx:180-195`

**Interfaces:**
- Consumes: `passExpiryReminder.tooltip` 现有剩余时间文案与续费提醒按钮。
- Produces: `role="tooltip"` 的可选择自定义浮层；不新增导出或公共接口。

- [x] **Step 1 — 增加失败回归测试**

  更新现有续费提醒用例，断言按钮不再包含 `title`，页面存在对应 `role="tooltip"`，并锁定白底、细边框、6px 圆角、11px 字号、轻阴影、可交互和可选择样式。

- [x] **Step 2 — 运行测试并确认 RED**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: FAIL，旧实现仍有原生 `title` 且没有自定义 Tooltip。

- [x] **Step 3 — 实现最小 Tooltip 调整**

  用 `group relative inline-flex` 包裹提醒按钮，删除 `title`，增加位于上方居中的自定义 Tooltip 与小三角；通过透明 `pb-2` hover 桥接按钮和气泡。

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: 该测试文件全部通过。

- [x] **Step 5 — 运行质量门禁并本地预览**

  Run: `cd frontend && pnpm check && pnpm i18n:check && cd .. && git diff --check`

  Expected: 全部以退出码 `0` 完成；在已登录本地预览中 hover/focus “即将到期”时显示新 Tooltip，点击仍打开续费弹窗。

- [x] **Step 6 — 验收门禁**

  展示改动与验证结果；仅在用户明确确认后提交、推送或创建 MR。

---

### Task 2: 在 Tooltip 内增加续费入口并验证

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx:5007-5024`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx:187-220`

**Interfaces:**
- Consumes: `passExpiryReminder.tooltip` 与现有 `setRenewPassModalOpen(true)`。
- Produces: Tooltip 内原生文字按钮“续费套餐”；不新增状态、组件、导出或公共接口。

- [x] **Step 1 — 增加失败回归测试**

  在现有 Tooltip 用例中查询 Tooltip 内的“续费套餐”按钮，断言其可聚焦，并点击后出现续费弹窗；原提醒标签打开续费弹窗的行为继续由实名认证用例覆盖。

- [x] **Step 2 — 运行测试并确认 RED**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: FAIL，Tooltip 内尚不存在“续费套餐”按钮。

- [x] **Step 3 — 实现最小文字按钮**

  在剩余时间文案后增加原生 `<button type="button">续费套餐</button>`，使用当前提醒橙色、hover 下划线和可见焦点样式；点击时阻止冒泡并复用 `setRenewPassModalOpen(true)`。

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: 该测试文件全部通过。

- [x] **Step 5 — 运行质量门禁并本地交互回验**

  Run: `cd frontend && pnpm check && pnpm i18n:check && cd .. && git diff --check`

  Expected: 全部以退出码 `0` 完成；本地 hover 后点击“续费套餐”能打开续费弹窗，Tooltip 在按钮 hover/focus 时保持可见。

- [x] **Step 6 — 验收门禁**

  展示本地效果与验证结果；仅在用户明确确认后提交、推送或创建 MR。

- [x] **Step 7 — 补充可点击鼠标样式并回验**

  为 Tooltip 内“续费套餐”文字按钮增加 `cursor-pointer`，扩展现有测试断言，并在本地预览确认计算样式为 `cursor: pointer`。

- [x] **Step 8 — 补充提醒标签可点击鼠标样式并回验**

  为外层“即将到期 / 临近到期”按钮增加 `cursor-pointer`，扩展现有测试断言，并在本地预览确认计算样式为 `cursor: pointer`；不改变 hover 颜色、焦点样式或点击逻辑。

- [x] **Step 9 — 更新 Tooltip 续费入口文案**

  将 Tooltip 内入口从“续费套餐”调整为“立即续费”，保留弹窗标题“续费套餐”和现有点击、焦点、cursor 行为；更新定向测试并回验。

---

# 自动任务最近执行空状态去灰底 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，等待用户验收；不自动提交实现、推送或创建 MR。

**Goal:** 去掉 `/agents/automations/` 最近执行空状态行的浅灰色背景与圆角，同时保留外层白色卡片和其余视觉属性。

**Architecture:** 沿用 `RecentCronRunsPanel` 的现有结构，只删除空状态行上的两个 Tailwind class。扩展现有组件测试直接渲染空记录状态，锁定内层背景/圆角移除且外层卡片仍存在，不新增组件、导出或依赖。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- 仅调整空状态行，不修改有记录列表、加载态、错误态、页签、刷新交互或 Hermes Cron 逻辑。
- 删除 `bg-black/[0.02]` 和 `rounded-lg`，保留空状态行的间距、图标、字号和颜色。
- 保留外层白色卡片的边框、阴影和 `rounded-md`。
- 国内站和国际站共用同一组件，不增加区域条件分支。
- 不新增依赖、文案或 i18n 生成文件。

---

### Task 1: 移除最近执行空状态灰底并验证

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx:1109-1115`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts:45-105`
- Design: `frontend/openspec/changes/2026-08-13-frontsandbox-automation-empty-state-transparent-design.md`

**Interfaces:**
- Consumes: `RecentCronRunsPanel` 现有 `runs` 与 `skillLoadState` props。
- Produces: 不新增导出；国内站和国际站继续渲染同一空状态 JSX。

- [x] **Step 1 — 增加失败回归测试**

  在 `recent run limit hint` 测试组中增加空状态用例：

  ```tsx
  it("renders the empty recent-runs message without a nested gray container", () => {
    const { container } = render(createElement(RecentCronRunsPanel, {
      runs: [],
      skillLoadState: { status: "ready", slugs: [], error: null },
    }));
    const message = screen.getByText("暂无执行记录");
    const emptyState = message.closest("div");
    const panel = container.querySelector("section");

    expect(emptyState).not.toBeNull();
    expect(emptyState).toHaveClass("m-4", "px-3", "py-2", "text-xs", "text-black/45");
    expect(emptyState).not.toHaveClass("bg-black/[0.02]", "rounded-lg");
    expect(panel).toHaveClass("rounded-md", "bg-white");
    expect(panel).toHaveStyle({ background: "#ffffff" });
  });
  ```

- [x] **Step 2 — 运行测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts
  ```

  Expected: FAIL，空状态行仍包含 `bg-black/[0.02]` 和 `rounded-lg`。

- [x] **Step 3 — 实现最小样式调整**

  将空状态行改为：

  ```tsx
  <div className="m-4 flex items-center gap-2 px-3 py-2 text-xs text-black/45">
  ```

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts
  ```

  Expected: 该测试文件全部通过，现有最近执行详情测试保持不变。

- [x] **Step 5 — 运行质量门禁**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  cd ..
  git diff --check
  ```

  Expected: TypeScript、i18n 和 diff 检查均以退出码 `0` 完成；不产生生成资源变更。

- [x] **Step 6 — 验收门禁**

  展示 diff 与验证结果；只有用户明确确认后才执行实现提交、推送或创建 MR。

---

# 2026-08-12 首页 Hero 浅色化

**Status:** 前端实现与基础检查已完成，待用户视觉验收后再提交 / MR。

**Goal:** 参考 `lightvela-next.zip` 的浅色首屏方向，重做首页 Hero 视觉层，去掉视频背景，提升整体轻盈感和顶部导航可读性。

**Scope:** 仅调整首页 Hero 区视觉实现；保留现有首页业务链路、CTA 跳转、i18n 文案、Header 组件和后续内容区。

## Tasks

- [x] 移除首页 Hero 的视频背景和对应加载状态。
- [x] 用浅色静态背景与现有装饰素材重组 Hero 首屏。
- [x] 完成 TypeScript / i18n / diff 检查，并用本地预览截图验证桌面与移动端可读性。
- [x] 移除 Hero 外层最大/最小高度限制，确保常见浏览器缩放 25%～125% 下 Hero 仍占满首屏。

---

# 更新日志左侧日期样式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，用户已确认 commit / push / MR。

**Goal:** 参考 Viktor Changelog，将 `/changelog` 左侧月份改成带日历勾选图标的紫色日期标签，同时保持页面其他部分不变。

**Architecture:** 继续使用 `ChangelogMonthGroup` 和现有双列网格，只在月份标签的 JSX 中复用 `lucide-react` 的 `CalendarCheck` 并替换局部样式。通过现有国内站 Changelog 渲染测试锁定图标、尺寸、间距和颜色，不新增组件、数据字段或依赖。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Lucide React、Vitest 4、Testing Library。

## Global Constraints

- 仅修改左侧月份标签及其回归测试，不修改日期数据、正文、配图、右侧时间线、页头、页脚或滚动行为。
- 使用 `#6E47FF` 前景色，不增加背景、边框、圆角或额外水平内边距。
- 标签固定 `48px` 高，图文间距 `16px`，图标 `20px`。
- 不新增依赖、组件、翻译文案或 i18n 生成文件。

---

### Task 1: 更新月份标签并验证

**Files:**
- Modify: `frontend/src/pages/marketing/changelog-page.tsx:8-12,404-421`
- Test: `frontend/src/pages/marketing/__tests__/channel-copy.test.tsx:69-99`
- Design: `frontend/openspec/changes/2026-08-12-frontsandbox-changelog-date-style-design.md`

**Interfaces:**
- Consumes: `ChangelogMonthGroup.month` 现有本地化月份字符串；`lucide-react` 的 `CalendarCheck`。
- Produces: 不新增导出；所有月份分组共用同一日期标签 JSX。

- [x] **Step 1 — 增加失败回归断言**

  在现有 `announces reliable Skill invocation for automations in the July changelog` 用例中，把月份存在性断言扩展为：

  ```tsx
  const monthText = screen.getByText("2026 年 7 月");
  const monthLabel = monthText.closest("p");

  expect(monthLabel).not.toBeNull();
  expect(monthLabel).toHaveClass(
    "inline-flex",
    "h-12",
    "items-center",
    "gap-4",
  );
  expect(monthLabel).not.toHaveClass("rounded-full", "px-6");
  expect(monthLabel).toHaveStyle({ color: "#6E47FF" });
  expect(monthLabel).not.toHaveStyle({
    backgroundColor: "rgba(110, 71, 255, 0.16)",
  });
  expect(monthLabel?.querySelector(".lucide-calendar-check")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  ```

- [x] **Step 2 — 运行测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/channel-copy.test.tsx
  ```

  Expected: FAIL，现有月份 `<p>` 仍带有 `rounded-full px-6` 和淡紫色背景。

- [x] **Step 3 — 实现最小日期标签样式**

  在 `changelog-page.tsx` 导入图标：

  ```tsx
  import { CalendarCheck } from "lucide-react";
  ```

  将左列月份 JSX 替换为：

  ```tsx
  <div className="pt-1">
    <p
      className="inline-flex h-12 items-center gap-4"
      style={{
        color: "#6E47FF",
        fontSize: "16px",
        fontWeight: 400,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
      }}
    >
      <CalendarCheck className="size-5 shrink-0" aria-hidden="true" />
      <span>{group.month}</span>
    </p>
  </div>
  ```

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx
  ```

  Expected: 两个测试文件全部通过，国内站和国际站现有 Changelog 内容断言保持不变。

- [x] **Step 5 — 运行质量门禁**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  cd ..
  git diff --check
  ```

  Expected: TypeScript、i18n 和 diff 检查均以退出码 `0` 完成；不产生 i18n 文件变更。

- [x] **Step 6 — 浏览器验证**

  启动本地前端并检查 `/changelog`：

  ```bash
  cd frontend
  pnpm dev:cn
  ```

  Expected:

  - 桌面端：月份标签位于左列，图标和文字垂直居中，不显示底框。
  - 移动端：月份标签按内容宽度左对齐，标签自身不增加横向溢出。
  - 右侧标题、描述、配图和点线时间轴与修改前一致。

  Verification evidence:

  - 用户标注的 `888 × 933` 视口：标签 `131.14 × 48px`，计算样式为透明背景、`0px` 边框、`0px` 圆角、`0px` 左右内边距。
  - 移动端：日期标签位于单列内容区内；页面既有页头说明文本使用 `white-space: nowrap`，会产生原有横向溢出，本次遵循范围约束未修改。
  - 浏览器控制台无 error。
  - 完整 `pnpm test` 仍有 1 条既有失败：`scripts/docs-image-assets.test.ts` 检出 9 个超出 `512 KiB` 的文档 PNG（被中英文文档重复引用为 18 条）；本分支未修改这些图片、文档或测试。

- [x] **Step 7 — 等待提交确认**

  展示 diff、测试结果和浏览器验证截图；只有用户明确确认后才执行 `git commit`、`git push` 或创建 MR。

---

# 2026-08-11 国际站首页默认英文一致性修复

**Status:** 实现中；确认前不 commit / push / MR。

**Goal:** `lightvela.ai/` 裸首页在浏览器残留中文语言偏好时仍默认全页英文，只有访问中文 locale 路径或用户显式切换中文时展示中文。

**Scope:** 仅收敛公开首页 locale 判定、公告条 locale 注入、首页导入区翻译调用和回归测试；不改视觉布局、路由 SEO 输出、后端接口或订阅/登录逻辑。

## Tasks

- [x] 修复国际站裸 `/` 的 i18n 初始语言，避免被 `localStorage.lw-locale=zh-CN` 覆盖。
- [x] 修复首页公告条与 FeatureSection 对全局 i18n 单例的依赖，统一跟随公开路由 locale。
- [x] 补充回归测试并运行定向测试、i18n 检查、类型检查和 diff 检查。

---

# 国际站 Skills 搜索结果来源链接 Implementation Plan

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 国际站所有 Skills 搜索结果都在技能标题和 slug 下方单独展示文字型 `Source` 链接；ClawHub 统一链接到 `https://clawhub.ai/`。

**Architecture:** `SearchSkillRow` 继续使用 skills.sh 的技能详情链接，但对 ClawHub 直接使用固定官网地址。
链接只由前端渲染，不查询 ClawHub 作者或技能详情，因此不会新增 ClawHub 请求或增加限流风险。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS、Vitest 4、React Testing Library。

## Global Constraints

- 仅影响国际站的 ClawHub 与 skills.sh 搜索结果。
- 国内 SkillHub 搜索结果不展示新来源行。
- 所有 ClawHub 搜索结果都显示来源链接，固定 URL 为 `https://clawhub.ai/`。
- 标签通过现有 i18n `t("来源")` 渲染，样式与 skills.sh 的文字型来源链接一致。
- 不新增依赖、动画或新的交互原语。

## Tasks

- [x] **Task 1: 固定 ClawHub 搜索结果来源链接。**
  - 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`，先断言 ClawHub 搜索结果的 `来源` 链接固定为 `https://clawhub.ai/`。
  - 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`，仅在 global mode 的 `SearchSkillRow` 中为 ClawHub 使用固定官网链接，skills.sh 与国内站逻辑保持不变。
  - 运行 `pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`。

- [x] **Task 2: 运行质量门禁并记录验证。**
  - 运行 `pnpm i18n:check`。
  - 运行 `pnpm check`。
  - 检查 `git diff --check` 与最终 diff，确认未修改国内站分支逻辑。

---
# Agents 左侧导航顺序调整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，用户已确认提交、推送与创建 MR。

**Goal:** 将 `/agents` 左侧导航中的“自动任务”移动到“人设”上方，并保持其余导航行为不变。

**Architecture:** 沿用 `AgentSettingsPage` 内现有 `settingsSections` 数组作为唯一顺序来源，只交换两个相邻配置项。用独立静态回归测试锁定两项顺序，避免为了单一展示顺序抽离新公共接口。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4。

## Global Constraints

- 仅修改导航顺序及其回归测试，不修改路由、图标、文案、权限或页面内容。
- 桌面和移动端继续共用同一导航配置。
- 不新增依赖或配置抽象。

## Tasks

- [x] **Task 1 — Developer / Reviewer：交换导航项并验证**
  - **Files:**
    - Create: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
    - Modify: `frontend/src/pages/marketing/agent-settings-page.tsx:4909-4915`
  - **Interfaces:** 不新增导出；测试只读取页面源码中的 `settingsSections` 配置片段。
  - **Step 1 — 写失败测试：** 新测试读取 `agent-settings-page.tsx`，截取 `const settingsSections` 到 `const isRestartDisabled` 之间的文本，并断言 `id: "automations"` 的索引小于 `id: "buddy"`：

    ```ts
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    import { describe, expect, it } from "vitest";

    describe("Agent settings navigation order", () => {
      it("places automations before persona", () => {
        const page = readFileSync(
          join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
          "utf8",
        );
        const settingsSectionsStart = page.indexOf("const settingsSections");
        const settingsSectionsEnd = page.indexOf("const isRestartDisabled");

        expect(settingsSectionsStart).toBeGreaterThanOrEqual(0);
        expect(settingsSectionsEnd).toBeGreaterThan(settingsSectionsStart);

        const settingsSections = page.slice(settingsSectionsStart, settingsSectionsEnd);
        const automationsIndex = settingsSections.indexOf('id: "automations"');
        const personaIndex = settingsSections.indexOf('id: "buddy"');

        expect(automationsIndex).toBeGreaterThanOrEqual(0);
        expect(personaIndex).toBeGreaterThanOrEqual(0);
        expect(automationsIndex).toBeLessThan(personaIndex);
      });
    });
    ```
  - **Step 2 — 确认 RED：** 在 `frontend/` 运行 `pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`；预期当前顺序下断言失败。
  - **Step 3 — 最小实现：** 在 `settingsSections` 中把完整的 `automations` 配置项移动到完整的 `buddy` 配置项之前，不改动两项内容：

    ```tsx
    { id: "automations", label: t("自动任务"), icon: <CalendarClock className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.automations },
    { id: "buddy" as const, label: t("人设"), icon: <UserRound className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.buddy },
    ```
  - **Step 4 — 确认 GREEN：** 重新运行同一定向 Vitest，预期 1 个测试通过。
  - **Step 5 — 完整验证：** 在 `frontend/` 运行 `pnpm check`，再在仓库根运行 `git diff --check`；检查 diff 仅包含计划、测试和两项顺序调整。
  - **Step 6 — 验收门禁：** 展示改动与验证结果，等待用户确认后才允许提交实现、推送或创建 MR。

---

# 2026-08-07 批量安装汇总结果对齐修复

**Status:** 实现与验证完成；等待用户确认后再 commit / push / MR。

**Goal:** ACLI 同时返回逐项 `progress` 和完整 `summary.results` 时，避免重复汇总结果错配到下一个未完成技能，确保部分失败状态准确展示。

**Scope:** 仅修正 Skills 批量安装结果匹配逻辑并补回归测试；不改变 ACLI 命令、SSE 协议、取消粒度或页面交互。

## Tasks

- [x] 增加“progress 后返回完整 summary.results”的失败回归测试并确认 RED。
- [x] 修正已完成结果的去重与无标识结果的顺序降级逻辑。
- [x] 运行 Skills 定向测试、类型检查、i18n 检查和 diff 检查。

---

# 2026-08-09 EdgeOne Pages 裸根路径 404 修复

**Status:** 实现与 Preview 验证完成，用户已确认提交、推送并创建 MR。

**Goal:** 让 EdgeOne Pages 的裸根路径 `/` 直接由 Build Output 的 filesystem 路由提供静态首页，避免显式重写 `/index.html` 触发 Pages 路由缓存分裂和概率性平台 404。

**Scope:** 仅调整 EdgeOne Build Output 路由生成及其回归测试；不修改页面运行时代码、外层加速域名配置或生产发布配置。

## Tasks

- [x] 先补充失败测试，禁止生成 `^/$ -> /index.html` 显式根路由。
- [x] 删除显式根路由，保留 filesystem 与普通目录 HTML fallback 的顺序。
- [x] 运行定向测试、frontend 检查并验证生成配置。
- [x] 发布 Preview，连续验证不带查询参数的裸 `/`。
- [x] 用户确认后提交、推送并创建 MR。

## Verification

- `pnpm exec vitest run scripts/fix-next-static-html-lang.test.ts`
- `pnpm check`
- `git diff --check`

---

# 2026-08-07 国际站 Skills 来源说明对齐国内站

**Status:** 实现与验证完成，等待用户手动验收；不自动 commit / push / MR。

**Goal:** 将国际站搜索来源说明从搜索栏移到搜索结果底部，复用国内站“查看更多居中、来源说明靠右”的蓝色布局，并恢复搜索框宽度及来源筛选器右对齐。

**Scope:** 仅调整国际站 Skills 搜索区域布局和对应组件测试；保留 Skills.sh、ClawHub 链接、搜索过滤与展开逻辑，不改变国内站行为。

## Tasks

- [x] **Developer / Test:** 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`，断言国际站搜索栏不再包含来源说明、结果底栏展示蓝色 Skills.sh 与 ClawHub 链接，并确认测试按预期失败。
- [x] **Developer / UI:** 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`，复用国内站三列结果底栏，删除搜索栏旧说明；验收时搜索框占满剩余宽度、来源筛选器靠右。
- [x] **Reviewer / Verification:** 运行 Skills 定向测试、`pnpm i18n:check`、`pnpm check` 和 `git diff --check`，确认国内站布局断言保持通过且无新增依赖或生成资源。

---

# 2026-08-07 国际站合并技能卸载降级

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 删除同时标记为 ClawHub 与 skills.sh 的单个运行时技能时，不重复执行两个卸载命令导致 `SKILLS_SH_NOT_INSTALLED`。

**Scope:** 合并行的来源标识作为候选卸载命令；任一候选成功后停止，明确未安装时尝试下一候选，其他错误继续正常失败。

## Tasks

- [x] 增加“首个来源成功即停止”和“首个来源未安装则降级”的失败回归测试。
- [x] 调整国际站卸载候选执行与错误处理逻辑。
- [x] 运行 Skills 定向测试、i18n、类型检查和 diff 检查。

---

# 2026-08-07 国际站已安装技能跨来源去重

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 国际站同一 Hermes 运行时技能同时出现在 ClawHub 与 skills.sh 已安装清单时，仅展示一行，并同时展示两个来源标签。

**Scope:** 仅调整国际站已安装技能归并逻辑与回归测试；保留各 registry 的真实卸载目标，不按短 slug 盲目合并无 Hermes 证据的记录。

## Tasks

- [x] 增加跨来源重复安装记录的回归测试，并确认当前实现失败。
- [x] 以 Hermes 运行时记录为归并证据，合并 ClawHub 与 skills.sh 展示记录并保留双来源卸载目标。
- [x] 运行定向测试、类型检查和 diff 检查。

---

# 2026-08-06 前端预览图片体积优化

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 将分支预览压缩包从约 60 MiB 降到 45-50 MiB，避免接近 StaticPages 上传链路的疑似 64 MiB 边界。

**Scope:** 仅优化文档中超过 512 KiB 的 PNG/JPEG 源图及其 Markdown 引用，并增加资源体积回归测试；不调整页面布局、搜索、视频或生产发布逻辑。

## Tasks

- [x] 增加文档大图格式与体积回归测试，并确认现有资源会触发失败。
- [x] 将超预算文档图片转换为 WebP，更新中英文 Markdown 引用和公开资源副本。
- [x] 运行定向测试、类型检查和 global 预览构建，核验压缩包体积为 43.50 MiB。

---

# 2026-08-04 QQ Bot 群聊策略自动开启

**Status:** 实现与验证完成，待用户验收；确认前不 commit / push / MR。

**Goal:** 在 LightVela 通道配置 SDK 的 QQ 卡片中，用户通过扫码或 AppID / Secret 绑定 QQ Bot 时，自动在同一次 debug/exec 命令里先执行 `hermes config set platforms.qqbot.extra.group_policy open`，再执行 SDK 原始 QQ 绑定命令，避免额外触发第二次 gateway restart。

**Scope:** 仅修改前端 SDK debug/exec 适配链路、QQ group policy helper、相关单测和 QQ 通道文档；不修改 SDK 包版本、不修改后端接口、不提交远端代码。

## Tasks

- [x] 新增 QQ group policy 命令识别与包装 helper，覆盖 AppID / Secret 与扫码两条 QQ 绑定命令。
- [x] 扩展 debug/exec lifecycle 支持 `transformCommand`，并提供 lifecycle 组合 helper，保证模型切换自动任务同步不被覆盖。
- [x] 在 `/agents` 设置页接入 QQ lifecycle，使 SDK QQ 配置卡片下发命令前完成 group_policy 注入。
- [x] 更新 QQ 通道中英文文档，说明绑定后默认开启群聊 @ 对话及 `open` 权限边界。
- [x] 运行相关 Vitest、类型检查和 diff 检查，停在用户验收确认点。

## Verification

- `pnpm exec vitest run src/pages/marketing/__tests__/agent-qqbot-group-policy.test.ts src/pages/marketing/__tests__/agent-debug-exec-lifecycle.test.ts src/pages/marketing/__tests__/agent-tat-adapter.test.ts src/pages/marketing/__tests__/agent-settings-sdk-boundary.test.ts`
- `pnpm check`
- `git diff --check`

---

# 2026-07-31 Hermes 版本升级公告

**Status:** 前端实现完成，待用户验收后再提交 / MR；关联 Vitest 受当前 jsdom 依赖链阻塞。

**Goal:** 基于最新 `master` 在首页公告条挂今晚 Hermes 版本升级提醒，国内站与国际站均展示对应时区文案。

**Scope:** 仅更新首页公告条、对应中英文 i18n 字典和本计划；不调整公告视觉结构、路由、登录态、后端接口或其他公告轮播逻辑。

## Tasks

- [x] 将 Hermes 升级公告切换到 2026-07-31 22:00 至 2026-08-01 02:00。
  - 国内站文案使用北京时间。
  - 国际站文案使用新加坡时间。
  - 公告 ID 更新，避免复用上一次关闭记忆。
  - 过期时间为 UTC 2026-07-31 18:00。
- [x] 更新 i18n 生成字典并补齐英文翻译。
- [x] 完成基础验证：`pnpm i18n:check`、`pnpm check`、global 环境 `pnpm check`、`git diff --check`、公告静态 smoke。
- [ ] 关联 Vitest 复跑：当前 `vitest related src/components/site/maintenance-announcement-banner.tsx` 被 `jsdom@28.1.0 -> html-encoding-sniffer@6.0.0 -> @exodus/bytes` 的 `ERR_REQUIRE_ESM` 阻塞，未进入业务断言。

---

# 国内站登录弹窗交互优化 Implementation Plan

**Status:** 前端实现已完成，待用户验收后再提交 / MR / 归档。

**Goal:** 国内站登录弹窗默认微信登录，手机号与 QQ 作为底部其他登录方式；手机号登录成为正式入口；不引入后端改动。

## Constraints

- 仅国内站生效，国际站登录方式保持不变。
- 不新增后端接口。
- 不修改 `user/auth`。
- 不修改 `service-gateway`。
- 微信和 QQ 均复用现有 OAuth start URL 跳转；不调用不存在的 `modal-config` 接口。
- 手机号登录复用现有 `PhoneLoginForm`。

## Current Implementation

### 国内站弹窗

- `LoginModal` 维护 `DomesticLoginMethod = "wechat" | "phone" | "qq"`。
- 弹窗打开时默认重置为微信登录。
- 当前选中的登录方式展示在主体区域；另外两种登录方式展示在底部“其他登录方式”。
- 国际站仍走原有 Google / GitHub 登录逻辑，不进入国内站三方式状态机。

### 微信 / QQ

- 微信主体展示“微信账号登录”按钮，QQ 主体展示“QQ账号登录”按钮。
- 两者均复用 `repositories.auth.getOAuthStartUrl(...)` 和 `redirectToOAuthStart(...)`。
- 微信按 user agent 选择现有 OAuth target：
  - 桌面浏览器：`website`
  - 微信内浏览器：`official_account`
  - 普通移动浏览器：提示“请在微信中打开当前页面后继续登录。”
- 不嵌入二维码、不加载微信 JS、不新增后端配置接口；如果后端不支持扫码弹窗，按 QQ 的按钮跳转方式回退。

### 手机登录

- 手机主体复用 `PhoneLoginForm` 的 `variant="modal"`。
- 手机登录标题保留为“手机登录”，副标题“使用手机号和短信验证码登录”已删除。
- 表单可访问 label 保留，但视觉上使用 `sr-only` 隐藏，不再显示“手机号 / 短信验证码”字段标题。
- 输入框文字使用普通字重；输入框、验证码按钮使用 `rounded-md` 和轻边框，聚焦态保持浅色 1px ring。
- 未输入手机号或验证码时，登录按钮禁用。
- 手机号 / 验证码校验错误分别显示在对应输入框下方，并同步将对应输入框边框置为红色。
- 手机登录的协议勾选放在登录按钮上方；微信 / QQ 的协议勾选位于主体按钮下方、“其他登录方式”上方。

### 其他登录方式

- 底部按钮为 logo + 文案，无按钮框线。
- 微信、QQ、手机 icon 使用固定 icon slot，统一视觉大小；两个其他登录方式之间使用竖线分隔。
- 国内站内容容器底部保留 `pb-6`，避免底部登录选项贴近弹窗下边框。

## Tasks

- [x] 更新登录弹窗国内站状态机：`wechat | phone | qq`。
- [x] 默认方式设置为微信，弹窗打开时重置到微信。
- [x] 微信主体改为 OAuth 跳转按钮，保留微信 logo。
- [x] 手机主体展示手机号验证码登录表单。
- [x] QQ 主体展示 OAuth 跳转按钮，保留 QQ logo。
- [x] 协议勾选移动到“其他登录方式”上方。
- [x] 底部其他方式按钮改为无边框、logo + 文案、竖线分隔。
- [x] 回退微信扫码 / 快捷登录嵌入方案，不新增 `modal-config` 后端接口。
- [x] 统一底部微信 / QQ / 手机 icon 视觉尺寸。
- [x] 手机登录删除副标题和视觉字段标题，改为轻量表单结构。
- [x] 手机登录协议勾选移动到登录按钮上方。
- [x] 手机登录输入框样式按 `DESIGN.md` 调整为轻边框、`rounded-md`、普通字重、浅聚焦态。
- [x] 手机登录错误提示改为字段下方红字，并同步红色边框。
- [x] 手机登录未填手机号或验证码时禁用登录按钮。
- [x] 增加弹窗底部空间，避免其他登录方式贴近下边框。
- [x] 更新国内站登录弹窗单测。
- [x] 更新手机号登录表单单测。
- [x] 更新 i18n 文案。
- [x] 修复 review 发现的动态创建失败文案 i18n 字典回退问题。
- [x] 补充微信移动端 fallback 与手机登录协议 gate 的 LoginModal 回归测试。
- [x] 更新认证模块长期规格，区分 `/auth/sign-in` 手机主路径和共享登录弹窗微信默认状态机。
- [ ] 用户验收后再进入提交 / MR / 归档流程。

## Verification

- `pnpm --dir frontend exec vitest run src/components/site/__tests__/login-modal.test.tsx src/components/site/__tests__/login-modal.global.test.tsx src/components/auth/__tests__/phone-login-form.test.tsx src/pages/marketing/__tests__/agent-create-error.test.ts`
- `pnpm --dir frontend i18n:check`
- `pnpm --dir frontend check`
# 2026-08-06 Frontend release Docker monorepo context fix

**Status:** 实现与验证完成，等待用户确认提交。

**Goal:** 修复 frontend 正式镜像构建无法解析仓库内 `file:../velalink` 依赖的问题，同时保持 Docker build context 最小化。

**Scope:** 仅调整 frontend release bundle、Dockerfile、Dockerfile 专属 ignore 和构建契约测试；不修改 frontend 或 velalink 运行时代码。

## Tasks

- [x] 将 frontend release bundle 的 build context 切换为仓库根，并把 `velalink` 纳入变更触发范围。
- [x] 更新 Dockerfile 的根目录相对 COPY 路径，显式复制 `/velalink`。
- [x] 用 Dockerfile 专属 ignore 仅放行 `frontend/` 与 `velalink/`。
- [x] 运行契约测试、diff 检查和真实 Tokyo `linux/amd64` 构建推送验证。

## Verification

- `python3 .ci/runtime/tests/contract_tests/test_build_release_image.py`
- `python3 .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py ReleaseBundleContractTests.test_frontend_playground_release_uses_beijing_registry`
- 国内构建机真实执行 `build_release_image.py --service frontend --env sandbox-jp-1 --platform linux/amd64 --push --reuse-existing`
- JP TCR manifest：`frontend-6cf545e930d2`，`linux/amd64`
- `git diff --check`

---

# 模型配置页 CR 问题修复 Implementation Plan

**Status:** Task 11 MR 范围收敛与验证完成，等待用户验收；不自动提交或推送。

**Goal:** 修复 MR !3181 评审指出的静态模型不可添加、备用模型凭据丢失、连通性检测假阳性、Tooltip 被裁剪、印尼语文案为空和模型列表探测被表述为真实连接的问题。

**Architecture:** 保持现有页面、Hermes debug/exec 通道和 Provider 产品配置边界不变。Hermes helper 在实例内原位修改 fallback 原始条目；前端只消费不含凭据的快照。模型列表优先采用实时探测，实时结果为空时仅以产品静态目录补充可选项；Tooltip 复用现有 Portal/fixed 浮层模式。

**Scope:** 仅修改 `agent-model-config` 模块、该页面四语言资源、对应定向测试和本计划；不改 SDK、Provider 产品配置、后端接口、Hermes 命令行为或页面整体结构。

### Task 1: 保留备用模型原始凭据字段

- [x] 在 `model-config-client.test.ts` 先增加失败测试，覆盖追加、取消和 legacy 迁移时已有 fallback 的 `api_key`、`key_env`、`api_key_env` 与未知扩展字段保持不变。
- [x] 修改 `hermes-model-config-command.ts`，让 fallback 增删直接基于实例内原始配置条目，只把脱敏后的模型视图返回前端。
- [x] 运行客户端定向测试确认 GREEN，且命令、输出与前端响应不包含明文 Key。

### Task 2: 连通性检测校验选中模型

- [x] 在 `model-config-client.test.ts` 先增加失败测试，覆盖 Provider 返回其他模型但不含当前 `model_id` 时检测失败。
- [x] 修改 Hermes helper，仅在探测结果包含选中模型 ID 时返回成功；空结果和不匹配结果返回就近错误。
- [x] 运行客户端定向测试确认 GREEN，并保留现有加密凭据传输断言。

### Task 3: 静态模型目录作为获取结果兜底

- [x] 先增加失败测试，覆盖 MiniMax 类 Provider 实时探测为空或 Hermes 返回 `models: None` 时，使用 `catalogModels` 填充下拉并允许添加。
- [x] 将面板模型选项统一为带 `id`、`name`、`source` 的结构；实时结果优先，只有实时结果为空且非自定义 Provider 时使用静态目录。
- [x] 覆盖无实时结果且无静态目录时仍不可添加、自定义 Provider 不使用静态兜底，并运行面板定向测试确认 GREEN。

### Task 4: 操作 Tooltip 脱离裁剪容器

- [x] 在 `model-config-panel.test.tsx` 先增加失败测试，断言 Tooltip 渲染到 `document.body`，支持 hover/focus、鼠标进入气泡和文本选择。
- [x] 将 `ModelActionTooltip` 改为 `createPortal` + `fixed` 定位，复用项目现有浮层定位模式；监听 resize 和 capture scroll 更新位置，保留短暂关闭缓冲。
- [x] 运行面板定向测试确认 GREEN，并检查按钮可访问名称、焦点状态和禁用原因提示不回退到原生 `title`。

### Task 5: 独立 CR 补充边界

- [x] 将模型 route 身份对齐 Hermes `(provider, model, normalized_base_url)`，同 Provider/模型的不同 endpoint 可独立删除且保留各自凭据。
- [x] 复用 Hermes fallback 链并按三元组去重，legacy 重复 route 不再写入 `fallback_providers`。
- [x] 将连通性请求绑定 Provider 指纹与 revision，Provider 变化后忽略延迟响应。
- [x] 解除两个 Dialog 的手工 description ID 覆盖，交由 Radix 自动关联并消除可访问性警告。

### Task 6: 修复 FE-AI 复审问题

- [x] 保留 Hermes `models: None` 的探测失败语义，仅在探测成功但模型列表为空时使用静态目录。
- [x] 拆分原始 route 身份与 Hermes runtime deployment 判定，精确增删 fallback 并拒绝无效主备组合。
- [x] 删除模型前检查 Provider、模型与 key env 的剩余引用，避免破坏兄弟 endpoint。
- [x] 将新增凭据失败回滚收窄为本次 `.env` 写入，不清理操作前已有的凭据池或镜像状态。
- [x] 补齐失败测试、真实 Hermes smoke、类型、i18n 与 diff 门禁后重新执行 FE-AI review。

### Task 7: 修复最新评审的本地化与探测语义问题

- [x] 先补模型配置页印尼语完整性测试，以及模型可用性检测成功文案测试并确认 RED。
- [x] 补齐本页面新增的 35 条印尼语翻译，并将连接成功/失败文案收紧为模型列表可用性语义。
- [x] 运行模型配置定向测试、类型检查、i18n 检查和 diff 门禁后重新执行 FE-AI review。

### Task 8: 修复类型门禁与模型身份契约

- [x] 建立真实执行 `tsconfig.app.json` 的无新增错误门禁，并接入 frontend `check` 命令，避免 solution-style `tsconfig.json` 导致类型检查空跑。
- [x] 统一模型身份输入类型、先收窄 `probeSucceeded` 再写入快照，并清零模型配置模块源代码与测试代码的类型错误。
- [x] 删除 `regionId === 5` 的失效地域推导，改为只透传明确的 region/Zone，并完成定向测试、类型基线、i18n 与 diff 验证。

### Task 9: 修复 MiniMax 静态发现与模型检测

- [x] 为 Provider 适配结果增加显式 `live | catalog` 模型发现策略，MiniMax 使用产品静态目录，其他预设和自定义 Provider 保持实时发现。
- [x] 将模型发现与模型可用性检测解耦；MiniMax 仅在用户主动点击“模型检测”时发送最小模型请求，验证当前 Key、endpoint 与所选模型。
- [x] 补齐 `models: None`、无效凭据、模型请求成功、其他 Provider 探测失败不回退目录等回归测试，并完成模型配置、类型、i18n 与 diff 门禁。

### Task 10: 修复 frontend 质量脚本递归调用 pnpm

- [x] 使用 CI Runtime 契约测试复现 `check` 与 `check:next` 递归调用 `pnpm typecheck` 的失败。
- [x] 保留独立 `typecheck` 命令，将两个质量脚本改为直接执行 `typecheck-baseline.mjs`。
- [x] 运行 CI Runtime 定向契约、frontend 质量检查、模型配置测试与 diff 门禁。

### Task 11: 撤销模型配置 MR 的 CI 工作流改动

- [x] 删除 `.ci/frontend.yml` 与 `.ci/frontend-preview.yml` 中本分支新增的 frontend 质量门禁步骤。
- [x] 以 MR merge-base 为基准确认 `.ci/**` 变更归零，保留模型配置业务实现与本地质量命令。
- [x] 重新运行模型配置测试、frontend 质量检查与 diff 门禁。

## Verification

- `pnpm exec vitest run src/pages/marketing/agent-model-config/__tests__/model-config-client.test.ts src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx src/pages/marketing/agent-model-config/__tests__/use-model-config.test.tsx`
- `pnpm check`
- `pnpm i18n:check`
- `git diff --check`

**Task 6 verification:** 7 个回归断言先按预期失败；模型配置相关 52 个测试通过、1 个环境测试跳过，真实 Hermes 源码 smoke 1/1 通过；`pnpm check`、`pnpm i18n:check`、`git diff --check` 通过。本地新进程 `http://127.0.0.1:5175/agents/models/` 返回 200。全仓测试另有 4 个未改动模块失败，随后一个 worker 持续满 CPU 无输出而终止，未作为本轮通过依据。

**Task 7 verification:** 新增本地化资源与检测语义断言先出现 38 个预期失败；实现后模型配置模块 90 个测试通过、1 个真实 Hermes 环境测试跳过。`pnpm check`、`pnpm i18n:check`、`git diff --check` 通过；英文待翻译为 0，印尼语待翻译由 213 条降至 178 条。本轮仅调整模型列表可用性文案与四语言资源，不改 Hermes 探测行为。

**Task 8 verification:** 地域适配 2 个回归断言先按预期失败；实现后 `pnpm test:model-config` 运行 7 个文件、94 个测试全部通过。真实类型门禁对空的根 `tsconfig.json` 和临时注入的 2 条诊断均按预期失败，最终 `pnpm check` 报告 276 条历史基线、0 条新增诊断。独立 CR 指出的 3 个 P1 与 2 个可立即处理的 P2 已修复；Task 11 已按 MR 范围要求撤销正式与预览流水线改动。实例 API 尚不提供 Zone，当前只移除失效推导并保留显式透传契约。

**Task 9 verification:** Provider 策略、MiniMax 静态目录、Anthropic/OpenAI 最小模型请求、凭据拒绝和安全 HTTP transport 共 6 个关键断言先按预期失败；实现后 `pnpm test:model-config` 运行 7 个文件、98 个测试全部通过，真实 Hermes 源码 smoke 1/1 通过。`pnpm check` 报告 276 条历史基线、0 条新增诊断；`pnpm i18n:check`、`git diff --check` 通过；本地 `/agents/models/` 编译并返回 200。

**Task 10 verification:** CI Runtime 定向契约在修改前稳定失败，改为直接执行 `node scripts/typecheck-baseline.mjs` 后通过；完整 `.ci/runtime/check_ci_runtime.sh` 运行 454 个测试全部通过。`pnpm check` 报告 275 条当前诊断、276 条历史基线、0 条新增诊断，`pnpm test:model-config` 运行 7 个文件、98 个测试全部通过。

**Task 11 verification:** 以当前 MR merge-base `7a9e26c73230` 比较后 `.ci/**` 变更文件数为 0。`pnpm check` 报告 275 条当前诊断、276 条历史基线、0 条新增诊断；`pnpm test:model-config` 运行 7 个文件、98 个测试全部通过，`git diff --check` 通过。

---
# My creations show() reveal Implementation Plan

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 国际站“我的作品”和账号页支付方式入口默认隐藏，仅在当前页面调用 `show()` 后展示，同时保持直接 URL 与订阅支付可用。

**Scope:** 仅调整头像菜单、Agent 导航、账号页支付方式区块及定向测试；不修改 `/agents/websites/` 路由、订阅下单、API 或后端。

### Task 1: 使用现有 show() 彩蛋控制“我的作品”入口

**Role:** Developer

**Files:**
- Modify: `frontend/src/components/site/user-avatar-menu.tsx`
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Test: `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`

**Acceptance:**
- 头像菜单和 Agent “使用”分组默认不显示“我的作品”。
- 调用 `window.show()` 后，两处入口按其所在组件生命周期展示。
- 直接访问 `/agents/websites/` 仍可渲染作品面板。
- 不修改网站 API、路由和后端能力。

- [x] 先补充失败测试并确认 RED。
- [x] 复用现有 `show()` 链式回调实现最小展示开关并确认 GREEN。
- [x] 运行定向测试、类型检查、i18n 检查和 diff 检查。

**Verification:**
- `pnpm exec vitest run src/components/site/__tests__/user-avatar-menu.test.tsx src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`（12 tests passed）
- `pnpm i18n:check`
- `pnpm check`
- `git diff --check`

### Task 2: 使用 show() 控制账号页支付方式区块

**Role:** Developer

**Files:**
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Test: `frontend/src/pages/marketing/__tests__/account-page-payment-visibility.test.ts`

**Acceptance:**
- 国际站账号页默认不挂载“支付方式”区块。
- 在账号页调用 `window.show()` 后挂载“支付方式”区块。
- `show()` 继续调用页面上原有的同名 helper。
- 订阅页下单与信用卡支付流程不变。

- [x] 先补充失败测试并确认 RED。
- [x] 实现账号页局部展示状态并确认 GREEN。
- [x] 运行支付方式相关测试、类型检查、i18n 检查和 diff 检查。

**Verification:**
- `pnpm exec vitest run src/pages/marketing/__tests__/account-page-payment-visibility.test.ts src/pages/marketing/__tests__/saved-cards-section.test.tsx src/components/site/__tests__/user-avatar-menu.test.tsx src/pages/marketing/__tests__/agent-settings-nav-order.test.ts src/pages/marketing/__tests__/agent-console-helpers.test.ts`（34 tests passed）
- `pnpm i18n:check`
- `pnpm check`
- `git diff --check`

---
# 国内站自动任务仅展示已配置通知通道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 国内站自动任务弹窗只展示已配置的微信、QQ、企业微信、飞书和钉钉通道，并在无配置时展示新的国内空态入口。

**Architecture:** 在自动任务模块内维护独立的国内候选通道常量，与国际站候选常量按区域选择后，共用配置状态过滤、空态和辅助说明判断。钉钉继续复用现有通用保存与测试发送链路，只补候选入口和中文展示名称。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、react-i18next。

## Global Constraints

- 国内候选范围及顺序固定为微信、QQ、企业微信、飞书、钉钉；不加入 Telegram、WhatsApp、Discord、Slack 或元宝。
- 国内站只展示 Hermes 已配置通道，未配置项不渲染。
- 国内站无配置时展示 `暂无已配置的通知通道。` 与 `前往通道配置`，链接仍为 `/agents/channels/`。
- 无配置时隐藏后台运行说明及占位高度；有通道但未选择时继续展示说明。
- 国际站通道范围、英文 `Configure channels`、空态和发送行为保持不变。
- 不修改 Hermes 状态解析、连接流程、发送命令、任务保存协议或后端接口。

---

### Task 1: 对齐国内站通知通道过滤并接入钉钉

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx:2009-2019,2495-2504,2946-2952,3464-3495`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts:1302-1345,1649-1659`
- Modify (generated): `frontend/src/i18n/generated/zh-to-key.json`
- Modify (generated): `frontend/src/i18n/generated/zh-CN.json`
- Modify (generated): `frontend/src/i18n/generated/zh-Hant.json`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Reference: `frontend/openspec/changes/2026-08-21-domestic-automation-configured-channels-design.md`

**Interfaces:**
- Consumes: `isGlobal`、`enabledChannels`、`channelStatus`、`isHermesNotificationChannelConfigured(...)`、`t(...)`。
- Produces: module-local `DOMESTIC_NOTIFICATION_CHANNELS` and component-local `availableNotificationChannels`; no new exports, APIs, command formats, or persisted fields.

- [x] **Step 1: 写国内空态、已配置钉钉和详情名称的失败测试**

  将区域感知测试更新为新契约：

  ```tsx
  it("shows the domestic empty state when no notification channel is configured", () => {
    if (isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(),
      channelStatus: "ready",
    });

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("暂无已配置的通知通道。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "前往通道配置" })).toHaveAttribute("href", "/agents/channels/");
    expect(screen.queryByText("如不选，智能体只会在后台执行任务，不发通知。")).toBeNull();
  });

  it("shows only configured domestic channels including DingTalk", () => {
    if (isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(["dingtalk", "feishu"]),
      channelStatus: "ready",
    });

    expect(screen.getByRole("checkbox", { name: "钉钉" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "飞书" })).toBeEnabled();
    expect(screen.queryByRole("checkbox", { name: "微信" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "QQ" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "企业微信" })).toBeNull();
    expect(screen.getByText("如不选，智能体只会在后台执行任务，不发通知。")).toBeTruthy();
  });
  ```

  同步更新文件后部的同名国内站保护测试，使其断言空态并加 `if (isGlobal) return;`，避免它继续守护旧的“未配置项置灰”契约。

  增加钉钉任务详情回归：

  ```tsx
  it("localizes DingTalk in task details", async () => {
    const job = makeCronJob({ id: "dingtalk-job", name: "钉钉通知任务", deliver: "dingtalk" });
    cronClientMocks.listCronJobs.mockResolvedValue([job]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("钉钉通知任务")).getByRole("button", { name: "查看" }));
    const dialog = screen.getByRole("dialog");
    const notificationRow = within(dialog).getByText("通知方式").closest("div");
    expect(notificationRow).not.toBeNull();
    expect(within(notificationRow!).getByText("钉钉")).toBeTruthy();
    expect(within(notificationRow!).queryByText("dingtalk")).toBeNull();
  });
  ```

- [x] **Step 2: 运行精准用例并确认 RED**

  Run:

  ```bash
  cd frontend
  VITE_REGION=cn pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    -t "shows the domestic empty state|shows only configured domestic channels including DingTalk|localizes DingTalk in task details" \
    --api.host 127.0.0.1
  ```

  Expected: 三个用例均失败；旧代码仍渲染四个未配置复选框、没有钉钉候选，并在详情中显示原始 `dingtalk` key。

- [x] **Step 3: 增加国内候选常量并统一过滤**

  在 `GLOBAL_NOTIFICATION_CHANNELS` 附近增加：

  ```tsx
  const DOMESTIC_NOTIFICATION_CHANNELS = [
    { key: "weixin", labelKey: "微信", comingSoon: false },
    { key: "qqbot", label: "QQ", comingSoon: false },
    { key: "wecom", labelKey: "企业微信", comingSoon: false },
    { key: "feishu", labelKey: "飞书", comingSoon: false },
    { key: "dingtalk", labelKey: "钉钉", comingSoon: false },
  ] as const;
  ```

  在 `AutomationFormModal` 中用当前区域候选派生可见列表：

  ```tsx
  const availableNotificationChannels = (isGlobal
    ? GLOBAL_NOTIFICATION_CHANNELS
    : DOMESTIC_NOTIFICATION_CHANNELS
  ).map((channel) => ({
    key: channel.key,
    label: "label" in channel ? channel.label : t(channel.labelKey),
    comingSoon: channel.comingSoon,
  })).filter(({ key, comingSoon }) => (
    isHermesNotificationChannelConfigured(enabledChannels, key, comingSoon)
  ));
  const hasAvailableNotificationChannel = availableNotificationChannels.length > 0;
  ```

  通知区域直接渲染 `availableNotificationChannels.map(...)`，删除国内站硬编码未过滤数组。保留现有 loading、选择、Chat ID、测试发送和微信限频分支。

  在详情名称映射中增加：

  ```tsx
  if (platform === "dingtalk") return t("钉钉");
  ```

- [x] **Step 4: 更新空态入口文案与 i18n 字典**

  将组件中的：

  ```tsx
  {t("去通道配置")}
  ```

  改为：

  ```tsx
  {t("前往通道配置")}
  ```

  Run:

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:zh-hant
  ```

  新 key 固定为 `k_3a42a311`。补齐：

  ```json
  // en-US.json
  "k_3a42a311": "Configure channels"

  // id-ID.json
  "k_3a42a311": "Konfigurasi kanal"
  ```

  `zh-to-key.json`、`zh-CN.json` 和 `zh-Hant.json` 只使用脚本生成结果，不手工改写。

- [x] **Step 5: 运行双区域 GREEN 回归**

  Run:

  ```bash
  cd frontend
  VITE_REGION=cn pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    --api.host 127.0.0.1
  VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.global.test.ts \
    --api.host 127.0.0.1
  VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    -t "hides the background-only hint in the global channel empty state|keeps the background-only hint when a global channel is available" \
    --api.host 127.0.0.1
  ```

  Expected: 国内站主文件、国际站专项文件和国际站空态 2 个精准用例全部通过。

- [x] **Step 6: 运行质量门禁并清理生成物**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  pnpm build
  pnpm build:global
  cd ..
  git diff --check
  git status --short
  ```

  Expected: 类型、i18n、国内/国际构建和 diff 检查通过；最终范围只包含设计/计划、自动任务组件、对应测试和必要 i18n 字典，不包含 `next-env.d.ts`、字体或构建输出。

- [x] **Step 7: 提交门禁**

  展示最终 diff、测试和构建证据，等待用户明确确认后再执行：

  ```bash
  git add frontend/openspec/plan.md \
    frontend/src/pages/marketing/agent-automations-panel.tsx \
    frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    frontend/src/i18n/generated/zh-to-key.json \
    frontend/src/i18n/generated/zh-CN.json \
    frontend/src/i18n/generated/zh-Hant.json \
    frontend/src/i18n/generated/en-US.json \
    frontend/src/i18n/generated/id-ID.json
  git commit -m "对齐国内站自动任务通知通道展示 / feat: filter domestic automation channels"
  ```

### Task 2: 调整国内站通知通道展示顺序

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- Modify: `frontend/openspec/changes/2026-08-21-domestic-automation-configured-channels-design.md`

**Acceptance:**
- 国内站已配置通道按微信、QQ、企业微信、飞书、钉钉展示。
- 过滤未配置通道后，剩余通道仍保持上述相对顺序。
- 国际站顺序保持不变。

- [x] 先增加国内五通道顺序断言并确认 RED。
- [x] 调整国内候选常量和邻近说明并确认 GREEN。
- [x] 运行国内完整面板测试、国际专项测试、类型检查和 diff 检查。

### Task 3: 补齐钉钉通道别名归一化与兜底优先级

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Modify: `frontend/src/lib/hermes-cron-client.ts`
- Modify: `frontend/src/pages/marketing/scenario-task-cron.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- Test: `frontend/src/lib/__tests__/hermes-cron-client.test.ts`
- Test: `frontend/src/pages/marketing/scenario-tasks/__tests__/scenario-task-cron.test.ts`

**Acceptance:**
- 自动任务与场景任务都将 `openclaw-dingtalk` 归一化为 `dingtalk`。
- 场景任务将归一化后的 `dingtalk` 展示为“钉钉”，不暴露内部 key。
- canonical `dingtalk` 行为保持不变；不增加未经真实上报验证的 `ding` / `dingding` 别名。
- deliver fallback 在钉钉和国际通道同时在线时优先选择钉钉；钉钉位于飞书之后、Telegram 之前。
- 不改变其他通道别名、区域候选列表或发送协议。

- [x] 分别增加自动任务、场景任务与 fallback 的失败用例并确认 RED。
- [x] 最小修改三处归一化逻辑与 fallback priority 并确认 GREEN。
- [x] 运行相关测试、类型检查、i18n 检查和双区域构建。
- [x] 展示修复 diff 与验证结果，等待提交确认后更新 !3180。

### Task 4: 对齐国际站未登录静态定价矩阵

**规模：** S（单页静态展示与回归测试，不改变 `show()`、登录后询价或支付链路）

**Files:**
- Modify: `frontend/next-site/subscribe-page.tsx`
- Modify: `frontend/next-site/__tests__/subscribe-page.global.test.tsx`

**Acceptance:**
- `show()` 前继续展示旧占位态，不提前公开国际站付费定价。
- `show()` 后，未登录用户不请求后端，展示启航/巡游标准版和 AI 版的月付、季付静态美元价格。
- 月付：启航标准版原价 `$6.50`、新用户 14 天免费实付 `$0.00`；启航 AI 原价 `$10.00`、新用户 3 天免费实付 `$0.00`；巡游标准版 `$14.00 → $7.00`；巡游 AI `$23.00 → $13.80`。
- 季付：`$19.50 → $18.07`、`$30.00 → $29.43`、`$42.00 → $38.92`、`$69.00 → $67.69`，对应 9.3/9.8/9.3/9.8 折。
- 登录后继续使用后端询价，CTA 点击与支付链路保持不变。

- [x] 更新国际站回归测试，覆盖 `show()` 门禁和 8 组静态价格。
- [x] 最小清理静态定价实现与相邻注释，保持门禁和业务链路不变。
- [x] 运行定向测试、类型检查、i18n 检查和 diff 检查。

### Task 5: 防御登录态异常询价的促销文案

**规模：** S（订阅页促销资格收紧与回归测试，不改变未登录静态定价矩阵）

**Files:**
- Modify: `frontend/next-site/subscribe-page.tsx`
- Modify: `frontend/next-site/__tests__/subscribe-page.global.test.tsx`

**Acceptance:**
- 未登录用户继续展示 Task 4 的静态免费与首月折扣信息，8 组价格不变。
- 登录新用户仅在启航 AI 月付实付金额为零时展示“首单免费 3 天”和“免费订阅”；异常全价询价不承诺免费。
- 已订阅用户不展示首单权益；只有后端实付价低于原价时才展示真实折扣，全价询价不虚构“首月 6 折”。
- 国际站零元套餐继续走点石零元下单，非零元套餐继续走信用卡确认链路。

- [x] 先补登录新用户零元/全价、已订阅全价/折扣回归测试并确认 RED。
- [x] 让国际站 AI 促销标签同时受用户资格与真实询价金额门禁，保持未登录静态矩阵不变。
- [x] 运行国际站订阅页测试、类型检查、i18n 检查和 diff 检查。

---

# 国际站 8 月新增自动任务上游任务动态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this S-level task.

**Status:** 实现与验证完成，用户已确认提交、推送并创建 MR。

**Size:** S。单一目标、静态 Changelog 局部调整，不涉及接口、权限、计费、发布或跨服务变更。

**Goal:** 在国际站 2026 年 8 月更新日志中新增“自动任务支持关联上游任务”，复用国内站现有文案、四语翻译和真实功能截图。

**Architecture:** 继续使用 `changelog-page.tsx` 的 `isGlobal` 编译期分支，只在国际站 8 月条目数组中复用现有 `automationUpstream` 视觉卡片。先修改国际站专项测试并确认因条目缺失而失败，再添加最小页面数据使其通过；国内站条目和其他国际站动态保持不变。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、现有中文即 key i18n。

## Global Constraints

- 仅新增国际站 2026 年 8 月条目；不改国内站内容、条目顺序或其他月份。
- 英文标题沿用现有 Title Case 翻译 `Automation Tasks Can Now Link to Upstream Tasks`。
- 复用 `lightvela-automation-upstream-task.png`，不新增或修改图片资源。
- 生成字典只允许通过 i18n 脚本处理；若抽取后无变化，不提交字典。

### Task 1: 新增国际站自动任务上游任务动态

**Role:** Developer / Reviewer

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/global-changelog.test.tsx`
- Modify: `frontend/src/pages/marketing/changelog-page.tsx`
- Verify: `frontend/src/i18n/generated/{en-US,id-ID,zh-CN,zh-Hant,zh-to-key}.json`

**Acceptance:**
- 国际站 2026 年 8 月展示上游任务标题、描述与 `automationUpstream` 图片。
- en-US、id-ID、zh-CN、zh-Hant 均使用现有正确翻译。
- 国际站仍不展示自定义人设和钉钉条目；国内站原有 8 月内容不回归。

- [x] **Step 1: 修改国际站专项测试，断言四语言标题和现有图片，并确认 RED 原因为条目缺失。**
- [x] **Step 2: 在国际站 8 月数组中加入 `automation-upstream-task`，复用现有中文源文案和 `automationUpstream`。**
- [x] **Step 3: 运行国际站专项测试和国内站 Changelog 回归，确认 GREEN。**
- [x] **Step 4: 运行 `pnpm i18n:extract`、`pnpm i18n:check`、`pnpm check` 与 `git diff --check`，确认最终范围。**
- [x] **Step 5: 展示 diff 与验证证据，等待用户确认后再进入提交/MR。**

---

# 国际站自动任务模板动态移至 7 月 Implementation Plan

**Size:** S。仅调整一条国际站静态 Changelog 的月份归属，不改文案、配图、国内站或其他条目。

**Acceptance:**
- `Ready-Made Automation Templates` 归入国际站 `July 2026`。
- 国际站 `August 2026` 不再包含该条目。
- 国内站与其他国际站动态保持不变。

- [x] **Step 1: 增加国际站月份归属断言并确认 RED。**
- [x] **Step 2: 将 `automation-templates` 从国际站 8 月移到 7 月并确认 GREEN。**
- [x] **Step 3: 运行国际站 Changelog 回归、类型、i18n 与 diff 检查。**

---

# 国际站新增自定义人设文件动态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development to implement this S-level task.

**Status:** 实现与验证完成，用户已确认提交、推送和创建 MR。

**Size:** S。单一国际站静态 Changelog 条目与区域化截图调整，不涉及接口、权限、计费或发布。

**Goal:** 在国际站 2026 年 8 月更新日志中新增“上传自定义人设文件”，沿用国内站文案结构并展示真实英文上传弹窗截图。

**Architecture:** 继续使用 `changelog-page.tsx` 的 `isGlobal` 编译期分支；国际站 8 月复用现有标题和描述翻译键，同时让 `personaUpload` 在国际站选择新的英文截图、国内站继续选择原中文截图。先修改国际站专项测试并确认因条目缺失而失败，再添加最小页面数据与图片分支使其通过。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、现有中文即 key i18n、真实国际站英文 UI 截图。

## Global Constraints

- 国际站条目放在 2026 年 8 月首位，国内站条目、文案、顺序与中文截图保持不变。
- 英文标题固定沿用现有翻译 `LightVela Now Supports Custom Persona File Uploads`。
- 英文描述固定沿用现有翻译 `Upload a Markdown persona file, then continue editing it or inject it directly into your Agent. Injected persona files can also be edited or downloaded at any time.`。
- 新图固定使用真实英文上传弹窗，路径为 `/assets/changelog/lightvela-persona-upload-global-en.png`；国际站四语言共用该国际版截图。
- 不手改生成字典；`pnpm i18n:extract` 若无变化，不提交 i18n 文件。

### Task 1: 新增国际站自定义人设文件动态

**Role:** Developer / Reviewer

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/global-changelog.test.tsx`
- Modify: `frontend/src/pages/marketing/changelog-page.tsx`
- Create: `frontend/public/assets/changelog/lightvela-persona-upload-global-en.png`
- Verify: `frontend/src/i18n/generated/{en-US,id-ID,zh-CN,zh-Hant,zh-to-key}.json`

**Interfaces:**
- Consumes: 现有 `personaUpload` visual、标题/描述翻译键和国际站上传人设弹窗。
- Produces: 国际站 8 月首条 `persona-file-upload` 数据和区域化图片选择；国内站保持原路径。

- [x] **Step 1: 修改国际站专项测试，断言四语言条目、英文截图与 8 月首位。**

  将原有“不展示人设上传”断言改为展示断言，并验证英文标题、描述、图片路径与 `1410 / 642` 比例；同时保留钉钉排除和 7 月自动任务模板归属断言。

- [x] **Step 2: 运行专项测试并确认 RED。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/global-changelog.test.tsx
  ```

  Expected: FAIL，原因是国际站 8 月尚无 `persona-file-upload` 条目，而不是测试环境或语法错误。

- [x] **Step 3: 捕获真实英文上传弹窗截图并加入 Changelog 资源。**

  在国际站英文界面打开 `/agents/persona` 的上传弹窗，保留标题、说明、文件限制和 `Choose file` 按钮，输出为 `1410 × 642` PNG：

  ```text
  frontend/public/assets/changelog/lightvela-persona-upload-global-en.png
  ```

- [x] **Step 4: 添加最小页面数据与区域化图片选择。**

  在国际站 8 月 `entries` 首位加入：

  ```ts
  {
    id: "persona-file-upload",
    title: t("LightVela 支持上传自定义人设文件"),
    desc: t("上传 Markdown 人设文件后，可继续编辑或直接注入 Agent；已注入的人设文件也支持随时编辑和下载。"),
    visual: "personaUpload" as const,
  }
  ```

  `personaUpload` 图片路径按区域选择：国际站使用 `lightvela-persona-upload-global-en.png`，国内站继续使用 `lightvela-persona-upload.png`。

- [x] **Step 5: 运行国际站专项测试与国内站 Changelog 回归并确认 GREEN。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/global-changelog.test.tsx \
    src/pages/marketing/__tests__/channel-copy.test.tsx
  ```

  Expected: 国际站四语言展示人设条目与英文截图；国内站仍展示原中文截图；其他区域条目不回归。

- [x] **Step 6: 运行完整质量门禁并展示提交范围。**

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:check
  pnpm check
  cd ..
  git diff --check
  git status --short
  ```

  Expected: i18n、类型与 diff 检查通过，最终仅包含计划、国际站 Changelog 测试、页面数据和英文截图。

- [x] **Step 7: 展示 diff、验证证据、提交信息和 MR 配置，等待用户确认。**

---

# Agent 审批模式 CR 修复 Implementation Plan

**Goal:** 修复 MR !3288 评审确认的恢复默认说明、未知枚举失败半径和关闭审批状态提示，并锁定 reset/save 保护。

**Design:** `openspec/changes/2026-08-25-agent-approval-mode-cr-fixes-design.md`

**Detailed plan:** `openspec/changes/2026-08-25-agent-approval-mode-cr-fixes-plan.md`

## Tasks

- [x] 未知 `approvals.mode` 仅降级审批字段，不阻塞整页读取。
- [x] 安全组恢复弹窗明确 `关闭审批 → 智能审批`，现有 `off` 展示低强度风险提示。
- [x] 补齐 unsupported reset 过滤与同步保存互斥测试，并用定向 mutation 验证测试有效。
- [x] 完成 i18n、焦点测试、类型检查、双区域构建和 diff 门禁。
- [x] 展示最终范围、提交信息和 MR 配置，等待用户确认。
- [x] 将安全分组、审批模式和关闭审批弹窗正文改为「高风险操作」，完成测试、i18n 和静态门禁后追加到 MR !3309。

---

# Agent 会话操作确认 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development. The repository remains single-agent unless the user explicitly authorizes subagents.

**Goal:** 在高级设置「安全」分组增加「会话操作确认」，并让安全分组恢复到 LightVela 预置 `approvals.mode=off`、`approvals.destructive_slash_confirm=false`。

**Design:** `openspec/changes/2026-08-25-session-operation-confirmation-design.md`

**Detailed plan:** `openspec/changes/2026-08-25-session-operation-confirmation-plan.md`

## Tasks

- [x] 扩展 typed settings、reader 与即时保存链路，接入 `approvals.destructive_slash_confirm`。
- [x] 将安全分组 reset 改为 `config set` 写回 LightVela `off/false`，不得 unset 成 Hermes `smart/true`。
- [x] 增加「会话操作确认」开关、风险确认、LightVela 恢复说明和四语言资源。
- [x] 完成焦点测试、i18n、类型检查、双区域构建和 diff 门禁。
- [x] 展示最终范围、验证证据、提交信息和 MR 配置，等待用户确认。

---
