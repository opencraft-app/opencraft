import { BRIDGE_PROTOCOL_VERSION, BRIDGE_GRAMMAR_RANGE, type BridgeDeclaration } from '@opencraft/agent-bridge-protocol';
export const codexDeclaration: BridgeDeclaration = {
  providerId: 'codex', protocolVersion: BRIDGE_PROTOCOL_VERSION, grammarRange: BRIDGE_GRAMMAR_RANGE,
  approvalExecutor: 'provider', minNativeVersion: '0.162.1',
  probeBasis: 'AppServer v2 turn/steer expectedTurnId and clientUserMessageId; native userMessage clientId events',
  capabilities: {
    model: true, reasoning: false, history: true, usage: true, approval: true,
    inputContentTypes: ['text'], cliExecutable: true, forkCheckpoint: false, skills: false, installation: false,
    steer: { deliveryMethods: ['native-inject'], evidenceKinds: ['admission', 'native-input-id'], withdrawal: 'none',
      contentLimits: { maxBytes: 65536, allowedContentTypes: ['text'] }, maxPendingWithoutNativeId: 1, fallbackPolicy: 'reject-unknown' },
  },
};
