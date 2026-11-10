import type { BridgeDeclaration } from "@opencraft/agent-bridge-protocol";

export const CLAUDE_BRIDGE_PROVIDER_ID = "claude-code-agent-sdk";

/**
 * Upper bound of the capabilities this bridge can serve. The SDK/CLI probe may
 * narrow these at initialize; it never widens them. `history` stays false
 * because this batch does not implement `history/read` or `session/resume`;
 * the native SDK session id is still reported for later recovery work.
 */
export const CLAUDE_BRIDGE_DECLARATION: BridgeDeclaration = ({
  providerId: CLAUDE_BRIDGE_PROVIDER_ID,
  protocolVersion: 1,
  grammarRange: { min: 1, max: 1 },
  approvalExecutor: "provider",
  capabilities: {
    model: true,
    reasoning: false,
    history: false,
    usage: true,
    approval: false,
    inputContentTypes: ["text"],
    cliExecutable: false,
    forkCheckpoint: false,
    skills: false,
    installation: false,
    steer: {
      deliveryMethods: ["native-inject"],
      evidenceKinds: ["context-confirmed", "admission"],
      withdrawal: "none",
      contentLimits: {
        maxBytes: 64 * 1024,
        allowedContentTypes: ["text"],
      },
      maxPendingWithoutNativeId: 1,
      fallbackPolicy: "reject-unknown",
    },
  },
  // Validated against Claude Code 2.1.321. Older CLIs may still connect; the
  // result probe only records admission evidence when it cannot report UUIDs.
  minNativeVersion: "2.1.321",
  probeBasis:
    "Agent SDK 0.3.263 initialization probe; user_message_uuids/replay and background_tasks_changed feature-detected at runtime",
});
