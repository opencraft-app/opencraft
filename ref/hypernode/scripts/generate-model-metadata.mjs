import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

const records = [];
for (const provider of getBuiltinProviders()) {
  for (const model of getBuiltinModels(provider)) {
    records.push({
      provider,
      id: model.id,
      name: model.name,
      api: model.api,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: Array.isArray(model.input) ? [...model.input] : ["text"],
    });
  }
}
records.sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
const target = resolve("policy/src/generated/model-metadata.ts");
await mkdir(dirname(target), { recursive: true });
await writeFile(target,
  "// Generated from @earendil-works/pi-ai; do not edit by hand.\n" +
  "import type { ModelMetadataRecord } from \"../types/model-metadata.ts\";\n" +
  `export const modelMetadata = ${JSON.stringify(records, null, 2)} as const satisfies readonly ModelMetadataRecord[];\n`,
);
console.log(`generated ${records.length} model metadata records from ${getBuiltinProviders().length} providers`);
