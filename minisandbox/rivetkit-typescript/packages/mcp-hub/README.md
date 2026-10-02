# Rivet Docs MCP Server

This package exposes a fully static Model Context Protocol (MCP) server that serves Rivet documentation
using generated documentation metadata. It provides:

- `createDocsMcpServer` — registers the docs/search/get/list tools, prompts, and resources.
- `createSseResponse` — helper for Fetch/Request handlers (Astro, Workers, Next.js, etc.).
- `cli` entry point (`pnpm --filter @rivetkit/mcp-hub run build && node dist/cli.js`) for a quick local server.

## Updating metadata

The public documentation is maintained outside this workspace. Set `DOCS_METADATA_PATH` to its
generated `docs.json` artifact at runtime, or pass a `DocsMetadata` value to
`createDocsMcpServer({ metadata })` when embedding the server.

## Building / running

```bash
# Emit JS + type definitions for the MCP package
pnpm --filter @rivetkit/mcp-hub run build

# Run the bundled CLI (HTTP SSE endpoint on http://localhost:7332/mcp by default)
DOCS_METADATA_PATH=/path/to/docs.json \
	node rivetkit-typescript/packages/mcp-hub/dist/cli.js
```

## Embedding in an HTTP handler

```ts
import { createDocsMcpServer, createSseResponse } from "@rivetkit/mcp-hub";

const { server } = createDocsMcpServer();

export default {
	async fetch(request: Request) {
		// Reuse a single transport internally; returns a web-standard Response.
		return createSseResponse(server, request);
	},
};
```

See `src/index.ts` for more examples (tools, prompts, resources) if you want to compose custom transports.
