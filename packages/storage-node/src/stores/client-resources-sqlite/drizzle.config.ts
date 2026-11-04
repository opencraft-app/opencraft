import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./packages/storage-node/src/stores/client-resources-sqlite/schema.ts", out: "./packages/storage-node/src/stores/client-resources-sqlite/migrations" });
