import {createHash} from 'node:crypto';
import type {Migration} from '@opencraft/sqlite-node';
import {SERVER_MIGRATIONS,SERVER_ALTERNATE_MIGRATIONS,SERVER_MIGRATION_CONTRACT_HASH,OPENCRAFT_VERSION} from './migrations.generated.js';

export interface ServerDataContract {
  readonly productVersion:string;
  readonly store:'server';
  readonly migrationVersion:number;
  readonly hash:string;
}
export interface ServerMigrationComposition {
  readonly canonical:readonly Migration[];
  readonly alternates:readonly {readonly id:string;readonly migrations:readonly Migration[]}[];
  readonly contract:ServerDataContract;
}
export interface ServerMigrationCompositionInput {
  readonly canonical:readonly Migration[];
  readonly alternates:readonly {readonly id:string;readonly migrations:readonly Migration[]}[];
  readonly productVersion:string;
  readonly expectedHash?:string;
}
function copyChain(chain:readonly Migration[]):readonly Migration[] {
  if(!Array.isArray(chain)||!chain.length||chain.length>10000)throw Error('Invalid Server migration chain');
  return Object.freeze(chain.map((m,index)=>{
    if(!m||m.version!==index+1||typeof m.name!=='string'||!m.name||m.name.includes('\0')||typeof m.sql!=='string'||!m.sql.trim())throw Error('Invalid Server migration identity');
    return Object.freeze({version:m.version,name:m.name,sql:m.sql});
  }));
}
/** Trusted installation composition, never a request-selected module or SQL path.
 * Hash the same complete finite family as compile-storage-migrations.mjs. */
export function createServerMigrationComposition(input:ServerMigrationCompositionInput):ServerMigrationComposition {
  if(!input||typeof input.productVersion!=='string'||!input.productVersion||input.productVersion.length>128||!Array.isArray(input.alternates))throw Error('Invalid Server migration composition');
  const canonical=copyChain(input.canonical),ids=new Set<string>();
  const alternates=Object.freeze(input.alternates.map(entry=>{
    if(!entry||typeof entry.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id)||ids.has(entry.id))throw Error('Invalid Server alternate history');
    ids.add(entry.id);return Object.freeze({id:entry.id,migrations:copyChain(entry.migrations)});
  }));
  const hash=createHash('sha256').update(JSON.stringify({canonical,alternates})).digest('hex');
  if(input.expectedHash!==undefined&&input.expectedHash!==hash)throw Error('Server migration contract hash mismatch');
  return Object.freeze({canonical,alternates,contract:Object.freeze({productVersion:input.productVersion,store:'server' as const,migrationVersion:canonical.length,hash})});
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
