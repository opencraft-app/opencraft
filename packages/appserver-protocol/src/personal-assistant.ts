import type { ChannelHistoryPage, ChannelSummary } from './channels.js';
import type { ConversationRef } from './collaboration.js';

export const PERSONAL_ASSISTANT_EXTENSION = 'opencraft/personal-assistant';
export interface PersonalAssistantBinding {
  /** Installation identity, not a renderer, login provider, or execution Host. */
  serverId: string;
  botId: string;
  assignmentId: string;
  owner: { kind: 'human'; id: string };
}
export type BotEnvironment = {kind:'local'} | {kind:'sandbox';backendId:string;templateId:string};
export interface BotEnvironmentCatalog {local:boolean;templates:{backendId:string;id:string;name:string}[]}
export type AssistantCardinality = 'singleton-per-human' | 'multi';
export type AssistantPresetId = 'personal-assistant';
export interface AssistantPreset {
  readonly id: AssistantPresetId;
  readonly cardinality: AssistantCardinality;
  readonly defaultEnvironment: BotEnvironment;
}
export const BUILTIN_ASSISTANT_PRESETS: readonly AssistantPreset[] = [
  {
    id: 'personal-assistant',
    cardinality: 'singleton-per-human',
    defaultEnvironment: { kind: 'local' },
  },
];
export interface PersonalAssistant {
  name?: string;
  duties?: string;
  isDefault?: boolean;
  presetId?: AssistantPresetId | null;
  cardinality?: AssistantCardinality;
  paused?: boolean;
  configRevision?: number;
  environment?: BotEnvironment;
  binding: PersonalAssistantBinding;
  actorId: string;
  state: 'claimed' | 'revoked';
  createdAt: number;
  /** Explicit owner choice. Connection and credential remain Host-owned. */
  model: PersonalAssistantModelSelection | null;
  modelRevision: number;
}
export type AssistantActor = PersonalAssistant;
export interface PersonalAssistantModelSelection { providerId: string; modelId: string }
export interface PersonalAssistantModelOption extends PersonalAssistantModelSelection { label: string }
export interface PersonalAssistantModelCatalog { models: PersonalAssistantModelOption[]; available: boolean }
export interface PersonalAssistantAccess {
  binding: PersonalAssistantBinding;
  epoch: string;
  expiresAt: number;
}
export interface PersonalAssistantWorkSummary {
  id: string;
  title: string;
  status: "queued" | "running" | "waiting_input" | "awaiting_review" | "awaiting_delivery" | "blocked" | "completed" | "cancelled" | "failed";
  updatedAt: number;
}
export interface PersonalAssistantRuntimeState {
  /** Bounded fresh current-work observation, not history or a delivery receipt. Terminal entries from older Hosts must not become current activity. */
  works?: PersonalAssistantWorkSummary[];
  phase: 'unavailable' | 'config_required' | 'starting' | 'queued' | 'running' | 'retrying' | 'stopped';
  retryAt?: number;
  /** Ephemeral model admission observation; no business completion or queue ownership. */
  modelWait?: { reason: 'capacity' | 'rate_limit'; retryAt?: number };
  /** Fresh read-only projection of durable user turns. Missing means unknown, not idle. */
  reception?: { queued: number; running: number };
}
export interface PersonalAssistantStatus { assistant: PersonalAssistant | null; channelId?: string | null; runtime: PersonalAssistantRuntimeState }
export type AssistantActorStatus = PersonalAssistantStatus;
/** Public methods. Thread writes require a separately granted execution profile. */
export interface AssistantThreadProfile { id:string; revision:number; source:string; enabled:boolean }
export interface AssistantMemoryItem {
  key:string;value:string;revision:number;kind:'profile'|'log';updatedAt:number;origin:string;evidenceIds:string[];
  document:{path:string;scope:string;agentId:string|null;project:string|null}|null;
}
export type AssistantMemoryErrorCode = 'conflict'|'snapshot_changed'|'document_changed'|'offline'|'not_provisioned'|'busy'|'recovery_required'|'storage'|'duplicate'|'invalid'|'entry_missing';
export interface AssistantMemoryDocument {path:string;kind:'profile'|'log';characters:number;facts:number;version:string}
export type AssistantMemoryResponse =
 |{action:'error';code:AssistantMemoryErrorCode}
 |{action:'status';version:string;writable:boolean;total:number}
 |{action:'entry';version:string;writable:boolean;item:AssistantMemoryItem|null}
 |{action:'documents';items:AssistantMemoryDocument[];next:string|null;version:string;writable:boolean;total:number}
 |{action:'list';items:AssistantMemoryItem[];next:string|null;version:string;writable:boolean;total:number}
 |{action:'file';content:string;path:string;exists:boolean;version:string;nextOffset:number|null}
 |{action:'sources';item:AssistantMemoryItem;sources:{id:string;text?:string;at?:number;truncated?:boolean;unavailable?:boolean}[]}
 |{action:'set'|'forget';key:string;revision:number};
export interface PersonalAssistantMethodMap {
  'opencraft/personal-assistant/bots/list':{params:Record<string,never>;result:{bots:PersonalAssistantStatus[]}};
  'opencraft/personal-assistant/bots/create':{
    params:
      | {presetId:AssistantPresetId;name?:string;duties?:string;environment?:BotEnvironment;clientRequestId:string}
      | {presetId?:undefined;name:string;duties:string;environment:BotEnvironment;clientRequestId:string};
    result:PersonalAssistantStatus;
  };
  'opencraft/personal-assistant/bots/update':{params:{botId:string;name:string;duties:string;environment:BotEnvironment;expectedRevision:number};result:PersonalAssistantStatus};
  'opencraft/personal-assistant/bots/pause':{params:{botId:string;paused:boolean;expectedRevision:number};result:PersonalAssistantStatus};
  'opencraft/personal-assistant/environments':{params:Record<string,never>;result:BotEnvironmentCatalog};
  'opencraft/personal-assistant/memory':{params:{botId:string;assignmentId:string;action:'list'|'documents'|'status'|'entry'|'file'|'sources'|'set'|'forget';query?:string;after?:string;kind?:'profile'|'log';key?:string;path?:string;offset?:number;version?:string;expectedRevision?:number;value?:string;requestId?:string};result:AssistantMemoryResponse};
  'opencraft/personal-assistant/threads/profiles': {params:{botId?:string};result:{profiles:AssistantThreadProfile[]}};
  'opencraft/personal-assistant/threads/sources': {params:{botId?:string;cursor?:string};result:{conversations:{ref:ConversationRef;title:string}[];nextCursor:string|null}};
  'opencraft/personal-assistant/threads/profile/set': {params:{botId?:string;id:string;reference:string;expectedRevision:number};result:unknown};
  'opencraft/personal-assistant/threads/profile/revoke': {params:{botId?:string;id:string;expectedRevision:number};result:unknown};
  'opencraft/personal-assistant/threads/command': {params:{argv:string[];workId?:string};result:unknown};
  'opencraft/personal-assistant/models': { params: {botId?:string}; result: PersonalAssistantModelCatalog };
  'opencraft/personal-assistant/model/set': { params: { botId?:string; model: PersonalAssistantModelSelection; expectedRevision: number }; result: PersonalAssistantStatus };
  'opencraft/personal-assistant/get': { params: {botId?:string}; result: PersonalAssistantStatus };
  'opencraft/personal-assistant/claim': { params: Record<string, never>; result: PersonalAssistantStatus };
  'opencraft/personal-assistant/revoke': { params: {botId?:string}; result: PersonalAssistantStatus };
  'opencraft/personal-assistant/open': { params: {botId?:string}; result: { channel: ChannelSummary } };
  'opencraft/personal-assistant/retry': { params: {botId?:string}; result: PersonalAssistantStatus };
  'opencraft/personal-assistant/authorize': { params: Record<string, never>; result: PersonalAssistantAccess };
  'opencraft/personal-assistant/groups/list': { params: Record<string, never>; result: { groups: { id: string; title: string; kind: 'group' }[] } };
  'opencraft/personal-assistant/groups/history': { params: { channelId: string; before?: number }; result: ChannelHistoryPage };
  'opencraft/personal-assistant/groups/search': { params: { channelId: string; query: string; before?: number; limit?: number }; result: ChannelHistoryPage };
  'opencraft/personal-assistant/conversations/list': { params: { query?: string; cursor?: string }; result: { conversations: { ref: ConversationRef; title: string }[]; nextCursor: string | null } };
  'opencraft/personal-assistant/conversations/history': { params: { reference: string; cursor?: string }; result: unknown };
}
export const PERSONAL_ASSISTANT_METHODS: readonly (keyof PersonalAssistantMethodMap)[] = [
  'opencraft/personal-assistant/bots/list','opencraft/personal-assistant/bots/create','opencraft/personal-assistant/bots/update','opencraft/personal-assistant/bots/pause','opencraft/personal-assistant/environments',
  'opencraft/personal-assistant/memory',
  'opencraft/personal-assistant/threads/profiles', 'opencraft/personal-assistant/threads/sources',
  'opencraft/personal-assistant/threads/profile/set', 'opencraft/personal-assistant/threads/profile/revoke', 'opencraft/personal-assistant/threads/command',
  'opencraft/personal-assistant/models', 'opencraft/personal-assistant/model/set',
  'opencraft/personal-assistant/get', 'opencraft/personal-assistant/claim', 'opencraft/personal-assistant/revoke',
  'opencraft/personal-assistant/open', 'opencraft/personal-assistant/retry',
  'opencraft/personal-assistant/authorize', 'opencraft/personal-assistant/groups/list',
  'opencraft/personal-assistant/groups/history', 'opencraft/personal-assistant/groups/search',
  'opencraft/personal-assistant/conversations/list', 'opencraft/personal-assistant/conversations/history',
];
