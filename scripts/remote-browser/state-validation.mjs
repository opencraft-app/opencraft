import { createHash } from 'node:crypto';
import { sessionLinkIndex } from '../remote-browser-state-file.mjs';
import { initializeRetirementFacts } from './retirement-facts.mjs';
export function validateBrowserState(saved) {
  if (saved.schemaVersion !== 1 || !Array.isArray(saved.pages) || !Array.isArray(saved.states)) throw new Error('Unsupported browser state');
  const accounts = new Map();
  for (const [owner, state] of saved.states) if (!accounts.has(owner)) accounts.set(owner, state);
  const links = new Map();
  for (const p of saved.pages) {
    if (typeof p.ownerId !== 'string' || typeof p.key !== 'string' || p.id !== createHash('sha256').update(p.key).digest('hex')
      || JSON.parse(p.key)[0] !== p.ownerId) throw new Error('Invalid browser state');
    p.lifecycle ??= p.closing ? 'closing' : 'open';
    if (p.link == null) {
      if (!links.has(p.ownerId)) links.set(p.ownerId, sessionLinkIndex(accounts.get(p.ownerId)));
      p.link = links.get(p.ownerId).get(JSON.parse(p.key)[1])?.link ?? null;
    }
  }
  if (saved.retired !== undefined && (!Array.isArray(saved.retired) || saved.retired.some(key => {
    if (typeof key !== 'string') return true;
    try { const pair = JSON.parse(key); return !Array.isArray(pair) || pair.length !== 2 || pair.some(v => typeof v !== 'string'); } catch { return true; }
  }))) throw new Error('Invalid browser retirement state');
  saved.retired ??= [];
  if (saved.closedTabs !== undefined && (!Array.isArray(saved.closedTabs) || saved.closedTabs.some(receipt => {
    if (!receipt || typeof receipt.key !== 'string' || typeof receipt.ownerId !== 'string' || typeof receipt.lease !== 'string'
      || typeof receipt.tabId !== 'string' || typeof receipt.pageId !== 'string' || typeof receipt.scopeId !== 'string'
      || !['closing', 'closed'].includes(receipt.status)
      || !Array.isArray(receipt.pageIds) || !Array.isArray(receipt.tabIds)
      || [...receipt.pageIds, ...receipt.tabIds].some(id => typeof id !== 'string')) return true;
    try { return JSON.stringify([receipt.ownerId, receipt.lease]) !== receipt.key; } catch { return true; }
  }))) throw new Error('Invalid browser close receipts');
  initializeRetirementFacts(saved);
  return saved;

}
