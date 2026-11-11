import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./packages/storage-node/src/stores/im/schema.ts", out: "./packages/storage-node/src/stores/im/migrations" });
