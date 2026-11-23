import type { PersonalMcpService } from "@opencraft/plugin-assets/server/personal-mcp";

/** A synthetic personal MCP service: the only configuration a composition supplies. */
export const SYNTHETIC_MCP: PersonalMcpService = {
  id: "synthetic",
  prefix: "synthetic_",
  endpoint: "https://mcp.example.test/mcp",
  service: "synthetic-mcp",
  tokenPattern: /^syn_[A-Za-z0-9_-]+$/u,
};
