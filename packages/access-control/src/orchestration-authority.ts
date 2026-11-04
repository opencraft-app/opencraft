import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ConversationRef } from '@opencraft/appserver-protocol/collaboration';

export { ORCHESTRATION_AUTHORITY_SCHEMA } from "@opencraft/storage-node/server-legacy";
export interface BoundedThreadDelegation {
  id: string; context: ActorContext; sourceThreadId: string; expiresAtMs: number;
}
export interface OrchestrationMessageOrigin {
  kind: 'user'|'agent'|'parent_system_notice'|'system'; clientMessageId: string;
  authorActorId: string|null; delegatorActorId: string|null; delegationId: string|null;
  senderConversation: ConversationRef|null; senderTurnId: string|null; operationId: string|null;
  replyExpectation: 'required'|'none'; delegationRevision: number; usageSourceKind: 'human'|'system'; createdAtMs: number;
  userInputExcerpt?: string;
  childBatchSize?: number;
}
