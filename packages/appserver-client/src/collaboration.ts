import type { ConversationRef, CollaborationReadCommandMap, ConversationReceipt, ConversationLookup } from '@opencraft/appserver-protocol/collaboration';
import { COLLABORATION_METHOD } from '@opencraft/appserver-protocol/collaboration';
import { JsonRpcAppServerClient } from './client';
import type { DuplexTransport } from './transport';

export class UnsupportedCollaborationCapability extends Error {
  readonly code = 'UNSUPPORTED_CAPABILITY';
  constructor(readonly capability: string) { super('Host does not support ' + capability); }
}
export type { ConversationDirectory } from '@opencraft/appserver-protocol/collaboration';
/** No DOM, routing registry, execution owner or retry loop. */
export class CollaborationClient {
  readonly connection: JsonRpcAppServerClient;
  private capabilities: Record<string, unknown> = {};
  constructor(transport: DuplexTransport) {
    this.connection = new JsonRpcAppServerClient({ hostId: 'collaboration', transport, requestTimeoutMs: 15_000 });
  }
  async connect() {
    const initialized = await this.connection.connect({ clientInfo: { name: 'opencraft-cli', version: '1' }, capabilities: { experimentalApi: true } });
    const extensions = initialized.capabilities?.extensions as Record<string, unknown> | undefined;
    const capability = extensions?.[COLLABORATION_METHOD];
    this.capabilities = capability && typeof capability === 'object' ? capability as Record<string, unknown> : {};
  }
  require(capability: string) {
    if (this.capabilities.version !== 1 || this.capabilities[capability] !== true) throw new UnsupportedCollaborationCapability(capability);
  }
  async command<T>(capability: string, params: Record<string, unknown>): Promise<T> {
    this.require(capability);
    return await this.connection.request(COLLABORATION_METHOD, params) as T;
  }
  private readCommand<Action extends keyof CollaborationReadCommandMap>(capability: string,
    params: CollaborationReadCommandMap[Action]['request']): Promise<CollaborationReadCommandMap[Action]['result']> {
    return this.command(capability, { ...params });
  }
  servers() { return this.readCommand<'servers'>('servers', { action: 'servers' }); }
  metadata(ref: ConversationRef) { return this.readCommand<'metadata'>('metadata', { action: 'metadata', reference: ref }); }
  discover(serverId: string, cursor?: string, includeTitle = false, filters: { projectId?: string; cwd?: string } = {}) {
    if (filters.projectId !== undefined || filters.cwd !== undefined) this.require('discoverFilters');
    return this.readCommand<'discover'>('metadataDiscovery',
      { action: 'discover', metadataOnly: true, serverId, ...(cursor ? { cursor } : {}), includeTitle, ...filters });
  }
  read(ref: ConversationRef, cursor?: string) {
    return this.readCommand<'read'>('boundedRead',
      { action: 'read', reference: ref, bounded: true, ...(cursor ? { cursor } : {}) });
  }
  send(ref: ConversationRef, content: string, operationKey: string, execution: { mode: 'queue' } | { mode: 'steer'; expectedTurnId: string }) {
    return this.command<{ messageId: string; requestId: string; replayed: boolean }>(execution.mode,
      { action: 'send', reference: ref, content, idempotencyKey: operationKey, execution });
  }
  delivery(ref: ConversationRef, requestId: string, timeoutMs = 15_000) {
    this.require('deliveryMetadata');
    return this.connection.requestRaw<ConversationReceipt>('opencraft/collaboration', { action: 'delivery', reference: ref, requestId, metadataOnly: true }, { timeoutMs });
  }
  lookup(ref: ConversationRef, operationKey: string) {
    return this.command<ConversationLookup>('lookup', { action: 'lookup', reference: ref, idempotencyKey: operationKey });
  }
  close() { return this.connection.close(); }
}
