import Database from 'better-sqlite3';
import {createHash,randomBytes,randomUUID,scryptSync} from 'node:crypto';
import type {Identity,IdentityKind} from '@vela/im-client';
export const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
export class Store {
 readonly db:Database.Database;
 constructor(path:string) {
  this.db=new Database(path);this.db.pragma('journal_mode = WAL');this.db.pragma('foreign_keys = ON');
  this.db.exec(`
   CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, subject TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS identities (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), kind TEXT NOT NULL CHECK(kind IN ('human','agent')), name TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS tokens (digest TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), identity_id TEXT REFERENCES identities(id), expires_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS token_identity ON tokens(identity_id);
   CREATE TABLE IF NOT EXISTS demo_participants (identity_id TEXT PRIMARY KEY REFERENCES identities(id), created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS group_reply_policies (group_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('mention','mention_context','all')), updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS demo_friendships (a TEXT NOT NULL, b TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(a,b));
   CREATE TABLE IF NOT EXISTS identity_settings (identity_id TEXT PRIMARY KEY REFERENCES identities(id), command_policy TEXT NOT NULL CHECK(command_policy IN ('owner','anyone')), updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS agents (identity_id TEXT PRIMARY KEY REFERENCES identities(id), host TEXT NOT NULL, profile TEXT, state TEXT NOT NULL CHECK(state IN ('registered','provisioning','ready','error')), error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `);
  // External reference (e.g. the LightVela bot an Agent represents); added after the first release of this table.
  if(!(this.db.prepare('PRAGMA table_info(agents)').all() as Array<{name:string}>).some(c=>c.name==='external_ref'))this.db.exec('ALTER TABLE agents ADD COLUMN external_ref TEXT');
  this.db.exec('CREATE INDEX IF NOT EXISTS agents_external_ref ON agents(external_ref)');
  // Earlier demo builds made every participant pair friends; record those pairs so they can be released.
  if(!(this.db.prepare('SELECT 1 FROM demo_friendships LIMIT 1').get())) this.db.exec(`
   INSERT OR IGNORE INTO demo_friendships SELECT MIN(x.identity_id,y.identity_id),MAX(x.identity_id,y.identity_id),MAX(x.created_at,y.created_at)
   FROM demo_participants x JOIN demo_participants y ON x.identity_id<y.identity_id`);
 }
 /** Demo-provisioned friendships, oldest first; stored once per pair with a < b. */
 demoFriends(id:string):string[] {
  return (this.db.prepare('SELECT CASE WHEN a=? THEN b ELSE a END AS id FROM demo_friendships WHERE a=? OR b=? ORDER BY created_at').all(id,id,id) as {id:string}[]).map(r=>r.id);
 }
 renameOwner(id:string,name:string) {this.db.prepare('UPDATE owners SET name=? WHERE id=?').run(name,id)}
 renameIdentity(id:string,name:string) {this.db.prepare('UPDATE identities SET name=? WHERE id=?').run(name,id)}
 ownerName(id:string):string|undefined {return (this.db.prepare('SELECT name FROM owners WHERE id=?').get(id) as any)?.name}
 /** Exact IM ID, or a name fragment; returns at most `limit` identities with their owner's display name. */
 searchIdentities(query:string,limit=20):Array<Identity&{ownerName:string}> {
  const q=query.trim();if(!q)return [];
  return this.db.prepare(`SELECT i.id,i.owner_id AS ownerId,i.kind,i.name,i.created_at AS createdAt,o.name AS ownerName FROM identities i JOIN owners o ON o.id=i.owner_id
   WHERE i.id=? OR i.name LIKE ? ESCAPE '\\' ORDER BY (i.id=?) DESC,i.created_at DESC LIMIT ?`).all(q,`%${q.replace(/[\\%_]/g,m=>'\\'+m)}%`,q,limit) as any;
 }
 addAgent(identityId:string,host:string,externalRef:string|null=null) {const now=Date.now();this.db.prepare("INSERT INTO agents (identity_id,host,profile,state,error,created_at,updated_at,external_ref) VALUES (?,?,NULL,'registered',NULL,?,?,?)").run(identityId,host,now,now,externalRef)}
 /** The owner's Agent registered for an external reference, if any. */
 agentByRef(ownerId:string,externalRef:string) {return this.db.prepare('SELECT a.identity_id AS id FROM agents a JOIN identities i ON i.id=a.identity_id WHERE i.owner_id=? AND a.external_ref=?').get(ownerId,externalRef) as {id:string}|undefined}
 updateAgent(identityId:string,patch:{state:'registered'|'provisioning'|'ready'|'error';profile?:string|null;error?:string|null}) {
  this.db.prepare('UPDATE agents SET state=?,profile=COALESCE(?,profile),error=?,updated_at=? WHERE identity_id=?').run(patch.state,patch.profile??null,patch.error??null,Date.now(),identityId);
 }
 agents(ownerId:string):Array<Identity&{host:string;profile:string|null;state:string;error:string|null;externalRef:string|null}> {
  return this.db.prepare(`SELECT i.id,i.owner_id AS ownerId,i.kind,i.name,i.created_at AS createdAt,a.host,a.profile,a.state,a.error,a.external_ref AS externalRef FROM agents a JOIN identities i ON i.id=a.identity_id WHERE i.owner_id=? ORDER BY i.created_at`).all(ownerId) as any;
 }
 agent(identityId:string) {return this.db.prepare('SELECT identity_id AS identityId,host,profile,state,error,external_ref AS externalRef FROM agents WHERE identity_id=?').get(identityId) as {identityId:string;host:string;profile:string|null;state:string;error:string|null;externalRef:string|null}|undefined}
 /** Who may issue runtime commands (e.g. Hermes /new) to this identity: only its owner's identities, or anyone. */
 identitySettings(id:string):{commandPolicy:'owner'|'anyone';updatedAt:number} {
  return this.db.prepare('SELECT command_policy AS commandPolicy,updated_at AS updatedAt FROM identity_settings WHERE identity_id=?').get(id) as any??{commandPolicy:'owner',updatedAt:0};
 }
 setIdentitySettings(id:string,commandPolicy:'owner'|'anyone') {
  this.db.prepare('INSERT INTO identity_settings VALUES (?,?,?) ON CONFLICT(identity_id) DO UPDATE SET command_policy=excluded.command_policy,updated_at=excluded.updated_at').run(id,commandPolicy,Date.now());
 }
 addDemoFriendship(x:string,y:string) {const [a,b]=[x,y].sort();this.db.prepare('INSERT OR IGNORE INTO demo_friendships VALUES (?,?,?)').run(a,b,Date.now())}
 removeDemoFriendship(x:string,y:string) {const [a,b]=[x,y].sort();this.db.prepare('DELETE FROM demo_friendships WHERE a=? AND b=?').run(a,b)}
 owner(subject:string,name:string) {
  const old=this.db.prepare('SELECT * FROM owners WHERE subject=?').get(subject) as any;
  if(old)return old;
  const id=randomUUID();const salt=randomBytes(16).toString('hex');
  // 内部密码由服务端随机生成，只保留 salted hash；外层登录映射 subject。
  const passwordHash=`${salt}:${scryptSync(randomBytes(32),salt,32).toString('hex')}`;
  this.db.prepare('INSERT INTO owners VALUES (?,?,?,?,?)').run(id,subject,name,passwordHash,Date.now());
  return {id,subject,name};
 }
 identities(ownerId:string):Identity[] {
  return this.db.prepare('SELECT id,owner_id AS ownerId,kind,name,created_at AS createdAt FROM identities WHERE owner_id=? ORDER BY created_at').all(ownerId) as Identity[];
 }
 identity(id:string):Identity|undefined {
  return this.db.prepare('SELECT id,owner_id AS ownerId,kind,name,created_at AS createdAt FROM identities WHERE id=?').get(id) as Identity|undefined;
 }
 demoParticipants():Identity[] {return this.db.prepare('SELECT i.id,i.owner_id AS ownerId,i.kind,i.name,i.created_at AS createdAt FROM demo_participants d JOIN identities i ON i.id=d.identity_id ORDER BY d.created_at').all() as Identity[]}
 isDemoIdentity(id:string) {return !!this.db.prepare('SELECT 1 FROM demo_participants WHERE identity_id=?').get(id)}
 enrollDemo(id:string) {this.db.prepare('INSERT OR IGNORE INTO demo_participants VALUES (?,?)').run(id,Date.now())}
 groupReplyPolicy(groupID:string):{mode:'mention'|'mention_context'|'all';updatedAt:number} {
  return this.db.prepare('SELECT mode,updated_at AS updatedAt FROM group_reply_policies WHERE group_id=?').get(groupID) as any??{mode:'mention',updatedAt:0};
 }
 setGroupReplyPolicy(groupID:string,mode:string) {this.db.prepare('INSERT INTO group_reply_policies VALUES (?,?,?) ON CONFLICT(group_id) DO UPDATE SET mode=excluded.mode,updated_at=excluded.updated_at').run(groupID,mode,Date.now())}
 addIdentity(ownerId:string,name:string,kind:IdentityKind,id=`${kind==='agent'?'a':'h'}_${randomUUID().replaceAll('-','')}`):Identity {
  const identity:Identity={id,ownerId,name,kind,createdAt:Date.now()};
  this.db.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run(identity.id,ownerId,kind,name,identity.createdAt);return identity;
 }
 token(ownerId:string,identityId:string|null,lifetimeMs=identityId?30*86400000:86400000) {
  const token=`vela_${randomBytes(32).toString('base64url')}`;const expiresAt=Date.now()+lifetimeMs;
  this.db.prepare('INSERT INTO tokens VALUES (?,?,?,?)').run(hash(token),ownerId,identityId,expiresAt);return {token,expiresAt};
 }
 authenticate(token:string):{ownerId:string;identityId:string|null;expiresAt:number}|undefined {
  return this.db.prepare('SELECT owner_id AS ownerId,identity_id AS identityId,expires_at AS expiresAt FROM tokens WHERE digest=? AND expires_at>?').get(hash(token),Date.now()) as any;
 }
 revoke(token:string) {this.db.prepare('DELETE FROM tokens WHERE digest=?').run(hash(token))}
 revokeIdentity(id:string) {this.db.prepare('DELETE FROM tokens WHERE identity_id=?').run(id)}
 close(){this.db.close()}
}
