import {projectContext,projectCommands} from '@opencraft/appserver-protocol/collaboration';
import {projectMessageAttachmentPage,parseMessageAttachmentQuery,type MessageAttachmentQuery} from '@opencraft/appserver-protocol';
import type {ThreadDefaultsBundle,ThreadDefaultsResult} from '@opencraft/appserver-protocol/collaboration';
import type { ConversationRef, CollaborationReadCommandMap, ConversationReceipt, ConversationLookup, ConversationCreateTarget, ConversationCreation, ConversationCreationLookup, ConversationStopResult, ConversationCancelResult } from '@opencraft/appserver-protocol/collaboration';
import type {ConversationInputSettings} from '@opencraft/appserver-protocol/collaboration';
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
  async connect(options?: {threadCountOnly?:boolean}) {
    const initialized = await this.connection.connect({ clientInfo: { name: 'opencraft-cli', version: '1' }, capabilities: { experimentalApi: true, ...(options?.threadCountOnly?{extensions:{'opencraft/recorded-thread-count':true}}:{}) } });
    const extensions = initialized.capabilities?.extensions as Record<string, unknown> | undefined;
    const capability = extensions?.[COLLABORATION_METHOD];
    this.capabilities = capability && typeof capability === 'object' ? capability as Record<string, unknown> : {};
  }
  require(capability: string) {
    if (this.capabilities.version !== 1 || this.capabilities[capability] !== true) throw new UnsupportedCollaborationCapability(capability);
  }
  async command<T>(capability: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    this.require(capability);
    return await this.connection.request(COLLABORATION_METHOD, params, { timeoutMs }) as T;
  }
  private readCommand<Action extends keyof CollaborationReadCommandMap>(capability: string,
    params: CollaborationReadCommandMap[Action]['request'], timeoutMs?: number): Promise<CollaborationReadCommandMap[Action]['result']> {
    return this.command(capability, { ...params }, timeoutMs);
  }
  threadCount(serverId:string) {
    this.require('threadCount');
    if(this.capabilities.threadCountMode!=='authorized-recorded-threads-v1')throw new UnsupportedCollaborationCapability('authorized-recorded-threads-v1');
    return this.readCommand<'threadCount'>('threadCount',{action:'threadCount',serverId});
  }
  projects(serverId: string, cursor?: string) { return this.readCommand<'projects'>('projectDiscovery', { action: 'projects', serverId, ...(cursor === undefined ? {} : {cursor}) }); }
  models(serverId: string, cursor?: string) { return this.readCommand<'models'>('modelDiscovery', { action: 'models', serverId, ...(cursor === undefined ? {} : {cursor}) }); }
  options(ref: ConversationRef) { return this.readCommand<'options'>('executionOptions', { action: 'options', reference: ref }); }
  turnConfigurationObservation(ref:ConversationRef,target:import('@opencraft/appserver-protocol/collaboration').ConversationResultTarget) {
    return this.readCommand<'turnConfigurationObservation'>('turnConfigurationObservation',{action:'turnConfigurationObservation',reference:ref,target});
  }
  exactResult(ref: ConversationRef, target: import('@opencraft/appserver-protocol/collaboration').ConversationResultTarget, output: boolean, cursor?: string, timeoutMs?: number) {
    return this.readCommand<'exactResult'>('exactResult',{action:'exactResult',reference:ref,target,output,...(cursor ? {cursor} : {})},timeoutMs);
  }
  interactions(ref: ConversationRef, interactionId?: string, cursor?: string) {
    return this.readCommand<'interactions'>('interactions',{action:'interactions',reference:ref,...(interactionId===undefined?{}:{interactionId}),...(cursor===undefined?{}:{cursor})});
  }
  respondInteraction(ref: ConversationRef, submission: import('@opencraft/appserver-protocol').StructuredInteractionSubmission) {
    return this.command<import('@opencraft/appserver-protocol/collaboration').ConversationInteractionReceipt>('interactionRespond',{action:'respondInteraction',reference:ref,...submission});
  }
  stop(ref: ConversationRef, expectedTurnId: string) {
    return this.command<ConversationStopResult>('stop',{action:'stop',reference:ref,expectedTurnId});
  }
  observeStop(ref: ConversationRef, expectedTurnId: string) {
    return this.readCommand<'stopObserve'>('stopObserve',{action:'stopObserve',reference:ref,expectedTurnId});
  }
  cancelQueue(ref: ConversationRef, requestId: string) {
    return this.command<ConversationCancelResult>('queueCancel',{action:'queueCancel',reference:ref,requestId});
  }
  async publicTextSearch(serverId:string,query:string,cursor?:string) {
    this.require('publicTextSearch');
    if(this.capabilities.publicTextSearchMode!=='public-text-token-and-v1')throw new UnsupportedCollaborationCapability('public-text-token-and-v1');
    return this.readCommand<'publicTextSearch'>('publicTextSearch',{action:'publicTextSearch',serverId,query,...(cursor===undefined?{}:{cursor})});
  }
  async threadSearch(serverId:string,query:string,cursor?:string) {
    this.require('threadSearch');
    if(this.capabilities.threadSearchMode!=='recorded-name-v1')throw new UnsupportedCollaborationCapability('recorded-name-v1');
    return this.readCommand<'threadSearch'>('threadSearch',{action:'threadSearch',serverId,field:'name',query,...(cursor===undefined?{}:{cursor})});
  }
  async messageAttachments(ref:ConversationRef,query:MessageAttachmentQuery={}) {
    const value=await this.readCommand<'messageAttachments'>('messageAttachments',{action:'messageAttachments',reference:ref,...parseMessageAttachmentQuery(query)},5000);
    return projectMessageAttachmentPage(value,ref);
  }
  async context(ref:ConversationRef) { const value=await this.readCommand<'context'>('contextUsage',{action:'context',reference:ref}); return {...projectContext(value),ref}; }
  async commands(ref:ConversationRef) { const value=await this.readCommand<'commands'>('threadCommands',{action:'commands',reference:ref}); return projectCommands(value,ref); }
  queueRequests(ref: ConversationRef, cursor?: string, limit?: number) {
    return this.readCommand<'queueRequests'>('queueRequests', { action: 'queueRequests', reference: ref,
      ...(cursor === undefined ? {} : {cursor}), ...(limit === undefined ? {} : {limit}) });
  }
  setThreadDefaults(ref:ConversationRef,scope:ThreadDefaultsResult['scope'],bundle:ThreadDefaultsBundle){return this.command<ThreadDefaultsResult>('threadDefaults',{action:'threadDefaults',reference:ref,scope,bundle},25000);}
  observeThreadDefaults(ref:ConversationRef){return this.readCommand<'threadDefaultsObserve'>('threadDefaultsObserve',{action:'threadDefaultsObserve',reference:ref});}
  servers() { return this.readCommand<'servers'>('servers', { action: 'servers' }); }
  metadata(ref: ConversationRef, timeoutMs?: number) { return this.readCommand<'metadata'>('metadata', { action: 'metadata', reference: ref }, timeoutMs); }
  discover(serverId: string, cursor?: string, includeTitle = false, filters: { projectId?: string; cwd?: string } = {}) {
    if (filters.projectId !== undefined || filters.cwd !== undefined) this.require('discoverFilters');
    return this.readCommand<'discover'>('metadataDiscovery',
      { action: 'discover', metadataOnly: true, serverId, ...(cursor ? { cursor } : {}), includeTitle, ...filters });
  }
  read(ref: ConversationRef, cursor?: string) {
    return this.readCommand<'read'>('boundedRead',
      { action: 'read', reference: ref, bounded: true, ...(cursor ? { cursor } : {}) });
  }
  tail(ref: ConversationRef, limit: number) {
    return this.readCommand<'read'>('tailRead', { action: 'read', reference: ref, bounded: true, tail: limit });
  }
  send(ref: ConversationRef, content: string, operationKey: string, execution: { mode: 'queue' } | { mode: 'steer'; expectedTurnId: string }, settings?: ConversationInputSettings) {
    if(settings)this.require('modelSettings');
    return this.command<{ messageId: string; requestId: string; replayed: boolean }>(execution.mode,
      { action: 'send', reference: ref, content, idempotencyKey: operationKey, execution, ...(settings?{settings}:{}) });
  }
  delivery(ref: ConversationRef, requestId: string, timeoutMs = 15_000) {
    this.require('deliveryMetadata');
    return this.connection.requestRaw<ConversationReceipt>('opencraft/collaboration', { action: 'delivery', reference: ref, requestId, metadataOnly: true }, { timeoutMs });
  }
  lookup(ref: ConversationRef, operationKey: string) {
    return this.command<ConversationLookup>('lookup', { action: 'lookup', reference: ref, idempotencyKey: operationKey });
  }
  create(target: ConversationCreateTarget, content: string, operationKey: string, settings?: ConversationInputSettings) {
    if(settings)this.require('modelSettings');
    this.require('createLookup');
    if(target.initialOptions !== undefined) this.require('initialPermissionMode');
    return this.command<ConversationCreation>('create',{action:'create',...target,content,idempotencyKey:operationKey,...(settings?{settings}:{})});
  }
  lookupCreation(serverId: string, operationKey: string, timeoutMs?: number) {
    return this.command<ConversationCreationLookup>('createLookup',{action:'createLookup',serverId,idempotencyKey:operationKey},timeoutMs);
  }
  close() { return this.connection.close(); }
}
