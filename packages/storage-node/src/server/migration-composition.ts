import {createHash} from 'node:crypto';
import type {Migration} from '@opencraft/sqlite-node';
import {SERVER_MIGRATIONS,SERVER_ALTERNATE_MIGRATIONS,SERVER_MIGRATION_CONTRACT_HASH,OPENCRAFT_VERSION} from './migrations.generated.js';

export interface ServerDataContract {
  readonly productVersion:string;
  readonly store:'server';
  readonly migrationVersion:number;
  readonly hash:string;
}
/** Ledger identity of one migration: `core` or a declared extension family. */
export interface ServerLedgerIdentity {
  readonly family:string;
  readonly version:number;
}
/** A product's own migrations for tables it owns, beside core's linear ledger.
 * Recorded in `schema_extension_migrations` under `id`; never renumbers core. */
export interface ServerMigrationFamily {
  readonly id:string;
  /** Every table and index the family creates, changes or writes starts with this prefix. */
  readonly objectPrefix:string;
  readonly migrations:readonly Migration[];
}
export interface ServerAlternateHistory {
  readonly id:string;
  readonly migrations:readonly Migration[];
  /**
   * Declares a published linear lineage that is adopted into the core and
   * extension ledgers once it reaches its last step: `adopts[i]` lists the
   * family identities that `migrations[i]` stands for. Without it the lineage
   * stays on its own ledger (the original alternates behaviour).
   */
  readonly adopts?:readonly (readonly ServerLedgerIdentity[])[];
}
export interface ServerMigrationComposition {
  readonly canonical:readonly Migration[];
  readonly alternates:readonly ServerAlternateHistory[];
  readonly extensions:readonly ServerMigrationFamily[];
  readonly contract:ServerDataContract;
}
export interface ServerMigrationCompositionInput {
  readonly canonical:readonly Migration[];
  readonly alternates:readonly ServerAlternateHistory[];
  /** Product extension families, applied after core in this order. */
  readonly extensions?:readonly ServerMigrationFamily[];
  readonly productVersion:string;
  readonly expectedHash?:string;
}
export const CORE_FAMILY='core';
const digest=(sql:string)=>createHash('sha256').update(sql).digest('hex');
function copyChain(chain:readonly Migration[]):readonly Migration[] {
  if(!Array.isArray(chain)||!chain.length||chain.length>10000)throw Error('Invalid Server migration chain');
  return Object.freeze(chain.map((m,index)=>{
    if(!m||m.version!==index+1||typeof m.name!=='string'||!m.name||m.name.includes('\0')||typeof m.sql!=='string'||!m.sql.trim())throw Error('Invalid Server migration identity');
    return Object.freeze({version:m.version,name:m.name,sql:m.sql});
  }));
}
function copyFamilies(input:readonly ServerMigrationFamily[]|undefined):readonly ServerMigrationFamily[] {
  if(input===undefined)return Object.freeze([]);
  if(!Array.isArray(input)||input.length>32)throw Error('Invalid Server extension families');
  const families:ServerMigrationFamily[]=[];
  for(const entry of input){
    if(!entry||typeof entry.id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(entry.id)||entry.id===CORE_FAMILY||families.some(f=>f.id===entry.id))throw Error('Invalid Server extension family id');
    // Lowercase, `_`-terminated and never SQLite's own namespace. SQLite names are
    // case-insensitive, so ownership checks compare lowercase names.
    if(typeof entry.objectPrefix!=='string'||!/^[a-z][a-z0-9_]{0,62}_$/.test(entry.objectPrefix)||entry.objectPrefix.startsWith('sqlite_')||entry.objectPrefix.startsWith('schema_'))throw Error('Invalid Server extension object prefix');
    if(families.some(f=>f.objectPrefix.startsWith(entry.objectPrefix)||entry.objectPrefix.startsWith(f.objectPrefix)))throw Error('Overlapping Server extension object prefixes');
    families.push(Object.freeze({id:entry.id,objectPrefix:entry.objectPrefix,migrations:copyChain(entry.migrations)}));
  }
  return Object.freeze(families);
}
/** Every step maps to existing identities; a single-identity step carries its
 * target's exact SQL, a merged step stays inside one family; together the
 * lineage covers a contiguous prefix of core and of each family exactly once. */
function copyAdoption(alternate:ServerAlternateHistory,migrations:readonly Migration[],canonical:readonly Migration[],families:readonly ServerMigrationFamily[]) {
  const adopts=alternate.adopts;
  if(!Array.isArray(adopts)||adopts.length!==migrations.length)throw Error('Invalid Server lineage adoption map');
  const chains=new Map<string,readonly Migration[]>([[CORE_FAMILY,canonical],...families.map(f=>[f.id,f.migrations] as const)]);
  const seen=new Map<string,Set<number>>([...chains.keys()].map(id=>[id,new Set<number>()]));
  const copied=adopts.map((targets,index)=>{
    if(!Array.isArray(targets)||!targets.length||targets.length>64)throw Error('Invalid Server lineage adoption map');
    const step=targets.map(target=>{
      const chain=target&&chains.get(target.family);
      if(!chain||!Number.isSafeInteger(target.version)||target.version<1||target.version>chain.length||seen.get(target.family)!.has(target.version))throw Error('Unknown or repeated Server lineage adoption identity');
      seen.get(target.family)!.add(target.version);
      return Object.freeze({family:target.family,version:target.version});
    });
    if(new Set(step.map(target=>target.family)).size!==1)throw Error('A merged Server lineage step must stay inside one family');
    if(step.length===1&&digest(chains.get(step[0]!.family)![step[0]!.version-1]!.sql)!==digest(migrations[index]!.sql))throw Error('Server lineage step SQL differs from the identity it adopts');
    return Object.freeze(step);
  });
  for(const [family,versions] of seen)if(versions.size&&Math.max(...versions)!==versions.size||family===CORE_FAMILY&&!versions.size)throw Error('Server lineage adoption must cover a contiguous prefix of each family');
  return Object.freeze(copied);
}
/** Trusted installation composition, never a request-selected module or SQL path.
 * Hash the same complete finite family as compile-storage-migrations.mjs. */
export function createServerMigrationComposition(input:ServerMigrationCompositionInput):ServerMigrationComposition {
  if(!input||typeof input.productVersion!=='string'||!input.productVersion||input.productVersion.length>128||!Array.isArray(input.alternates))throw Error('Invalid Server migration composition');
  const canonical=copyChain(input.canonical),extensions=copyFamilies(input.extensions),ids=new Set<string>();
  const alternates=Object.freeze(input.alternates.map(entry=>{
    if(!entry||typeof entry.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id)||ids.has(entry.id))throw Error('Invalid Server alternate history');
    ids.add(entry.id);const migrations=copyChain(entry.migrations);
    return Object.freeze(entry.adopts===undefined?{id:entry.id,migrations}:{id:entry.id,migrations,adopts:copyAdoption(entry,migrations,canonical,extensions)});
  }));
  // Without families the hashed value is unchanged, so the published core contract stays stable.
  const hash=digest(JSON.stringify(extensions.length?{canonical,alternates,extensions}:{canonical,alternates}));
  if(input.expectedHash!==undefined&&input.expectedHash!==hash)throw Error('Server migration contract hash mismatch');
  return Object.freeze({canonical,alternates,extensions,contract:Object.freeze({productVersion:input.productVersion,store:'server' as const,migrationVersion:canonical.length,hash})});
}
function snapshot(value:ServerMigrationComposition):ServerMigrationComposition {
  if(value?.contract?.store!=='server'||value.contract.migrationVersion!==value.canonical?.length)throw Error('Invalid Server data contract');
  return createServerMigrationComposition({...value,productVersion:value.contract.productVersion,expectedHash:value.contract.hash});
}
/** A separate factory permits isolated ownership tests without resetting live state. */
export function createServerMigrationRegistry(fallback:ServerMigrationComposition) {
  const initial=snapshot(fallback);
  let source:ServerMigrationComposition|undefined,installed:ServerMigrationComposition|undefined,opened=false;
  return Object.freeze({
    install(value:ServerMigrationComposition) {
      if(source!==undefined&&source===value)return;
      if(opened)throw Error('Server migration composition already in use');
      if(source)throw Error('Server migration composition already installed');
      installed=snapshot(value);source=value;
    },
    current():ServerMigrationComposition {opened=true;return installed??initial;},
    /** Immutable trusted Worker handoff, without selecting code from a path. */
    installed():ServerMigrationComposition|undefined {return installed;},
  });
}
export const DEFAULT_SERVER_MIGRATION_COMPOSITION=createServerMigrationComposition({canonical:SERVER_MIGRATIONS,alternates:SERVER_ALTERNATE_MIGRATIONS,productVersion:OPENCRAFT_VERSION,expectedHash:SERVER_MIGRATION_CONTRACT_HASH});
const registry=createServerMigrationRegistry(DEFAULT_SERVER_MIGRATION_COMPOSITION);
export const installServerMigrationComposition=registry.install;
export const serverMigrationComposition=registry.current;
export const installedServerMigrationComposition=registry.installed;
