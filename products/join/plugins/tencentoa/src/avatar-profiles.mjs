import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createNativeMemberOwnerDirectory } from './native-member-owner-directory.mjs';
import { linkedSenderActorId } from '../../wecom/linked-sender.mjs';

const maxEntries = 8192, maxBytes = 2 * 1024 * 1024, maxAge = 60 * 86400000;
const account = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
const stores = new Map();
export const avatarProfilePath = directory => join(directory, 'join-avatar-profiles.json');
const externalKey = (source, senderId) => JSON.stringify(['external', source, senderId]);

/** Presentation cache only, not an identity/admission authority. The one Gateway
 * writer observes authenticated provider evidence. Workers only read snapshots.
 * No credentials, supplied URLs, or arbitrary display names are persisted. */
export class VerifiedAvatarProfiles {
  constructor(path, now = Date.now) { this.path = resolve(path); this.now = now; this.rows = new Map(); this.stamp = null; }
  refresh() {
    let fd;
    try {
      fd = fs.openSync(this.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.size > BigInt(maxBytes) || (stat.mode & 0o077n) !== 0n) throw Error('invalid_avatar_cache');
      const stamp = [stat.ino, stat.size, stat.mtimeNs].join(':');
      if (this.stamp === stamp) return;
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (value?.version !== 1 || !Array.isArray(value.rows) || value.rows.length > maxEntries) throw Error('invalid_avatar_cache');
      const rows = new Map();
      for (const row of value.rows) {
        if (!row || typeof row.key !== 'string' || row.key.length > 2048 || !account(row.loginName)
          || !Number.isSafeInteger(row.at) || row.at > this.now() + 300000) throw Error('invalid_avatar_cache');
        if (row.at > this.now() - maxAge) rows.set(row.key, row);
      }
      this.rows = rows; this.stamp = stamp;
    } catch (error) {
      this.rows = new Map(); this.stamp = null;
      if (error.code !== 'ENOENT') return;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  lookup(key) {
    this.refresh();
    const row = this.rows.get(key);
    return row && row.at > this.now() - maxAge ? { kind: 'employee', name: row.loginName } : null;
  }
  remember(key, loginName) {
    if (!account(loginName)) return;
    this.refresh();
    const old = this.rows.get(key), at = this.now();
    // Refresh once a day, not on every authenticated HTTP/WS request.
    if (old?.loginName === loginName && old.at > at - 86400000) return;
    this.rows.delete(key); this.rows.set(key, { key, loginName, at });
    while (this.rows.size > maxEntries) this.rows.delete(this.rows.keys().next().value);
    const bytes = JSON.stringify({ version: 1, rows: [...this.rows.values()] });
    if (Buffer.byteLength(bytes) > maxBytes) throw Error('avatar_cache_too_large');
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.path); this.stamp = null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  /** Caller must already have verified this principal via the installed authority. */
  observePrincipal(principal) {
    if (principal?.provider !== 'tencentoa' || !/^[1-9][0-9]*$/u.test(principal.subject)
      || principal.expiresAt <= this.now() || !account(principal.attributes?.loginName)) return;
    this.remember(JSON.stringify(['tencentoa', principal.subject]), principal.attributes.loginName);
  }
  /** Only called with the authenticated directory API's explicit raw-ID mapping. */
  observeDirectory(source, rawId, loginName) {
    if (typeof source !== 'string' || source.length > 1024 || typeof rawId !== 'string' || rawId.length > 256) return;
    const senderId = 'external:' + createHash('sha256').update(JSON.stringify([source, rawId])).digest('hex');
    this.remember(externalKey(source, senderId), loginName);
  }
  forActor(actors, actorId, scope = new Map()) {
    const actor = actors.get(actorId);
    if (!actor?.enabled || actor.kind !== 'human') return null;
    const photos = actors.bindings(actorId).filter(b => b.provider === 'tencentoa' && /^[1-9][0-9]*$/u.test(b.subject))
      .map(b => {
        const cached = this.lookup(JSON.stringify([b.provider, b.subject]));
        if (cached) return cached;
        // Older verified logins predate the photo cache. Reuse IOA's existing
        // read-only subject -> account owner; never the Actor's mutable label.
        const key = 'join.ioa.avatar-owner:' + this.path;
        let names = scope.get(key);
        if (!names) { names = new Map(); scope.set(key, names); }
        if (!names.has(b.subject)) {
          let directory;
          try { directory = createNativeMemberOwnerDirectory(dirname(this.path)); names.set(b.subject, directory.lookup(b.subject)); }
          catch { names.set(b.subject, null); }
          finally { directory?.close(); }
        }
        const name = names.get(b.subject);
        return account(name) ? {kind:'employee',name} : null;
      }).filter(Boolean);
    const names = new Set(photos.map(p => p.name));
    return names.size === 1 ? { kind: 'employee', name: photos[0].name } : null;
  }
  forExternal(source, senderId) { return this.lookup(externalKey(source, senderId)); }
}
export function avatarProfiles(directory) {
  const path = avatarProfilePath(resolve(directory));
  if (!stores.has(path)) stores.set(path, new VerifiedAvatarProfiles(path));
  return stores.get(path);
}
/** Display-only name fallback, explicitly separate from verified identity metadata.
 * Never persist it, feed it to account linking, or use it as admission evidence. */
export function actorPresentationAvatar(profiles, actors, actorId, scope = new Map()) {
  const verified = profiles.forActor(actors, actorId, scope);
  if (verified) return verified;
  const actor = actors.get(actorId);
  if (!actor?.enabled || actor.kind !== 'human') return null;
  const oa = actors.bindings(actorId).filter(b => b.provider === 'tencentoa' && /^[1-9][0-9]*$/u.test(b.subject));
  const name = typeof actor.displayName === 'string' ? actor.displayName.trim().toLowerCase() : '';
  // Only RTX-shaped employee labels in the OA namespace. Numeric IDs, arbitrary
  // nicknames, URLs and labels from unrelated providers remain default avatars.
  return oa.length === 1 && /^[a-z][a-z0-9._-]{0,127}$/u.test(name) ? {kind:'employee',name} : null;
}
/** Product-owned provider namespace and exact opaque-ID association. One index
 * per source/read; never retain identity links across reads or guess by label. */
export function communicationAvatar(service, db, subject, scope = new Map()) {
  const location = db.location();
  if (!location) return null;
  const profiles = avatarProfiles(dirname(location));
  if ('actorId' in subject) {
    const actor=service.actors.get(subject.actorId);
    if (actor?.enabled) return actorPresentationAvatar(profiles, service.actors, subject.actorId, scope);
    // A trusted directory reservation may lend a roster photo, never login,
    // message authorship or admission. The alias comes from its exact reservation,
    // not the mutable display name; ordinary disabled/revoked actors fail closed.
    if (!service.actors.isReservedHuman(subject.actorId)) return null;
    const rows=db.prepare("SELECT alias FROM actor_human_reservations WHERE actor_id=? AND state='pending' AND login_provider='tencentoa'").all(subject.actorId);
    const names=new Set(rows.map(row=>row.alias));
    return names.size===1 && account(rows[0].alias) ? {kind:'employee',name:rows[0].alias} : null;
  }
  const {source, senderId} = subject;
  let parts;
  try { parts = JSON.parse(source); } catch { return null; }
  if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 'wecom-customer-service'
    || parts.slice(1).some(p => typeof p !== 'string' || !p)) return null;
  const id = linkedSenderActorId(db, subject, scope);
  if (id) {
    const actor = service.actors.get(id);
    if (!actor?.enabled || actor.kind !== 'human' || !service.admittedActor(id)) return null;
    const avatar = actorPresentationAvatar(profiles, service.actors, id, scope);
    if (avatar) return avatar;
  }
  return profiles.forExternal(source, senderId);
}
