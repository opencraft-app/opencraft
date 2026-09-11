#!/usr/bin/env bun
import { HermesAppServerAdapter } from "./adapter";
import { loadConfig } from "./config";
import { HermesGatewayClient } from "./hermes-client";
import { startServer } from "./server";

function usage(): string {
  return `hemesclient - Hermes Gateway to Vela AppServer bridge

Usage:
  hemesclient serve [--gateway URL] [--token TOKEN] [--host HOST] [--port PORT]
  hemesclient sessions [--gateway URL] [--token TOKEN]

Environment:
  HERMES_GATEWAY_URL       Hermes serve base URL (default http://127.0.0.1:9119)
  HERMES_GATEWAY_TOKEN     Optional loopback session token (auto-discovered locally)
  HEMESCLIENT_HOST         AppServer listen host (default 0.0.0.0)
  HEMESCLIENT_PORT         AppServer listen port (default 9989)
  HEMESCLIENT_TIMEOUT_MS   Hermes request timeout (default 30000)
  HEMESCLIENT_DEFAULT_CWD  cwd for thread/start when omitted (default /)`;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(usage());
    return;
  }
  const config = loadConfig(process.argv.slice(3));
  const gateway = new HermesGatewayClient({
    baseUrl: config.gatewayUrl,
    token: config.gatewayToken,
    timeoutMs: config.timeoutMs,
  });
  const adapter = new HermesAppServerAdapter(gateway, config.defaultCwd);
  if (command === "sessions") {
    try {
      const result = await adapter.listThreads({ limit: 200 });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      gateway.close();
    }
    return;
  }
  if (command !== "serve") throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  const server = startServer({ hostname: config.listenHost, port: config.listenPort, adapter });
  console.log(`hemesclient listening on ws://${server.hostname}:${server.port}/rpc`);
  console.log(`Hermes Gateway: ${config.gatewayUrl}`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
