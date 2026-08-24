# 国际站开放自定义人设文件 Design

**状态：** 首轮方案与 CR 增量均已实施，已通过自定义人设定向双区域验证，待提交。

**规模：** S。复用国内站已经上线的完整能力，仅移除国际站展示门禁并补齐双区域回归；不新增接口、数据结构或运行时命令。

**区域：** 国内站行为保持不变；国际站新增完整的自定义人设上传、编辑和下载能力。

## 背景

国内站现有 Agent 人设页已经支持上传 Markdown、自定义人设编辑、覆盖确认、安全注入和原文件下载。国际站使用相同的 Persona 页面、Hermes `SOUL.md` 读取与写入命令及数据状态，但 `agent-buddy-panel.tsx` 仍通过三个 `isGlobal` 展示门禁隐藏上传入口、编辑/下载操作和编辑弹窗。

这使国际站用户可以看到已经注入的自定义人设状态，却无法在页面内创建或继续维护自定义人设。

## 目标

1. 国际站 Persona 页面完整开放“上传人设文件”。
2. 国际站已注入自定义人设时提供编辑和下载操作。
3. 国内站与国际站复用同一套文件校验、内容标准化、备份、原子写入、读取和下载实现。
4. 国内站现有行为、预设人设、抽卡和答题测试流程保持不变。

## 非目标

- 不新增国际站专属组件、API、命令或数据模型。
- 不改变 `SOUL.md` 的格式、来源标记、备份目录或写入协议。
- 不调整预设人设内容、抽卡概率、答题测试或注入后的 `/new` 提示。
- 不新增或改写用户可见文案；现有英文翻译直接复用。
- 不改变国际站 Persona 路由或 Agent 导航结构。
- 不在本 MR 修复推荐人设 / 抽卡的国际站既有失败。
- 不在本 MR 调整 `equippedStatus === "error"` 时的上传入口重试策略。
- 不在本 MR 修改仓库级 `pnpm check` 脚本。

## CR 增量方案

MR !3248 的评审确认核心展示门禁改动可以合并，同时指出国际站开放后暴露的两个语言边界和一个测试遗留。用户确认在当前 MR 内处理以下四项：

1. 为结构建议识别补充繁體中文与印尼语的标准标题词，继续保持软提示、不阻止注入。
2. 删除 `shows inject only after selecting a persona` 中纯遗留的国际站早退，让该行为在两个区域共同执行。
3. 将自定义人设默认展示名作为参数沿 `validateCustomSoulMarkdown`、`buildCustomSoulMarkdown`、`getPersonaDisplayName` 传递，由上传和编辑弹窗传入 `t("自定义人设")`；纯函数未传参数时使用语言中立的 `Custom persona`。
4. 把“双区域验证通过”限定为自定义人设定向链路，并明确国际站整文件仍有 8 个 `master` 既有的推荐人设失败。

### 方案选择

- **采用：在当前 MR 内修复上述四项。** 两个语言问题由国际站入口开放直接暴露，改动局限于现有纯函数、两个调用方、测试和文档。
- **未采用：只删测试守卫并改文档。** 可以保持最小 diff，但会把已确认的繁中/印尼语误导和中文兜底带入国际站上线。
- **未采用：连同推荐人设和读取失败重试一起修。** 这会跨入推荐人设 slug 本地化和状态恢复机制，扩大当前 MR 的架构边界。

### 多语言结构识别

继续使用单一、区域无关的结构识别函数，不根据站点或 UI 语言分叉。四类结构在现有简中 / 英文关键词基础上增加：

- Identity：`Identitas`、`Posisi Peran`；繁中“角色定位”与现有词同形。
- Communication style：`溝通風格`、`語氣`、`表達`、`Gaya Komunikasi`、`Nada`。
- Working principles：`工作原則`、`原則`、`優先級`、`Prinsip Kerja`、`Prioritas`。
- Behavioral boundaries：`行為邊界`、`邊界`、`禁止`、`Batasan Perilaku`、`Batasan`，正文禁令继续兼容 `Jangan`。

只新增各语言的明确结构词，不引入语言检测、翻译服务或可配置词库。

### 本地化默认展示名

`getPersonaDisplayName` 增加可选的 `fallbackDisplayName`，默认值为语言中立的 `Custom persona`。`buildCustomSoulMarkdown` 与 `validateCustomSoulMarkdown` 原样向下传递该参数；上传弹窗和当前文件编辑弹窗都显式传入 `t("自定义人设")`。

名称优先级保持不变：`Name:` 元数据 → 文件名 → 本地化兜底。80 字节截断、控制字符清理和写入 `Name:` 的行为不变。

### 测试

先添加失败测试并确认 RED：

- 结构完整的繁中 / 印尼语 Markdown 不产生对应的四项缺失提示。
- `.md` 且无 `Name:` 时使用调用方传入的英文或印尼语兜底，并写入最终 `SOUL.md`。
- 国际站实际执行 `shows inject only after selecting a persona`。

再实现最小生产改动并运行：上传纯函数与弹窗测试、国际站自定义人设定向测试、国内站 Persona 回归、i18n、类型检查和国内 / 国际构建。

## 当前实现边界

- UI 与状态编排：`frontend/src/pages/marketing/agent-buddy-panel.tsx`
- 上传和编辑弹窗：`agent-persona-upload-modal.tsx`、`agent-custom-persona-file-modal.tsx`
- Markdown 校验与标准化：`agent-persona-upload.ts`
- Hermes 读写命令：`agent-buddy-command.ts`
- 核心回归：`frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`

国际站当前被以下三处展示条件限制：

1. 自定义人设状态后的编辑、下载操作只在 `!isGlobal` 时渲染。
2. `PersonaUploadModal` 只在 `!isGlobal` 时渲染。
3. `CustomPersonaFileModal` 只在 `!isGlobal` 时渲染。

底层读取、识别、写入和下载逻辑本身是共享实现，不需要区域分叉。

## 设计方案

### 采用方案：移除三个国际站展示门禁

让编辑/下载操作、上传弹窗和编辑弹窗在国内站与国际站统一渲染。组件继续消费现有 `botId`、加载状态、`hasExistingSoul` 和 Hermes 调试执行仓库，不增加新的 capability flag。

选择该方案的原因：

- 国际站已经具备相同 Agent 和 Hermes 执行能力。
- 现有英文词条完整，无需引入区域文案分支。
- 改动最小，不会产生两套 Persona 工作流。
- 后续上传能力修复可同时覆盖两个站点，减少区域漂移。

### 未采用方案

1. **增加区域 capability flag：** 可以保留单独开关，但当前产品决策已经明确完整上线，没有第二个实际配置来源；增加开关只会扩大状态空间。
2. **复制国际站专属组件：** 可以独立定制，但会复制文件校验、安全写入和状态恢复逻辑，容易造成安全契约和体验漂移。

## 用户流程与数据流

### 上传

1. 国际站用户进入现有 Agent 的 Persona 页面。
2. 点击 “Upload persona file”，选择一个 `.md` 文件。
3. 浏览器复用现有扩展名、UTF-8、20 KB、空内容和控制字符校验。
4. 用户在现有编辑弹窗预览、修改并确认注入。
5. 已存在 `SOUL.md` 时继续显示覆盖确认。
6. 通过现有 Hermes 命令执行旧文件备份、临时文件写入、非空检查和原子 `mv`。
7. 写入成功后回读真实身份信息并展示自定义人设状态。

### 编辑与下载

- 编辑：按需读取当前 Agent 的真实 `SOUL.md`，在现有编辑弹窗修改并通过同一安全写入链路保存。
- 下载：按需读取真实 `SOUL.md`，直接下载为 `soul.md`，不重写用户内容。

## 错误处理

国际站完全复用国内站现有错误语义：

- 文件选择和内容校验失败时保留弹窗，允许重新选择或修改。
- Hermes 读取失败时不打开空编辑器、不生成空下载文件。
- 写入失败时保留原 `SOUL.md` 和编辑内容，允许重试。
- 写入命令失败不得把自定义人设状态误报为成功。
- Agent 切换或过期异步结果继续由现有请求隔离逻辑处理。

## 国际化

不新增文案。以下现有英文词条直接复用：

- “上传人设文件” → “Upload persona file”
- “编辑自定义人设” → “Edit custom persona”
- “下载自定义人设” → “Download custom persona”
- “编辑人设文件” → “Edit persona file”
- “注入人设” → “Inject soul”

实现后运行 i18n 抽取与检查，确保字典未产生漂移。

## 测试设计

### TDD RED

先修改区域回归，要求 `VITE_REGION=global` 时：

- 上传入口可见且在 Agent 状态就绪后可用。
- 已注入自定义人设时编辑和下载操作可见。
- 国际站可以完成上传到 Hermes 命令、编辑保存和真实文件下载流程。

在生产代码未修改前，测试必须因现有 `!isGlobal` 门禁失败。

### GREEN

移除三个展示门禁后，运行同一组 Persona 测试：

- `VITE_REGION=cn`：确认国内站现有行为不回归。
- `VITE_REGION=global`：确认上传、编辑、下载完整可用。

这里的“双区域验证”限定为自定义人设定向链路。`agent-buddy-panel.test.tsx` 在国际站整文件运行时仍有 8 个推荐人设 / 抽卡用例失败，`master` 基线同样存在；本 MR 不修改这些用例依赖的区域化 slug 与推荐人设详情流程。

### 质量门禁

- Persona 定向 Vitest（国内与国际环境）。
- `pnpm i18n:check`。
- `pnpm check`。
- `git diff --check`。
- `pnpm build:cn` 与 `pnpm build:global`，确认两个区域产物均可生成。

## 验收标准

1. 国际站 Persona 页面显示 “Upload persona file”。
2. 文件校验、编辑、覆盖确认和注入行为与国内站一致。
3. 自定义人设注入成功后，国际站显示真实名称以及编辑、下载操作。
4. 编辑保存继续备份并安全替换真实 `SOUL.md`；下载内容与运行时文件一致。
5. 国际站失败路径不误报成功、不覆盖旧文件、不产生空下载。
6. 国内站相关测试和行为保持通过。
7. 国内、国际区域构建和静态质量门禁通过。

## 回滚

若国际站上线后需要回滚，只恢复 `agent-buddy-panel.tsx` 的三个 `isGlobal` 展示门禁和对应区域测试预期；底层共享上传与 Hermes 命令无需回滚。
