import { isCurrentAssistantWork } from '@opencraft/appserver-protocol/assistant-work';
const statuses = new Set(['queued','running','waiting_input','awaiting_review','awaiting_delivery','blocked','completed','cancelled','failed']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const validTime = value => Number.isFinite(value) && value >= 0 && value <= 8.64e15;
/** Public observation only; delegations, errors, engine state and results stay private. */
export function workObservation(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => row && validId(row.id) && typeof row.text === 'string' && row.text.trim()
    && isCurrentAssistantWork(row.status) && validTime(row.updated_at))
    .sort((a,b) => b.updated_at - a.updated_at)
    .slice(0, 8).map(row => ({id: row.id, title: row.text.slice(0, 512), status: row.status, updatedAt: row.updated_at}));
}
/** Validate the Worker boundary too; the existing Host lease expires observations. */
export function readWorkObservation(value) {
  if (!Array.isArray(value) || value.length > 8 || value.some(row => !row || !validId(row.id)
    || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 512 || !statuses.has(row.status) || !validTime(row.updatedAt))) return undefined;
  if (new Set(value.map(row => row.id)).size !== value.length) return undefined;
  return value.filter(row => isCurrentAssistantWork(row.status)).map(({id,title,status,updatedAt})=>({id,title,status,updatedAt}));
}
