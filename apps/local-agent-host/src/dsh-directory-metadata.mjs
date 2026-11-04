/** Read only the native live projection seam. No session activation, event-log
 * access, persistence listing, model input or unrelated projection payloads. */
export function liveDirectoryMetadata(ctx, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length > 64 || sessionIds.some(id => typeof id !== 'string' || !id || id.length > 512))
    throw new Error('Invalid directory metadata batch');
  const items = [], missing = [];
  const projections = ctx.get('sessionProjections');
  for (const id of new Set(sessionIds)) {
    try {
      const session = ctx.sessions.get(id);
      if (!session || !projections) { missing.push(id); continue; }
      const header = session.header, block = projections.snapshot(session), metadata = block.values.sessionListMetadata;
      if (!Number.isFinite(header.createdAt) || typeof metadata?.blank !== 'boolean'
        || !(metadata.lastPromptAt === null || Number.isFinite(metadata.lastPromptAt))) { missing.push(id); continue; }
      items.push({ sessionId: id, updatedAt: Math.max(header.createdAt, metadata.lastPromptAt ?? 0),
        running: ctx.agents.get(id)?.status === 'running', blank: metadata.blank,
        ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
        ...(typeof header.origin === 'string' ? { origin: header.origin } : {}),
        ...(typeof header.parentSession === 'string' ? { parentSessionId: header.parentSession } : {}),
        projections: { asOfSeq: block.asOfSeq, values: typeof block.values.title === 'string' ? { title: block.values.title } : {} } });
    } catch { missing.push(id); }
  }
  return { items, missing };
}
