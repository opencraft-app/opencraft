import type { BotConsoleState, BotNavigationGroup } from "@opencraft/mobile-bot-bridge";

/** Display snapshots only. The embedded controller still authorizes every command. */
export type BotNavigationState = {
  selectedBotId: string;
  confirmed: boolean;
  snapshots: ReadonlyMap<string, BotConsoleState>;
  groups: readonly BotNavigationGroup[];
  rowCount: number;
};

export const emptyBotNavigation = (): BotNavigationState => ({
  selectedBotId: "", confirmed: false, snapshots: new Map(), groups: [], rowCount: 0,
});

export function selectBotNavigation(state: BotNavigationState, botId: string): BotNavigationState {
  if (botId === state.selectedBotId) return state;
  if (!botId) return emptyBotNavigation();
  return { ...state, selectedBotId: botId, confirmed: false };
}

export function receiveBotNavigation(state: BotNavigationState, message: BotConsoleState): BotNavigationState {
  const previous = state.snapshots.get(message.botId);
  // A refresh is not an empty successful result. Keep this Bot's own rows only.
  const retaining = message.loading && message.sessions.length === 0 && !!previous?.sessions.length;
  const snapshot = retaining ? { ...message, sessions: previous.sessions, hasMore: previous.hasMore,
    commandsReady: false, error: false } : message;
  const snapshots = new Map(state.snapshots);
  snapshots.delete(message.botId);
  snapshots.set(message.botId, snapshot);
  // Bounded, runtime-local LRU; never persists account/session data.
  if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!);
  const current = message.botId === state.selectedBotId;
  return { ...state, snapshots, ...(current ? { confirmed: true, groups: message.groups,
    rowCount: Math.min(snapshot.sessions.length, 6) } : {}) };
}

export function pruneBotNavigation(state: BotNavigationState, ids: readonly string[]): BotNavigationState {
  if (ids.length === 0) return emptyBotNavigation();
  const allowed = new Set(ids);
  return { ...state, snapshots: new Map([...state.snapshots].filter(([id]) => allowed.has(id))),
    confirmed: state.confirmed && allowed.has(state.selectedBotId) };
}

export function projectBotNavigation(state: BotNavigationState, botId: string, ready: boolean) {
  const snapshot = state.snapshots.get(botId);
  const interactive = ready && state.selectedBotId === botId && state.confirmed;
  return {
    groups: botId ? snapshot?.groups ?? state.groups : [],
    interactive,
    consoleState: snapshot ? interactive ? snapshot : { ...snapshot, commandsReady: false, pending: false, error: false } : null,
    placeholderRows: botId && !snapshot ? state.rowCount : 0,
  };
}
