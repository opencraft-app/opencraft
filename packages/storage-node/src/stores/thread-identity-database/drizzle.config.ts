import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./packages/storage-node/src/stores/thread-identity-database/schema.ts", out: "./packages/storage-node/src/stores/thread-identity-database/migrations" });
