# 自定义人设文件编辑与下载 Implementation Plan

> **执行要求：** 实现阶段必须使用 `test-driven-development`、`karpathy-guidelines`、`executing-plans` 和 `verification-before-completion`。本仓库为 single-agent 模式，任务按顺序在当前会话内执行，不派发子 Agent。

**Status:** 实现、相关回归和本地冒烟完成，等待用户验收与提交确认。

**规模:** M。触发理由是该需求仍位于国内站 Agent 人设单一产品域内，不涉及后端 API、权限、数据迁移或发布；但新增全文读取协议、编辑弹窗、下载链路和跨 Agent 竞态处理，存在多个相互依赖的状态与接口，需要标准规划和分阶段验证。未命中 L 级条件。

**Goal:** 在自定义人设已注入状态后增加编辑与下载图标；编辑当前 Agent 实际 `SOUL.md` 并安全覆盖，或直接下载其原始内容为 `soul.md`。

**Architecture:** 页面初始化继续使用只返回 `Exists`、`Slug`、`Name` 的轻量身份读取命令。用户点击编辑或下载图标时，才调用独立的全文读取命令，以带字节数的单行 Base64 协议返回当前 Agent 实际文件。编辑弹窗只负责内容校验和保存交互；`BuddyPanel` 负责读取、竞态保护、下载和复用现有备份加原子替换写入链路。

**Tech Stack:** React 19、TypeScript 5.9、Radix Dialog、Tailwind CSS 4、lucide-react、Vitest 4、Testing Library、现有 `BotRepository.execDebugCommand`。

## 范围与边界

- 仅国内站、已有 Agent、且当前 `Slug: custom-upload` 时显示入口。
- 状态文字保持不可点击，只新增编辑和下载两个图标按钮。
- 编辑内容来源于当前 Agent 实际 `SOUL.md`，不读取浏览器缓存或最初上传文件。
- 下载图标直接下载，不打开弹窗；编辑弹窗中不放上传或下载功能。
- 不修改现有轻量身份读取协议，不新增后端 API、依赖或浏览器持久化。
- 不改变推荐人设、抽卡、国际站和新建 Agent 流程。
- 保存成功后不声称当前会话已热更新，继续提示用户发送 `/new`。

## 已选方案与取舍

- 选择独立全文读取命令：按需传输完整文件，并保持现有页面初始化读取轻量。
- 不扩展身份读取命令：避免刷新页面和注入后同步时无条件传输全文。
- 不缓存上传内容：缓存会在刷新后丢失，也无法反映 Agent 内部的真实修改。
- 不把下载放进编辑弹窗：编辑和直接获取文件是两个独立动作，用户已确认分别使用图标入口。

## Task 1：新增当前 `SOUL.md` 全文读取协议与严格解析

**Role:** Developer / Reviewer

**Files:**

- Modify: `frontend/src/pages/marketing/agent-buddy-command.ts`
- Modify: `frontend/src/pages/marketing/__tests__/agent-buddy-command.test.ts`

**Interfaces:**

```ts
export function buildHermesSoulContentReadCommand(): string;

export type HermesSoulContentResult =
  | { status: "ready"; markdown: string; byteLength: number }
  | { status: "missing" }
  | { status: "too_large"; byteLength: number }
  | { status: "invalid" };

export function parseHermesSoulContent(
  output: string,
): HermesSoulContentResult;
```

**Acceptance:**

- 文件不存在或为空时返回 `Exists: no`。
- 文件超过 `20 * 1024` 字节时只返回 `Exists: yes`、`TooLarge: yes`、`ByteLength`，不输出正文。
- 合法文件返回 `Exists: yes`、`ByteLength` 和单行 `ContentBase64`。
- 解析器严格拒绝缺失字段、非法 Base64、无效 UTF-8、长度不一致、负数或超限 ready 状态。
- 现有 `buildHermesSoulReadCommand()` 仍只读取身份字段，不输出全文。

- [x] **Step 1 — 先写协议与解析失败测试**

  在 `agent-buddy-command.test.ts` 增加以下场景：

  - 命令包含 `wc -c`、20 KB 上限分支和单行 Base64 输出。
  - 命令不使用会把原始 Markdown 直接写到 stdout 的 `cat "$soul_file"`。
  - 中文、多行 Markdown 可以从 Base64 完整往返。
  - `Exists: no` 解析为 `missing`。
  - `TooLarge: yes` 解析为带实际字节数的 `too_large`。
  - 非法 Base64、非 UTF-8、声明长度与解码长度不一致、ready 状态超过 20 KB、未知输出均解析为 `invalid`。
  - 现有身份读取命令继续不包含 `ContentBase64`。

- [x] **Step 2 — 运行定向测试并确认 RED**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-buddy-command.test.ts \
    --api.host 127.0.0.1
  ```

  Expected: 新导出尚不存在或新协议断言失败；现有身份读取用例继续通过。

- [x] **Step 3 — 实现最小读取命令与解析器**

  - 读取路径沿用 `${HERMES_HOME:-$HOME/.hermes}/SOUL.md`。
  - shell 先验证非空文件，再用 `wc -c` 获取实际字节数。
  - `base64` 输出必须移除平台可能产生的换行，只保留单行正文。
  - 解析器使用严格 Base64 形态校验；解码后使用 fatal UTF-8 解码，并以 `TextEncoder` 复核实际字节数。
  - 复用 `PERSONA_MARKDOWN_MAX_BYTES`，不复制第二个 20 KB 数值。

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run: Step 2 相同命令。

  Expected: 命令与解析器全部通过，现有身份读取契约无回归。

## Task 2：新增当前人设编辑弹窗

**Role:** Developer / Reviewer

**Files:**

- Add: `frontend/src/pages/marketing/agent-custom-persona-file-modal.tsx`
- Add: `frontend/src/pages/marketing/__tests__/agent-custom-persona-file-modal.test.tsx`
- Reuse: `frontend/src/pages/marketing/agent-persona-upload.ts`
- Reuse: `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`

**Interfaces:**

```ts
export type CustomPersonaSavePayload = {
  markdown: string;
  displayName: string;
};

type CustomPersonaFileModalProps = {
  open: boolean;
  initialMarkdown: string;
  onClose: () => void;
  onSave: (payload: CustomPersonaSavePayload) => Promise<void>;
};
```

**Acceptance:**

- 弹窗标题为“编辑人设文件”，文件名为 `SOUL.md`。
- 编辑框复用上传人设编辑态的圆角、边框、等宽字体及标题到编辑框 6px 间距。
- 显示实时 UTF-8 字节数和 `20 KB` 上限。
- 内容未改变、为空、包含非法控制字符或超过 20 KB 时禁用“保存修改”。
- 保存前通过 `buildCustomSoulMarkdown(value, "SOUL.md")` 标准化，保证 `Slug: custom-upload` 和有效 `Name`。
- 保存失败保留用户内容并允许重试；保存中禁止关闭、重复提交。
- 右下角只显示“取消”和“保存修改”，弹窗内不显示上传或下载入口。

- [x] **Step 1 — 新增弹窗组件失败测试**

  覆盖以下行为：

  - 初次打开显示标题、`SOUL.md`、原始内容、字节数和两个右下角按钮。
  - 未修改时“保存修改”禁用。
  - 修改为合法内容后按钮启用，提交 payload 是标准化 Markdown 和解析出的展示名称。
  - 空内容、控制字符、超过 20 KB 时显示现有校验错误并禁用保存。
  - `onSave` reject 后弹窗不关闭、编辑内容不丢失并显示“保存失败，请检查网络后重试”。
  - 保存 Promise 未结束时“取消”和关闭按钮不可用，重复点击只调用一次 `onSave`。
  - 弹窗中不存在“选择文件”“重新上传文件”或下载按钮。

- [x] **Step 2 — 运行弹窗测试并确认 RED**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-custom-persona-file-modal.test.tsx \
    --api.host 127.0.0.1
  ```

  Expected: 新组件尚不存在，测试失败。

- [x] **Step 3 — 实现最小编辑弹窗**

  - 复用 `validatePersonaMarkdownText`、`buildCustomSoulMarkdown` 和现有字节计数规则。
  - 每次由关闭切到打开时使用新的 `initialMarkdown` 初始化编辑值；打开期间不要因父组件重复渲染覆盖用户输入。
  - `onSave` 只接收已标准化内容和展示名称；文件写入、成功提示和身份刷新留在 `BuddyPanel`。
  - 使用现有 Dialog 与按钮样式，不新增设计系统或依赖。

- [x] **Step 4 — 运行弹窗测试并确认 GREEN**

  Run: Step 2 相同命令。

  Expected: 新弹窗全部交互测试通过。

## Task 3：接入图标入口、直接下载、安全保存和完整验证

**Role:** Developer / Reviewer

**Files:**

- Modify: `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- Modify: `frontend/src/i18n/generated/zh-to-key.json`
- Modify: `frontend/src/i18n/generated/zh-CN.json`
- Modify: `frontend/src/i18n/generated/zh-Hant.json`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Modify: `frontend/openspec/spec.md`
- Modify: `frontend/openspec/specs/buddy.md`
- Modify: `frontend/openspec/changes/2026-08-23-custom-persona-file-actions-design.md`
- Modify: `frontend/openspec/plan.md`
- Modify: `wiki/prd-docs/2026-08-22-agent-persona-markdown-upload.md`

**Integration shape:**

```ts
type CustomPersonaFileAction = "idle" | "editing" | "downloading";

type CustomPersonaEditorState = {
  markdown: string;
} | null;
```

`BuddyPanel` 新增一个按需读取 helper。它调用 `buildHermesSoulContentReadCommand()` 和 `parseHermesSoulContent()`，并在每次异步结果落地前校验请求序号和当前 `botId`。编辑入口在 ready 时打开弹窗；下载入口在 ready 时创建 UTF-8 Blob 并立即清理对象 URL；保存入口复用 `buildHermesSoulWriteCommand()` 和现有命令执行函数。

**Acceptance:**

- 只有自定义已注入状态显示编辑、下载图标；推荐人设和国际站均不显示。
- 两个图标分别具备 `aria-label` / tooltip：“编辑自定义人设”“下载自定义人设”。
- 点击编辑后读取实际文件并打开弹窗；点击下载后直接下载精确原文为 `soul.md`，不打开弹窗。
- 保存沿用备份、临时文件、原子替换命令；成功后刷新真实身份和名称，并提示“人设已更新，请发送 /new 开始新会话以生效”。
- missing、too large、invalid、网络失败均显示设计文档中的对应错误，不产生空弹窗或空文件。
- 切换 Agent、组件卸载或较新请求开始后，旧结果不得打开弹窗、触发下载、写入状态或显示成功。

- [x] **Step 1 — 在面板测试中锁定入口与交互并确认 RED**

  增加以下组件测试：

  - `custom-upload` 状态显示两个图标，状态文字本身不是按钮；推荐人设状态不显示图标。
  - 编辑图标先执行全文读取命令，ready 后弹窗展示 Agent 实际内容。
  - 保存调用现有安全写入命令，成功后重新读取身份、更新名称并显示 `/new` 提示。
  - 下载图标读取后以 `text/markdown;charset=utf-8` Blob 下载精确原文，文件名为 `soul.md`，不打开弹窗，并调用 `URL.revokeObjectURL`。
  - missing、too large、invalid、命令 reject 分别显示正确提示且不创建下载。
  - 读取期间两个图标禁用，重复点击不产生并发命令。
  - 切换 `botId` 后，旧 Agent 的读取或保存结果被忽略。
  - 国际站已有隔离测试继续断言没有这些入口。

  测试中 mock `URL.createObjectURL`、`URL.revokeObjectURL` 和临时 `<a>` 点击，断言下载内容来自读取结果且未经过标准化。

- [x] **Step 2 — 运行面板相关测试并确认 RED**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-buddy-command.test.ts \
    src/pages/marketing/__tests__/agent-custom-persona-file-modal.test.tsx \
    src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
    --api.host 127.0.0.1
  ```

  Expected: 图标、全文读取、编辑保存和直接下载尚未接入，新增面板断言失败。

- [x] **Step 3 — 最小接入面板功能**

  - 从 `lucide-react` 引入 `Pencil`；复用已存在的 `Download`。
  - 图标按钮放在自定义状态文字之后，复用现有 tooltip 样式和紧凑图标按钮 token。
  - 读取中只禁用这一组文件操作，不阻塞页面其他人设浏览功能。
  - Blob 内容使用读取到的 `markdown` 原文；触发点击后移除 `<a>` 并 revoke URL。
  - 保存时将弹窗传回的标准化 Markdown 编码后交给 `buildHermesSoulWriteCommand`；只有命令真实成功才关闭弹窗并刷新身份。
  - 保存成功提示使用现有信息弹窗或同等级成功反馈，不新增第二套全局通知系统。

- [x] **Step 4 — 更新 i18n、OpenSpec 与 PRD**

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:zh-hant
  ```

  补齐英文和印尼语：编辑/下载无障碍名称、编辑弹窗按钮、读取错误、保存错误和保存成功提示。同步当前 Spec、Buddy 长期规格、设计文档和 PRD，使其与最终代码一致。

- [x] **Step 5 — 运行相关回归与质量门禁**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-buddy-draw-modal.test.tsx \
    src/pages/marketing/__tests__/agent-buddy-panel.test.tsx \
    src/pages/marketing/__tests__/agent-buddy-command.test.ts \
    src/pages/marketing/__tests__/agent-persona-upload-modal.test.tsx \
    src/pages/marketing/__tests__/agent-persona-upload.test.ts \
    src/pages/marketing/__tests__/agent-custom-persona-file-modal.test.tsx \
    --api.host 127.0.0.1
  pnpm check
  pnpm i18n:check
  cd ..
  git diff --check
  ```

  Expected: 所有相关测试、类型检查、lint、i18n 和差异检查通过；现有上传、抽卡和推荐人设流程无回归。

- [x] **Step 6 — 本地浏览器验收**

  在 `http://127.0.0.1:5174/agents/persona/` 验证：

  - 自定义状态后的图标位置、tooltip、键盘焦点和禁用态。
  - 编辑弹窗桌面布局、实际内容、字节计数、失败保留和成功 `/new` 提示。
  - 下载文件名及内容。
  - 若当前账号或 Agent 条件不足，明确记录未验证项，以组件和命令测试作为替代证据，不伪造浏览器结果。

  结果：本地服务返回 `200`，页面可加载至登录空态；当前浏览器会话未登录，且认证服务暂时不可用，因此无法在真实 Agent 上点验图标、编辑和下载。未验证项由组件测试、真实 Bash 命令往返测试和区域隔离测试覆盖。

- [ ] **Step 7 — 提交门禁**

  展示最终变更文件、diff、测试和浏览器证据，以及拟提交信息：

  ```text
  增加自定义人设编辑与下载 / feat: edit and download custom persona
  ```

  只有用户明确确认后，才执行精确 `git add`、`git commit`、`git push` 或创建 MR；不得包含 `frontend/next-env.d.ts`、字体文件或其他无关改动。

## Planning Gate

- 需求范围和八条验收标准已由用户确认，非目标明确。
- 规模按 `flow-cost.md` 唯一路由判为 M，未命中跨服务或高风险 L 条件。
- 已加载 P0 上下文、现有 Buddy Spec、实现代码、测试和设计文档。
- 采用独立按需读取协议，不引入依赖；空态、超限、编码、网络、下载和竞态均有处理。
- 当前仓库 capability 为空；本需求是已有页面局部交互，不依赖 Figma，也不强制启用 E2E capability。
- 主计划包含未完成任务，运行摘要将在计划写入后刷新。

**结论:** 通过。可在用户确认后进入 single-agent TDD 实现阶段。
