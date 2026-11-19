import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: ["./src/server/schema.ts", "../../products/join/plugins/wecom/assistant-schema.ts"], out: "./src/server/migrations" });
