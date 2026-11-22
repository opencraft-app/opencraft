import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, chmodSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { addAbortSignal, Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { BlobDigestError, BlobLimitError, type BlobUpload } from '@opencraft/blob-storage';
import { openManagedDatabase, createSchemaValidator } from '@opencraft/sqlite-node';
import { hostFileBlobStore, type HostFileBlobStore } from '../storage/host-file-blobs.js';

export interface Artifact {
  id: string; name: string; mimeType: string; size: number; sha256: string; path: string;
  origin: 'upload' | 'generation' | 'transform' | 'execution-copy';
}
export interface ArtifactIdentity { scope: string; key: string }
export type ArtifactSource = Omit<Artifact, 'id'>;
const schema = `
CREATE TABLE artifacts (id TEXT PRIMARY KEY, scope TEXT NOT NULL, source_key TEXT NOT NULL,
 name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
 path TEXT NOT NULL, origin TEXT NOT NULL, created_ms INTEGER NOT NULL, deleting INTEGER NOT NULL DEFAULT 0,
 UNIQUE(scope, source_key)) STRICT;
CREATE TABLE artifact_references (owner TEXT NOT NULL, slot TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id),
 PRIMARY KEY(owner, slot)) STRICT;
CREATE INDEX artifact_reference_target ON artifact_references(artifact_id);
CREATE TABLE artifact_ingestions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, path TEXT NOT NULL,
 phase TEXT NOT NULL, created_ms INTEGER NOT NULL) STRICT;
CREATE TABLE artifact_leases (owner TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id),
 PRIMARY KEY(owner, artifact_id)) STRICT;
`;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const stamp = (s: import('node:fs').BigIntStats) => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');

/** Verify the opened object, not a path/length guess. Never buffer the whole file. */
export async function inspectArtifactFile(path: string, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw Error('Artifact must be a regular file');
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) { size += chunk.length; hash.update(chunk); }
    if (stamp(before) !== stamp(await file.stat({ bigint: true })) || BigInt(size) !== before.size) throw Error('Artifact changed while reading');
    return { size, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}

/** Host-owned, engine-neutral directory. GC is intentionally inspect-only until migration is complete. */
export class ArtifactCatalog {
  private readonly db: DatabaseSync;
  private closed=false;
  readonly root: string;
  private readonly content: HostFileBlobStore;
  /**
   * `content` owns the object bytes; this catalog owns their SQL index and cleanup.
   * The default keeps key `content/<ingestionId>` at the historical `root/content/<ingestionId>`.
   */
  constructor(root: string, content?: HostFileBlobStore) {
    this.root = resolve(root); mkdirSync(join(this.root, 'content'), { recursive: true, mode: 0o700 });
    this.content = content ?? hostFileBlobStore(this.root);
    // Serialize schema opening across Gateway/engine owners; ordinary writes use SQLite transactions.
    const schemaPath=join(this.root,'schema-lock.sqlite'),schemaLock=new DatabaseSync(schemaPath);
    chmodSync(schemaPath,0o600);
    try {
      schemaLock.exec('PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE');
      this.db = openManagedDatabase({ schemaId: 'artifact-catalog', path: join(this.root, 'catalog.sqlite'), legacyPolicy: 'reject-unknown',
        validateSchema: createSchemaValidator(schema), migrations: [{ version: 1, name: 'artifact-catalog', sql: schema }] }).database;
    } finally {schemaLock.close();}
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  }
  id(identity: ArtifactIdentity) {
    if (!identity.scope || !identity.key || identity.scope.length > 8192 || identity.key.length > 8192) throw Error('Invalid artifact identity');
    return digest(JSON.stringify([identity.scope, identity.key]));
  }
  get(id: string): Artifact | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=? AND deleting=0').get(id);
    return row ? { id: String(row.id), name: String(row.name), mimeType: String(row.mime), size: Number(row.size),
      sha256: String(row.sha256), path: String(row.path), origin: String(row.origin) as Artifact['origin'] } : null;
  }
  /** Only trusted storage owners register a committed path. General files use ingest(). */
  register(identity: ArtifactIdentity, source: ArtifactSource, reference?: { owner: string; slot: string }): Artifact {
    if (!Number.isSafeInteger(source.size) || source.size < 0 || !/^[a-f0-9]{64}$/.test(source.sha256)
      || !source.name || source.name.length > 255 || source.mimeType.length > 255 || !['upload','generation','transform','execution-copy'].includes(source.origin)
      || resolve(source.path) !== source.path) throw Error('Invalid artifact metadata');
    const id = this.id(identity);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.get(id);
      if (existing && (existing.sha256 !== source.sha256 || existing.size !== source.size || existing.name !== source.name
        || existing.mimeType !== source.mimeType || existing.origin !== source.origin)) throw Error('Artifact identity has different content or metadata');
      if (!existing) this.db.prepare('INSERT INTO artifacts(id,scope,source_key,name,mime,size,sha256,path,origin,created_ms) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, identity.scope, identity.key, source.name, source.mimeType, source.size, source.sha256, source.path, source.origin, Date.now());
      if (reference) this.retain(id, reference.owner, reference.slot);
      this.db.exec('COMMIT'); return existing ?? { id, ...source };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  retain(id: string, owner: string, slot: string) {
    if (!owner || !slot || !this.get(id)) throw Error('Invalid artifact reference');
    const prior = this.db.prepare('SELECT artifact_id FROM artifact_references WHERE owner=? AND slot=?').get(owner,slot);
    if (prior && prior.artifact_id !== id) throw Error('Artifact reference cannot change version');
    this.db.prepare('INSERT OR IGNORE INTO artifact_references SELECT ?,?,id FROM artifacts WHERE id=? AND deleting=0').run(owner,slot,id);
    if(!this.db.prepare('SELECT 1 FROM artifact_references WHERE owner=? AND slot=? AND artifact_id=?').get(owner,slot,id))throw Error('Artifact is being removed');
  }
  release(owner: string, slot?: string) {
    if (slot === undefined) this.db.prepare('DELETE FROM artifact_references WHERE owner=?').run(owner);
    else this.db.prepare('DELETE FROM artifact_references WHERE owner=? AND slot=?').run(owner,slot);
  }
  cloneReferences(source: string, target: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.db.prepare('SELECT slot,artifact_id FROM artifact_references WHERE owner=?').all(source))
        this.retain(String(row.artifact_id),target,String(row.slot));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  findPath(path: string): Artifact | null {
    const row=this.db.prepare('SELECT id FROM artifacts WHERE path=? AND origin != ?').get(path,'execution-copy');
    return row?this.get(String(row.id)):null;
  }
  beginRemoval(id: string) {
    return Number(this.db.prepare('UPDATE artifacts SET deleting=1 WHERE id=? AND deleting=0 AND NOT EXISTS(SELECT 1 FROM artifact_references WHERE artifact_id=?) AND NOT EXISTS(SELECT 1 FROM artifact_leases WHERE artifact_id=?)').run(id,id,id).changes)===1;
  }
  cancelRemoval(id: string) {this.db.prepare('UPDATE artifacts SET deleting=0 WHERE id=?').run(id);}
  forgetUnreferenced(id: string) {
    this.db.prepare('DELETE FROM artifacts WHERE id=? AND NOT EXISTS(SELECT 1 FROM artifact_references WHERE artifact_id=?) AND NOT EXISTS(SELECT 1 FROM artifact_leases WHERE artifact_id=?)').run(id,id,id);
  }
  hasReferences(id: string) { return !!this.db.prepare('SELECT 1 FROM artifact_references WHERE artifact_id=? LIMIT 1').get(id); }
  lease(id: string, owner: string) {
    if (!owner || !this.get(id)) throw Error('Invalid artifact lease');
    this.db.prepare('INSERT OR IGNORE INTO artifact_leases SELECT ?,id FROM artifacts WHERE id=? AND deleting=0').run(owner,id);
    if(!this.db.prepare('SELECT 1 FROM artifact_leases WHERE owner=? AND artifact_id=?').get(owner,id))throw Error('Artifact is being removed');
  }
  releaseLease(owner: string) { this.db.prepare('DELETE FROM artifact_leases WHERE owner=?').run(owner); }
  /** No age-only deletion: pending/legacy references remain protected; leases require explicit reconciliation. */
  gcCandidates(beforeMs: number) {
    return this.db.prepare(`SELECT id,path,size,origin FROM artifacts a WHERE deleting=0 AND created_ms < ?
      AND NOT EXISTS(SELECT 1 FROM artifact_references r WHERE r.artifact_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM artifact_leases l WHERE l.artifact_id=a.id)`).all(beforeMs);
  }
  incompleteIngestions() {
    return this.db.prepare("SELECT i.*,EXISTS(SELECT 1 FROM artifacts a WHERE a.id=i.artifact_id AND a.deleting=0) AS has_committed_artifact FROM artifact_ingestions i WHERE phase='receiving'").all();
  }
  async ingest(identity: ArtifactIdentity, metadata: Pick<Artifact,'name'|'mimeType'|'origin'>,
    body: Readable, options: { maxBytes: number; size?: number; sha256?: string; signal?: AbortSignal; reference: { owner: string; slot: string } }): Promise<Artifact> {
    this.id(identity);
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.size !== undefined && (!Number.isSafeInteger(options.size) || options.size < 0 || options.size > options.maxBytes)
      || !options.reference.owner || !options.reference.slot || !metadata.name || metadata.name.length > 255 || metadata.mimeType.length > 255) {body.destroy();throw Error('Invalid artifact admission');}
    const ingestionId=randomUUID(),key=`content/${ingestionId}`,path=this.content.path(key);
    const limit=options.size ?? options.maxBytes;
    let upload: BlobUpload | undefined;
    try {
      this.db.prepare("INSERT INTO artifact_ingestions VALUES(?,?,?,?,?)").run(ingestionId,this.id(identity),path,"receiving",Date.now());
      upload = await this.content.blobs.upload(key,{maxBytes:limit});
      if (options.signal) addAbortSignal(options.signal,body);
      let size=0;
      for await (const value of body as AsyncIterable<Uint8Array | string>) {
        options.signal?.throwIfAborted();
        const chunk = typeof value === 'string' ? Buffer.from(value) : value;
        size += chunk.byteLength;
        await upload.write(chunk);
      }
      if (options.size !== undefined && size !== options.size) throw Error('Artifact content mismatch');
      // The blob store fsyncs the object and its directory before it becomes visible.
      const {size: stored, sha256} = await upload.complete(options.sha256 === undefined ? {} : {sha256:options.sha256});
      const existing=this.get(this.id(identity));
      if(existing){const actual=await inspectArtifactFile(existing.path,options.signal);if(actual.sha256!==existing.sha256 || actual.size!==existing.size)throw Error('Registered artifact content changed');}
      const result = this.register(identity,{...metadata,path,size:stored,sha256},options.reference);
      if (result.path !== path) await this.content.blobs.delete(key);
      this.db.prepare("UPDATE artifact_ingestions SET phase='committed' WHERE id=?").run(ingestionId);
      return result;
    } catch (cause) {
      body.destroy();
      const error = cause instanceof BlobLimitError ? Error('Artifact exceeds declared size')
        : cause instanceof BlobDigestError ? Error('Artifact content mismatch') : cause;
      // A lost acknowledgement after COMMIT must not delete the published object.
      let uncertain=this.closed;
      if(!uncertain){try{uncertain=this.get(this.id(identity))?.path===path;}catch{uncertain=true;}}
      if(!uncertain){
        await upload?.abort();
        await this.content.blobs.delete(key);
        this.db.prepare("UPDATE artifact_ingestions SET phase='failed' WHERE id=?").run(ingestionId);
      }
      throw error;
    }
  }
  close() { if(!this.closed){this.closed=true;this.db.close();} }
}

export function artifactFileBody(path: string) {
  return Readable.from((async function* () {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({bigint:true});
      if (!before.isFile()) throw Error('Artifact must be a regular file');
      for await (const chunk of file.createReadStream({autoClose:false})) yield chunk;
      if (stamp(before)!==stamp(await file.stat({bigint:true}))) throw Error('Artifact changed while reading');
    } finally {await file.close();}
  })());
}

/** Linux mount declaration is the local backend's capability, never a renderer flag. */
export async function isReadOnlyArtifactMount(path: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const { readFile, realpath } = await import('node:fs/promises');
  const actual = await realpath(path);
  const mounts = (await readFile('/proc/self/mountinfo','utf8')).split('\n').map(line => {
    const fields = line.split(' ');
    const mount = fields[4]?.replace(/\\([0-7]{3})/g,(_m,octal:string)=>String.fromCharCode(parseInt(octal,8)));
    return {mount,readOnly:fields[5]?.split(',').includes('ro')};
  }).filter(row=>row.mount && (actual===row.mount || actual.startsWith(row.mount==='/'?'/':row.mount+'/')))
    .sort((a,b)=>b.mount!.length-a.mount!.length);
  return mounts[0]?.readOnly === true;
}

export async function prepareLocalArtifact(artifact: Artifact, catalog: ArtifactCatalog, owner: string, signal?: AbortSignal): Promise<Artifact> {
  if (await isReadOnlyArtifactMount(artifact.path).catch(()=>false)) {
    const actual = await inspectArtifactFile(artifact.path,signal);
    if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256) throw Error('Artifact content mismatch');
    catalog.lease(artifact.id,owner);
    return artifact;
  }
  const identity = {scope:'execution-copy',key:artifact.id};
  const existing = catalog.get(catalog.id(identity));
  if (existing) {
    const actual = await inspectArtifactFile(existing.path,signal);
    if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size) throw Error('Execution artifact content changed');
    catalog.lease(existing.id,owner); return existing;
  }
  const copy = await catalog.ingest(identity,{name:artifact.name,mimeType:artifact.mimeType,origin:'execution-copy'},artifactFileBody(artifact.path),
    {maxBytes:1024**3,size:artifact.size,sha256:artifact.sha256,signal,reference:{owner,slot:JSON.stringify(["replica",artifact.id])}});
  catalog.lease(copy.id,owner); return copy;
}
