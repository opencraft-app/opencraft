import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./packages/storage-node/src/stores/workbench-storage-node/schema.ts", out: "./packages/storage-node/src/stores/workbench-storage-node/migrations" });
