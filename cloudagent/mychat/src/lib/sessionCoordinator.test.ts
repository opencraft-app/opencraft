import { describe, expect, it } from 'vitest';
import type { ChatMessage, ListedSession, SessionState } from './acpClient';
import {
  planCreateConversation,
  planLoadReplaySettled,
  planOpenConversation,
  planReady,
  planRestoreError,
  planSendPrompt,
  planSessionList,
  planSessionReady,
  planTransportLoss,
  type AcpRestoreEnvironment,
  type PendingPrompt,
} from './sessionCoordinator';
import { createDraftRow, rowsFromListedSessions, updateRowRestoreState, type SessionRow } from './sessionState';

const restoreEnvironment: AcpRestoreEnvironment = {
  cwd: '/workspace',
  mcpServers: [],
  mcpServersAuthoritative: true,
};

const listCapable = {
  loadSession: true,
  sessionCapabilities: { list: {} },
};

describe('ACP session coordinator readiness', () => {
  it('requests session/list when the agent advertises list support', () => {
    expect(planReady({
      capabilities: listCapable,
      storedActiveSessionId: 'session-1',
      defaultCwd: restoreEnvironment.cwd,
    })).toMatchObject({
      listStatus: 'loading',
      listError: '',
      pendingOpenAfterList: 'session-1',
      effects: [{ type: 'list_sessions', cwd: restoreEnvironment.cwd }],
    });
  });

  it('fails closed when session/list is unavailable', () => {
    expect(planReady({
      capabilities: {},
      defaultCwd: restoreEnvironment.cwd,
    })).toMatchObject({
      listStatus: 'blocked',
      listError: 'restore_failed/session_list_unavailable',
      conversations: [],
      activeConversationId: '',
      effects: [],
    });
  });
});

describe('ACP session coordinator open decisions', () => {
  it('turns session/list into rows and exactly one selected-session load effect', () => {
    const sessions: ListedSession[] = [{ sessionId: 'session-1', title: 'History', cwd: restoreEnvironment.cwd }];

    const result = planSessionList({
      sessions,
      previousRows: [],
      defaultCwd: restoreEnvironment.cwd,
      pendingOpenAfterList: 'first',
      storedActiveSessionId: 'session-1',
      activeConversationId: '',
      capabilities: listCapable,
      restoreEnvironment,
      activeLiveConnection: false,
    });

    expect(result.activeConversationId).toBe('session-1');
    expect(result.conversations).toHaveLength(1);
    expect(result.effects).toMatchObject([
      { type: 'remove_transcript', conversationId: 'session-1' },
      { type: 'update_row_restore_state', conversationId: 'session-1', restoreState: 'restoring' },
      { type: 'load_session', conversationId: 'session-1', sessionId: 'session-1' },
    ]);
  });

  it('creates a writable draft when session/list is empty', () => {
    const result = planSessionList({
      sessions: [],
      previousRows: [],
      defaultCwd: restoreEnvironment.cwd,
      emptyDraftId: 'draft-empty',
      pendingOpenAfterList: 'first',
      storedActiveSessionId: undefined,
      activeConversationId: '',
      capabilities: listCapable,
      restoreEnvironment,
      activeLiveConnection: false,
    });

    expect(result.activeConversationId).toBe('draft-empty');
    expect(result.conversations).toMatchObject([
      { id: 'draft-empty', restoreState: 'new', source: 'draft' },
    ]);
    expect(result.conversations[0].sessionId).toBeUndefined();
    expect(result.effects).toEqual([]);
  });

  it('rebinds an already-live session without replaying history', () => {
    const row = rowFromSession('session-1');

    expect(planOpenConversation({
      conversation: row,
      capabilities: listCapable,
      listedSessions: [{ sessionId: 'session-1' }],
      restoreEnvironment,
      liveConnection: true,
    }).effects).toEqual([
      { type: 'update_row_restore_state', conversationId: 'session-1', restoreState: 'live' },
      { type: 'activate_loaded_session', conversationId: 'session-1', sessionId: 'session-1' },
    ]);
  });

  it('loads a listed ready runtime after browser reload before resume reattach', () => {
    const row = rowFromSession('session-1');

    expect(planOpenConversation({
      conversation: row,
      capabilities: listCapable,
      listedSessions: [{ sessionId: 'session-1', state: 'ready' }],
      restoreEnvironment,
      liveConnection: false,
    }).effects).toMatchObject([
      { type: 'remove_transcript', conversationId: 'session-1' },
      { type: 'update_row_restore_state', conversationId: 'session-1', restoreState: 'restoring' },
      { type: 'load_session', conversationId: 'session-1', sessionId: 'session-1' },
    ]);
  });

  it('loads read-only listed sessions instead of treating ready state as writable', () => {
    const row = rowFromSession('session-1', {
      readOnly: true,
      readOnlyReason: 'runtime_not_recovered',
      state: 'ready',
    });

    expect(planOpenConversation({
      conversation: row,
      capabilities: listCapable,
      listedSessions: [{ sessionId: 'session-1', state: 'ready', readOnly: true, readOnlyReason: 'runtime_not_recovered' }],
      restoreEnvironment,
      liveConnection: false,
    }).effects).toMatchObject([
      { type: 'remove_transcript', conversationId: 'session-1' },
      { type: 'update_row_restore_state', conversationId: 'session-1', restoreState: 'restoring' },
      { type: 'load_session', conversationId: 'session-1', sessionId: 'session-1' },
    ]);
  });

  it('blocks a stored session that the ACP session/list does not contain', () => {
    const row = rowFromSession('missing-session');

    expect(planOpenConversation({
      conversation: row,
      capabilities: listCapable,
      listedSessions: [{ sessionId: 'session-1' }],
      restoreEnvironment,
      liveConnection: false,
    }).effects).toEqual([
      { type: 'update_row_restore_state', conversationId: 'missing-session', restoreState: 'blocked' },
      { type: 'report_error', conversationId: 'missing-session', content: 'restore_failed/resume_rejected' },
    ]);
  });

  it('does nothing when the row is already restoring', () => {
    const row = updateRowRestoreState([rowFromSession('session-1')], 'session-1', 'restoring')[0];

    expect(planOpenConversation({
      conversation: row,
      capabilities: listCapable,
      listedSessions: [{ sessionId: 'session-1' }],
      restoreEnvironment,
      liveConnection: false,
    }).effects).toEqual([]);
  });
});

describe('ACP session coordinator send decisions', () => {
  it('sends immediately on a live active session', () => {
    const prompt = pendingPrompt('session-1');

    expect(planSendPrompt({
      prompt,
      activeConversation: updateRowRestoreState([rowFromSession('session-1')], 'session-1', 'live')[0],
      capabilities: listCapable,
      listedSessions: [{ sessionId: 'session-1' }],
      restoreEnvironment,
      liveConnection: true,
    })).toEqual({
      queuePrompt: undefined,
      clearComposer: true,
      effects: [{ type: 'send_prompt', prompt }],
    });
  });

  it('queues prompt and emits one load path for a non-live stored session', () => {
    const prompt = pendingPrompt('session-1');

    const result = planSendPrompt({
      prompt,
      activeConversation: rowFromSession('session-1'),
      capabilities: listCapable,
      listedSessions: [{ sessionId: 'session-1' }],
      restoreEnvironment,
      liveConnection: false,
    });

    expect(result.queuePrompt).toEqual(prompt);
    expect(result.clearComposer).toBe(true);
    expect(result.effects.filter((effect) => effect.type === 'load_session')).toHaveLength(1);
    expect(result.effects.map((effect) => effect.type)).not.toContain('resume_session');
  });

  it('queues prompt and creates a draft session exactly once', () => {
    const draft = createDraftRow('draft-1', restoreEnvironment.cwd);
    const prompt = pendingPrompt('draft-1');

    expect(planSendPrompt({
      prompt,
      activeConversation: draft,
      capabilities: listCapable,
      listedSessions: [],
      restoreEnvironment,
      liveConnection: false,
    })).toMatchObject({
      queuePrompt: prompt,
      clearComposer: true,
      effects: [
        { type: 'update_row_restore_state', conversationId: 'draft-1', restoreState: 'restoring' },
        { type: 'create_session', conversationId: 'draft-1', cwd: restoreEnvironment.cwd },
      ],
    });
  });

  it('blocks prompts against read-only restored sessions without clearing the composer', () => {
    const prompt = pendingPrompt('session-1');
    const readOnly = rowFromSession('session-1', {
      readOnly: true,
      readOnlyReason: 'runtime_not_recovered',
    });

    expect(planSendPrompt({
      prompt,
      activeConversation: readOnly,
      capabilities: listCapable,
      listedSessions: [{ sessionId: 'session-1', readOnly: true }],
      restoreEnvironment,
      liveConnection: false,
    })).toEqual({
      queuePrompt: undefined,
      clearComposer: false,
      effects: [
        {
          type: 'report_error',
          conversationId: 'session-1',
          content: 'session_read_only/runtime_not_recovered',
        },
      ],
    });
  });
});

describe('ACP session coordinator lifecycle transitions', () => {
  it('promotes a draft session and migrates messages, pending turn, and queued prompt', () => {
    const draft = createDraftRow('draft-1', restoreEnvironment.cwd);
    const messages: ChatMessage[] = [{
      id: 'm1',
      conversationId: 'draft-1',
      role: 'user',
      sender: 'meo',
      time: '12:00',
      content: 'hello',
    }];
    const prompt = pendingPrompt('draft-1');
    const state: SessionState = {
      conversationId: 'draft-1',
      sessionId: 'session-1',
      configOptions: [],
      restoreSource: 'new',
    };

    const result = planSessionReady({
      state,
      conversations: [draft],
      activeConversationId: 'draft-1',
      messages,
      pendingTurns: new Set(['draft-1']),
      pendingPrompts: new Map([['draft-1', prompt]]),
    });

    expect(result.activeConversationId).toBe('session-1');
    expect(result.conversations[0]).toMatchObject({ id: 'session-1', sessionId: 'session-1', restoreState: 'live' });
    expect(result.messages[0].conversationId).toBe('session-1');
    expect(Array.from(result.pendingTurns)).toEqual(['session-1']);
    expect(result.pendingPrompts.get('session-1')).toMatchObject({ conversationId: 'session-1' });
    expect(result.effects).toEqual([
      { type: 'activate_loaded_session', conversationId: 'session-1', sessionId: 'session-1' },
      { type: 'clear_load_replay', conversationId: 'session-1' },
      { type: 'flush_pending_prompt', conversationId: 'session-1' },
    ]);
  });

  it('keeps loaded sessions non-live until replay settlement', () => {
    const row = rowFromSession('session-1');
    const state: SessionState = {
      conversationId: 'session-1',
      sessionId: 'session-1',
      configOptions: [],
      restoreSource: 'load',
    };

    const result = planSessionReady({
      state,
      conversations: [row],
      activeConversationId: 'session-1',
      messages: [],
      pendingTurns: new Set(),
      pendingPrompts: new Map(),
    });

    expect(result.conversations[0].restoreState).toBe('restoring');
    expect(result.effects).toEqual([
      { type: 'start_load_replay', conversationId: 'session-1' },
    ]);
  });

  it('resumes loaded sessions after replay settlement before flushing prompts', () => {
    const row = rowFromSession('session-1');

    expect(planLoadReplaySettled({
      conversationId: 'session-1',
      conversations: [row],
    }).effects).toEqual([
      {
        type: 'resume_session',
        conversationId: 'session-1',
        sessionId: 'session-1',
        cwd: restoreEnvironment.cwd,
        mcpServers: undefined,
        additionalDirectories: undefined,
      },
    ]);
  });

  it('keeps read-only loaded sessions blocked after replay settlement', () => {
    const row = rowFromSession('session-1', {
      readOnly: true,
      readOnlyReason: 'runtime_not_recovered',
    });

    expect(planLoadReplaySettled({
      conversationId: 'session-1',
      conversations: [row],
    }).effects).toEqual([
      { type: 'update_row_restore_state', conversationId: 'session-1', restoreState: 'blocked' },
      { type: 'report_error', conversationId: 'session-1', content: 'session_read_only/runtime_not_recovered' },
    ]);
  });

  it('migrates queued prompts and flushes immediately after resume success', () => {
    const row = rowFromSession('session-1');
    const prompt = pendingPrompt('session-1');
    const state: SessionState = {
      conversationId: 'session-1',
      sessionId: 'session-1',
      configOptions: [],
      restoreSource: 'resume',
    };

    const result = planSessionReady({
      state,
      conversations: [row],
      activeConversationId: 'session-1',
      messages: [],
      pendingTurns: new Set(['session-1']),
      pendingPrompts: new Map([['session-1', prompt]]),
    });

    expect(result.conversations[0].restoreState).toBe('live');
    expect(result.pendingPrompts.get('session-1')).toEqual(prompt);
    expect(result.pendingTurns.has('session-1')).toBe(true);
    expect(result.effects).toEqual([
      { type: 'activate_loaded_session', conversationId: 'session-1', sessionId: 'session-1' },
      { type: 'clear_load_replay', conversationId: 'session-1' },
      { type: 'flush_pending_prompt', conversationId: 'session-1' },
    ]);
  });

  it('clears pending state and marks rows disconnected on transport loss', () => {
    const live = updateRowRestoreState([rowFromSession('session-1')], 'session-1', 'live')[0];
    const restoring = updateRowRestoreState([rowFromSession('session-2')], 'session-2', 'restoring')[0];

    const result = planTransportLoss({ conversations: [live, restoring] });

    expect(result.conversations.map((row) => row.restoreState)).toEqual(['new', 'error']);
    expect(result.pendingPrompts.size).toBe(0);
    expect(result.pendingTurns.size).toBe(0);
    expect(result.permissionRequests).toEqual([]);
    expect(result.effects).toEqual([{ type: 'clear_all_load_replay' }]);
  });

  it('marks restore failures against the target row and drops queued prompt', () => {
    const prompt = pendingPrompt('session-1');
    const result = planRestoreError({
      targetConversationId: 'session-1',
      kind: 'resume_rejected',
      content: 'restore_failed/resume_rejected',
      conversations: [rowFromSession('session-1')],
      pendingTurns: new Set(['session-1']),
      pendingPrompts: new Map([['session-1', prompt]]),
    });

    expect(result.conversations[0].restoreState).toBe('error');
    expect(result.pendingPrompts.has('session-1')).toBe(false);
    expect(result.pendingTurns.has('session-1')).toBe(false);
    expect(result.effects).toEqual([{ type: 'clear_load_replay', conversationId: 'session-1' }]);
  });

  it('promotes session/list unavailable restore errors into sidebar list error state', () => {
    const result = planRestoreError({
      targetConversationId: 'session-1',
      kind: 'session_list_unavailable',
      content: 'restore_failed/session_list_unavailable',
      conversations: [rowFromSession('session-1')],
      pendingTurns: new Set(),
      pendingPrompts: new Map(),
    });

    expect(result.listStatus).toBe('error');
    expect(result.listError).toBe('restore_failed/session_list_unavailable');
    expect(result.conversations[0].restoreState).toBe('error');
  });

  it('creates connected drafts as restoring and emits one create effect', () => {
    const result = planCreateConversation({
      id: 'draft-1',
      status: 'connected',
      restoreEnvironment,
    });

    expect(result.conversation).toMatchObject({ id: 'draft-1', restoreState: 'restoring', source: 'draft' });
    expect(result.effects).toEqual([{ type: 'create_session', conversationId: 'draft-1', cwd: restoreEnvironment.cwd, mcpServers: [] }]);
  });
});

function rowFromSession(sessionId: string, extra: Partial<ListedSession> = {}): SessionRow {
  return rowsFromListedSessions([{ sessionId, cwd: restoreEnvironment.cwd, ...extra }], [], restoreEnvironment.cwd)[0];
}

function pendingPrompt(conversationId: string): PendingPrompt {
  return { conversationId, text: 'hello', files: [] };
}
