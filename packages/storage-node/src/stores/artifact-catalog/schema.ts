import {sqliteTable,text,integer,primaryKey,unique,index} from 'drizzle-orm/sqlite-core';
export const artifacts=sqliteTable('artifacts',{
 id:text('id'),scope:text('scope').notNull(),source_key:text('source_key').notNull(),name:text('name').notNull(),mime:text('mime').notNull(),size:integer('size').notNull(),sha256:text('sha256').notNull(),path:text('path').notNull(),origin:text('origin').notNull(),created_ms:integer('created_ms').notNull(),deleting:integer('deleting').notNull().default(0)
},t=>[primaryKey({columns:[t.id]}),unique('artifacts_scope_source_key_unique').on(t.scope,t.source_key)]);
export const references=sqliteTable('artifact_references',{owner:text('owner').notNull(),slot:text('slot').notNull(),artifact_id:text('artifact_id').notNull().references(()=>artifacts.id)},t=>[primaryKey({columns:[t.owner,t.slot]}),index('artifact_reference_target').on(t.artifact_id)]);
export const ingestions=sqliteTable('artifact_ingestions',{id:text('id'),artifact_id:text('artifact_id').notNull(),path:text('path').notNull(),phase:text('phase').notNull(),created_ms:integer('created_ms').notNull()},t=>[primaryKey({columns:[t.id]})]);
export const leases=sqliteTable('artifact_leases',{owner:text('owner').notNull(),artifact_id:text('artifact_id').notNull().references(()=>artifacts.id)},t=>[primaryKey({columns:[t.owner,t.artifact_id]})]);
