'use strict';
const conflict = () => Object.assign(new Error('Shared data changed in the same record; reload to synchronize'), { code: 'STATE_CONFLICT' });
const equal = (a, b) => a === undefined || b === undefined ? a === b : canonical(a) === canonical(b);
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
// Native navigation/history and viewer presentation are observations, not
// resource authority. Merge independent fields; an already committed concurrent
// observation wins its field. Keep entries/index atomic and never merge identity,
// binding or storage changes this way.
function mergePresentationRecord(key, before, next, current) {
  if (!before || !next || !current || !['pages', 'tabs'].includes(key)) throw conflict();
  const groups = key === 'pages' ? [['entries', 'index']] : [['viewportMode'], ['panelAttached']];
  const mutable = new Set(groups.flat());
  const fixed = row => Object.fromEntries(Object.entries(row).filter(([name]) => !mutable.has(name)));
  if (!equal(fixed(before), fixed(next)) || !equal(fixed(before), fixed(current))) throw conflict();
  const merged = { ...current };
  for (const names of groups) {
    const take = row => names.map(name => row[name]);
    if (equal(take(before), take(next)) || !equal(take(before), take(current))) continue;
    for (const name of names) {
      if (Object.hasOwn(next, name)) merged[name] = next[name]; else delete merged[name];
    }
  }
  return merged;
}
/** Three-way merge. Resource identity remains strict; concurrent navigation and
 * presentation observations converge without disabling the browser. */
function mergeBrowserMetadata(key, base, local, remote) {
  if (local === base || local === remote) return remote;
  if (remote === base) return local;
  try {
    const before = records(key, base), next = records(key, local), current = records(key, remote);
    for (const id of new Set([...before.keys(), ...next.keys()])) {
      if (equal(before.get(id), next.get(id))) continue;
      if (!equal(current.get(id), before.get(id)) && !equal(current.get(id), next.get(id))) {
        current.set(id, mergePresentationRecord(key, before.get(id), next.get(id), current.get(id)));
      } else if (next.has(id)) current.set(id, next.get(id)); else current.delete(id);
    }
    return JSON.stringify(key === 'storage' ? Object.fromEntries(current) : [...current.values()]);
  } catch { throw conflict(); }
}
/** Retirement is authoritative for these resource identities. Drop only their
 * metadata edits; unrelated drafts continue through the normal conflict check. */
function retireBrowserMetadata(key, value, retirements) {
  if (value === null || !['pages', 'tabs', 'storage'].includes(key) || retirements.empty === true || Array.isArray(retirements) && !retirements.length) return value;
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


const { canonical, mergeMetadataValue } = (() => {
'use strict';
// Client-side half of browser-metadata sync: the row-level three-way merge.
// Kept apart from metadata-sync so the Web startup bundle does not carry the
// portable SHA-256 used only for Server-side fingerprints.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v === undefined ? null : v)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  const text = JSON.stringify(value);
  return text === undefined ? 'null' : text;
}
function rowId(field, row, index) {
  if (row && typeof row === 'object') {
    const id = field === 'bindings' ? row.scopeId : row.id;
    if (typeof id === 'string' && id) return 'id:' + id;
  }
  return 'row:' + canonical(row) + '#' + index;
}
function rows(field, value) {
  if (Array.isArray(value)) {
    const map = new Map(); value.forEach((row, index) => map.set(rowId(field, row, index), row)); return { kind: 'array', map };
  }
  if (value && typeof value === 'object') return { kind: 'object', map: new Map(Object.entries(value)) };
  return null;
}
function parse(value) { if (typeof value !== 'string') return undefined; try { return JSON.parse(value); } catch { return undefined; } }
/**
 * Row-level three-way merge for one metadata field. Rows changed locally since
 * the base win; every other row follows the remote value. Removal wins over a
 * concurrent edit, so a tab closed on one device is not resurrected by another
 * device's stale viewport/attachment update. Unparseable or differently shaped values fall back to the
 * local value, which is then committed against the remote revision.
 */
function mergeMetadataValue(field, base, local, remote) {
  if (field === 'sideChats') {
    const left = rows(field, parse(local)), right = rows(field, parse(remote));
    if (left?.kind === 'array' && right?.kind === 'array') {
      const merged = JSON.parse(mergeMetadataValue('resource-rows', base, local, remote));
      const result = new Map(merged.map(row => [row.id, row]));
      for (const row of [...left.map.values(), ...right.map.values()]) if (row?.closed === true) {
        // Close wins, but an older writer must not erase a known binding.
        const retained = result.get(row.id);
        result.set(row.id, row.parent && row.key ? row
          : retained?.closed === true && retained.parent && retained.key ? retained : { id: row.id, closed: true });
      }
      return JSON.stringify([...result.values()]);
    }
  }
  if (local === remote) return local;
  if (local === base || local === undefined) return remote;
  if (remote === base || remote === undefined) return local;
  const r = rows(field, parse(remote)), l = rows(field, parse(local));
  if (!r || !l || r.kind !== l.kind) return local;
  const parsedBase = rows(field, parse(base));
  const b = parsedBase && parsedBase.kind === r.kind ? parsedBase.map : new Map();
  const changed = id => {
    const has = l.map.has(id), had = b.has(id);
    return has !== had || (has && canonical(l.map.get(id)) !== canonical(b.get(id)));
  };
  const merged = new Map();
  for (const [id, row] of r.map) {
    if (!changed(id)) merged.set(id, row);
    else if (l.map.has(id)) merged.set(id, l.map.get(id));
  }
  // Only rows added locally (absent from base) survive a remote removal.
  for (const [id, row] of l.map) if (!merged.has(id) && !r.map.has(id) && !b.has(id)) merged.set(id, row);
  return JSON.stringify(r.kind === 'array' ? [...merged.values()] : Object.fromEntries(merged));
}
return { canonical, mergeMetadataValue };

})();
module.exports = { mergeBrowserMetadata, retireBrowserMetadata, browserMetadataReferences, canonical, mergeMetadataValue };
