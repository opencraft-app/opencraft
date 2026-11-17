'use strict';
const conflict = () => Object.assign(new Error('Browser metadata changed in the same record; reload to synchronize'), { code: 'STATE_CONFLICT' });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function records(key, value) {
  const parsed = JSON.parse(value ?? (key === 'storage' ? '{}' : '[]'));
  if (key === 'storage') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw conflict();
    return new Map(Object.entries(parsed));
  }
  const identity = key === 'bindings' ? 'scopeId' : 'id';
  if (!['pages', 'tabs', 'bindings'].includes(key) || !Array.isArray(parsed)) throw conflict();
  const map = new Map();
  for (const row of parsed) {
    if (!row || typeof row !== 'object' || typeof row[identity] !== 'string' || map.has(row[identity])) throw conflict();
    map.set(row[identity], row);
  }
  return map;
}
/** Three-way record merge. A local deletion/change must still match its base
 * on the server. Unchanged rows never overwrite remote additions or changes. */
function mergeBrowserMetadata(key, base, local, remote) {
  if (local === base || local === remote) return remote;
  if (remote === base) return local;
  try {
    const before = records(key, base), next = records(key, local), current = records(key, remote);
    for (const id of new Set([...before.keys(), ...next.keys()])) {
      if (equal(before.get(id), next.get(id))) continue;
      if (!equal(current.get(id), before.get(id)) && !equal(current.get(id), next.get(id))) throw conflict();
      if (next.has(id)) current.set(id, next.get(id)); else current.delete(id);
    }
    return JSON.stringify(key === 'storage' ? Object.fromEntries(current) : [...current.values()]);
  } catch { throw conflict(); }
}
/** Retirement is authoritative for these resource identities. Drop only their
 * metadata edits; unrelated drafts continue through the normal conflict check. */
function retireBrowserMetadata(key, value, retirements) {
  if (value === null || key === 'bindings' || retirements.empty === true || Array.isArray(retirements) && !retirements.length) return value;
  try {
    const lookup = Array.isArray(retirements) ? { pages: new Set(retirements.flatMap(r => r.pageIds)), tabs: new Set(retirements.flatMap(r => r.tabIds)), leases: new Set(retirements.map(r => r.lease).filter(lease => typeof lease === 'string')) } : retirements;
    const { pages, tabs, leases } = lookup, current = records(key, value), size = current.size;
    for (const [id, row] of current) {
      if (key === 'pages' && pages.has(id) || key === 'tabs' && (tabs.has(id) || pages.has(row.pageId))
        || key === 'storage' && (pages.has(id) || typeof row === 'string' && leases.has(row.replace(':', '-')))) current.delete(id);
    }
    return current.size === size ? value : JSON.stringify(key === 'storage' ? Object.fromEntries(current) : [...current.values()]);
  } catch { throw conflict(); }
}
function browserMetadataReferences(key, value) {
  const pages = new Set(), tabs = new Set(), leases = new Set();
  let entries = [];
  try { if (value !== null && key !== 'bindings') entries = records(key, value); } catch {}
  for (const [id, row] of entries) {
    if (key === 'pages') pages.add(id);
    if (key === 'tabs') { tabs.add(id); if (typeof row.pageId === 'string') pages.add(row.pageId); }
    if (key === 'storage') { pages.add(id); if (typeof row === 'string') leases.add(row.replace(':', '-')); }
  }
  return { pages: [...pages], tabs: [...tabs], leases: [...leases] };
}
module.exports = { mergeBrowserMetadata, retireBrowserMetadata, browserMetadataReferences };
