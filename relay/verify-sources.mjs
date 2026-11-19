import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const base = new URL('./', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('sources.json', base), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw Error('Invalid provenance manifest');
const seen = new Set();
for (const file of manifest.files) {
  if (!file.path.startsWith('recovery/mono2/') || file.path.split('/').some(p => p === '..' || !p)
    || seen.has(file.path) || file.sourceRevision !== manifest.mono2Revision) throw Error('Invalid source entry');
  seen.add(file.path);
  if (hash(await readFile(new URL(file.path, base))) !== file.sha256) throw Error(`Source differs: ${file.path}`);
}
const evidence = new URL('.evidence/live-relay.mjs', base);
let hasEvidence = false;
try { await stat(evidence); hasEvidence = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (hasEvidence && hash(await readFile(evidence)) !== manifest.runtime.bundleSha256) throw Error('Runtime bundle differs');
console.log(`Verified ${seen.size} recovered source files; local runtime evidence ${hasEvidence ? 'verified' : 'not present (optional)'}.`);
