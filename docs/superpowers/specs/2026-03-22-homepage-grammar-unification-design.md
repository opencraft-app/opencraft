# Homepage Grammar Unification Design

## Goal

把 `https://lightclaw.pages.dev` 首页的视觉语言和版式气质，沉淀成一套可复用的页面语法，并先在 `style-lab` 中落成真相源。

目标不是只统一颜色和按钮，而是统一：

- 页面节奏
- 版式层级
- 文案层级
- 表面系统
- 控制台页面如何继承首页气质

第一阶段只改：

- `frontend/src/pages/app/style-lab-page.tsx`

但这个页面要承担的职责是：

- 成为 `Lightclaw` 的页面语法实验室
- 成为首页语言向 app 页面翻译的规范样板
- 为后续登录、计划页、dashboard、workspace、settings 提供直接可复用的原语

## Problem

当前站点存在两套明显不同的语言：

- 首页更像品牌叙事页
  - 大留白
  - 编辑式节奏
  - 更强的块面关系
  - 更有辨识度的标题层级
- 其他页面更像常规 app / shadcn 组合页面
  - 信息组织更“后台”
  - 节奏更均匀
  - 表面系统更中性
  - 和首页不像同一产品

如果直接逐页改，会快速变成“局部模仿首页”，而不是建立统一的设计系统。

## Design Direction

推荐方向：

- 统一到首页的**版式气质**，不只是视觉 token
- 但不把 app 页面做成营销页复制品
- 统一的是“语言”，不是“模板”

这套语言可以概括为：

- warm neutral 的背景系统
- 高对比但不过度装饰的标题体系
- 大块面之间有明显呼吸感
- 面板不是通用后台卡片，而是具有编辑感和控制感的 surfaces
- 页面从上到下有清晰的 narrative cadence，而不是平均分布的卡片网格

## Non-Goals

- 不在第一阶段重写首页本身
- 不在第一阶段逐页改完整个 app
- 不在 `style-lab` 里做组件展馆式“全量 catalog”
- 不把 dashboard 强行改成营销 hero
- 不新增复杂主题系统或多品牌主题切换

## Why Style Lab First

`style-lab` 应该成为设计系统的真相源，而不是调色盘页。

如果先把这里做好，后续页面统一时会得到：

- 明确的页面级原语
- 明确的 block 级变体
- 明确的排版与 spacing 规则
- 首页语言向 app 语言的翻译样例

这样其他页面会自然一致，因为它们复用的是同一套 grammar，而不是人工对齐截图。

## Core Design Grammar

### 1. Page Rhythm

页面节奏不再是均匀堆叠 section。

应该形成：

- 一个强起始区块
- 若干呼吸充分的 section
- section 间明显的密度变化
- 紧内容 + 宽留白交替出现

规则：

- 不使用平均高度的内容段落
- 不用后台式“卡片阵列 = 页面”
- 用不对称组合制造层次

### 2. Narrative Hierarchy

首页最有价值的不是颜色，而是文案层级关系：

- section eyebrow
- 大标题
- 一句说明
- 次级支撑信息

这套结构应推广到 app 页面。

例如：

- settings 页标题不只是 “Settings”
- 而应有：
  - eyebrow
  - primary heading
  - short operational description

### 3. Surface System

需要统一 surface，不再默认用通用 shadcn card 当所有容器。

建议定义四级 surface：

- `bare`
  - 几乎无容器，只靠排版和背景层区分
- `line`
  - 轻描边、轻底色、用于解释性内容
- `panel`
  - 主控制面板，适合表单、数据、设置块
- `control`
  - 更强对比、偏 terminal / operator surface，用于 dashboard/workspace 关键区

原则：

- 不嵌套 card inside card
- container 的存在必须有理由
- 通过 surface 层级表达重要性，而不是全都同一种盒子

### 4. Typography

统一首页字体气质：

- 标题更有编辑感
- 正文更克制
- 数字和 label 要有清晰技术感，但不依赖“全站等宽”

规则：

- display typography 只用于关键页面起始区和 section 标题
- body typography 保持稳定可读
- monospace 只用于 terminal/data/control 语境

### 5. Color and Contrast

沿用首页的 warm neutral 基底，不走默认 dashboard 灰蓝路线。

规则：

- 主背景和中性背景保持轻微暖色偏移
- 深色文本不使用纯黑
- 强强调面不依赖高饱和渐变
- 交互色要服务操作，而不是做装饰

### 6. App Translation

首页语法进入 app 后，需要有翻译规则：

- homepage hero -> app section intro
- homepage editorial panel -> settings / plan / dashboard feature block
- homepage action cluster -> app command / CTA cluster
- homepage atmospheric background -> app page field / shell framing

关键点：

- app 仍然是工具界面
- 但应该看起来像“来自同一品牌世界的工具界面”

## Style Lab Structure

`style-lab` 不再只是零散组件展示，而是分成几组：

### Foundations

展示：

- background fields
- key neutrals
- accent usage
- spacing rhythm
- border / shadow / radius language

### Type and Narrative

展示：

- eyebrow
- hero heading
- section heading
- supporting copy
- operational copy

### Surface Families

展示：

- bare
- line
- panel
- control

每种都给出：

- 适用场景
- 应搭配的 typography
- 不该出现的场景

### Action Language

展示：

- primary CTA
- secondary CTA
- tertiary / text action
- inline action cluster

重点不是按钮样式，而是 action hierarchy。

### App Mappings

这是第一阶段最关键的一组。

直接展示首页语言如何翻译到：

- sign-in shell
- plan selection section
- dashboard summary intro
- workspace control header
- settings profile block
- empty state

也就是说，`style-lab` 本身要包含“未来页面片段”的标准样板。

## Component Strategy

不建议在第一阶段新建大量零散基础组件。

建议只抽**页面语法级**原语：

- `PageField`
- `SectionIntro`
- `SurfaceBlock`
- `ActionCluster`
- `ControlPanel`

这些原语应该服务页面结构，不只是视觉皮肤。

已有 `shadcn/ui` 基础组件继续保留，但它们退到更底层：

- button
- input
- tabs
- dialog

页面真实气质由新的 grammar primitives 决定。

## Implementation Scope for Phase 1

只改 `style-lab`，但允许顺手抽出它所需的共享原语。

会做的：

- 重新组织 `style-lab` 内容结构
- 建立 homepage grammar 的 section 体系
- 建立基础 surface 变体
- 建立 app translation demos
- 调整样式 token 与页面级容器逻辑

不会做的：

- 同 turn 内重写所有 app 页面
- 改首页信息架构
- 建立庞大设计系统文档站

## Testing

至少补这几类验证：

- `style-lab` 渲染测试
- 关键 section 文案存在性测试
- 新增 grammar primitives 的基本 smoke tests
- `pnpm build`

人工验收标准：

- `style-lab` 一眼就能看出与首页是同一套语言
- 同时又能看出这套语言如何进入 app 页面，而不是只适用于 marketing
- 页面整体不再是组件样板间，而是设计手册

## Follow-up Phases

完成 `style-lab` 后，按下面顺序扩散：

1. auth shell / sign-in / sign-up
2. plan select
3. dashboard
4. workspace
5. settings / profile

每一步都以 `style-lab` 为真相源，不再单独发明页面语言。

## Recommendation

按这个设计推进时，判断标准不是“像不像首页”，而是：

- 是否共享同一套 grammar
- 是否让 app 页面获得首页的品牌气质
- 是否在不牺牲工具效率的前提下完成统一

如果后续页面严格复用 `style-lab` 中沉淀出的原语，那么全站统一会自然发生，而不是靠一次次视觉返工。
