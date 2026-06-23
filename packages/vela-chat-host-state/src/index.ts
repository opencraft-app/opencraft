export interface VelaHostKeyValueStore {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface ConversationScrollClientState {
  routeKey: string;
  scrollTop: number;
  followOutput: boolean;
  anchor?: ConversationScrollAnchorClientState;
}

export interface ConversationScrollAnchorClientState {
  itemId: string;
  offsetTop: number;
}

export interface ComposerDraftClientState {
  sessionId: string;
  text: string;
  updatedAt: number;
}

export interface ShellLayoutState {
  sidebarWidthPx: number;
  isSidebarVisible: boolean;
  updatedAt: number;
}

export interface VelaStateSlot<T> {
  clear(scope: string): void;
  read(scope: string): T | null;
  write(scope: string, state: T): void;
}

export interface VelaClientStateStore {
  conversationScroll: VelaStateSlot<ConversationScrollClientState>;
  composerDraft: VelaStateSlot<ComposerDraftClientState>;
}

export interface VelaShellLayoutStore {
  clear(): void;
  read(): ShellLayoutState | null;
  write(state: ShellLayoutState): void;
}

interface StoreOptions {
  hostId?: string;
}

const DEFAULT_HOST_ID = "web";
const CLIENT_STATE_PREFIX = "vela-chat:client-state";
const SHELL_LAYOUT_PREFIX = "vela-chat:shell-layout";

export function createMemoryKeyValueStore(
  initial: Record<string, string> = {},
): VelaHostKeyValueStore {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

export function createVelaClientStateStore(
  kv: VelaHostKeyValueStore,
  options: StoreOptions = {},
): VelaClientStateStore {
  const hostId = normalizeScopePart(options.hostId ?? DEFAULT_HOST_ID);
  return {
    conversationScroll: createStateSlot(
      kv,
      `${CLIENT_STATE_PREFIX}:${hostId}:conversation_scroll`,
      parseConversationScrollState,
      serializeConversationScrollState,
    ),
    composerDraft: createStateSlot(
      kv,
      `${CLIENT_STATE_PREFIX}:${hostId}:composer_draft`,
      parseComposerDraftState,
      serializeComposerDraftState,
    ),
  };
}

export function createVelaShellLayoutStore(
  kv: VelaHostKeyValueStore,
  options: StoreOptions = {},
): VelaShellLayoutStore {
  const key = `${SHELL_LAYOUT_PREFIX}:${normalizeScopePart(options.hostId ?? DEFAULT_HOST_ID)}`;
  return {
    clear() {
      kv.removeItem(key);
    },
    read() {
      return parseShellLayoutState(kv.getItem(key));
    },
    write(state) {
      kv.setItem(key, serializeShellLayoutState(state));
    },
  };
}

export function webStorageKeyValueStore(
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem"> | null | undefined,
): VelaHostKeyValueStore | null {
  if (!storage) return null;
  return {
    getItem: (key) => storage.getItem(key),
    removeItem: (key) => storage.removeItem(key),
    setItem: (key, value) => storage.setItem(key, value),
  };
}

export function createBrowserVelaClientStateStore(
  options: StoreOptions = {},
): VelaClientStateStore | null {
  if (typeof window === "undefined") return null;
  const kv = webStorageKeyValueStore(window.sessionStorage);
  return kv ? createVelaClientStateStore(kv, options) : null;
}

export function createBrowserVelaShellLayoutStore(
  options: StoreOptions = {},
): VelaShellLayoutStore | null {
  if (typeof window === "undefined") return null;
  const kv = webStorageKeyValueStore(window.localStorage);
  return kv ? createVelaShellLayoutStore(kv, options) : null;
}

function createStateSlot<T>(
  kv: VelaHostKeyValueStore,
  prefix: string,
  parse: (raw: string | null, scope: string) => T | null,
  serialize: (state: T) => string,
): VelaStateSlot<T> {
  return {
    clear(scope) {
      kv.removeItem(scopedKey(prefix, scope));
    },
    read(scope) {
      return parse(kv.getItem(scopedKey(prefix, scope)), scope);
    },
    write(scope, state) {
      kv.setItem(scopedKey(prefix, scope), serialize(state));
    },
  };
}

function scopedKey(prefix: string, scope: string): string {
  return `${prefix}:${normalizeScopePart(scope)}`;
}

function normalizeScopePart(value: string): string {
  return encodeURIComponent(value);
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function serializeConversationScrollState(
  state: ConversationScrollClientState,
): string {
  const value: Record<string, unknown> = {
    version: 1,
    route_key: state.routeKey,
    scroll_top: state.scrollTop,
    follow_output: state.followOutput,
  };
  if (isConversationScrollAnchorState(state.anchor)) {
    value.anchor = {
      item_id: state.anchor.itemId,
      offset_top: state.anchor.offsetTop,
    };
  }
  return JSON.stringify(value);
}

function parseConversationScrollState(
  raw: string | null,
  routeKey: string,
): ConversationScrollClientState | null {
  const value = parseJsonObject(raw);
  if (!value || value.version !== 1) return null;
  if (value.route_key !== routeKey) return null;
  if (
    typeof value.scroll_top !== "number" ||
    !Number.isFinite(value.scroll_top) ||
    value.scroll_top < 0
  ) {
    return null;
  }
  if (typeof value.follow_output !== "boolean") return null;
  const anchor = parseConversationScrollAnchorState(value.anchor);
  return {
    routeKey,
    scrollTop: value.scroll_top,
    followOutput: value.follow_output,
    ...(anchor ? { anchor } : {}),
  };
}

function isConversationScrollAnchorState(
  value: ConversationScrollAnchorClientState | undefined,
): value is ConversationScrollAnchorClientState {
  return Boolean(
    value &&
      typeof value.itemId === "string" &&
      value.itemId.length > 0 &&
      Number.isFinite(value.offsetTop),
  );
}

function parseConversationScrollAnchorState(
  raw: unknown,
): ConversationScrollAnchorClientState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.item_id !== "string" || value.item_id.length === 0) {
    return null;
  }
  if (
    typeof value.offset_top !== "number" ||
    !Number.isFinite(value.offset_top)
  ) {
    return null;
  }
  return {
    itemId: value.item_id,
    offsetTop: value.offset_top,
  };
}

function serializeComposerDraftState(state: ComposerDraftClientState): string {
  return JSON.stringify({
    version: 1,
    session_id: state.sessionId,
    text: state.text,
    updated_at: state.updatedAt,
  });
}

function parseComposerDraftState(
  raw: string | null,
  sessionId: string,
): ComposerDraftClientState | null {
  const value = parseJsonObject(raw);
  if (!value || value.version !== 1) return null;
  if (value.session_id !== sessionId) return null;
  if (typeof value.text !== "string") return null;
  if (
    typeof value.updated_at !== "number" ||
    !Number.isFinite(value.updated_at) ||
    value.updated_at < 0
  ) {
    return null;
  }
  return {
    sessionId,
    text: value.text,
    updatedAt: value.updated_at,
  };
}

function serializeShellLayoutState(state: ShellLayoutState): string {
  return JSON.stringify({
    version: 1,
    sidebar_width_px: state.sidebarWidthPx,
    is_sidebar_visible: state.isSidebarVisible,
    updated_at: state.updatedAt,
  });
}

function parseShellLayoutState(raw: string | null): ShellLayoutState | null {
  const value = parseJsonObject(raw);
  if (!value || value.version !== 1) return null;
  if (
    typeof value.sidebar_width_px !== "number" ||
    !Number.isFinite(value.sidebar_width_px) ||
    value.sidebar_width_px <= 0
  ) {
    return null;
  }
  if (typeof value.is_sidebar_visible !== "boolean") return null;
  if (
    typeof value.updated_at !== "number" ||
    !Number.isFinite(value.updated_at) ||
    value.updated_at < 0
  ) {
    return null;
  }
  return {
    sidebarWidthPx: value.sidebar_width_px,
    isSidebarVisible: value.is_sidebar_visible,
    updatedAt: value.updated_at,
  };
}
