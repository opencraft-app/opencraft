import {createHash} from 'node:crypto';
/** IOA owns employee account semantics. Directory evidence is not a login,
 * Actor registration, admission decision, or permission grant. */
export function normalizeRtx(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/u.test(value)
    ? value.toLowerCase() : null;
}
function association(value, rtx) {
  if (value?.provider !== 'tencentoa' || typeof value.subject !== 'string'
    || !/^[1-9][0-9]*$/u.test(value.subject)
    || normalizeRtx(value.attributes?.loginName) !== rtx
    || !Array.isArray(value.aliases) || !value.aliases.includes('login:' + rtx)) return null;
  // Only the exact employee alias may cross the directory admission boundary.
  return { provider: 'tencentoa', subject: value.subject, displayName: rtx,
    attributes: { loginName: rtx }, aliases: ['login:' + rtx] };
}
/** Inputs are from the trusted authority and private directory store. Never pass
 * callback labels, avatar caches or user-supplied claims here. Persist conflicts
 * so expiry of one browser session cannot silently select the other employee. */
export function resolveRtxAssociation(rtx, principals, stored, now = Date.now()) {
  rtx = normalizeRtx(rtx);
  if (!rtx) return { state: 'unresolved' };
  if (stored?.state === 'conflict') return { state: 'conflict' };
  const prior = stored == null ? null : association(stored, rtx);
  if (stored != null && !prior) return { state: 'conflict' };
  const current = principals.filter(p => p?.provider === 'tencentoa'
    && Number.isFinite(p.expiresAt) && p.expiresAt > now);
  const matches = current.map(p => association(p, rtx)).filter(Boolean);
  const subjects = new Set(matches.map(p => p.subject));
  if (prior) subjects.add(prior.subject);
  if (subjects.size > 1) return { state: 'conflict' };
  const identity = matches[0] ?? prior;
  // A live claim for the same stable subject contradicting its retained RTX
  // invalidates that old association; labels and numeric equality never match.
  if (identity && current.some(p => p.subject === identity.subject && !association(p, rtx)))
    return { state: 'conflict' };
  return identity ? { state: 'resolved', identity } : { state: 'unresolved' };
}

// Compare-and-set prevents concurrent Relay workers overwriting different staff
// associations. All reads/writes use the pre-existing private key namespace.
const compareAndSet = `local old=redis.call('GET',KEYS[1]);
if (old or '')~=ARGV[1] then return 0 end;
redis.call('SET',KEYS[1],ARGV[2]);return 1`;
export function createRtxDirectoryResolver(redis, { now = Date.now } = {}) {
  let principals = [], refreshedAt = -Infinity, refreshing;
  async function refresh() {
    if (now() - refreshedAt < 30000) return;
    refreshing ??= redis.knownPrincipals().then(value => {
      if (!Array.isArray(value)) throw Error('ioa_directory_unavailable');
      principals = value; refreshedAt = now();
    }).finally(() => { refreshing = undefined; });
    await refreshing;
  }
  return async (rtx, key) => {
    if (!normalizeRtx(rtx)) return { state: 'unresolved' };
    await refresh();
    for (let attempt = 0; attempt < 8; attempt++) {
      const raw = await redis.read(key);
      let stored;
      try { stored = raw === null ? null : JSON.parse(raw); }
      catch { stored = { state: 'conflict' }; }
      const result = resolveRtxAssociation(rtx, principals, stored, now());
      if (result.state === 'unresolved') return result;
      const next = JSON.stringify(result.state === 'resolved' ? result.identity : { state: 'conflict' });
      if (raw === next || Number(await redis.evaluate(compareAndSet, [key], [raw ?? '', next])) === 1) return result;
    }
    throw Error('ioa_directory_contended');
  };
}

/** Relay-side bridge: current verified IOA claims plus the authenticated WeCom
 * directory mapping, preserving durable associations to existing IOA Actors.
 * Missing associations permit only a disabled reservation. */
export function createRtxMemberEvidence(redis, resolveSender, now = Date.now, resolveBatch) {
  const resolve = createRtxDirectoryResolver(redis, {now});
  return async (source, memberIds, signal) => {
    const parts = JSON.parse(source);
    if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 'wecom-customer-service'
      || !/^wx[a-z0-9]+$/iu.test(parts[1])) throw Error('ioa_member_source_invalid');
    const principals = await redis.knownPrincipals();
    const resolved = resolveBatch ? await resolveBatch(source, memberIds, signal) : null;
    const members = [];
    for (let offset = 0; offset < memberIds.length; offset += 8) {
      signal?.throwIfAborted();
      const batch = await Promise.all(memberIds.slice(offset, offset + 8).map(async userId => {
        if (typeof userId !== 'string' || /^(wb|fw|external:)/iu.test(userId)) return null;
        let rtx;
        try { rtx = normalizeRtx(resolved ? resolved.get(userId) : await resolveSender(source, userId, signal)); }
        catch { return null; }
        if (!rtx) return null;
        const observedAt = now();
        const key = 'wecom-directory:v1:identity:' + createHash('sha256').update(JSON.stringify(['wecom',parts[1],rtx])).digest('hex');
        const result = await resolve(rtx, key);
        if (result.state === 'conflict') return null;
        if (result.state === 'unresolved') return { userId, rtx, subject: null, expiresAt: observedAt + 60000 };
        const identity = principals.find(p => association(p, rtx)?.subject === result.identity.subject && p.expiresAt > observedAt);
        return { userId, rtx, subject: result.identity.subject, ...(identity ? {identity} : {}),
          expiresAt: Math.min(identity?.expiresAt ?? Infinity, now() + 60000) };
      }));
      members.push(...batch.filter(Boolean));
    }
    return { source, members };
  };
}

/** Gateway Actor-owner bridge. This runs before Worker membership projection;
 * existing humans link through mirrorLink; unknown humans use disabled Worker
 * reservations. Neither path fabricates IOA login, admission, assistants or keys. */
export async function synchronizeRtxMembers(collaboration, source, snapshot, evidence, now = Date.now, prepareIdentity) {
  if (!evidence) return; // Older Relay versions remain compatible.
  const parts = JSON.parse(source);
  if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 'wecom-customer-service'
    || !/^wx[a-z0-9]+$/iu.test(parts[1]) || snapshot?.externalId !== parts[3]
    || evidence.source !== source || !Array.isArray(evidence.members) || evidence.members.length > 2000)
    throw Error('ioa_member_evidence_invalid');
  const ids = new Set(snapshot.memberIds), seen = new Set();
  for (const member of evidence.members) {
    if (!member || !ids.has(member.userId) || seen.has(member.userId)
      || /^(wb|fw|external:)/iu.test(member.userId) || normalizeRtx(member.rtx) !== member.rtx
      || !member.rtx || (member.subject !== null && (typeof member.subject !== 'string' || !/^[1-9][0-9]*$/u.test(member.subject)))
      || !Number.isFinite(member.expiresAt)) throw Error('ioa_member_evidence_invalid');
    if (member.identity && (!association(member.identity, member.rtx)
      || member.identity.subject !== member.subject || !Number.isFinite(member.identity.expiresAt)
      || member.identity.expiresAt < member.expiresAt)) throw Error('ioa_member_evidence_invalid');
    seen.add(member.userId);
  }
  for (const member of evidence.members) {
    if (member.expiresAt <= now()) continue;
    const actor = member.subject === null ? null : collaboration.actors.findHuman({ provider: 'tencentoa', subject: member.subject });
    if (!actor) {
      const binding = { provider: 'wecom.' + parts[1], subject: member.userId };
      if (!collaboration.actors.findHuman(binding)) {
        try {
          await collaboration.synchronizeChannels({ method: 'reserveHuman', params: {
            reservation: { binding, loginProvider: 'tencentoa', alias: member.rtx },
          } });
        } catch (error) {
          // Worker domain rejection affects this identity only. In particular a
          // revoked reservation must not prevent other members' departures.
          // Transport, storage and programming failures still fail the poll.
          if (!(error instanceof Error) || error.message !== 'Human reservation conflict') throw error;
        }
      }
      continue;
    }
    if (member.identity && prepareIdentity) await prepareIdentity(member.identity);
    if (member.expiresAt <= now() || !actor?.enabled || actor.kind !== 'human' || !collaboration.admittedActor(actor.id)) continue;
    const binding = { provider: 'wecom.' + parts[1], subject: member.userId };
    const existing = collaboration.actors.findHuman(binding);
    // Never merge or move an existing identity; administrative repair is separate.
    if (existing || collaboration.actors.bindings(actor.id).some(b => b.provider === binding.provider)) continue;
    try {
      await collaboration.synchronizeChannels({ method: 'mirrorLink', params: {
        actorId: actor.id, generation: actor.generation, corpId: parts[1], userId: member.userId,
      } });
    } catch (error) {
      if (!(error instanceof Error) || !['Human reservation conflict', 'Human reservation retired'].includes(error.message)) throw error;
    }
  }
}


/** Only Relay's authenticated Principal is accepted. The directory response adds
 * a short-lived claim hint; it is never a substitute for IOA authentication. */
export function createRtxLoginPreparation(directory, now = Date.now) {
  const pending = new Map(); let owner;
  return async principal => {
    if (principal.provider !== 'tencentoa' || principal.expiresAt <= now()) return principal;
    const rtx = normalizeRtx(principal.attributes?.loginName);
    if (!rtx || !principal.aliases?.includes('login:' + rtx)) return principal;
    // Drop hints from old sessions before asking the current directory owner.
    const { wecomCorpId, wecomUserId, wecomVerifiedUntil, ...attributes } = principal.attributes ?? {};
    const clean = { ...principal, attributes };
    const lookup = directory();
    if (!lookup) return clean;
    try {
      if (lookup !== owner) { pending.clear(); owner = lookup; }
      const key = JSON.stringify([principal.subject, rtx]);
      let entry = pending.get(key);
      if (!entry || entry.expiresAt <= now()) {
        if (pending.size >= 1024) pending.delete(pending.keys().next().value);
        // Coalesce request bursts; evidence retains its original deadline.
        entry = { expiresAt: now() + 10000, work: Promise.resolve().then(() => lookup(rtx, AbortSignal.timeout(5000))) };
        pending.set(key, entry);
      }
      const employee = await entry.work;
      if (entry.expiresAt <= now()) return clean;
      if (employee.rtx !== rtx || !/^wx[a-z0-9]+$/iu.test(employee.corpId)
        || typeof employee.userId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(employee.userId)) return clean;
      return { ...clean, attributes: { ...attributes, wecomCorpId: employee.corpId,
        wecomUserId: employee.userId, wecomVerifiedUntil: String(Math.min(principal.expiresAt, entry.expiresAt)) } };
    } catch { return clean; }
  };
}

/** Installed only by IOA composition. Core owns the atomic claim transaction. */
export function rtxReservationClaim(principal, now = Date.now) {
  if (principal.provider !== 'tencentoa' || !/^[1-9][0-9]*$/u.test(principal.subject)) return null;
  const alias = normalizeRtx(principal.attributes?.loginName);
  if (!alias || !principal.aliases?.includes('login:' + alias)) return null;
  const a = principal.attributes, until = Number(a.wecomVerifiedUntil);
  const binding = Number.isSafeInteger(until) && until > now() && until <= now() + 60000
    && /^wx[a-z0-9]+$/iu.test(a.wecomCorpId ?? '') && /^[A-Za-z0-9._-]{1,128}$/u.test(a.wecomUserId ?? '')
    && !/^(wb|fw)/iu.test(a.wecomUserId)
    ? { provider: 'wecom.' + a.wecomCorpId, subject: a.wecomUserId } : null;
  return { alias, binding };
}
