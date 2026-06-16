# mono2 Docs Site

Root-level Fumadocs portal for mono2.

The first curated section is CloudAgent, with AI-friendly entrypoints for agents
and integration clients.

## Local Development

```bash
cd docs-site
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:3000
```

## Verification

```bash
npm run typecheck
npm run build
```

From the repository root, run the divided generation flow:

```bash
./makedocs.sh
```

## AI Entry Points

| URL | Purpose |
| --- | --- |
| `/llms.txt` | Compact AI index generated from the Fumadocs page tree. |
| `/llms-full.txt` | Full text export of curated docs. |
| `/docs-index.json` | Machine-readable docs index. |
| `/cloudagent-endpoints.json` | Compact endpoint inventory derived from the CloudAgent OpenAPI schema. |

## Generated API Docs

CloudAgent OpenAPI is generated from the Go protocol spec:

```text
cloudagent/gateway/internal/wrapper/cloudagent_run_spec.go
```

Run the divided docs generator from the repository root:

```text
./makedocs.sh
```

It writes:

```text
docs-site/openapi/cloudagent.json
```

Fumadocs provides the mono2-wide shell. Scalar renders the interactive API
reference at `/reference/cloudagent`, embedded by `/docs/cloudagent/api`.

## Content Policy

- Keep source MDX readable without running the web app.
- Use frontmatter for `owner`, `status`, `last_reviewed`, `tags`, and
  `source_path`.
- Keep CloudAgent gateway engineering docs under `cloudagent/gateway/docs` for
  the first slice; copy curated public-facing content into `docs-site`.
- Generate full OpenAPI-style contracts from route/schema truth before treating
  them as canonical.
