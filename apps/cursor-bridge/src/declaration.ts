import type { BridgeDeclaration } from "@opencraft/agent-bridge-protocol";

export const CURSOR_DECLARATION: BridgeDeclaration = {
  providerId: "cursor-sdk", protocolVersion: 1, grammarRange: { min: 1, max: 1 },
  approvalExecutor: "provider", minNativeVersion: "@cursor/sdk 1.0.32",
  probeBasis: "Pinned SDK Run.steer terminal outcomes; per-run function probe; SDK delivery only",
  capabilities: {
    model: true, reasoning: false, history: false, usage: false, approval: false,
    inputContentTypes: ["text", "attachment"], cliExecutable: false,
    forkCheckpoint: false, skills: false, installation: false,
    steer: {
      deliveryMethods: ["native-inject"], evidenceKinds: ["admission"],
      withdrawal: "before-dispatch", maxPendingWithoutNativeId: 1,
      contentLimits: { maxBytes: 64 * 1024, allowedContentTypes: ["text", "attachment"] },
      fallbackPolicy: "reject-unknown",
    },
  },
};
