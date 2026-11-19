import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./packages/storage-node/src/stores/employee-git-vault-store/schema.ts", out: "./packages/storage-node/src/stores/employee-git-vault-store/migrations" });
