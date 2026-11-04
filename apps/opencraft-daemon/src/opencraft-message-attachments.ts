import {randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {setImmediate as yieldControl} from 'node:timers/promises';
import {parseMessageAttachmentQuery,projectMessageAttachmentPage,MESSAGE_ATTACHMENT_SOURCE,metadataText,type MessageAttachmentQuery,type ConversationMessageAttachments} from '@opencraft/appserver-protocol';
import type {ConversationRef} from '@opencraft/appserver-protocol/collaboration';
import { ownedDatabasePath } from "./owned-database-path.js";
import { acquireOwnedStorageLease } from "./owned-storage-lease.js";
import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createMissingLegacyObjects, type DatabaseOutcome } from "@opencraft/sqlite-node";

import type { AttachmentRef } from "@opencraft/appserver-protocol";

export const OPENCRAFT_MESSAGE_ATTACHMENTS_BASELINE = `
CREATE TABLE codex_message_attachments (
        thread_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        ref_json TEXT NOT NULL,
        PRIMARY KEY(thread_id, client_message_id, attachment_id)
      ) STRICT;
      CREATE INDEX codex_message_attachments_message
        ON codex_message_attachments(thread_id, client_message_id, ordinal);
`;

/** v2 changes owned live names without rewriting the published v1 baseline. */
export const OPENCRAFT_MESSAGE_ATTACHMENTS_OWNED_NAMES = `
ALTER TABLE codex_message_attachments RENAME TO opencraft_message_attachments;
DROP INDEX codex_message_attachments_message;
CREATE INDEX opencraft_message_attachments_message
  ON opencraft_message_attachments(thread_id, client_message_id, ordinal);
`;
export const OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS = [
  { version: 1, name: "codex-message-attachments", sql: OPENCRAFT_MESSAGE_ATTACHMENTS_BASELINE },
  { version: 2, name: "opencraft-message-attachments-owned-names", sql: OPENCRAFT_MESSAGE_ATTACHMENTS_OWNED_NAMES },
] as const;
const FULL_SCHEMA = OPENCRAFT_MESSAGE_ATTACHMENTS_BASELINE + OPENCRAFT_MESSAGE_ATTACHMENTS_OWNED_NAMES;
const legacy = createMissingLegacyObjects(OPENCRAFT_MESSAGE_ATTACHMENTS_BASELINE);

/** Durable display metadata; Codex's native `mention` remains the execution input. */
export class OpenCraftMessageAttachments {
  private readonly db: DatabaseSync;
  private readonly metadataCursorKey=randomBytes(32);
  private metadataClosed=false;
  readonly outcome: DatabaseOutcome;
  readonly path: string;
  private readonly releaseLease: () => void;

  constructor(dataDirectory: string) {
    ownedDatabasePath(dataDirectory, "opencraft-message-attachments.sqlite", "codex-message-attachments.sqlite");
    this.releaseLease = acquireOwnedStorageLease(dataDirectory);
    try {
      const path = this.path = ownedDatabasePath(dataDirectory, "opencraft-message-attachments.sqlite", "codex-message-attachments.sqlite");
      const managed = openManagedDatabase({ schemaId: "opencraft-message-attachments", path, legacyPolicy: "reject-unknown",  migrations: OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS,
        legacyMigration: { accepts: legacy.accepts, migrate(database) { legacy.migrate(database); database.exec(OPENCRAFT_MESSAGE_ATTACHMENTS_OWNED_NAMES); } } });
      this.db = managed.database;
      this.outcome = managed.outcome;
    } catch (error) { this.releaseLease(); throw error; }
  }

  close(): void { this.metadataClosed=true;try { this.db.close(); } finally { this.releaseLease(); } }

  /** Record before dispatch. A retry may repeat the same identity, never replace it. */
  record(threadId: string, clientMessageId: string, refs: readonly AttachmentRef[]): void {
    if (!threadId || !clientMessageId) throw new Error("Attachment message identity is required");
    if (refs.length === 0) return;
    const existing = this.list(threadId, clientMessageId);
    if (existing.length > 0) {
      if (JSON.stringify(existing) !== JSON.stringify(refs)) {
        throw new Error("Client message identity already has different attachments");
      }
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(`INSERT INTO opencraft_message_attachments
        (thread_id,client_message_id,attachment_id,ordinal,ref_json) VALUES(?,?,?,?,?)`);
      refs.forEach((ref, ordinal) => insert.run(threadId, clientMessageId, ref.id, ordinal, JSON.stringify(ref)));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(threadId: string, clientMessageId: string): AttachmentRef[] {
    return this.db.prepare(`SELECT ref_json FROM opencraft_message_attachments
      WHERE thread_id=? AND client_message_id=? ORDER BY ordinal`)
      .all(threadId, clientMessageId)
      .map(row => JSON.parse(String(row.ref_json)) as AttachmentRef);
  }

  /** PK keyset window only. Ref JSON is clipped in SQL before decoding; no body/file reads. */
  async readMetadata(scope:{actorId:string;generation:number;expiresAt:number;ref:ConversationRef},raw:MessageAttachmentQuery,
    assertCurrent:()=>void,signal?:AbortSignal):Promise<ConversationMessageAttachments> {
    const started=performance.now(),check=()=>{assertCurrent();signal?.throwIfAborted();if(this.metadataClosed||performance.now()-started>250||Date.now()>=scope.expiresAt)throw Error();};
    try {
      check();const query=parseMessageAttachmentQuery(raw),limit=query.limit??25;
      const binding=createHash('sha256').update(JSON.stringify([1,scope.actorId,scope.generation,scope.ref,query.clientMessageId??null,limit])).digest('hex');
      let position:string[]|null=null,expires=Math.min(scope.expiresAt,Date.now()+300000);
      if(query.cursor!==undefined){
        try {
          const bytes=Buffer.from(query.cursor,'base64url');if(bytes.toString('base64url')!==query.cursor||bytes.length<29||bytes.length>3072)throw Error();
          const decipher=createDecipheriv('aes-256-gcm',this.metadataCursorKey,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));
          const value=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
          if(!Array.isArray(value)||value.length!==3||value[0]!==binding||!Number.isSafeInteger(value[1])||value[1]<=Date.now()||value[1]>scope.expiresAt||!Array.isArray(value[2])||value[2].length!==2)throw Error();
          position=value[2].map((v:unknown)=>metadataText(v,512));expires=value[1];
        }catch{throw Object.assign(Error('Attachment cursor invalid'),{status:409,code:'attachment_cursor_invalid'});}
      }
      await yieldControl();check();
      const columns=`substr(CAST(client_message_id AS BLOB),1,513) AS message_key,
        substr(CAST(attachment_id AS BLOB),1,513) AS attachment_key,substr(CAST(ref_json AS BLOB),1,8193) AS ref`;
      const rows=query.clientMessageId!==undefined
        ? position===null
          ? this.db.prepare(`SELECT ${columns} FROM opencraft_message_attachments WHERE thread_id=? AND client_message_id=? ORDER BY attachment_id LIMIT ?`).all(scope.ref.threadId,query.clientMessageId,limit+1)
          : this.db.prepare(`SELECT ${columns} FROM opencraft_message_attachments WHERE thread_id=? AND client_message_id=? AND attachment_id>? ORDER BY attachment_id LIMIT ?`).all(scope.ref.threadId,query.clientMessageId,position[1]!,limit+1)
        : position===null
          ? this.db.prepare(`SELECT ${columns} FROM opencraft_message_attachments WHERE thread_id=? ORDER BY client_message_id,attachment_id LIMIT ?`).all(scope.ref.threadId,limit+1)
          : this.db.prepare(`SELECT ${columns} FROM opencraft_message_attachments WHERE thread_id=? AND (client_message_id,attachment_id)>(?,?) ORDER BY client_message_id,attachment_id LIMIT ?`).all(scope.ref.threadId,position[0]!,position[1]!,limit+1);
      check();const entries=[];
      const decode=(v:unknown,max:number)=>{if(!(v instanceof Uint8Array)||v.byteLength>max)throw Error();return new TextDecoder('utf-8',{fatal:true}).decode(v);};
      for(const row of rows.slice(0,limit)){
        check();const clientMessageId=metadataText(decode(row.message_key,512),512),id=metadataText(decode(row.attachment_key,512),512);
        const value=JSON.parse(decode(row.ref,8192));if(value?.id!==id)throw Error();
        entries.push({clientMessageId,id,name:value.name,mimeType:value.mimeType,declaredSize:value.size,kind:value.location?.kind,contentAvailable:'unknown' as const});
        if(entries.length%8===0){await yieldControl();check();}
      }
      let nextCursor:string|null=null;
      if(rows.length>limit){const last=entries.at(-1)!;const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.metadataCursorKey,iv);
        const bytes=Buffer.concat([cipher.update(JSON.stringify([binding,expires,[last.clientMessageId,last.id]]),'utf8'),cipher.final()]);nextCursor=Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url');}
      const result=projectMessageAttachmentPage({ref:scope.ref,source:MESSAGE_ATTACHMENT_SOURCE,observedAt:Date.now(),consistency:'live-pages',entries,nextCursor,complete:nextCursor===null},scope.ref);check();return result;
    }catch(error){assertCurrent();if((error as {code?:unknown}).code==='attachment_cursor_invalid')throw error;throw Object.assign(Error('Attachment metadata unavailable'),{status:503,code:'attachment_metadata_unavailable'});}
  }

  hasReference(attachmentId: string): boolean {
    return this.db.prepare("SELECT 1 FROM opencraft_message_attachments WHERE attachment_id=? LIMIT 1")
      .get(attachmentId) !== undefined;
  }

  /** A fork keeps historical messages but receives a new Thread identity. */
  cloneThread(sourceThreadId: string, targetThreadId: string): void {
    if (!sourceThreadId || !targetThreadId || sourceThreadId === targetThreadId) return;
    this.db.prepare(`INSERT OR IGNORE INTO opencraft_message_attachments
      (thread_id,client_message_id,attachment_id,ordinal,ref_json)
      SELECT ?,client_message_id,attachment_id,ordinal,ref_json
      FROM opencraft_message_attachments WHERE thread_id=?`)
      .run(targetThreadId, sourceThreadId);
  }
}
