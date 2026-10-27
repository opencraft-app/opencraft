import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import manifestSchema from '../../packaging/full-release/manifest-v1.schema.json' with { type: 'json' };
import preflightSchema from '../../packaging/full-release/preflight-v1.schema.json' with { type: 'json' };

export const BOOTSTRAP_PROTOCOL = 1;
export const AGENT_PROTOCOL = 1;
export const HELPER_PROTOCOL = 1;
export const HARD_LIMITS = Object.freeze({ archiveBytes: 1024 ** 3, unpackedBytes: 4 * 1024 ** 3,
  entries: 100_000, depth: 2, manifestBytes: 16 * 1024 ** 2, metadataBytes: 64 * 1024, npmJsonBytes: 32 * 1024 ** 2,
  diskBytes: 16 * 1024 ** 3, memoryBytes: 512 * 1024 ** 2 });
export const LEGACY_LIMITS = Object.freeze({ archiveBytes: 512 * 1024 ** 2, unpackedBytes: 2 * 1024 ** 3, entries: 20_000 });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('Invalid full release contract'); };

// Parse once with duplicate-key detection, including escaped keys. JSON.parse alone
// silently accepts a different meaning for the same signed object.
export function parseStrictJson(bytes, limit = HARD_LIMITS.manifestBytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > limit) fail();
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(); }
  let cursor = 0;
  const space = () => { while (/[ \t\r\n]/.test(source[cursor] || '') && cursor < source.length) cursor++; };
  const string = () => {
    const start = cursor++;
    while (cursor < source.length) {
      const ch = source[cursor++];
      if (ch === '\\') cursor++;
      else if (ch === '"') return JSON.parse(source.slice(start, cursor));
    }
    fail();
  };
  function value(depth = 0) {
    if (depth > 64) fail();
    space();
    const ch = source[cursor];
    if (ch === '"') return string();
    if (ch === '{') {
      cursor++; space(); const result = Object.create(null), seen = new Set();
      if (source[cursor] === '}') { cursor++; return result; }
      while (cursor < source.length) {
        space(); if (source[cursor] !== '"') fail();
        const key = string(); if (seen.has(key)) fail(); seen.add(key);
        space(); if (source[cursor++] !== ':') fail();
        result[key] = value(depth + 1); space();
        if (source[cursor] === '}') { cursor++; return result; }
        if (source[cursor++] !== ',') fail();
      }
    } else if (ch === '[') {
      cursor++; space(); const result = [];
      if (source[cursor] === ']') { cursor++; return result; }
      while (cursor < source.length) {
        result.push(value(depth + 1)); space();
        if (source[cursor] === ']') { cursor++; return result; }
        if (source[cursor++] !== ',') fail();
      }
    } else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(cursor));
      if (!match) fail(); cursor += match[0].length;
      const result = JSON.parse(match[0]);
      if (typeof result === 'number' && !Number.isSafeInteger(result)) fail();
      return result;
    }
    fail();
  }
  try { const result = value(); space(); if (cursor !== source.length) fail(); return result; }
  catch { fail(); }
}

function validate(schema, value) {
  if ('const' in schema && value !== schema.const) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    for (const key of schema.required) if (!Object.hasOwn(value, key)) fail();
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail();
      validate(schema.properties[key], value[key]);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > schema.maxItems) fail();
    if (schema.prefixItems) schema.prefixItems.forEach((item, index) => validate(item, value[index]));
    if (schema.items) for (const item of value) validate(schema.items, item);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? 8192)
      || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail();
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) fail();
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') fail();
}

export function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\u0000-\u001f\u007f\\]/u.test(path)
    || /[\ud800-\udfff]/u.test(path) || path !== path.normalize('NFC') || path.split('/').some(p => !p || p === '.' || p === '..') || path.includes(':')) fail();
  return path;
}
const reserved = new Set(['release/full-release.json', 'release/full-release.sig']);
export const isSignatureFile = path => reserved.has(path);
export function fileListDigest(files) { return sha256(Buffer.from(JSON.stringify(files))); }
export function validateFileList(files, root) {
  let previous = null, bytes = 0;
  const paths = new Set();
  for (const entry of files) {
    if (!Array.isArray(entry) || entry.length !== 4) fail();
    const [path, digest, size, mode] = entry;
    safePath(path);
    if (reserved.has(path) || !/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(size) || size < 0
      || !['0644', '0755'].includes(mode) || (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(path)) >= 0)
      || (root !== '.' && path !== root && !path.startsWith(root + '/'))) fail();
    let parent = path;
    while (parent.includes('/')) { parent = parent.slice(0, parent.lastIndexOf('/')); if (paths.has(parent)) fail(); }
    paths.add(path); previous = path; bytes += size;
    if (!Number.isSafeInteger(bytes)) fail();
  }
  return bytes;
}

function common(record) {
  const { budgets: b, updater: u, release: r } = record;
  for (const key of ['manifestBytes', 'metadataBytes', 'npmJsonBytes']) if (b[key] > HARD_LIMITS[key]) fail();
  for (const key of ['archiveBytes', 'unpackedBytes', 'entries']) {
    if (b.outer[key] > HARD_LIMITS[key] || u.legacy[key] > LEGACY_LIMITS[key]) fail();
    if (u.bridge && b.outer[key] > LEGACY_LIMITS[key]) fail();
  }
  for (const key of ['unpackedBytes', 'entries', 'depth', 'diskBytes', 'memoryBytes']) if (b.recursive[key] > HARD_LIMITS[key]) fail();
  if (b.recursive.unpackedBytes < b.outer.unpackedBytes || b.recursive.entries < b.outer.entries) fail();
  for (const key of ['createdAt', 'expiresAt']) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r[key]) || new Date(r[key]).toISOString() !== r[key]) fail();
  }
  if (Date.parse(r.expiresAt) <= Date.parse(r.createdAt)) fail();
  const registry = new URL(record.transport.registry);
  if (registry.protocol !== 'https:' || registry.username || registry.password || registry.search || registry.hash) fail();
  for (const list of [record.revocations.keyIds, record.revocations.releaseIds]) if (new Set(list).size !== list.length) fail();
}
export function parseManifest(bytes) {
  const record = parseStrictJson(bytes); validate(manifestSchema, record); common(record);
  if (Buffer.byteLength(bytes) > record.budgets.manifestBytes) fail();
  const ids = new Set(), paths = new Set(); let total = 0, count = 0;
  const roots = [];
  for (const c of record.components) {
    if (ids.has(c.componentId)) fail(); ids.add(c.componentId);
    if (c.content.root !== '.') safePath(c.content.root);
    if (roots.some(r => r === '.' || c.content.root === '.' || r === c.content.root || r.startsWith(c.content.root + '/') || c.content.root.startsWith(r + '/'))) fail();
    roots.push(c.content.root);
    const size = validateFileList(c.fileList, c.content.root);
    if (size !== c.content.unpackedBytes || c.fileList.length !== c.content.entries || fileListDigest(c.fileList) !== c.content.fileListSha256) fail();
    for (const [path] of c.fileList) { if (paths.has(path)) fail(); paths.add(path); }
    total += size; count += c.fileList.length;
    for (const license of c.licenses) if (!c.fileList.some(([path]) => path === license)) fail();
  }
  for (const path of paths) {
    let parent = path;
    while (parent.includes('/')) { parent = parent.slice(0, parent.lastIndexOf('/')); if (paths.has(parent)) fail(); }
  }
  for (const c of record.components) for (const dependency of c.requires) if (!ids.has(dependency.componentId)) fail();
  if (total > record.budgets.outer.unpackedBytes || count > record.budgets.outer.entries) fail();
  return record;
}
export function parseReplayState(bytes) {
  const value = parseStrictJson(bytes, HARD_LIMITS.metadataBytes);
  if (!Number.isSafeInteger(value.highestSequence) || value.highestSequence < 1 || !/^[a-f0-9]{64}$/.test(value.manifestSha256)
    || !Number.isSafeInteger(value.revocationSequence) || value.revocationSequence < 1
    || !Array.isArray(value.revokedKeyIds) || !Array.isArray(value.revokedReleaseIds)) throw new Error('Invalid full release replay state');
  return value;
}
export function preflightFor(record) {
  return { schemaVersion: 1, kind: 'opencraft.full-release-preflight', ...Object.fromEntries(
    ['release', 'transport', 'targets', 'updater', 'revocations', 'budgets'].map(key => [key, record[key]])) };
}
export function signBytes(bytes, privateKey, keyId) {
  return { schemaVersion: 1, algorithm: 'Ed25519', keyId, sha256: sha256(bytes), signature: sign(null, bytes, privateKey).toString('base64') };
}
export function verifyBytes(bytes, envelope, trust) {
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'algorithm,keyId,schemaVersion,sha256,signature'
    || envelope.schemaVersion !== 1 || envelope.algorithm !== 'Ed25519' || !Object.hasOwn(trust.keys, envelope.keyId)
    || trust.revokedKeyIds?.includes(envelope.keyId) || envelope.sha256 !== sha256(bytes)
    || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new Error('Untrusted full release signature');
  const key = createPublicKey(trust.keys[envelope.keyId]);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(envelope.signature, 'base64'))) throw new Error('Untrusted full release signature');
}
export function signPreflight(record, privateKey, keyId) {
  const bytes = Buffer.from(JSON.stringify(preflightFor(record)));
  return { payload: bytes.toString('base64'), ...signBytes(bytes, privateKey, keyId) };
}
export function verifyPreflight(envelope, trust, now = Date.now()) {
  if (!envelope || Buffer.byteLength(JSON.stringify(envelope)) > HARD_LIMITS.metadataBytes || typeof envelope.payload !== 'string') fail();
  const { payload, ...signature } = envelope;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) fail();
  const bytes = Buffer.from(payload, 'base64'); verifyBytes(bytes, signature, trust);
  const record = parseStrictJson(bytes, HARD_LIMITS.metadataBytes); validate(preflightSchema, record); common(record);
  enforcePolicy(record, signature.keyId, trust, {}, now);
  return record;
}
export function enforcePolicy(record, keyId, trust, state = {}, now = Date.now(), { retainedRollback = false } = {}) {
  const r = record.release, t = record.transport, u = record.updater;
  if (r.product !== trust.product || r.channel !== trust.channel || t.registry !== trust.registry || t.packageName !== trust.packageName
    || Date.parse(r.createdAt) > now + 300_000 || Date.parse(r.expiresAt) <= now
    || (retainedRollback ? Math.max(record.revocations.sequence, state.revocationSequence || 1) : record.revocations.sequence) < Math.max(trust.minRevocationSequence || 1, state.revocationSequence || 1)
    || record.revocations.keyIds.includes(keyId) || record.revocations.releaseIds.includes(r.releaseId)
    || state.revokedKeyIds?.includes(keyId) || state.revokedReleaseIds?.includes(r.releaseId)) throw new Error('Full release policy rejected');
  if (u.minBootstrap > BOOTSTRAP_PROTOCOL || u.minAgent > AGENT_PROTOCOL || u.helperProtocol !== HELPER_PROTOCOL) throw new Error('Full release requires bootstrap maintenance');
  if (!record.targets.some(t => t.platform === process.platform && t.arch === process.arch
    && t.nodeAbi === Number(process.versions.modules))) throw new Error('Full release target is incompatible');
  if (!retainedRollback && r.releaseSequence < (state.highestSequence || 0)) throw new Error('Full release replay rejected');
}
export function acceptManifest(bytes, envelope, trust, state = {}, preflight = null, now = Date.now()) {
  verifyBytes(bytes, envelope, trust);
  const record = parseManifest(bytes); enforcePolicy(record, envelope.keyId, trust, state, now);
  if (preflight && JSON.stringify(preflightFor(record)) !== JSON.stringify(preflight)) fail();
  const digest = sha256(bytes);
  if (record.release.releaseSequence === state.highestSequence && digest !== state.manifestSha256) throw new Error('Full release sequence collision');
  return { record, state: { highestSequence: record.release.releaseSequence, manifestSha256: digest,
    releaseId: record.release.releaseId, revocationSequence: record.revocations.sequence,
    revokedKeyIds: [...new Set([...(state.revokedKeyIds || []), ...record.revocations.keyIds])],
    revokedReleaseIds: [...new Set([...(state.revokedReleaseIds || []), ...record.revocations.releaseIds])] } };
}
