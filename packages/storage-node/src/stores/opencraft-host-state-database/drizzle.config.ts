import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./packages/storage-node/src/stores/opencraft-host-state-database/schema.ts", out: "./packages/storage-node/src/stores/opencraft-host-state-database/migrations" });
