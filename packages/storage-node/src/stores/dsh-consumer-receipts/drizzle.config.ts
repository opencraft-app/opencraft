import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/storage-node/src/stores/dsh-consumer-receipts/schema.ts",
  out: "./packages/storage-node/src/stores/dsh-consumer-receipts/migrations",
});
