# 国内站钉钉通道产品动态 Implementation Plan

> **For agentic workers:** 按任务内复选框逐步执行。当前会话采用 inline execution；不启用 subagent。

**Goal:** 在国内站 2026 年 8 月更新日志中依次展示自动任务上游任务、钉钉通道和 QQ 群聊动态，并为前两条使用不含用户和实例信息的真实控制台截图。

**Architecture:** 沿用 `ChangelogContent` 的 `isGlobal` 编译期区域分支，在国内站 8 月数组中按自动任务、钉钉、QQ 排序静态条目；沿用 `VisualCard` 的图片 variant 映射分别接入 PNG。国际站数组不增加这两条动态，通过专属回归测试锁定隔离边界。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、react-i18next、静态 PNG 资产。

## Global Constraints

- 只修改国内站更新日志；国际站不新增自动任务上游任务和钉钉条目。
- 标题固定为 `LightVela 支持钉钉通道`。
- 描述固定为 `现在可以将 Hermes Agent 接入钉钉，在钉钉会话中直接与云端智能伙伴对话。`。
- 自动任务标题固定为 `自动任务支持关联上游任务`。
- 自动任务描述固定为 `创建或编辑自动任务时，可以关联一个上游任务。后续该任务执行时，会使用上游任务最近一次的输出作为上下文。`。
- 国内站 8 月排序固定为自动任务、钉钉、QQ；不恢复已删除的“自动任务模板”条目。
- 真实截图只保留通道说明和卡片，排除头像、实例名称、套餐状态、侧栏、实例 ID、凭据和二维码。
- 自动任务截图只保留真实“添加自动任务”弹窗中的上游任务区域，选择框保持关闭，不展示用户任务名称、任务内容或执行结果。
- 不修改钉钉通道配置、扫码或凭据绑定功能。
- 不重构 `VisualCard` 或相邻条目。
- `git commit`、`git push` 和创建 MR 前必须展示内容并等待用户确认。

---

### Task 1: 用双区域测试锁定钉钉动态范围

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/channel-copy.test.tsx:113-135`
- Modify: `frontend/src/pages/marketing/__tests__/global-changelog.test.tsx:42-76`

**Interfaces:**
- Consumes: `ChangelogPage`、`VisualCard` 的现有 DOM、图片 `alt` 和父卡片 `aspectRatio`。
- Produces: 国内站文案、排序、图片和宽高比断言；国际站不展示钉钉条目的隔离断言。

- [x] **Step 1: 扩展国内站 8 月回归测试**

将用例改名为 `shows the domestic August updates with DingTalk first`，并在现有 8 月断言前加入：

```tsx
expect(screen.getByRole("heading", { name: "LightVela 支持钉钉通道" })).toBeInTheDocument();
expect(
  screen.getByText("现在可以将 Hermes Agent 接入钉钉，在钉钉会话中直接与云端智能伙伴对话。"),
).toBeInTheDocument();
const dingtalkImage = screen.getByAltText("LightVela 支持钉钉通道");
expect(dingtalkImage).toHaveAttribute(
  "src",
  expect.stringContaining("/assets/changelog/lightvela-dingtalk-channel.png"),
);
expect(dingtalkImage.parentElement).toHaveStyle({ aspectRatio: "816 / 356" });
const augustHeadings = screen.getAllByRole("heading").map((heading) => heading.textContent);
expect(augustHeadings.indexOf("LightVela 支持钉钉通道")).toBeLessThan(
  augustHeadings.indexOf("自动任务模板"),
);
```

- [x] **Step 2: 增加国际站隔离断言**

在 `shows the new global August updates in every global locale` 的中文断言中加入：

```tsx
expect(screen.queryByRole("heading", { name: "LightVela 支持钉钉通道" })).not.toBeInTheDocument();
```

- [x] **Step 3: 运行测试确认 RED 和隔离基线**

Run:

```bash
cd frontend
VITE_REGION=cn pnpm exec vitest run \
  src/pages/marketing/__tests__/channel-copy.test.tsx \
  -t "shows the domestic August updates with DingTalk first" \
  --api.host 127.0.0.1
VITE_REGION=global pnpm exec vitest run \
  src/pages/marketing/__tests__/global-changelog.test.tsx \
  -t "shows the new global August updates in every global locale" \
  --api.host 127.0.0.1
```

Expected: 国内站用例因找不到 `LightVela 支持钉钉通道` 失败；国际站隔离断言通过。

---

### Task 2: 接入真实截图和国内站条目

**Files:**
- Create: `frontend/public/assets/changelog/lightvela-dingtalk-channel.png`
- Modify: `frontend/src/pages/marketing/changelog-page.tsx:46-221,294-312`
- Generated: `frontend/src/i18n/generated/zh-CN.json`
- Generated: `frontend/src/i18n/generated/zh-Hant.json`
- Generated: `frontend/src/i18n/generated/zh-to-key.json`
- Generated and translate: `frontend/src/i18n/generated/en-US.json`
- Generated and translate: `frontend/src/i18n/generated/id-ID.json`

**Interfaces:**
- Consumes: 已登录国内站 `/agents/channels/` 页面；`ChangelogEntry.visual`；`VisualCard({ variant })`。
- Produces: `dingtalk` visual variant，图片路径 `/assets/changelog/lightvela-dingtalk-channel.png`，宽高比 `816 / 356`，国内站 8 月首条记录。

- [x] **Step 1: 从真实控制台截取无敏感信息的图片**

关闭钉钉连接方式弹窗，确认页面仍为 `/agents/channels/`，从当前 1280 × 720 控制台截图中裁出内容区：

```js
const screenshot = await tab.screenshot({ fullPage: false });
// 从完整截图裁出 x=384、y=96、width=816、height=356 的内容区。
```

将结果保存为 `frontend/public/assets/changelog/lightvela-dingtalk-channel.png`，并检查画面只包含顶部通道说明及微信、QQ、企业微信、钉钉四张卡片。

- [x] **Step 2: 验证图片尺寸和隐私边界**

Run:

```bash
sips -g pixelWidth -g pixelHeight frontend/public/assets/changelog/lightvela-dingtalk-channel.png
```

Expected: `pixelWidth: 816`、`pixelHeight: 356`。人工确认没有头像、实例名称、套餐状态、实例 ID、凭据或二维码。

- [x] **Step 3: 为 `VisualCard` 增加最小 variant 映射**

在 `ChangelogEntry.visual` 和 `VisualCard` 参数联合类型中加入 `"dingtalk"`，并在三个映射中分别加入：

```tsx
: variant === "dingtalk"
? "/assets/changelog/lightvela-dingtalk-channel.png"
```

```tsx
: variant === "dingtalk"
? t("LightVela 支持钉钉通道")
```

```tsx
: variant === "dingtalk"
? "816 / 356"
```

同步更新 `ChangelogEntry.visual` 注释，增加 `dingtalk=钉钉通道图`。

- [x] **Step 4: 在国内站 8 月数组首位增加条目**

在 `isGlobal` 的国内站分支 `entries` 数组首位加入：

```tsx
{
  id: "dingtalk-channel",
  title: t("LightVela 支持钉钉通道"),
  desc: t("现在可以将 Hermes Agent 接入钉钉，在钉钉会话中直接与云端智能伙伴对话。"),
  visual: "dingtalk" as const,
},
```

- [x] **Step 5: 生成 i18n 文件**

Run:

```bash
cd frontend
pnpm i18n:extract
```

Expected: `zh-CN.json` 和 `zh-to-key.json` 新增两条中文 key；`en-US.json` 和 `id-ID.json` 新增对应空值。

按抽取脚本提示补齐：

```json
"k_0f3415c4": "You can now connect your Hermes Agent to DingTalk and chat with your cloud-based intelligent companion directly in DingTalk.",
"k_2bbceed3": "LightVela Now Supports DingTalk"
```

```json
"k_0f3415c4": "Kini Anda dapat menghubungkan Hermes Agent ke DingTalk dan mengobrol langsung dengan pendamping cerdas berbasis cloud melalui DingTalk.",
"k_2bbceed3": "LightVela Kini Mendukung DingTalk"
```

- [x] **Step 6: 运行精准双区域回归确认 GREEN**

Run:

```bash
cd frontend
VITE_REGION=cn pnpm exec vitest run \
  src/pages/marketing/__tests__/channel-copy.test.tsx \
  --api.host 127.0.0.1
VITE_REGION=global pnpm exec vitest run \
  src/pages/marketing/__tests__/global-changelog.test.tsx \
  --api.host 127.0.0.1
```

Expected: 两个测试文件全部通过；国内站显示钉钉条目，国际站不显示。

---

### Task 3: 完成质量门禁和页面预览

**Files:**
- Verify: `frontend/src/pages/marketing/changelog-page.tsx`
- Verify: `frontend/public/assets/changelog/lightvela-dingtalk-channel.png`
- Verify: `frontend/src/i18n/generated/zh-CN.json`
- Verify: `frontend/src/i18n/generated/zh-Hant.json`
- Verify: `frontend/src/i18n/generated/zh-to-key.json`

**Interfaces:**
- Consumes: Task 2 产出的静态条目和图片。
- Produces: 类型、i18n、格式和浏览器预览证据。

- [x] **Step 1: 运行静态门禁**

Run:

```bash
cd frontend
pnpm check
pnpm i18n:check
git diff --check
```

Expected: 三条命令均以退出码 0 完成。

- [x] **Step 2: 启动国内站预览**

Run:

```bash
cd frontend
pnpm dev:cn -- --hostname 127.0.0.1 --port 5176
```

打开 `http://127.0.0.1:5176/changelog`，检查：

- 2026 年 8 月第一条为钉钉通道动态。
- 标题、描述与设计说明一致。
- 图片无拉伸，通道卡片内容清晰。
- 时间线点线关系和后续 8 月条目保持正常。

- [x] **Step 3: 展示变更并等待提交授权**

Run:

```bash
git status --short
git diff --stat
git diff -- frontend/src/pages/marketing/changelog-page.tsx \
  frontend/src/pages/marketing/__tests__/channel-copy.test.tsx \
  frontend/src/pages/marketing/__tests__/global-changelog.test.tsx \
  frontend/src/i18n/generated/zh-CN.json \
  frontend/src/i18n/generated/zh-to-key.json
```

展示截图预览、变更文件、测试结果和拟提交信息；未得到用户确认前不执行 `git commit`、`git push` 或创建 MR。

---

### Task 4: 移除国内站自动任务模板动态

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/channel-copy.test.tsx`
- Modify: `frontend/src/pages/marketing/changelog-page.tsx`

- [x] **Step 1: 将国内站回归测试改为不展示自动任务模板，并确认 RED**
- [x] **Step 2: 从国内站 2026 年 8 月数组删除该条目，并确认 GREEN**
- [x] **Step 3: 重新运行区域测试、类型检查、i18n 检查和 diff 检查**

国际站同名条目保持不变，避免扩大本次国内站调整范围。

---

### Task 5: 增加自动任务上游任务动态和真实截图

**Files:**
- Create: `frontend/public/assets/changelog/lightvela-automation-upstream-task.png`
- Modify: `frontend/src/pages/marketing/__tests__/channel-copy.test.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/global-changelog.test.tsx`
- Modify: `frontend/src/pages/marketing/changelog-page.tsx`
- Generated: `frontend/src/i18n/generated/zh-CN.json`
- Generated: `frontend/src/i18n/generated/zh-Hant.json`
- Generated: `frontend/src/i18n/generated/zh-to-key.json`
- Generated and translate: `frontend/src/i18n/generated/en-US.json`
- Generated and translate: `frontend/src/i18n/generated/id-ID.json`

**Interfaces:**
- Consumes: `ChangelogEntry.visual`、`VisualCard({ variant })`、已登录国内站 Agent 控制台的“添加自动任务”弹窗。
- Produces: `automationUpstream` 图片 variant、路径 `/assets/changelog/lightvela-automation-upstream-task.png`、宽高比 `816 / 356`、国内站 8 月首条自动任务动态。

- [x] **Step 1: 用双区域测试锁定文案、排序、图片和隔离边界**

在国内站 8 月用例中加入：

```tsx
expect(screen.getByRole("heading", { name: "自动任务支持关联上游任务" })).toBeInTheDocument();
expect(
  screen.getByText(
    "创建或编辑自动任务时，可以关联一个上游任务。后续该任务执行时，会使用上游任务最近一次的输出作为上下文。",
  ),
).toBeInTheDocument();
const upstreamImage = screen.getByAltText("自动任务支持关联上游任务");
expect(upstreamImage).toHaveAttribute(
  "src",
  expect.stringContaining("/assets/changelog/lightvela-automation-upstream-task.png"),
);
expect(upstreamImage.parentElement).toHaveStyle({ aspectRatio: "816 / 356" });
const augustHeadings = screen.getAllByRole("heading").map((heading) => heading.textContent);
expect(augustHeadings.indexOf("自动任务支持关联上游任务")).toBeLessThan(
  augustHeadings.indexOf("LightVela 支持钉钉通道"),
);
expect(augustHeadings.indexOf("LightVela 支持钉钉通道")).toBeLessThan(
  augustHeadings.indexOf("支持在 QQ 群聊中 @ 机器人"),
);
```

在国际站中文用例中加入：

```tsx
expect(screen.queryByRole("heading", { name: "自动任务支持关联上游任务" })).not.toBeInTheDocument();
```

- [x] **Step 2: 运行测试确认 RED 和国际站隔离基线**

Run:

```bash
cd frontend
VITE_REGION=cn pnpm exec vitest run \
  src/pages/marketing/__tests__/channel-copy.test.tsx \
  -t "shows the domestic August updates" \
  --api.host 127.0.0.1
VITE_REGION=global pnpm exec vitest run \
  src/pages/marketing/__tests__/global-changelog.test.tsx \
  --api.host 127.0.0.1
```

Expected: 国内站用例因找不到 `自动任务支持关联上游任务` 失败；国际站用例通过。

- [x] **Step 3: 从真实控制台截取上游任务区域**

在已登录国内站控制台打开 `/agents/automations/`，点击“添加自动任务”，滚动弹窗使“上游任务”字段位于视口中心，并保持选择框关闭。截取 1280 × 720 当前视口后执行居中裁剪：

```bash
sips -c 356 816 <原始截图> --out frontend/public/assets/changelog/lightvela-automation-upstream-task.png
sips -g pixelWidth -g pixelHeight frontend/public/assets/changelog/lightvela-automation-upstream-task.png
```

Expected: `pixelWidth: 816`、`pixelHeight: 356`；画面不包含用户任务名称、任务内容、执行结果、头像、实例名称或实例 ID。

- [x] **Step 4: 增加图片 variant 和国内站首条动态**

在 `ChangelogEntry.visual` 和 `VisualCard` 参数类型中加入 `"automationUpstream"`，并增加三处映射：

```tsx
: variant === "automationUpstream"
? "/assets/changelog/lightvela-automation-upstream-task.png"
```

```tsx
: variant === "automationUpstream"
? t("自动任务支持关联上游任务")
```

```tsx
: variant === "automationUpstream"
? "816 / 356"
```

在国内站 8 月数组首位加入：

```tsx
{
  id: "automation-upstream-task",
  title: t("自动任务支持关联上游任务"),
  desc: t("创建或编辑自动任务时，可以关联一个上游任务。后续该任务执行时，会使用上游任务最近一次的输出作为上下文。"),
  visual: "automationUpstream" as const,
},
```

- [x] **Step 5: 抽取并补齐 i18n**

Run:

```bash
cd frontend
pnpm i18n:extract
```

为抽取出的两个新 key 分别补齐：

```json
"Automation Tasks Can Now Link to Upstream Tasks"
"When creating or editing an automation task, you can link an upstream task. When the task runs later, it uses the upstream task's most recent output as context."
```

```json
"Tugas Otomatis Kini Dapat Ditautkan ke Tugas Hulu"
"Saat membuat atau mengedit tugas otomatis, Anda dapat menautkan satu tugas hulu. Saat tugas tersebut dijalankan kemudian, tugas akan menggunakan output terbaru dari tugas hulu sebagai konteks."
```

Run:

```bash
pnpm i18n:zh-hant
```

- [x] **Step 6: 确认 GREEN 和完整质量门禁**

Run:

```bash
cd frontend
VITE_REGION=cn pnpm exec vitest run src/pages/marketing/__tests__/channel-copy.test.tsx --api.host 127.0.0.1
VITE_REGION=global pnpm exec vitest run src/pages/marketing/__tests__/global-changelog.test.tsx --api.host 127.0.0.1
pnpm check
pnpm i18n:check
git diff --check
```

Expected: 国内站相关测试 10 个全部通过；国际站相关测试 2 个全部通过；类型、i18n 和 diff 检查退出码均为 0。

- [x] **Step 7: 浏览器预览并等待提交授权**

启动国内站本地预览并打开 `/changelog/`，确认：

- 2026 年 8 月顺序为自动任务、钉钉、QQ。
- “自动任务模板”不出现。
- 两张新增图片均按真实比例展示且没有敏感信息。
- 国际站不新增自动任务上游任务和钉钉动态。

展示变更范围和验证结果；未得到用户确认前不执行 `git commit`、`git push` 或创建 MR。
