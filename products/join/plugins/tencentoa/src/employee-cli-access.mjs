import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

/** Read existing operator-managed CLI public keys. Never migrate, register an
 * identity, generate credentials or select private key columns. */
export function createEmployeeCliAccess({ path, actors, getAccess }) {
  let closed = false;
  const current = username => {
    if (closed || typeof username !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(username)) return [];
    let db;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || ![0, process.getuid()].includes(info.uid) || info.mode & 0o077) return [];
      // No cached authorization: key removal and membership/generation changes
      // are visible on the next request, including isCurrent on active sessions.
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0');
      const rows = db.prepare(`SELECT id,actor_id,subject,username,generation,membership_revision,public_key
        FROM employee_cli_keys WHERE username=? AND revoked_at IS NULL LIMIT 257`).all(username);
      if (!rows.length || rows.length > 256 || new Set(rows.map(row => row.subject)).size !== 1) return [];
      const access = getAccess();
      return rows.filter(row => {
        if (!/^[1-9][0-9]*$/u.test(String(row.subject))) return false;
        const actor = actors.findHuman({ provider: 'tencentoa', subject: row.subject });
        return actor?.enabled && actor.kind === 'human' && actor.id === row.actor_id && actor.generation === row.generation
          && access?.admitsActor(actor.id) === true
          && access.store.revocationRevision(actor.id, actors.bindings(actor.id)) === row.membership_revision;
      });
    } catch { return []; }
    finally { db?.close(); }
  };
  return {
    publicKeys: username => current(username).map(row => row.public_key),
    authorize(username, key) {
      if (!Buffer.isBuffer(key)) return null;
      const row = current(username).find(row => {
        const expected = Buffer.from(String(row.public_key).split(' ')[1] ?? '', 'base64');
        return expected.length === key.length && timingSafeEqual(expected, key);
      });
      if (!row) return null;
      const expiresAt = Date.now() + 86_400_000;
      const isCurrent = () => Date.now() < expiresAt && current(username).some(latest =>
        latest.id === row.id && latest.public_key === row.public_key && latest.actor_id === row.actor_id
        && latest.generation === row.generation && latest.membership_revision === row.membership_revision);
      return { isCurrent, submissionContext: {
        sender: { kind: 'employee', loginName: username },
        executionPrincipal: { provider: 'tencentoa', subject: row.subject, loginName: username },
        actorContext: { actorId: row.actor_id, generation: row.generation, credentialId: null, expiresAt }, validUntil: expiresAt,
        resourceOwner: { id: row.actor_id, assertCurrent() { if (!isCurrent()) throw Error('employee_access_required'); } },
        tokenUsageAuthority: () => isCurrent() ? {
          actorId: row.actor_id, administrator: getAccess()?.store.actorMembership(row.actor_id)?.role === 'admin',
        } : null,
      } };
    },
    close() { closed = true; },
  };
}
