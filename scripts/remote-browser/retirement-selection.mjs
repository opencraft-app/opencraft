import { browserMetadataReferences } from '@opencraft/browser-core/metadata-merge';
export const emptyReferences = () => ({ pages: [], tabs: [], leases: [] });
export function mergeReferences(...references) {
  return Object.fromEntries(['pages', 'tabs', 'leases'].map(kind => [kind, [...new Set(references.flatMap(ref => ref?.[kind] ?? []))]]));
}
export function retirementSelection(state, { keys = [], values = [] } = {}) {
  const owners = new Map();
  const add = ({ ownerId, key, value }) => owners.set(ownerId, mergeReferences(owners.get(ownerId), browserMetadataReferences(key, value)));
  for (const [ownerId, account] of state.states ?? []) for (const [key, value] of Object.entries(account.values)) if (key !== 'bindings') add({ ownerId, key, value });
  for (const value of values) add(value);
  const allKeys = new Set([...keys, ...(state.pages ?? []).map(page => page.key), ...(state.closedTabs ?? []).map(receipt => receipt.key)]);
  for (const [owner, refs] of owners) for (const lease of refs.leases) allKeys.add(JSON.stringify([owner, lease]));
  return { keys: [...allKeys], owners: [...owners] };
}
export function referenceLookup(refs) {
  return { empty: !['pages', 'tabs', 'leases'].some(kind => refs?.[kind]?.length),
    ...Object.fromEntries(['pages', 'tabs', 'leases'].map(kind => [kind, new Set(refs?.[kind] ?? [])])) };
}
export function referenceFacts(refs) {
  return [...(refs.pages.length || refs.tabs.length ? [{ pageIds: refs.pages, tabIds: refs.tabs }] : []),
    ...refs.leases.map(lease => ({ lease, pageIds: [], tabIds: [] }))];
}
export function validateReferences(value) {
  if (!value || typeof value !== 'object' || ['pages', 'tabs', 'leases'].some(kind => !Array.isArray(value[kind])
    || value[kind].length > 65536 || value[kind].some(id => typeof id !== 'string' || id.length > 65536))) throw Error('Invalid retirement references');
  return value;
}
