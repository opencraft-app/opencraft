import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ConversationRef } from '@opencraft/appserver-protocol/collaboration';

export const ORCHESTRATION_AUTHORITY_SCHEMA = `
ALTER TABLE opencraft_orchestration_operations ADD COLUMN quota_reserved INTEGER NOT NULL DEFAULT 0;
CREATE TABLE opencraft_orchestration_acks (operation_id TEXT PRIMARY KEY REFERENCES opencraft_orchestration_operations(operation_id)) STRICT;
CREATE TABLE opencraft_notification_authorities (batch_id TEXT PRIMARY KEY REFERENCES opencraft_parent_notification_batches(batch_id),authority_id TEXT NOT NULL REFERENCES conversation_authorities(id)) STRICT;
CREATE TABLE opencraft_spawn_preparations (operation_id TEXT PRIMARY KEY REFERENCES opencraft_orchestration_operations(operation_id), settings_json TEXT NOT NULL) STRICT;
CREATE TABLE opencraft_input_authorities (thread_id TEXT NOT NULL,input_id TEXT NOT NULL,authority_id TEXT NOT NULL REFERENCES conversation_authorities(id),PRIMARY KEY(thread_id,input_id)) STRICT;
CREATE TABLE opencraft_thread_authorities (
 thread_id TEXT PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES conversation_authorities(id)
) STRICT;
CREATE TABLE opencraft_delegation_roots (
 authority_id TEXT PRIMARY KEY REFERENCES conversation_authorities(id), root_authority_id TEXT NOT NULL REFERENCES conversation_authorities(id)
) STRICT;
CREATE TABLE opencraft_input_origins (
 thread_id TEXT NOT NULL, input_id TEXT NOT NULL, origin_json TEXT NOT NULL,
 PRIMARY KEY(thread_id,input_id)
) STRICT;
`;
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
