import type { AgentCapabilities, ChatMessage, ListedSession, PermissionRequest, SessionState } from './acpClient';
import { decideReopen, type PromptAttachment } from './protocol';
import {
  createDraftRow,
  canStartSessionOpen,
  markRowsDisconnected,
  promoteDraftToSession,
  removeTranscriptForSession,
  resolveActiveRowId,
  rowsFromListedSessions,
  updateRowConfigOptions,
  updateRowRestoreState,
  type RestoreState,
  type SessionListStatus,
  type SessionRow,
} from './sessionState';

export interface PendingPrompt {
  conversationId: string;
  text: string;
  files: PromptAttachment[];
  optimisticMessageId?: string;
}

export interface AcpRestoreEnvironment {
  cwd: string;
  mcpServers: unknown[];
  mcpServersAuthoritative: boolean;
}

export type SessionCoordinatorEffect =
  | { type: 'list_sessions'; cwd: string }
  | { type: 'update_row_restore_state'; conversationId: string; restoreState: RestoreState }
  | { type: 'remove_transcript'; conversationId: string }
  | { type: 'activate_loaded_session'; conversationId: string; sessionId: string }
  | { type: 'resume_session'; conversationId: string; sessionId: string; cwd: string; mcpServers?: unknown[]; additionalDirectories?: string[] }
  | { type: 'load_session'; conversationId: string; sessionId: string; cwd: string; mcpServers: unknown[]; additionalDirectories?: string[] }
  | { type: 'create_session'; conversationId: string; cwd: string; mcpServers: unknown[] }
  | { type: 'send_prompt'; prompt: PendingPrompt }
  | { type: 'report_error'; conversationId: string; content: string }
  | { type: 'start_load_replay'; conversationId: string }
  | { type: 'clear_load_replay'; conversationId: string }
  | { type: 'flush_pending_prompt'; conversationId: string }
  | { type: 'clear_all_load_replay' };

export function planTransportLoss(input: { conversations: SessionRow[] }) {
  return {
    conversations: markRowsDisconnected(input.conversations),
    pendingTurns: new Set<string>(),
    permissionRequests: [] as PermissionRequest[],
    pendingPrompts: new Map<string, PendingPrompt>(),
    effects: [{ type: 'clear_all_load_replay' } satisfies SessionCoordinatorEffect],
  };
}

export function planReady(input: {
  capabilities: AgentCapabilities;
  storedActiveSessionId?: string;
  defaultCwd: string;
}) {
  if (input.capabilities.sessionCapabilities?.list) {
    return {
      listStatus: 'loading' as SessionListStatus,
      listError: '',
      pendingOpenAfterList: input.storedActiveSessionId ?? 'first',
      effects: [{ type: 'list_sessions', cwd: input.defaultCwd } satisfies SessionCoordinatorEffect],
    };
  }
  return {
    listStatus: 'blocked' as SessionListStatus,
    listError: 'restore_failed/session_list_unavailable',
    pendingOpenAfterList: null,
    conversations: [] as SessionRow[],
    activeConversationId: '',
    effects: [] as SessionCoordinatorEffect[],
  };
}

export function planSessionList(input: {
  sessions: ListedSession[];
  previousRows: SessionRow[];
  defaultCwd: string;
  emptyDraftId?: string;
  pendingOpenAfterList: string | null;
  storedActiveSessionId?: string;
  activeConversationId: string;
  capabilities: AgentCapabilities;
  restoreEnvironment: AcpRestoreEnvironment;
  activeLiveConnection: boolean;
}) {
  const listedRows = rowsFromListedSessions(input.sessions, input.previousRows, input.defaultCwd);
  const createdEmptyDraft = listedRows.length === 0;
  const conversations = !createdEmptyDraft
    ? listedRows
    : [createDraftRow(input.emptyDraftId ?? 'conv-empty-draft', input.defaultCwd, input.restoreEnvironment.mcpServers)];
  const preferred = input.pendingOpenAfterList === 'first' ? input.storedActiveSessionId : input.pendingOpenAfterList;
  const activeConversationId = resolveActiveRowId(conversations, preferred ?? input.activeConversationId);
  const activeConversation = conversations.find((row) => row.id === activeConversationId);
  const effects = activeConversation && !createdEmptyDraft
    ? planOpenConversation({
      conversation: activeConversation,
      capabilities: input.capabilities,
      listedSessions: input.sessions,
      restoreEnvironment: input.restoreEnvironment,
      liveConnection: input.activeLiveConnection,
    }).effects
    : [];
  return {
    conversations,
    activeConversationId,
    listStatus: 'ready' as SessionListStatus,
    listError: '',
    pendingOpenAfterList: null,
    effects,
  };
}

export function planOpenConversation(input: {
  conversation: SessionRow;
  capabilities: AgentCapabilities;
  listedSessions: ListedSession[];
  restoreEnvironment: AcpRestoreEnvironment;
  liveConnection: boolean;
}) {
  const { conversation, capabilities, listedSessions, restoreEnvironment } = input;
  const effects: SessionCoordinatorEffect[] = [];
  if (!canStartSessionOpen(conversation)) return { effects };

  const listedSession = conversation.sessionId
    ? listedSessions.find((session) => session.sessionId === conversation.sessionId)
    : undefined;
  const listedByAgent = Boolean(listedSession);
  if (
    input.liveConnection &&
    conversation.sessionId &&
    !listedSession?.readOnly &&
    (listedSession?.state === 'ready' || listedSession?.state === 'prompting')
  ) {
    effects.push(
      { type: 'update_row_restore_state', conversationId: conversation.id, restoreState: 'live' },
      { type: 'activate_loaded_session', conversationId: conversation.id, sessionId: conversation.sessionId },
    );
    return { effects };
  }
  const decision = decideReopen({
    liveConnection: input.liveConnection,
    listedByAgent,
    listSupported: Boolean(capabilities.sessionCapabilities?.list),
    loadSupported: capabilities.loadSession === true,
    hasSessionId: Boolean(conversation.sessionId),
    hasCwd: Boolean(conversation.cwd),
    mcpServersAuthoritative: restoreEnvironment.mcpServersAuthoritative && Array.isArray(restoreEnvironment.mcpServers),
    requiredRootsAuthoritative: true,
  });

  if (decision.action === 'rebind' && conversation.sessionId) {
    effects.push(
      { type: 'update_row_restore_state', conversationId: conversation.id, restoreState: 'live' },
      { type: 'activate_loaded_session', conversationId: conversation.id, sessionId: conversation.sessionId },
    );
    return { effects };
  }
  if (decision.action === 'load' && conversation.sessionId) {
    effects.push(
      { type: 'remove_transcript', conversationId: conversation.id },
      { type: 'update_row_restore_state', conversationId: conversation.id, restoreState: 'restoring' },
      {
        type: 'load_session',
        conversationId: conversation.id,
        sessionId: conversation.sessionId,
        cwd: conversation.cwd,
        mcpServers: restoreEnvironment.mcpServers,
        additionalDirectories: conversation.additionalDirectories,
      },
    );
    return { effects };
  }
  if (decision.action === 'blocked') {
    effects.push(
      { type: 'update_row_restore_state', conversationId: conversation.id, restoreState: 'blocked' },
      { type: 'report_error', conversationId: conversation.id, content: `restore_failed/${decision.errorKind ?? 'resume_rejected'}` },
    );
    return { effects };
  }

  effects.push(
    { type: 'update_row_restore_state', conversationId: conversation.id, restoreState: 'restoring' },
    { type: 'create_session', conversationId: conversation.id, cwd: conversation.cwd, mcpServers: restoreEnvironment.mcpServers },
  );
  return { effects };
}

export function planSendPrompt(input: {
  prompt: PendingPrompt;
  activeConversation: SessionRow;
  capabilities: AgentCapabilities;
  listedSessions: ListedSession[];
  restoreEnvironment: AcpRestoreEnvironment;
  liveConnection: boolean;
}) {
  const { prompt, activeConversation } = input;
  if (activeConversation.readOnly) {
    return {
      queuePrompt: undefined,
      clearComposer: false,
      effects: [
        {
          type: 'report_error',
          conversationId: activeConversation.id,
          content: `session_read_only/${activeConversation.readOnlyReason ?? 'runtime_not_recovered'}`,
        } satisfies SessionCoordinatorEffect,
      ],
    };
  }
  if (activeConversation.sessionId && activeConversation.restoreState === 'live' && input.liveConnection) {
    return {
      queuePrompt: undefined,
      clearComposer: true,
      effects: [{ type: 'send_prompt', prompt } satisfies SessionCoordinatorEffect],
    };
  }

  const effects = activeConversation.sessionId
    ? planOpenConversation({
      conversation: activeConversation,
      capabilities: input.capabilities,
      listedSessions: input.listedSessions,
      restoreEnvironment: input.restoreEnvironment,
      liveConnection: input.liveConnection,
    }).effects
    : canStartSessionOpen(activeConversation)
      ? [
        { type: 'update_row_restore_state', conversationId: activeConversation.id, restoreState: 'restoring' },
        { type: 'create_session', conversationId: activeConversation.id, cwd: activeConversation.cwd, mcpServers: input.restoreEnvironment.mcpServers },
      ] satisfies SessionCoordinatorEffect[]
      : [];

  return {
    queuePrompt: prompt,
    clearComposer: true,
    effects,
  };
}

export function planCreateConversation(input: {
  id: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  restoreEnvironment: AcpRestoreEnvironment;
}) {
  const draft = createDraftRow(input.id, input.restoreEnvironment.cwd, input.restoreEnvironment.mcpServers);
  const conversation = input.status === 'connected' ? { ...draft, restoreState: 'restoring' as const } : draft;
  return {
    conversation,
    effects: input.status === 'connected'
      ? [{ type: 'create_session', conversationId: conversation.id, cwd: conversation.cwd, mcpServers: input.restoreEnvironment.mcpServers } satisfies SessionCoordinatorEffect]
      : [],
  };
}

export function planSessionReady(input: {
  state: SessionState;
  conversations: SessionRow[];
  activeConversationId: string;
  messages: ChatMessage[];
  pendingTurns: Set<string>;
  pendingPrompts: Map<string, PendingPrompt>;
}) {
  const previousId = input.state.conversationId;
  const nextId = input.state.sessionId;
  const restoreState = input.state.restoreSource === 'load' ? 'restoring' : 'live';
  const promotedRows = promoteDraftToSession(input.conversations, previousId, nextId, input.state.configOptions);
  const withReadOnly = promotedRows.map((row) =>
    row.id === nextId
      ? {
          ...row,
          readOnly: input.state.readOnly ?? row.readOnly,
          readOnlyReason: input.state.readOnlyReason ?? row.readOnlyReason,
        }
      : row,
  );
  const conversations = updateRowConfigOptions(
    updateRowRestoreState(
      withReadOnly,
      nextId,
      input.state.readOnly && input.state.restoreSource !== 'load' ? 'blocked' : restoreState,
    ),
    nextId,
    input.state.configOptions,
  );
  const activeConversationId = input.activeConversationId === previousId || !input.activeConversationId ? nextId : input.activeConversationId;
  const messages = input.messages.map((message) => message.conversationId === previousId ? { ...message, conversationId: nextId } : message);
  const pendingTurns = replacePendingTurn(input.pendingTurns, previousId, nextId);
  const pendingPrompts = new Map(input.pendingPrompts);
  const pendingPrompt = pendingPrompts.get(previousId);
  if (pendingPrompt) {
    pendingPrompts.delete(previousId);
    pendingPrompts.set(nextId, { ...pendingPrompt, conversationId: nextId });
  }
  const effects: SessionCoordinatorEffect[] = input.state.restoreSource === 'load'
    ? [
      { type: 'start_load_replay', conversationId: nextId },
    ]
    : [
      { type: 'activate_loaded_session', conversationId: nextId, sessionId: nextId },
      { type: 'clear_load_replay', conversationId: nextId },
      { type: 'flush_pending_prompt', conversationId: nextId },
    ];
  return { conversations, activeConversationId, messages, pendingTurns, pendingPrompts, effects };
}

export function planRestoreError(input: {
  targetConversationId: string;
  kind: string;
  content: string;
  conversations: SessionRow[];
  pendingTurns: Set<string>;
  pendingPrompts: Map<string, PendingPrompt>;
}) {
  const pendingPrompts = new Map(input.pendingPrompts);
  pendingPrompts.delete(input.targetConversationId);
  const pendingTurns = new Set(input.pendingTurns);
  pendingTurns.delete(input.targetConversationId);
  const restoreState = input.kind === 'session_read_only' ? 'blocked' : 'error';
  return {
    conversations: updateRowRestoreState(input.conversations, input.targetConversationId, restoreState),
    pendingTurns,
    pendingPrompts,
    listStatus: input.kind === 'session_list_unavailable' ? 'error' as SessionListStatus : undefined,
    listError: input.kind === 'session_list_unavailable' ? input.content : undefined,
    effects: [{ type: 'clear_load_replay', conversationId: input.targetConversationId } satisfies SessionCoordinatorEffect],
  };
}

export function planLoadReplaySettled(input: {
  conversationId: string;
  conversations: SessionRow[];
}) {
  const conversation = input.conversations.find((row) => row.id === input.conversationId);
  const effects: SessionCoordinatorEffect[] = [];
  if (conversation?.sessionId) {
    if (conversation.readOnly) {
      effects.push(
        {
          type: 'update_row_restore_state',
          conversationId: input.conversationId,
          restoreState: 'blocked',
        },
        {
          type: 'report_error',
          conversationId: input.conversationId,
          content: `session_read_only/${conversation.readOnlyReason ?? 'runtime_not_recovered'}`,
        },
      );
      return { effects };
    }
    effects.push({
      type: 'resume_session',
      conversationId: input.conversationId,
      sessionId: conversation.sessionId,
      cwd: conversation.cwd,
      mcpServers: conversation.mcpServersAuthoritative ? conversation.mcpServers : undefined,
      additionalDirectories: conversation.additionalDirectories,
    });
  }
  return { effects };
}

export function replacePendingTurn(turns: Set<string>, previousId: string, nextId: string) {
  const next = new Set(turns);
  if (next.delete(previousId)) next.add(nextId);
  return next;
}

export function applyRowRestoreEffect(rows: SessionRow[], effect: Extract<SessionCoordinatorEffect, { type: 'update_row_restore_state' }>) {
  return updateRowRestoreState(rows, effect.conversationId, effect.restoreState);
}

export function applyTranscriptEffect<T extends { conversationId: string }>(
  messages: T[],
  effect: Extract<SessionCoordinatorEffect, { type: 'remove_transcript' }>,
) {
  return removeTranscriptForSession(messages, effect.conversationId);
}
