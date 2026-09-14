import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const input = resolve(process.argv[2] ?? "protocol/upstream/codex_app_server_protocol.schemas.json");
const output = resolve(process.argv[3] ?? "protocol/generated/app-server-manifest.json");
const bytes = await readFile(input);
const schema = JSON.parse(bytes);

function envelopeMethods(definitionName) {
  const variants = schema.definitions?.[definitionName]?.oneOf ?? [];
  return variants.flatMap((variant) => {
    const method = variant.properties?.method?.enum?.[0];
    if (typeof method !== "string") return [];
    return [{
      method,
      title: variant.title ?? null,
      paramsRef: variant.properties?.params?.$ref ?? null,
      paramsType: variant.properties?.params?.type ?? null,
      paramsRequired: variant.required?.includes("params") ?? false,
    }];
  });
}

const manifest = {
  schemaTitle: schema.title,
  schemaDraft: schema.$schema,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  definitions: {
    root: Object.keys(schema.definitions ?? {}).length,
    v2: Object.keys(schema.definitions?.v2 ?? {}).length,
  },
  clientRequests: envelopeMethods("ClientRequest"),
  clientNotifications: envelopeMethods("ClientNotification"),
  serverRequests: envelopeMethods("ServerRequest"),
  serverNotifications: envelopeMethods("ServerNotification"),
};

await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`projected ${manifest.clientRequests.length} client requests from ${manifest.sha256}`);
