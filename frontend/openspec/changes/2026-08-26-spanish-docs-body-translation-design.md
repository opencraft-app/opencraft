# 国际站西语 Docs 正文全量适配设计

**日期：** 2026-08-26
**规模：** M
**区域：** `global`，仅 `lightvela.ai/es/docs/**`
**内容底稿：** 国际站英文源 `frontend/src/content/docs/en/**`

## 目标

为当前 61 篇国际站英文文档增加一一对应的拉美西语正文源，使 `/es/docs/**` 不再依赖英文正文回退。翻译保持原文信息架构、事实、步骤、表格、代码、链接和能力边界，不修改图片资源或图片引用路径。

## 明确边界

- 只新增或修改 `frontend/src/content/docs/es/**`、西语 Docs 生成/校验逻辑、对应 OpenSpec 与生成清单。
- 不修改 `frontend/src/content/docs/en/**`、`frontend/src/content/docs/global/**` 或国内站根目录正文。
- 不修改 `frontend/src/content/docs/images/**` 与 `frontend/public/docs-images/**` 的任何图片字节。
- Markdown 图片目标必须与英文源完全一致；图片 alt 文本属于可访问性文案，翻译为西语。
- 法务正文继续保持英文，不纳入 Docs 61 篇正文清单。
- 不借翻译任务修订英文或中文原文；已知原文事实或措辞按当前英文源忠实本地化。
- 产品名、模型名、渠道名、协议名、文件名、命令、代码与 URL 保持原样。

## 方案选择

采用显式西语源文件、分三批落盘：在 `src/content/docs/es/` 创建与 `en/` 完全同构的 61 个 Markdown 文件。每批完成后运行 Docs 同步和定向测试；第三批完成后移除西语 docSet 的英文/中文 fallback，使缺少任一西语正文直接失败。

未采用一次性生成全部 61 篇，因为差异过大，不利于逐批检查术语、Markdown 结构与内部链接。未采用继续英文 fallback 或运行时翻译，因为不能满足西语正文适配，并会带来不稳定输出、SEO 内容漂移和代码块误翻风险。

## 三批边界

1. 第一批 28 篇：Getting Started、Plans & Activation、Features & Configuration、Support。
2. 第二批 16 篇：Use Cases。
3. 第三批 17 篇：Compare & Choose、Hermes Agent Deep Dive。

## 内容规则

- 使用自然、简洁的拉美西语，不使用 `vosotros`。
- 每篇保留与英文源一致的 H1/H2/H3 层级顺序、表格数量和 fenced code block 数量。
- fenced code block 的语言标识与内容逐字保持；只翻译代码块外的解释文字。
- 相对链接和外链目标保持，渲染时由现有同步器改写为 `/es/docs/**`。
- Markdown 图片和 HTML `<img>` 的 `src` 保持；alt 文本翻译为自然西语。
- Warning、FAQ、限制、失败处理和能力边界不得删减或弱化。

## 数据流

```text
src/content/docs/es/**/*.md
        ↓ scripts/sync-fumadocs-content.mjs
.fumadocs-content/docs/es/**/*.mdx
        ↓ fumadocs-mdx
/es/docs/**
```

最终西语 docSet 只读取 `sourcePrefix: "es"`。英文与中文 docSet、sidebar、图片选择和其他 locale 行为保持不变。

## 失败处理

- 缺少西语源：同步或 parity 测试失败，不回退英文。
- 图片路径变化：结构测试失败。
- 代码块、标题层级或表格数量变化：结构测试失败并回读对应页面。
- 内部链接目标无对应西语 slug：parity 测试失败。
- 译文仍出现大段英文正文：按页面回读修正；品牌名、代码、命令和专有名词列入允许范围。

## 验收

1. `src/content/docs/es/` 恰有 61 篇，路径集合与 `en/` 一致。
2. `.fumadocs-content/docs/es/` 的所有 `source_path` 指向 `src/content/docs/es/`。
3. 61 个 `/es/docs/**` slug 均生成，metadata 与导航继续为西语。
4. 英文源与西语源的图片目标、代码块、标题层级和表格结构通过自动校验。
5. `pnpm docs:sync`、Docs parity/image 测试、`pnpm check`、`git diff --check` 通过。
6. `git diff --name-only` 不包含任何图片资源文件。
