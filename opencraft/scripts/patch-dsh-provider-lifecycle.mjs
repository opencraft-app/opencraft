import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Maintained artifact patch for the pinned rc.2 runtime. No alternate storage:
// disabled profiles remain in the original llm-pi-ai settings namespace.
export const providerLifecycleEdits = [
  ['const Config = z.object({ providers: z.dict(profile).default({}) });', 'const Config = z.object({ providers: z.dict(profile).default({}), modelSelection: z.dict(z.array(z.string())).default({}) });'],
  ["const profile = z.object({\n\tapiKeyEnv:", "const profile = z.object({\n\tenabled: z.boolean().default(true),\n\tapiKeyEnv:"],
  ['\t\tif (source.baseURL !== void 0 && source.baseURL.length === 0)', '\t\tif (source.enabled === false) continue;\n\t\tif (source.baseURL !== void 0 && source.baseURL.length === 0)'],
  ['\t\tconst entries = directoryEntries(profiles());', '\t\tconst entries = directoryEntries(new Map(Object.entries(current().providers ?? {}).map(([id, value]) => [id, { displayName: value.displayName ?? id }])));'],
];
export async function patchDshProviderLifecycle(runtime) {
  const path = resolve(runtime, "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js");
  let source = await readFile(path, "utf8");
  for (const [before, after] of providerLifecycleEdits) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error("Pinned DSH provider lifecycle patch no longer matches; review the runtime version before packaging");
    source = source.replace(before, after);
  }
  await writeFile(path, source);
}
