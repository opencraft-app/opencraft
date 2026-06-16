# mono2 Docs Site / mono2 文档站

Root-level Fumadocs portal for mono2.

mono2 的根目录级 Fumadocs 文档门户。

The first curated section is CloudAgent, with AI-friendly entrypoints for agents
and integration clients.

第一期重点是 CloudAgent，为 Agent 和集成客户端提供 AI-friendly 入口。

## Bilingual Policy / 双语策略

v1 uses an in-place English/Chinese toggle instead of locale routing.

v1 采用原位 EN/中文切换，不先做 `/zh`、`/en` 这类 locale routing。

This keeps URLs stable for humans, agents, and generated indexes while letting
readers switch the visible language without duplicate paragraphs.

这样可以保持人类、Agent 和生成式索引使用的 URL 稳定，同时避免中英文段落堆叠。

## Local Development / 本地开发

```bash
cd docs-site
npm install
npm run dev
```

Open / 打开：

```text
http://127.0.0.1:3000
```

## Verification / 验证

```bash
npm run typecheck
npm run build
```

From the repository root, run the divided generation flow:

从仓库根目录运行分治生成流程：

```bash
./makedocs.sh
```

## AI Entry Points / AI 入口

| URL | Purpose / 用途 |
| --- | --- |
| `/llms.txt` | Compact AI index generated from the Fumadocs page tree. 从 Fumadocs 页面树生成的紧凑 AI 索引。 |
| `/llms-full.txt` | Full text export of curated docs. 精选文档的全文导出。 |
| `/docs-index.json` | Machine-readable docs index. 机器可读文档索引。 |
| `/cloudagent-endpoints.json` | Compact endpoint inventory derived from the CloudAgent OpenAPI schema. 从 CloudAgent OpenAPI schema 派生的紧凑 endpoint inventory。 |

## Generated API Docs / 生成式 API 文档

CloudAgent OpenAPI is generated from the Go protocol spec:

CloudAgent OpenAPI 从 Go 协议 spec 生成：

```text
cloudagent/gateway/internal/wrapper/cloudagent_run_spec.go
```

Run the divided docs generator from the repository root:

从仓库根目录运行分治文档生成器：

```text
./makedocs.sh
```

It writes:

它会写入：

```text
docs-site/generated/docs-index.fragments.json
docs-site/generated/docs-index/<component>.json
docs-site/generated/llms/<component>.txt
docs-site/content/docs/components/<component>.mdx
docs-site/openapi/<api-id>.json|yaml        # when a component exposes OpenAPI
docs-site/asyncapi/<api-id>.json|yaml       # when a component exposes AsyncAPI
```

Fumadocs provides the mono2-wide shell. Scalar renders any generated OpenAPI
surface at `/reference/<api-id>`. The root docs generator indexes first-level
directories without business-specific knowledge:

- Level 0: no component script; index README, AGENTS, TEST, shallow docs, and API specs.
- Level 1: component `makedocs.sh` owns docs-index and LLM fragments.
- Level 2: Level 1 plus OpenAPI or AsyncAPI surfaces.

Fumadocs 提供 mono2-wide 文档外壳。Scalar 会在 `/reference/<api-id>` 渲染任意生成的 OpenAPI 面。根文档生成器在不理解业务细节的前提下索引一级目录：

- Level 0：没有组件脚本；索引 README、AGENTS、TEST、浅层 docs 和 API spec。
- Level 1：组件级 `makedocs.sh` 自己维护 docs-index 和 LLM fragment。
- Level 2：Level 1 加上 OpenAPI 或 AsyncAPI 面。

## Content Policy / 内容策略

- Keep source MDX readable without running the web app.
- Use `lang-en` and `lang-zh` spans for curated docs so content switches in place.
- Use frontmatter for `owner`, `status`, `last_reviewed`, `tags`, and
  `source_path`.
- Keep component-specific engineering docs in their owning directories; copy
  curated public-facing content into `docs-site` only when it needs hand-written
  presentation.
- Generate full OpenAPI-style contracts from route/schema truth before treating
  them as canonical.

- 源 MDX 在不运行 Web app 的情况下也应可读。
- 精选文档使用 `lang-en` 和 `lang-zh` 片段，让内容在同一位置切换。
- 使用 frontmatter 记录 `owner`、`status`、`last_reviewed`、`tags` 和
  `source_path`。
- 组件工程文档保留在各自目录；只有需要手写呈现的对外精选内容才复制到
  `docs-site`。
- 完整 OpenAPI 风格契约必须从 route/schema truth 生成，生成后才能作为 canonical contract。
