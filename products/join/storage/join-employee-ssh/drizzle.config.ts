import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "products/join/storage/join-employee-ssh/schema.ts", out: "products/join/storage/join-employee-ssh/migrations" });
