// Emit a public, build-time browsing projection. Runtime state is never copied.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
if (!process.argv[2]?.trim()) throw new Error('Usage: node scripts/export-hermes-connector-catalog.mjs <marketplace-directory>; this optional product snapshot is not included in OpenCraft.');
const root = process.argv[2];
const manifest = JSON.parse(readFileSync(join(root, '.codebuddy-connector/connectors.json'), 'utf8'));
console.log('// Generated marketplace browsing snapshot. No VM connection or credentials required.');
console.log('import type { ConnectorCard, ConnectorDetail } from "./connector-client";');
console.log('export type BrowseConnector = ConnectorCard & ConnectorDetail;');
console.log('export const connectorCatalog: BrowseConnector[] = [');
for (const d of manifest.connectors) {
  const id = d.source ?? d.id;
  if (!/^[\w-]+$/.test(id)) throw new Error('Unsafe marketplace ID');
  const schema = join(root, 'connectors', id, 'token-schema.json');
  const raw = existsSync(schema) ? JSON.parse(readFileSync(schema, 'utf8')) : undefined;
  const tokenSchema = raw ? { description: raw.description, fields: raw.fields.map(f => ({
    key: f.key, label: f.label, required: f.required, secret: f.secret, type: f.type,
  })) } : undefined;
  const entry = {id, name: d.name_zh ?? d.name ?? d.name_en ?? id,
    description: d.description_zh ?? d.description ?? d.description_en ?? '',
    type: d.type ?? 'mcp', authMode: d.auth_mode ?? 'native', status: 'disconnected', tools: [],
    hasTokenSchema: Boolean(tokenSchema), tokenSchema,
    definition: { name_zh: d.name_zh, description_zh: d.description_zh, examples_zh: d.examples_zh }};
  const icon = ['svg','png'].find(ext => existsSync(join(root, 'icons', `${id}.${ext}`)));
  console.log(JSON.stringify(entry).slice(0,-1) + (icon ? `,icon: new URL("./icons/${id}.${icon}?no-inline", import.meta.url).href` : '') + '},');
}
console.log('];');
