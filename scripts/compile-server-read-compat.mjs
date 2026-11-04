import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { SERVER_MIGRATIONS } from '../packages/storage-node/src/server/migrations.generated.ts';

const root = new URL('../packages/storage-node/src/server/', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
const declaration = JSON.parse(read('read-compat/contracts.json'));
const { baseVersion, baseHash, targetHash, migration, nextMigration, nextHash, onceTierMigration, onceTierHash, attachmentMigration, attachmentHash } = declaration;
const base = SERVER_MIGRATIONS.slice(0, baseVersion);
const sql = read(`read-compat/${migration.tag}.sql`);
const future = { version: migration.version, name: migration.tag, sql };
const target = [...base, future];
if (baseVersion !== 5 || migration.version !== 6 || digest(JSON.stringify(base)) !== baseHash
  || digest(sql) !== migration.sqlChecksum || digest(sql) !== migration.compiledChecksum
  || digest(JSON.stringify(target)) !== targetHash) throw new Error('Server read compatibility contract drift');
const nextSql = read(`read-compat/${nextMigration.tag}.sql`);
const next = {version:nextMigration.version,name:nextMigration.tag,sql:nextSql};
const nextChain = [...target,next];
if(next.version!==7 || digest(nextSql)!==nextMigration.sqlChecksum || digest(nextSql)!==nextMigration.compiledChecksum
  || digest(JSON.stringify(nextChain))!==nextHash) throw new Error('Server7 read compatibility contract drift');
const onceTierSql = read(`read-compat/${onceTierMigration.tag}.sql`);
const onceTier = {version:onceTierMigration.version,name:onceTierMigration.tag,sql:onceTierSql};
const onceTierChain = [...nextChain,onceTier];
if(onceTier.version!==8 || digest(onceTierSql)!==onceTierMigration.sqlChecksum || digest(onceTierSql)!==onceTierMigration.compiledChecksum
  || digest(read('read-compat/0007_snapshot.json'))!==onceTierMigration.snapshotChecksum
  || digest(JSON.stringify(onceTierChain))!==onceTierHash) throw new Error('Server8 read compatibility contract drift');
const attachmentSql=read(`read-compat/${attachmentMigration.tag}.sql`);
const attachment={version:attachmentMigration.version,name:attachmentMigration.tag,sql:attachmentSql};
const attachmentChain=[...onceTierChain,attachment];
if(attachment.version!==9||digest(attachmentSql)!==attachmentMigration.sqlChecksum||digest(attachmentSql)!==attachmentMigration.compiledChecksum||digest(JSON.stringify(attachmentChain))!==attachmentHash)throw new Error('Server9 read compatibility contract drift');
const expected = [base,target,nextChain,onceTierChain,attachmentChain].find(chain=>chain.length===SERVER_MIGRATIONS.length);
if(!expected || JSON.stringify(expected)!==JSON.stringify(SERVER_MIGRATIONS))
  throw new Error('Server writer must match an exact declared compatibility boundary');
const output = '// Generated from owner read-compat/contracts.json and exact reviewed SQL.\n'
  + 'export const SERVER_READ_COMPATIBILITY = ' + JSON.stringify({baseVersion,baseHash,targetHash,migration:future,nextHash,nextMigration:next,onceTierHash,onceTierMigration:onceTier,attachmentHash,attachmentMigration:attachment},null,2) + ' as const;\n';
const path = new URL('read-compat.generated.ts', root);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output) throw new Error('Server read compatibility generated output drift');
} else writeFileSync(path, output);
