import {sqliteTable,text,integer,primaryKey,index,unique,check} from "drizzle-orm/sqlite-core";
import {sql} from "drizzle-orm";
export const table_dsh_consumer_receipt_metadata=sqliteTable("dsh_consumer_receipt_metadata",{"key":text("key").notNull(),"value":text("value").notNull()},t=>[primaryKey({columns:[t["key"]]})]);
export const table_dsh_consumer_receipts=sqliteTable("dsh_consumer_receipts",{"id":text("id").notNull(),"value":text("value").notNull()},t=>[primaryKey({columns:[t["id"]]})]);
