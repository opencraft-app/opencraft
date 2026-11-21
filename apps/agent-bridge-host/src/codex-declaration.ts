import { BRIDGE_PROTOCOL_VERSION, BRIDGE_GRAMMAR_RANGE, BUILTIN_CODEX_VERSION, type BridgeDeclaration } from '@opencraft/agent-bridge-protocol';
export const codexDeclaration: BridgeDeclaration = {
  providerId: 'codex', protocolVersion: BRIDGE_PROTOCOL_VERSION, grammarRange: BRIDGE_GRAMMAR_RANGE,
  // The declaration was established against the builtin Codex; external versions must be at least this.
  approvalExecutor: 'provider', minNativeVersion: BUILTIN_CODEX_VERSION,
  probeBasis: 'AppServer v2 turn/steer expectedTurnId and clientUserMessageId; native userMessage clientId events; thread/fork, name/set, archive, unarchive, delete and goal methods in the 0.162.1 schema',
  capabilities: {
    model: true, reasoning: false, history: true, usage: true, approval: true,
    inputContentTypes: ['text'], cliExecutable: true, forkCheckpoint: true, skills: false, installation: false,
    lifecycle: true, goals: true,
    steer: { deliveryMethods: ['native-inject'], evidenceKinds: ['admission', 'native-input-id'], withdrawal: 'none',
      contentLimits: { maxBytes: 65536, allowedContentTypes: ['text'] }, maxPendingWithoutNativeId: 1, fallbackPolicy: 'reject-unknown' },
  },
};
