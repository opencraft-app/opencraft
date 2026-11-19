import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./packages/storage-node/src/stores/transcript-read-cache/schema.ts", out: "./packages/storage-node/src/stores/transcript-read-cache/migrations" });
