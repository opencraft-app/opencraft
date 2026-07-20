---
name: lightvela-changelog-update
description: 当用户需要为 LightVela 设计或执行产品动态/更新日志流程时使用，包括在 PRD/TAPD 阶段判断是否创建产品动态、从 TAPD/MR/提交中产出动态日志草稿、准备截图或 HTML 插图、录入 AutoSync 所需结构化内容、改造前端展示已发布动态，或兼容维护静态 changelog 页面。
metadata:
  short-description: LightVela 产品动态与更新日志
---

# LightVela 产品动态与更新日志

当用户要求更新 LightVela 更新日志、设计产品动态流程、从 TAPD/MR/提交记录中提炼功能级更新、准备截图或 HTML 插图、对接 AutoSync 平台、改造 `/changelog` 前端展示，或提交更新日志 MR 时，使用这个 skill。

这个 skill 不只服务“手工改静态页面”，也服务未来的动态链路：

```text
PRD/需求阶段判断是否需要产品动态
  -> 创建/关联 TAPD
  -> 功能分支/MR 关联 TAPD
  -> Agent 产出动态日志草稿
  -> AutoSync 入库与状态流转
  -> 前端只展示已发布动态
```

## 核心原则

- 先读仓库规范。至少读取根目录 `AGENTS.md`；涉及前端、截图、HTML 插图或视觉风格判断时，必须读取 `frontend/AGENTS.md`。
- 若任务匹配仓库本地 skill，按根 `AGENTS.md` 约定读取 `.agents/skills/<skill-name>/SKILL.md`。
- 只把用户可感知的产品能力写入产品动态。内部重构、配置、CI、基础设施、纯后端支撑默认不写，除非它们明显改变了用户体验。
- 国内站和国际站分开判断，不要把国内通道、国内截图或国内文案带到国际站。
- 不默认依赖 Chrome Use、图片生成工具或线上登录态；不同 Agent 能力不同，流程必须可降级。
- 不要把 token、密码、SSH、内部敏感信息写入动态内容、截图、提交信息、MR 描述或最终回答。
- `git commit`、`git push`、创建 MR 前，必须先向用户展示提交内容和 MR 信息并等待确认。

## 三种工作模式

根据用户当前任务选择模式，不要把所有步骤都强行执行。

### 模式 A：需求阶段埋点

适用于 prd-init、feai-start、需求初始化或产品需求讨论阶段。

目标：在需求还没进入开发前，判断它是否需要未来出现在产品动态/更新日志里，并把这件事通过 TAPD 和分支关联沉淀下来。

### 模式 B：动态日志内容产出

适用于 AutoSync Agent 或内容生成 Agent。

目标：从 TAPD、MR、提交记录、用户补充材料中提炼出可录入 AutoSync 的结构化产品动态草稿，包括标题、摘要、月份、站点、状态、图片方案和来源链接。

### 模式 C：前端展示或静态页面兼容维护

适用于前端改造或当前静态 `/changelog` 页面维护。

目标：前端读取已发布动态并展示；在动态数据源未落地前，可以继续兼容修改 `frontend/src/pages/marketing/changelog-page.tsx` 和 `frontend/public/assets/changelog/`。

## 模式 A：需求阶段埋点

在 PRD/需求初始化阶段，增加“是否需要产品动态”的判断。

### 判断条件

如果需求满足以下任一条件，应询问用户是否创建产品动态 TAPD：

- 新增用户可见功能。
- 用户入口、核心流程、关键页面发生变化。
- 支持新的通道、平台、能力模块或集成方式。
- 对外需要感知的体验升级。
- 需要在官网、控制台或发布材料中告知用户。

通常不需要产品动态的情况：

- 纯代码重构。
- 内部配置调整。
- CI、测试、构建、监控改动。
- 仅修复用户无感的小 bug。
- 后端支撑已完成，但没有前端入口或用户可感知能力。

### 需求确认阶段新增问题

在需求确认文档中加入一项：

```md
## 产品动态

- 是否需要对外更新动态：是 / 否 / 待确认
- 原因：
- 目标站点：国内站 / 国际站 / 两者
- 建议发布时间或月份：
- 建议标题：
- 建议描述：
- 配图方案：用户提供截图 / 生成 HTML 插图 / 暂不确定
```

### 创建或补充 TAPD

如果用户确认需要产品动态：

1. 创建或补充一个产品动态相关 TAPD，标题建议：

```text
【产品动态】LightVela 支持 <能力名称>
```

2. TAPD 内容建议包含：
   - 关联原始需求 TAPD。
   - 关联功能分支或 MR。
   - 功能名称。
   - 用户价值。
   - 目标站点：`cn` / `global` / `all`。
   - 建议月份。
   - 截图方案。
   - 验收条件：内容已确认、图片已确认、发布状态已确认。

3. 分支需要关联 TAPD，便于 AutoSync Agent 后续从 TAPD 反查分支、MR 和发布状态。

TAPD 操作需遵循仓库和 TAPD skill 的调用规范，使用 `mcporter-internal call tapd...`。批量或危险操作需先确认。

## 模式 B：动态日志内容产出

动态日志 Agent 的职责是“产出内容”，不是直接发布线上。除非用户明确要求并提供平台接口规范，否则不要擅自写数据库或改发布状态。

### 输入来源

优先按以下顺序读取：

1. 产品动态 TAPD。
2. 关联原始需求 TAPD。
3. 关联 MR、分支和提交记录。
4. 用户补充的截图、说明和发布时间。
5. 相关前端实现代码。

### 候选更新筛选

从 MR 或提交中发现候选更新时，按月份归类，并标记：

- `feature`：用户可见产品能力，优先进入动态。
- `experience`：体验、流程、文案或页面调整，视影响决定。
- `internal`：内部实现、配置、CI、发布支撑，通常不写。

候选列表建议格式：

```md
- 功能：
- 月份：
- 类型：feature / experience / internal
- 建议标题：
- 建议描述：
- 用户价值：
- 站点：cn / global / all
- 是否需要配图：
- 来源：TAPD / MR / commit
```

先给用户确认候选列表，再生成正式草稿。

### 文案规则

- 标题优先使用 `LightVela 支持...`、`LightVela 新增...` 等产品化表达。
- 描述控制在一句话，强调用户价值，不写实现细节。
- 避免 MR、接口、数据库、配置项等工程化词汇。
- 风格要和现有更新日志一致。
- 如果用户给了指定标题或描述，优先保留；只在明显不通顺或不准确时微调。

#### 国际站英文标题大小写

- 国际站（`global` / 国际站）更新日志标题统一使用 Title Case；只处理标题，不改描述。
- 首字母大写：第一个和最后一个词、名词、代词、动词（包括 `Is` / `Are`）、形容词、副词，以及品牌和产品名。
- 通常小写：冠词 `a` / `an` / `the`（首尾词除外）、短介词 `as` / `at` / `by` / `for` / `from` / `in` / `of` / `on` / `to` / `via` / `with`，以及短并列连词 `and` / `but` / `or` / `nor` / `so` / `yet`。
- 保留产品名原有大小写，例如 `LightVela`、`Hermes`、`Agent`、`Skill`、`WeCom`、`ClawHub`、`skills.sh`。
- 示例：使用 `Diagnostics Center Is Here for Faster Agent Troubleshooting`，不要写成 `Diagnostics Center is Here For Faster Agent Troubleshooting`。

### AutoSync 草稿 Payload

动态日志 Agent 应产出结构化 payload，交给 AutoSync 平台或后续 Agent 入库。

推荐字段：

```json
{
  "external_key": "tapd:10132091:<tapd_id>",
  "source_type": "tapd",
  "source_id": "<tapd_id>",
  "title": "LightVela 支持云存储",
  "summary": "现在可以在 LightVela 中查看和管理 Hermes Agent 的云存储文件，上传、下载、整理工作资料更方便。",
  "month": "2026-06",
  "site": "cn",
  "category": "feature",
  "status": "draft",
  "asset": {
    "type": "image",
    "source": "user_upload",
    "path": "lightvela-cloud-storage.png",
    "aspect_ratio": "2140 / 1532"
  },
  "links": {
    "tapd": "https://tapd.woa.com/...",
    "mr": "https://git.woa.com/..."
  }
}
```

字段说明：

- `external_key`：幂等键，避免重复录入。优先使用 `tapd:<workspace_id>:<tapd_id>`，没有 TAPD 时可用 `mr:<project>:<iid>`。
- `status`：默认 `draft`，不要直接写成已发布，除非用户或 AutoSync 流程明确确认。
- `site`：`cn`、`global` 或 `all`。
- `category`：`feature` 或 `experience`，避免过细分类。
- `asset.source`：`user_upload`、`html_render`、`live_screenshot`、`none`。

### 状态流转建议

AutoSync 平台可使用如下状态机：

```text
draft
  -> pending_review
  -> ready_to_publish
  -> published_online
  -> archived
```

状态含义：

- `draft`：Agent 自动生成，尚未人工确认。
- `pending_review`：等待产品/运营确认文案、图片和月份。
- `ready_to_publish`：已确认，可以发布。
- `published_online`：已发布至线上，前端可以展示。
- `archived`：废弃、过期或不再展示。

自动流转规则建议：

- 如果 TAPD 已完成，或人工确认发布，则 AutoSync 可将状态转为 `published_online`。
- 如果 TAPD 未完成但内容已生成，保持 `draft` 或 `pending_review`。
- 如果功能 MR 未合入，不要标记为 `published_online`。

## 图片素材策略

不要默认依赖 Chrome Use、图片生成工具或线上登录态。每次需要新增配图时，先让用户在两个方案中选择：

### 方案一：用户提供截图（推荐）

- 使用用户提供的截图作为真实产品画面。
- 只做必要裁剪、比例统一、压缩和资源落位。
- 尽量保留真实 UI，不额外添加装饰。
- 如果用户提供多张图，按用户说明或更新条目顺序映射。

### 方案二：生成 HTML 插图

- 根据选定功能范围，创建一个局部产品能力展示 HTML。
- HTML 必须基于 LightVela 核心设计语言和真实前端组件形态，不要凭空设计。
- 如果当前环境有浏览器截图能力，将 HTML 渲染为 PNG 后接入动态草稿或静态页面。
- 如果当前 Agent 没有浏览器截图能力，保留 HTML 文件，并说明需要用户或具备截图能力的 Agent 完成转 PNG。

只有在用户明确要求，或当前 Agent 具备能力且用户允许时，才使用 Chrome Use 访问线上 `lightvela.com` 截图。线上截图只是可选增强，不是必需步骤。

## LightVela 设计语言来源

生成 HTML 插图时，必须优先读取并参考：

- `frontend/AGENTS.md`
- `frontend/src/pages/marketing/changelog-page.tsx`
- `frontend/public/assets/changelog/`
- 对应功能的真实前端实现，例如通道、云存储、成就、记忆、自动任务、网页对话等组件。

保持 LightVela 的核心设计语言：

- 浅灰页面背景。
- 白色卡片。
- 克制圆角。
- 细边框。
- 柔和阴影。
- 黑白主操作按钮。
- 低饱和标签和状态提示。
- 清晰的信息层级。
- 产品 UI 优先，装饰性插图其次。

配图尺寸优先贴近现有更新日志图片比例。若使用新比例，必须同步记录 `aspect_ratio`；静态页面模式下还要同步更新 `VisualCard` 的 `aspectRatio`。

## 模式 C：前端展示与静态兼容

### 动态数据前端读取

前端不要直接读数据库。应通过 API 或 repository 方法读取已发布动态。

推荐接口：

```http
GET /api/product-updates?site=cn&status=published_online&locale=zh-CN
```

推荐类型：

```ts
type ProductUpdate = {
  id: string;
  title: string;
  summary: string;
  month: string;
  category: "feature" | "experience";
  site: "cn" | "global" | "all";
  status: "published_online";
  imageUrl?: string;
  imageAspectRatio?: string;
  publishedAt: string;
  source?: {
    tapdId?: string;
    mrUrl?: string;
  };
};
```

推荐 repository 方法：

```ts
async function listPublishedProductUpdates(params: {
  site: "cn" | "global";
  locale: "zh-CN" | "en-US";
}): Promise<ProductUpdate[]>
```

展示规则：

- 只展示 `status = published_online` 的记录。
- 按 `month` 倒序分组。
- 同月多条继续使用点-线-点 timeline。
- 图片使用 `imageUrl` 和 `imageAspectRatio`。
- 接口失败时，可以短期 fallback 到静态 changelog 数据。

### 静态页面兼容维护

动态数据源未落地前，可以继续维护现有静态文件。

常见修改文件：

- `frontend/src/pages/marketing/changelog-page.tsx`
- `frontend/public/assets/changelog/*`
- `frontend/src/i18n/generated/en-US.json`
- `frontend/src/i18n/generated/zh-CN.json`
- `frontend/src/i18n/generated/zh-to-key.json`

新增中文文案后：

```bash
cd frontend
pnpm i18n:extract
pnpm i18n:check
```

新增图片后：

1. 放到 `frontend/public/assets/changelog/`。
2. 使用清晰文件名，例如：
   - `lightvela-cloud-storage.png`
   - `lightvela-achievements.png`
   - `lightvela-wecom-channel.png`
3. 检查图片实际尺寸。
4. 在 `VisualCard` 中同步新增 variant、图片路径、alt 文案和 `aspectRatio`。

## 预览和验证

前端或静态页面编辑完成后运行：

```bash
cd frontend
pnpm check
pnpm i18n:check
pnpm dev --host 127.0.0.1 --port <可用端口> --strictPort
```

预览 `/changelog` 时检查：

- 月份分组是否正确。
- 同月多条更新是否使用点-线-点 timeline 样式。
- 文案是否清楚、克制、产品化。
- 图片是否比例正确，没有横向或纵向压缩。
- 图片内容是否能表达该功能能力。
- 国内站和国际站是否符合预期。
- 动态数据模式下，未发布状态不应展示。

## 提交和 MR

提交前：

1. 合并最新 `origin/master`。
2. 如 i18n 生成文件冲突，保留 master 新增文案，再运行 `pnpm i18n:extract` 重新生成。
3. 重新运行验证命令。
4. 展示 staged diff、拟提交信息和拟 MR 信息，等待用户确认。

提交信息和 MR 标题遵循仓库当前约定，优先中文在前、英文补充在后。

提交信息示例：

```bash
更新 6 月产品动态 / feat(changelog): update June feature entries
```

MR 标题示例：

```bash
更新 6 月产品动态 / feat: update June changelog entries
```

MR 描述建议包含：

```md
## 变更内容
- ...

## 验证
- pnpm check
- pnpm i18n:check
- 本地 /changelog 预览
```

创建 MR 时按仓库规范关联 TAPD，并添加需要的标签。
