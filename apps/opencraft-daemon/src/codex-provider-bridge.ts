import { BridgeGateway, type BridgeGatewayOptions } from "@opencraft/agent-bridge-host/gateway";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import { CodexProviderBridgeSession } from "./codex-provider-bridge-session.js";

/** Node transport assembly for the shared AppServer-to-Bridge session. */
export class CodexProviderBridge extends CodexProviderBridgeSession {
  constructor(
    legacy: DuplexTransport,
    options: BridgeGatewayOptions,
    policy?: ConstructorParameters<typeof CodexProviderBridgeSession>[2],
  ) {
    super(legacy, (publish) => new BridgeGateway(options, publish), policy);
  }
}
