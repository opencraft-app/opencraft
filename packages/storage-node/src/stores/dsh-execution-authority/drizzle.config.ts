import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./packages/storage-node/src/stores/dsh-execution-authority/schema.ts", out: "./packages/storage-node/src/stores/dsh-execution-authority/migrations" });
