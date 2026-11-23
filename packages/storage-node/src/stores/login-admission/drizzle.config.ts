import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/storage-node/src/stores/login-admission/schema.ts",
  out: "./packages/storage-node/src/stores/login-admission/migrations",
});
