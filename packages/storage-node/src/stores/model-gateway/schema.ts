import {sqliteTable,text,integer,real,blob,numeric,primaryKey,unique,index,uniqueIndex,foreignKey,check} from "drizzle-orm/sqlite-core";
import {sql} from "drizzle-orm";
export const table_gateway_audit=sqliteTable("gateway_audit", {
"id": integer("id"),
"actor": text("actor").notNull(),
"action": text("action").notNull(),
"subject": text("subject").notNull(),
"detail": text("detail").notNull(),
"at": integer("at").notNull(),
},table=>[
primaryKey({columns:[table["id"]]})
]);
export const table_gateway_contributions=sqliteTable("gateway_contributions", {
"provider": text("provider").notNull(),
"actor": text("actor").notNull(),
"template_provider": text("template_provider").notNull(),
"state": text("state").notNull(),
"created_at": integer("created_at").notNull(),
"scope": text("scope").notNull().default(sql`'team'`),
"revision": integer("revision").notNull().default(sql`0`),
},table=>[
primaryKey({columns:[table["provider"]]}),
check("gateway_contributions_check_0",sql`state IN ('preparing','shared','withdrawn')`),
check("gateway_contributions_check_1",sql`scope IN ('personal','team')`)
]);
export const table_gateway_execution_heads=sqliteTable("gateway_execution_heads", {
"thread": text("thread").notNull(),
"execution": text("execution").notNull(),
},table=>[
primaryKey({columns:[table["thread"]]})
]);
export const table_gateway_execution_turns=sqliteTable("gateway_execution_turns", {
"thread": text("thread").notNull(),
"turn": text("turn").notNull(),
"execution": text("execution").notNull(),
"admission": text("admission"),
},table=>[
primaryKey({columns:[table["thread"],table["turn"]]})
]);
export const table_gateway_executions=sqliteTable("gateway_executions", {
"id": text("id").notNull(),
"thread": text("thread").notNull(),
"authorizer": text("authorizer").notNull(),
"executor": text("executor"),
"model": text("model").notNull(),
"parent": text("parent"),
"expires_at": integer("expires_at").notNull(),
"state": text("state").notNull(),
"created_at": integer("created_at").notNull(),
"authority": text("authority"),
"admission": text("admission"),
},table=>[
primaryKey({columns:[table["id"]]}),
check("gateway_executions_check_0",sql`state IN ('active','closed','revoked')`)
]);
export const table_gateway_limits=sqliteTable("gateway_limits", {
"actor": text("actor").notNull(),
"monthly_tokens": integer("monthly_tokens").notNull(),
"request_tokens": integer("request_tokens").notNull(),
"concurrency": integer("concurrency").notNull(),
"revision": integer("revision").notNull(),
},table=>[
primaryKey({columns:[table["actor"]]}),
check("gateway_limits_check_0",sql`monthly_tokens>=0`),
check("gateway_limits_check_1",sql`request_tokens>0`),
check("gateway_limits_check_2",sql`concurrency>0`)
]);
export const table_gateway_personal_limits=sqliteTable("gateway_personal_limits", {
"actor": text("actor").notNull(),
"monthly_tokens": integer("monthly_tokens").notNull(),
"revision": integer("revision").notNull(),
},table=>[
primaryKey({columns:[table["actor"]]}),
check("gateway_personal_limits_check_0",sql`monthly_tokens>=0`)
]);
export const table_gateway_private_threads=sqliteTable("gateway_private_threads", {
"thread": text("thread").notNull(),
"actor": text("actor").notNull(),
},table=>[
primaryKey({columns:[table["thread"]]})
]);
export const table_gateway_requests=sqliteTable("gateway_requests", {
"id": text("id").notNull(),
"actor": text("actor").notNull(),
"thread": text("thread").notNull(),
"model": text("model").notNull(),
"credential": text("credential"),
"period": text("period").notNull(),
"reserved": integer("reserved").notNull(),
"actual": integer("actual"),
"state": text("state").notNull(),
"created_at": integer("created_at").notNull(),
"updated_at": integer("updated_at").notNull(),
"execution": text("execution"),
"key_owner": text("key_owner"),
"turn": text("turn"),
"input_tokens": integer("input_tokens"),
"output_tokens": integer("output_tokens"),
"cache_read_tokens": integer("cache_read_tokens"),
"cache_write_tokens": integer("cache_write_tokens"),
},table=>[
primaryKey({columns:[table["id"]]}),
index("gateway_requests_turn").on(table["thread"],table["turn"]),
index("gateway_requests_actor").on(table["actor"],table["period"],table["state"]),
check("gateway_requests_check_0",sql`reserved>0`),
check("gateway_requests_check_1",sql`actual>=0`),
check("gateway_requests_check_2",sql`state IN ('reserved','dispatched','settled','released','unknown')`)
]);
export const table_gateway_sponsors=sqliteTable("gateway_sponsors", {
"thread": text("thread").notNull(),
"actor": text("actor").notNull(),
"parent": text("parent"),
"created_at": integer("created_at").notNull(),
},table=>[
primaryKey({columns:[table["thread"]]})
]);
export const table_gateway_thread_humans=sqliteTable("gateway_thread_humans", {
"thread": text("thread").notNull(),
"actor": text("actor").notNull(),
},table=>[
primaryKey({columns:[table["thread"],table["actor"]]})
]);
export const table_gateway_thread_models=sqliteTable("gateway_thread_models", {
"thread": text("thread").notNull(),
"creator": text("creator").notNull(),
"provider": text("provider").notNull(),
"contribution_revision": integer("contribution_revision").notNull(),
"created_at": integer("created_at").notNull(),
},table=>[
primaryKey({columns:[table["thread"]]})
]);
