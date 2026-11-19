import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/storage-node/src/stores/model-gateway/schema.ts",
  out: "./packages/storage-node/src/stores/model-gateway/migrations",
});
