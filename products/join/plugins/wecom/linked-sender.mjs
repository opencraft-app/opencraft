import {createHash} from 'node:crypto';

/** Exact verified bindings only. Labels and directory photo hints are not identity.
 * Indexes live for one native projection read, never across binding mutations. */
export function linkedSenderActorId(db, {source, senderId}, scope = new Map()) {
  let parts;
  try { parts = JSON.parse(source); } catch { return null; }
  if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 'wecom-customer-service'
    || parts.slice(1).some(p => typeof p !== 'string' || !p)) return null;
  let index = scope.get(source);
  if (!index) {
    index = new Map(); scope.set(source, index);
    const rows = db.prepare("SELECT binding,actor_id FROM actor_bindings WHERE json_extract(binding,'$[0]')=?").all('wecom.' + parts[1]);
    for (const row of rows) {
      const [, rawId] = JSON.parse(String(row.binding));
      const opaque = 'external:' + createHash('sha256').update(JSON.stringify([source, rawId])).digest('hex');
      index.set(opaque, String(row.actor_id));
    }
  }
  return index.get(senderId) ?? null;
}

export function communicationSenderHuman(service, db, subject, scope) {
  const id = linkedSenderActorId(db, subject, scope);
  const actor = id ? service.actors.get(id) : null;
  return actor?.enabled && actor.kind === 'human' && service.admittedActor(actor.id) ? actor.id : null;
}
