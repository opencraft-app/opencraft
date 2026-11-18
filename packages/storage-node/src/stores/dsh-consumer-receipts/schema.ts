import {sqliteTable,text,integer,real,blob,numeric,primaryKey,unique,index,uniqueIndex,foreignKey,check} from "drizzle-orm/sqlite-core";
import {sql} from "drizzle-orm";
export const table_dsh_consumer_receipt_metadata=sqliteTable("dsh_consumer_receipt_metadata", {
"key": text("key").notNull(),
"value": text("value").notNull(),
},table=>[
primaryKey({columns:[table["key"]]})
]);
export const table_dsh_consumer_receipts=sqliteTable("dsh_consumer_receipts", {
"id": text("id").notNull(),
"value": text("value").notNull(),
},table=>[
primaryKey({columns:[table["id"]]})
]);
