import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./packages/storage-node/src/stores/ui-preferences-store/schema.ts", out: "./packages/storage-node/src/stores/ui-preferences-store/migrations" });
