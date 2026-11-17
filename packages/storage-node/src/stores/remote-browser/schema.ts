import { sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core';
export const meta = sqliteTable('browser_meta', { key: text('key').primaryKey(), value: text('value').notNull() });
export const pages = sqliteTable('browser_pages', { key: text('key').primaryKey(), value: text('value').notNull() });
export const metadata = sqliteTable('browser_metadata', { key: text('key').primaryKey(), value: text('value').notNull() });
export const receipts = sqliteTable('browser_receipts', { key: text('key').primaryKey(), value: text('value').notNull() });
export const retirements = sqliteTable('browser_retirements', { key: text('key').primaryKey(), owner: text('owner').notNull(), value: text('value').notNull() }, table => [index('browser_retirements_owner').on(table.owner)]);
export const identities = sqliteTable('browser_retirement_identities', {
  owner: text('owner').notNull(), kind: text('kind').notNull(), id: text('id').notNull(), key: text('key').notNull(),
}, table => [primaryKey({ columns: [table.owner, table.kind, table.id, table.key] })]);
