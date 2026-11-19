import { createHash } from 'node:crypto';
import {
  FORWARDED_RECORD_MIME,
  parseForwardedRecord,
  forwardedRecordIdentity,
} from '@opencraft/appserver-protocol';
import { readInboundFileChunk } from './inbound-files.mjs';
export const forwardedFingerprint = (arrival) =>
  arrival.forwardedRecord
    ? [
        createHash('sha256')
          .update(
            JSON.stringify(forwardedRecordIdentity(arrival.forwardedRecord)),
          )
          .digest('hex'),
      ]
    : [];
/** Existing native attachment bytes belong to the enclosing native message and its membership checks. */
export function persistForwardedRecord(db, arrival, messageId) {
  if (!arrival.forwardedRecord) return;
  const record = parseForwardedRecord(arrival.forwardedRecord),
    bytes = Buffer.from(JSON.stringify(record)),
    name =
      record.title.replace(/[\\/\x00-\x1f]/gu, '_').slice(0, 120) +
      '.chat-record.json';
  db.prepare(
    'INSERT INTO actor_channel_attachments(message_id,name,mime,bytes) VALUES(?,?,?,?)',
  ).run(messageId, name, FORWARDED_RECORD_MIME, bytes);
}
export function forwardedResource(service, db, c, p) {
  if (
    !p ||
    Object.keys(p).some(
      (k) => !['channelId', 'sequence', 'path', 'offset'].includes(k),
    ) ||
    typeof p.channelId !== 'string' ||
    !Number.isSafeInteger(p.sequence) ||
    p.sequence < 1 ||
    typeof p.path !== 'string' ||
    !Number.isSafeInteger(p.offset) ||
    p.offset < 0
  )
    throw Error('invalid_input');
  service.channels.assertReadable(c, p.channelId);
  const row = db
    .prepare(
      'SELECT a.mime,a.bytes,e.source FROM actor_messages m JOIN actor_channel_attachments a ON a.message_id=m.id JOIN actor_channel_external_messages e ON e.message_id=m.id WHERE m.channel_id=? AND m.seq=?',
    )
    .get(p.channelId, p.sequence);
  if (!row || row.mime !== FORWARDED_RECORD_MIME) return null;
  const record = parseForwardedRecord(
      JSON.parse(Buffer.from(row.bytes).toString()),
    ),
    ref = record.resources?.find((r) => r.path === p.path);
  return ref
    ? readInboundFileChunk(ref.id, String(row.source), p.offset)
    : null;
}
