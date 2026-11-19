import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "products/join/storage/join-employee-admission/schema.ts", out: "products/join/storage/join-employee-admission/migrations" });
