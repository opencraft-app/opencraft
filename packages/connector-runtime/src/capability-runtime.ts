import type {
  ConnectorCapabilityEntry,
  ConnectorCapabilityIdentity,
  ConnectorScope,
} from "./contract";
import { ConnectorError } from "./lifetime";
import type { ConnectorRuntime } from "./runtime";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const PAGE_BYTE_BUDGET = 64 * 1024;
const DETAIL_BYTE_BUDGET = 224 * 1024;
const SCHEMA_BYTE_BUDGET = 48 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 4096;
const MAX_DETAIL_ITEMS = 4;
const MAX_STATE = 4096;
const STATE_TTL_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();
const scopeKey = (scope: ConnectorScope) => JSON.stringify([scope.hostId, scope.threadId]);
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

export interface ConnectorCapabilitySearchRequest {
  readonly query?: string;
  readonly connectorId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ConnectorCapabilitySummary {
  readonly toolRef: string;
  readonly connectorId: string;
  readonly connectorTitle: string;
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
}

export interface ConnectorCapabilitySearchPage {
  readonly revision: string;
  readonly items: readonly ConnectorCapabilitySummary[];
  readonly nextCursor: string | null;
}

export interface ConnectorCapabilityDetail {
  readonly toolRef: string;
  readonly connectorId: string;
  readonly connectorTitle: string;
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly handle: string;
}

interface CursorState {
  readonly scope: string;
  readonly revision: string;
  readonly entries: readonly ConnectorCapabilityEntry[];
  readonly offset: number;
  readonly expiresAt: number;
}

interface ToolRefState {
  readonly scope: string;
  readonly revision: string;
  readonly entry: ConnectorCapabilityEntry;
  readonly expiresAt: number;
}

export interface ConnectorCapabilitySource {
  inspectCapabilities(scope: ConnectorScope, signal: AbortSignal): ReturnType<ConnectorRuntime["inspectCapabilities"]>;
  openCapability(scope: ConnectorScope, identity: ConnectorCapabilityIdentity, signal: AbortSignal): ReturnType<ConnectorRuntime["openCapability"]>;
  releaseCapabilityHandle(scope: ConnectorScope, handle: string): void;
}

const compactText = (value: string, maxCharacters: number) => {
  const characters = Array.from(value.replace(/\s+/gu, " ").trim());
  return characters.length <= maxCharacters ? characters.join("") : `${characters.slice(0, maxCharacters - 1).join("")}…`;
};

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const compareEntries = (left: ConnectorCapabilityEntry, right: ConnectorCapabilityEntry) =>
  compareText(left.connectorTitle, right.connectorTitle)
  || compareText(left.connectorId, right.connectorId)
  || compareText(left.name, right.name)
  || compareText(left.identity.contributionId, right.identity.contributionId);

const searchScore = (entry: ConnectorCapabilityEntry, query: string): number | null => {
  if (!query) return 0;
  const name = entry.name.toLowerCase();
  const connector = `${entry.connectorTitle} ${entry.connectorId}`.toLowerCase();
  const description = entry.description.toLowerCase();
  const tokens = query.split(/\s+/u).filter(Boolean);
  if (!tokens.every(token => name.includes(token) || connector.includes(token) || description.includes(token))) return null;
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (connector.includes(query)) return 3;
  return 4;
};

function validateSchema(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) throw new ConnectorError("tool-schema-too-large");
    if (Array.isArray(current)) for (const item of current) visit(item, depth + 1);
    else if (current && typeof current === "object") for (const item of Object.values(current)) visit(item, depth + 1);
  };
  visit(value, 0);
  if (bytes(value) > SCHEMA_BYTE_BUDGET) throw new ConnectorError("tool-schema-too-large");
}

/**
 * Engine-neutral progressive disclosure for Connector tools. It owns no
 * credentials, selections, transports, approvals or invocation execution.
 */
export class ConnectorCapabilityRuntime {
  private readonly cursors = new Map<string, CursorState>();
  private readonly toolRefs = new Map<string, ToolRefState>();

  constructor(private readonly source: ConnectorCapabilitySource) {}

  async search(scope: ConnectorScope, request: ConnectorCapabilitySearchRequest, signal: AbortSignal): Promise<ConnectorCapabilitySearchPage> {
    const limit = request.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ConnectorError("invalid-input");
    this.prune();
    let state: CursorState;
    if (request.cursor !== undefined) {
      if (typeof request.cursor !== "string" || request.cursor.length === 0 || request.query !== undefined || request.connectorId !== undefined) throw new ConnectorError("invalid-input");
      const current = this.cursors.get(request.cursor);
      if (!current || current.scope !== scopeKey(scope)) throw new ConnectorError("stale-cursor");
      const view = await this.source.inspectCapabilities(scope, signal);
      if (view.revision !== current.revision) throw new ConnectorError("stale-cursor");
      state = current;
    } else {
      const query = request.query?.trim().toLowerCase() ?? "";
      const connectorId = request.connectorId?.trim();
      if (query.length > 256 || (connectorId !== undefined && (!connectorId || connectorId.length > 256))) throw new ConnectorError("invalid-input");
      const view = await this.source.inspectCapabilities(scope, signal);
      const ranked = view.entries
        .filter(entry => connectorId === undefined || entry.connectorId === connectorId)
        .map(entry => ({ entry, score: searchScore(entry, query) }))
        .filter((row): row is { entry: ConnectorCapabilityEntry; score: number } => row.score !== null)
        .sort((left, right) => left.score - right.score || compareEntries(left.entry, right.entry))
        .map(row => row.entry);
      state = { scope: scopeKey(scope), revision: view.revision, entries: ranked, offset: 0, expiresAt: Date.now() + STATE_TTL_MS };
    }
    return this.page(state, limit);
  }

  async detail(scope: ConnectorScope, refs: readonly string[], signal: AbortSignal): Promise<{ readonly revision: string; readonly items: readonly ConnectorCapabilityDetail[] }> {
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > MAX_DETAIL_ITEMS || new Set(refs).size !== refs.length) throw new ConnectorError("invalid-input");
    this.prune();
    const view = await this.source.inspectCapabilities(scope, signal);
    const states = refs.map(ref => {
      if (typeof ref !== "string" || !ref) throw new ConnectorError("invalid-input");
      const state = this.toolRefs.get(ref);
      if (!state || state.scope !== scopeKey(scope) || state.revision !== view.revision) throw new ConnectorError("stale-handle");
      validateSchema(state.entry.inputSchema);
      return { ref, state };
    });
    const projected = states.map(({ ref, state }) => ({
      toolRef: ref,
      connectorId: state.entry.connectorId,
      connectorTitle: state.entry.connectorTitle,
      name: state.entry.name,
      description: state.entry.description,
      readOnly: state.entry.readOnly,
      inputSchema: state.entry.inputSchema,
      handle: "00000000-0000-4000-8000-000000000000",
    }));
    if (bytes({ revision: view.revision, items: projected }) > DETAIL_BYTE_BUDGET) throw new ConnectorError("discovery-budget-exhausted");
    const items: ConnectorCapabilityDetail[] = [];
    try {
      for (const { ref, state } of states) {
        const opened = await this.source.openCapability(scope, state.entry.identity, signal);
        items.push({
          toolRef: ref,
          connectorId: state.entry.connectorId,
          connectorTitle: state.entry.connectorTitle,
          name: opened.name,
          description: opened.description,
          readOnly: opened.readOnly,
          inputSchema: opened.inputSchema,
          handle: opened.handle,
        });
      }
    } catch (error) {
      for (const item of items) this.source.releaseCapabilityHandle(scope, item.handle);
      throw error;
    }
    return { revision: view.revision, items };
  }

  releaseScope(scope: ConnectorScope): void {
    const key = scopeKey(scope);
    for (const [id, state] of this.cursors) if (state.scope === key) this.cursors.delete(id);
    for (const [id, state] of this.toolRefs) if (state.scope === key) this.toolRefs.delete(id);
  }

  dispose(): void {
    this.cursors.clear();
    this.toolRefs.clear();
  }

  private page(state: CursorState, limit: number): ConnectorCapabilitySearchPage {
    const items: ConnectorCapabilitySummary[] = [];
    let offset = state.offset;
    while (offset < state.entries.length && items.length < limit) {
      const entry = state.entries[offset]!;
      const toolRef = crypto.randomUUID();
      const item: ConnectorCapabilitySummary = {
        toolRef,
        connectorId: entry.connectorId,
        connectorTitle: compactText(entry.connectorTitle, 128),
        name: entry.name,
        description: compactText(entry.description, 512),
        readOnly: entry.readOnly,
      };
      if (bytes({ revision: state.revision, items: [...items, item], nextCursor: "cursor" }) > PAGE_BYTE_BUDGET) {
        if (items.length === 0) throw new ConnectorError("discovery-budget-exhausted");
        break;
      }
      this.toolRefs.set(toolRef, { scope: state.scope, revision: state.revision, entry, expiresAt: Date.now() + STATE_TTL_MS });
      items.push(item);
      offset++;
    }
    let nextCursor: string | null = null;
    if (offset < state.entries.length) {
      nextCursor = crypto.randomUUID();
      this.cursors.set(nextCursor, { ...state, offset, expiresAt: Date.now() + STATE_TTL_MS });
    }
    this.trim(this.cursors);
    this.trim(this.toolRefs);
    return { revision: state.revision, items, nextCursor };
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, state] of this.cursors) if (state.expiresAt <= now) this.cursors.delete(id);
    for (const [id, state] of this.toolRefs) if (state.expiresAt <= now) this.toolRefs.delete(id);
  }

  private trim<T>(map: Map<string, T>): void {
    while (map.size > MAX_STATE) map.delete(map.keys().next().value!);
  }
}
