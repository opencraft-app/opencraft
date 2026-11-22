import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { codexPermissionMode } from '@opencraft/appserver-protocol';

const fault = (status, code) => Object.assign(new Error(code), { status, code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function projectConversationMetadata(serverId, thread, includeTitle = false, recovery = null) {
  const status = thread.status?.type;
  const flags = thread.status?.activeFlags ?? [];
  const attention = status !== 'active' ? null : flags.includes('waitingOnApproval') ? 'approval' : flags.includes('waitingOnUserInput') ? 'question' : null;
  return { ref: { serverId, threadId: thread.id }, projectId: thread.projectId ?? null, cwd: thread.cwd ?? null,
    runtime: attention ? 'awaiting_interaction' : recovery?.state === 'scheduled' ? 'recovering'
      : recovery?.state === 'unconfirmed' ? 'unknown' : recovery?.state === 'exhausted' ? 'failed'
      : status === 'active' ? 'running' : status === 'idle' ? 'idle' : status === 'systemError' ? 'failed' : 'unknown',
    currentTurnId: null, recovery, attention: attention ? { kind: attention, interactionId: null } : null,
    observedAt: Date.now(), ...(includeTitle && typeof thread.name === 'string' ? { title: thread.name } : {}) };
}

/** One native item at a time, including continuation inside a very long message.
 * The cursor binds the resource, native metadata revision and current item hash.
 * No history mirror and no full-history read is used. */
export async function readConversationPage(invoke, ref, cursor) {
  const metadata = (await invoke('thread/read', { includeTurns: false })).thread;
  if (metadata?.id !== ref.threadId) throw fault(404, 'conversation_unavailable');
  const tail = await invoke('thread/items/list', { limit: 1, sortDirection: 'desc', cursor: null });
  const watermark = digest([ref, metadata.updatedAt ?? null, tail.data?.[0] ?? null]);
  let position = { version: 1, ref, watermark, nativeCursor: null, offset: 0, itemHash: null };
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (parsed.version !== 1 || JSON.stringify(parsed.ref) !== JSON.stringify(ref)
        || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > 100_000_000
        || parsed.nativeCursor !== null && typeof parsed.nativeCursor !== 'string'
        || parsed.itemHash !== null && typeof parsed.itemHash !== 'string') throw Error();
      position = parsed;
    } catch { throw fault(400, 'invalid_cursor'); }
    if (position.watermark !== watermark) throw fault(409, 'history_changed');
  }
  const page = await invoke('thread/items/list', { limit: 1, sortDirection: 'asc', cursor: position.nativeCursor });
  if (!Array.isArray(page.data) || page.data.length > 1) throw fault(503, 'invalid_history_page');
  const source = page.data[0], item = source?.item;
  const itemHash = source ? digest(source) : null;
  if (position.itemHash !== null && position.itemHash !== itemHash) throw fault(409, 'history_changed');
  const content = item?.type === 'agentMessage' ? item.text : item?.type === 'userMessage'
    ? (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n') : null;
  const points = typeof content === 'string' ? Array.from(content) : [];
  if (position.offset > points.length) throw fault(400, 'invalid_cursor');
  const text = points.slice(position.offset, position.offset + 2000).join('');
  const continuing = position.offset + 2000 < points.length;
  const nextCursor = continuing ? encode({ ...position, offset: position.offset + 2000, itemHash })
    : page.nextCursor ? encode({ ...position, nativeCursor: page.nextCursor, offset: 0, itemHash: null }) : null;
  const after = (await invoke('thread/read', { includeTurns: false })).thread;
  const tailAfter = await invoke('thread/items/list', { limit: 1, sortDirection: 'desc', cursor: null });
  if (watermark !== digest([ref, after?.updatedAt ?? null, tailAfter.data?.[0] ?? null])) throw fault(409, 'history_changed');
  return { entries: content === null ? [] : [{ turnId: source.turnId ?? null, itemId: item.id,
    role: item.type === 'userMessage' ? 'user' : 'assistant', offset: position.offset, text }],
    watermark, latestTurnId: tail.data?.[0]?.turnId ?? null, nextCursor, truncated: nextCursor !== null };
}

/** Read a window of recent turns. Native pages, the response and each text
 * item have independent limits; no full history or resume is needed. */
export async function readConversationTail(invoke, ref, limit) {
  const metadata = (await invoke('thread/read', { includeTurns: false })).thread;
  if (metadata?.id !== ref.threadId) throw fault(404, 'conversation_unavailable');
  const turns = await invoke('thread/turns/list', { limit, sortDirection: 'desc', itemsView: 'notLoaded', cursor: null });
  if (!Array.isArray(turns.data) || turns.data.length > limit || turns.data.some(turn => typeof turn?.id !== 'string'))
    throw fault(503, 'invalid_history_page');

  const entries = [];
  let bytes = 2, truncated = turns.nextCursor != null;
  turns: for (const { id: turnId } of turns.data) {
    const page = await invoke('thread/items/list', { turnId, limit: 30, sortDirection: 'desc', cursor: null });
    if (!Array.isArray(page.data) || page.data.length > 30) throw fault(503, 'invalid_history_page');
    truncated ||= page.nextCursor != null;
    for (const source of page.data) {
      const item = source?.item;
      if (!item || !['userMessage', 'agentMessage'].includes(item.type)) continue;
      if (source.turnId !== turnId || typeof item.id !== 'string') throw fault(503, 'invalid_history_page');
      const content = item.type === 'agentMessage' ? item.text : item.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (typeof content !== 'string') throw fault(503, 'invalid_history_page');
      const points = Array.from(content), offset = Math.max(0, points.length - 2000);
      const entry = { turnId, itemId: item.id, role: item.type === 'userMessage' ? 'user' : 'assistant',
        offset, text: points.slice(offset).join(''), ...(offset ? { partial: true } : {}) };
      const size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0);
      if (bytes + size > 24_000) { truncated = true; break turns; }
      bytes += size;
      truncated ||= offset > 0;
      entries.push(entry);
    }
  }
  entries.reverse();
  return { entries, nextCursor: null, watermark: digest([ref, entries]), latestTurnId: turns.data[0]?.id ?? null, truncated };
}

const PROJECT_PAGE_LIMIT = 30;
const validString = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

function catalogCursor(serverId, kind, cursor) {
  if (cursor === null) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.version !== 1 || value.kind !== kind || value.serverId !== serverId || !validString(value.nativeCursor, 2048)) throw Error();
    return value.nativeCursor;
  } catch { throw fault(400, 'invalid_cursor'); }
}
function nextCatalogCursor(serverId, kind, next, prior, errorCode) {
  if (next == null) return null;
  if (!validString(next, 2048) || next === prior) throw fault(503, errorCode);
  return encode({ version: 1, kind, serverId, nativeCursor: next });
}

/** Project discovery shares the Host catalog used for creation. Only the
 * display name, stable ID and workspace roots cross the CLI boundary. */
export async function readConversationProjectPage(invoke, serverId, cursor) {
  const nativeCursor = catalogCursor(serverId, 'projects', cursor);
  const page = await invoke('project/list', { limit: PROJECT_PAGE_LIMIT, cursor: nativeCursor });
  if (!Array.isArray(page?.data) || page.data.length > PROJECT_PAGE_LIMIT) throw fault(503, 'project_catalog_unavailable');
  const projects = page.data.map(row => {
    if (!validString(row?.id, 256) || !validString(row.name, 1024) || !Array.isArray(row.roots) || row.roots.length > 64)
      throw fault(503, 'project_catalog_unavailable');
    const roots = row.roots.map(root => {
      if (!validString(root?.path, 4096) || !isAbsolute(root.path) || /[\x00-\x1f]/u.test(root.path))
        throw fault(503, 'project_catalog_unavailable');
      return { path: root.path };
    });
    return { id: row.id, name: row.name, roots };
  });
  if (Buffer.byteLength(JSON.stringify(projects)) > 192_000) throw fault(503, 'project_catalog_unavailable');
  return { serverId, projects, nextCursor: nextCatalogCursor(serverId, 'projects', page.nextCursor, nativeCursor, 'project_catalog_unavailable') };
}


const valueString = (value, limit = 512) => validString(value, limit) && !/[\x00-\x1f\x7f]/u.test(value) ? value : null;
const unsupported = error => error?.code === -32601 || error?.code === 'unsupported_capability';
async function probe(invoke, method, params, optional = false) {
  try { return await invoke(method, params); }
  catch (error) {
    if (unsupported(error)) {
      if (optional) return undefined;
      throw fault(409, 'unsupported_capability');
    }
    if (error?.status === 401 || error?.status === 403) throw fault(error.status, 'conversation_action_denied');
    if (method === 'thread/read' && (error?.status === 404 || error?.code === -32004)) throw fault(404, 'conversation_unavailable');
    throw fault(503, 'discovery_unavailable');
  }
}
function stringList(value, limit = 100) {
  if (!Array.isArray(value) || value.length > limit || value.some(item => !valueString(item, 128)))
    throw fault(503, 'discovery_unavailable');
  return [...new Set(value)];
}

/** Model/list has already passed the Host's Actor and model-policy projection. */
export async function readConversationModelPage(invoke, serverId, cursor) {
  const kind = 'models', nativeCursor = catalogCursor(serverId, kind, cursor);
  const page = await probe(invoke, 'model/list', { cursor: nativeCursor, limit: 30, includeHidden: false });
  if (!Array.isArray(page?.data) || page.data.length > 30) throw fault(503, 'discovery_unavailable');
  const models = page.data.filter(row => row?.hidden !== true && row?.policySelectable !== false).map(row => {
    const id = valueString(row?.id), model = valueString(row?.model);
    if (!id || !model || !Array.isArray(row.supportedReasoningEfforts)) throw fault(503, 'discovery_unavailable');
    const reasoningEfforts = stringList(row.supportedReasoningEfforts.map(option => option?.reasoningEffort));
    if (row.serviceTiers != null && !Array.isArray(row.serviceTiers)) throw fault(503, 'discovery_unavailable');
    const serviceTiers = row.serviceTiers == null ? null : stringList(row.serviceTiers.map(tier => tier?.id));
    return { id, model, reasoningEfforts, serviceTiers };
  });
  return { serverId, models, observedAt: Date.now(),
    nextCursor: nextCatalogCursor(serverId, kind, page.nextCursor, nativeCursor, 'discovery_unavailable') };
}

async function readRequirements(invoke) {
  const result = await probe(invoke, 'configRequirements/read', {}, true);
  if (result === undefined) return undefined;
  if (!result || !Object.hasOwn(result, 'requirements')) throw fault(503, 'discovery_unavailable');
  const requirements = result.requirements;
  if (requirements !== null && (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)))
    throw fault(503, 'discovery_unavailable');
  return requirements;
}

function allowedByRequirements(requirements, profileId, mode, approvalPolicy) {
  if (requirements === null) return true;
  if (requirements === undefined) return null;
  const { allowedApprovalPolicies, allowedSandboxModes, allowedPermissionProfiles } = requirements;
  const sandbox = mode === 'full' ? 'danger-full-access' : mode === 'accept-edits' ? 'workspace-write' : 'read-only';
  if (allowedApprovalPolicies != null && (!Array.isArray(allowedApprovalPolicies) || allowedApprovalPolicies.length > 100)
    || allowedSandboxModes != null && (!Array.isArray(allowedSandboxModes) || allowedSandboxModes.length > 100)
    || allowedPermissionProfiles != null && (typeof allowedPermissionProfiles !== 'object' || Array.isArray(allowedPermissionProfiles))) {
    throw fault(503, 'discovery_unavailable');
  }
  if (Array.isArray(allowedApprovalPolicies) && !allowedApprovalPolicies.includes(approvalPolicy)
    || Array.isArray(allowedSandboxModes) && !allowedSandboxModes.includes(sandbox)
    || allowedPermissionProfiles != null && allowedPermissionProfiles[profileId] !== true) return false;
  // Older protocol implementations can omit a requirement field. Do not
  // project a positive policy observation when a layer is unknown.
  return allowedApprovalPolicies === undefined || allowedSandboxModes === undefined || allowedPermissionProfiles === undefined ? null : true;
}

async function readPermissionProfiles(invoke, cwd) {
  if (cwd === null) return null;
  let cursor = null;
  const rows = new Map(), seen = new Set();
  for (let i = 0; i < 4; i++) {
    const page = await probe(invoke, 'permissionProfile/list', { cwd, cursor, limit: 100 }, true);
    if (page === undefined) return null;
    if (!Array.isArray(page?.data) || page.data.length > 100) throw fault(503, 'discovery_unavailable');
    for (const row of page.data) {
      const profileId = valueString(row?.id), nativeProfileId = row?.openCraftNativeProfileId === undefined
        ? profileId : valueString(row.openCraftNativeProfileId);
      if (!profileId || !nativeProfileId || typeof row.allowed !== 'boolean') throw fault(503, 'discovery_unavailable');
      const mode = codexPermissionMode(nativeProfileId);
      if (mode && (!row.openCraftMode || row.openCraftMode === mode) && !rows.has(mode)) {
        rows.set(mode, { mode, nativeProfileId, approvalPolicy: mode === 'full' ? 'never' : 'on-request', allowed: row.allowed });
      }
    }
    if (page.nextCursor == null) return [...rows.values()];
    if (!valueString(page.nextCursor, 2048) || seen.has(page.nextCursor)) throw fault(503, 'discovery_unavailable');
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  throw fault(503, 'discovery_unavailable');
}

export async function readConversationOptions(invoke, ref) {
  const result = await probe(invoke, 'thread/read', { includeTurns: false });
  const thread = result?.thread;
  if (thread?.id !== ref.threadId) throw fault(404, 'conversation_unavailable');
  const path = valueString(thread.cwd, 4096), cwd = path && isAbsolute(path) ? path : null;
  const configuration = { model: valueString(thread.model), reasoningEffort: valueString(thread.reasoningEffort, 128) };
  const [modelCatalog, requirements, profiles, collaboration] = await Promise.all([
    readConversationModelPage(invoke, ref.serverId, null),
    readRequirements(invoke),
    readPermissionProfiles(invoke, cwd),
    probe(invoke, 'collaborationMode/list', {}, true),
  ]);
  if (collaboration !== undefined && (!Array.isArray(collaboration?.data) || collaboration.data.length > 100))
    throw fault(503, 'discovery_unavailable');
  const collaborationModes = collaboration === undefined ? null
    : [...new Set(collaboration.data.map(row => row?.mode).filter(mode => mode === 'default' || mode === 'plan'))];
  const permissionModes = profiles === null ? null : profiles.map(profile => ({
    ...profile,
    allowed: profile.allowed ? allowedByRequirements(requirements, profile.nativeProfileId, profile.mode, profile.approvalPolicy) : false,
  }));
  return {
    ref, observedAt: Date.now(), nativeConfirmedConfiguration: configuration, modelCatalog,
    optionCatalog: { cwd, requirementsConfigured: requirements === undefined ? null : requirements !== null, permissionModes, collaborationModes },
  };
}
