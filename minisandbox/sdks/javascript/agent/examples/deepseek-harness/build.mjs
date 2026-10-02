import { build } from "esbuild";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "dist/worker.js");
const llmEntry = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-llm"));
const llmPackage = JSON.parse(await readFile(join(dirname(llmEntry), "../package.json"), "utf8"));

const buildResult = await build({
	entryPoints: [join(root, "worker.ts")],
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	minify: true,
	alias: {
		"node:module": join(root, "compat/node-module.ts"),
	},
	define: {
		DSH_LLM_VERSION: JSON.stringify(llmPackage.version),
	},
	external: ["node:*", "cloudflare:workers"],
	metafile: true,
	outfile: output,
});

const maxModuleBytes = 1 << 20;
const outputSize = (await stat(output)).size;
if (outputSize > maxModuleBytes) {
	throw new Error(`Harness bundle is ${outputSize} bytes; Worker modules are limited to 1 MiB`);
}

const allowedImports = new Set([
	"cloudflare:workers",
	"node:async_hooks",
	"node:crypto",
	"node:path",
	"node:util",
	"node:util/types",
]);
for (const metadata of Object.values(buildResult.metafile.outputs)) {
	for (const imported of metadata.imports.filter((entry) => entry.external)) {
		if (!allowedImports.has(imported.path)) {
			throw new Error(`Harness bundle contains an unreviewed external import: ${imported.path}`);
		}
	}
}
