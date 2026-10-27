import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Maintained artifact patch for the pinned rc.2 runtime. No alternate storage:
// disabled profiles remain in their original adapter settings namespaces.
export const providerLifecycleEdits = [
  ['const Config = z.object({ providers: z.dict(profile).default({}) });', 'const Config = z.object({ providers: z.dict(profile).default({}), modelSelection: z.dict(z.array(z.string())).default({}) });'],
  ["const profile = z.object({\n\tapiKeyEnv:", "const profile = z.object({\n\tenabled: z.boolean().default(true),\n\tapiKeyEnv:"],
  ['\t\tif (source.baseURL !== void 0 && source.baseURL.length === 0)', '\t\tif (source.enabled === false) continue;\n\t\tif (source.baseURL !== void 0 && source.baseURL.length === 0)'],
  ['\t\tconst entries = directoryEntries(profiles());', '\t\tconst entries = directoryEntries(new Map(Object.entries(current().providers ?? {}).map(([id, value]) => [id, { displayName: value.displayName ?? id }])));'],
];
export const nativeProviderLifecycleEdits = [
  ['const Config = z.object({\n\tapiKeyEnv:', 'const Config = z.object({\n\tenabled: z.boolean().default(true),\n\tapiKeyEnv:'],
  ['const registration = ctx.llm.registerAdapter([PROVIDER], adapter);', 'let registration = current().enabled === false ? null : ctx.llm.registerAdapter([PROVIDER], adapter);'],
  ['const ensureRegistrationFacts = () => {\n\t\tconst policy = options().retryPolicy;', 'const ensureRegistrationFacts = () => {\n\t\tif (current().enabled === false) {\n\t\t\tregistration?.();\n\t\t\tregistration = null;\n\t\t\treturn;\n\t\t}\n\t\tconst policy = options().retryPolicy;\n\t\tif (registration === null) {\n\t\t\tregistration = ctx.llm.registerAdapter([PROVIDER], adapter);\n\t\t\tregisteredPolicy = policy;\n\t\t\treturn;\n\t\t}'],
];
export async function patchDshProviderLifecycle(runtime) {
  const outputs = [];
  for (const [module, edits] of [["dsh-llm-pi-ai", providerLifecycleEdits], ["dsh-llm-deepseek", nativeProviderLifecycleEdits]]) {
    const path = resolve(runtime, `node_modules/@deepseek-ai/${module}/lib/index.js`);
    let source = await readFile(path, "utf8");
    for (const [before, after] of edits) {
      if (source.includes(after)) continue;
      if (source.split(before).length !== 2) throw new Error("Pinned DSH provider lifecycle patch no longer matches; review the runtime version before packaging");
      source = source.replace(before, after);
    }
    outputs.push([path, source]);
  }
  // Validate every adapter before writing any artifact.
  for (const [path, source] of outputs) await writeFile(path, source);
}
