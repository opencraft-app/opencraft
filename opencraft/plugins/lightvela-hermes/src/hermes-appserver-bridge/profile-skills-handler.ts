import {
  type ProfileSkillAction,
  type ProfileSkillActionKind,
  type ProfileSkillCatalogEntry,
  type ProfileSkillInstalled,
  type ProfileSkillScope,
  type ProfileSkillsActionResult,
  type ProfileSkillsCatalogOfficialListResult,
  type ProfileSkillsCatalogPreviewResult,
  type ProfileSkillsCatalogScanResult,
  type ProfileSkillsCatalogSearchResult,
  type ProfileSkillsCatalogSourcesListResult,
  type ProfileSkillsContentReadResult,
  type ProfileSkillsEnabledSetResult,
  type ProfileSkillsErrorCode,
  type ProfileSkillsEvent,
  type ProfileSkillsInstalledListResult,
  type ProfileSkillsMethod,
  type ProfileSkillsMethodParams,
  type ProfileSkillsMethodResult,
  isProfileSkillScope,
} from "@opencraft/appserver-protocol";
import type { TatHttpVirtualClient } from "../lib/tat-http-virtual-client";

type JsonHttpClient = Pick<TatHttpVirtualClient, "fetchJson" | "close">;

export interface ProfileSkillsJournalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface PersistedAction {
  readonly providerActionName: string;
  readonly fingerprint: string;
  readonly action: ProfileSkillAction;
  readonly invalidationPublished: boolean;
}

interface PersistedOperation {
  readonly fingerprint: string;
  readonly result: unknown;
}

interface JournalDocument {
  readonly version: 1;
  readonly actions: Readonly<Record<string, PersistedAction>>;
  readonly operations: Readonly<Record<string, PersistedOperation>>;
}

interface HermesActionReceipt {
  readonly ok?: boolean;
  readonly name?: string;
}

interface HermesActionStatus {
  readonly name?: string;
  readonly running?: boolean;
  readonly exit_code?: number | null;
  readonly lines?: readonly unknown[];
}

const POLL_INTERVAL_MS = 1_200;
const MAX_JOURNAL_OPERATIONS = 256;
const DEFAULT_MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_LOG_LINES = 500;
const CURSOR_PREFIX = "profile-skills:";

const record = (value: unknown): Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const optionalText = (value: unknown) => typeof value === "string" && value !== "" ? value : undefined;
const finiteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const stringList = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === "string")
  : [];

const clone = <T>(value: T): T => structuredClone(value);

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function opaqueRevision(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `skills-v1-${hash.toString(16).padStart(8, "0")}`;
}

function cursorOffset(cursor: unknown): number {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor !== "string" || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new ProfileSkillsDomainError("INVALID_IDENTIFIER", "Invalid Profile Skills cursor", false);
  }
  const value = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProfileSkillsDomainError("INVALID_IDENTIFIER", "Invalid Profile Skills cursor", false);
  }
  return value;
}

function slicePage<T>(items: readonly T[], cursor: unknown, limit: unknown) {
  const offset = cursorOffset(cursor);
  const size = typeof limit === "number" && Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), DEFAULT_MAX_PAGE_SIZE)
    : DEFAULT_MAX_PAGE_SIZE;
  return {
    data: items.slice(offset, offset + size),
    nextCursor: offset + size < items.length ? `${CURSOR_PREFIX}${offset + size}` : null,
  };
}

function normalizeScope(value: unknown): ProfileSkillScope {
  if (!isProfileSkillScope(value)) {
    throw new ProfileSkillsDomainError("PROFILE_NOT_FOUND", "Profile Skills requires an explicit Profile scope", false);
  }
  return { type: "profile", profileId: value.profileId.trim() };
}

function profileQuery(scope: ProfileSkillScope): string {
  return `profile=${encodeURIComponent(scope.profileId)}`;
}

function installedSkill(value: unknown, catalogIdentifier?: string): ProfileSkillInstalled | null {
  const row = record(value);
  const name = text(row.name).trim();
  if (name === "") return null;
  const rawProvenance = text(row.provenance);
  const provenance: ProfileSkillInstalled["provenance"] = rawProvenance === "bundled"
    ? "bundled"
    : rawProvenance === "hub"
      ? "catalog"
      : rawProvenance === "agent"
        ? "local"
        : "unknown";
  return {
    name,
    description: text(row.description),
    category: text(row.category, "general"),
    enabled: row.enabled !== false,
    provenance,
    ...(finiteNumber(row.usage) === undefined ? {} : { usageCount: finiteNumber(row.usage) }),
    ...(catalogIdentifier === undefined ? {} : { catalogIdentifier }),
  };
}

function installedCatalogState(value: unknown) {
  const row = record(value);
  const name = optionalText(row.name);
  const trustLevel = optionalText(row.trust_level);
  const scanVerdict = optionalText(row.scan_verdict);
  return name === undefined && trustLevel === undefined && scanVerdict === undefined
    ? undefined
    : { ...(name === undefined ? {} : { name }), ...(trustLevel === undefined ? {} : { trustLevel }), ...(scanVerdict === undefined ? {} : { scanVerdict }) };
}

function catalogEntry(value: unknown, installed?: unknown, defaultSource = "official"): ProfileSkillCatalogEntry | null {
  const row = record(value);
  const identifier = text(row.identifier).trim();
  const name = text(row.name).trim();
  if (identifier === "" || name === "") return null;
  const trustLevel = optionalText(row.trust_level);
  const repositoryUrl = optionalText(row.repo);
  const installedState = typeof installed === "boolean"
    ? installed ? { name } : undefined
    : installedCatalogState(installed);
  return {
    identifier,
    name,
    description: text(row.description),
    source: text(row.source, defaultSource),
    ...(trustLevel === undefined ? {} : { trustLevel }),
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    tags: stringList(row.tags),
    ...(installedState === undefined ? {} : { installed: installedState }),
  };
}

function sanitizeLines(value: unknown, maximum = DEFAULT_MAX_LOG_LINES): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-maximum).map((line) => String(line).slice(0, 4_000));
}

function emptyJournal(): JournalDocument {
  return { version: 1, actions: {}, operations: {} };
}

function parseJournal(raw: string | null): JournalDocument {
  if (raw === null) return emptyJournal();
  try {
    const parsed = record(JSON.parse(raw));
    if (parsed.version !== 1) return emptyJournal();
    return {
      version: 1,
      actions: record(parsed.actions) as Readonly<Record<string, PersistedAction>>,
      operations: record(parsed.operations) as Readonly<Record<string, PersistedOperation>>,
    };
  } catch {
    return emptyJournal();
  }
}

export class ProfileSkillsDomainError extends Error {
  readonly rpcCode = -32061;
  readonly domainData: {
    readonly domain: "profile-skills";
    readonly code: ProfileSkillsErrorCode;
    readonly retryable: boolean;
    readonly scope?: ProfileSkillScope;
    readonly actionId?: string;
    readonly operationId?: string;
    readonly currentRevision?: string;
  };

  constructor(
    code: ProfileSkillsErrorCode,
    message: string,
    retryable: boolean,
    details: Omit<ProfileSkillsDomainError["domainData"], "domain" | "code" | "retryable"> = {},
  ) {
    super(message);
    this.name = "ProfileSkillsDomainError";
    this.domainData = { domain: "profile-skills", code, retryable, ...details };
  }
}

/** Profile-scoped projection and Action owner over Hermes Dashboard REST. */
export class HermesDashboardProfileSkillsHandler {
  private client: JsonHttpClient | null = null;
  private sessionToken: string | null = null;
  private journal: JournalDocument;
  private readonly listeners = new Set<(event: ProfileSkillsEvent) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(
    private readonly storageKey: string,
    private readonly storage?: ProfileSkillsJournalStorage,
  ) {
    this.journal = this.readJournal();
  }

  attach(client: JsonHttpClient, sessionToken: string): void {
    if (this.disposed) throw new Error("Profile Skills handler is disposed");
    this.client?.close();
    this.client = client;
    this.sessionToken = sessionToken;
    for (const [actionId, row] of Object.entries(this.journal.actions)) {
      if (
        row.action.state === "accepted"
        || row.action.state === "running"
        || !row.invalidationPublished
      ) this.schedulePoll(actionId, 0);
    }
  }

  detach(): void {
    this.client?.close();
    this.client = null;
    this.sessionToken = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.listeners.clear();
  }

  subscribe(listener: (event: ProfileSkillsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async handle<TMethod extends ProfileSkillsMethod>(
    method: TMethod,
    rawParams: unknown,
  ): Promise<ProfileSkillsMethodResult<TMethod>> {
    const params = record(rawParams);
    const scope = normalizeScope(params.scope);
    try {
      let result: unknown;
      switch (method) {
        case "skills/installed/list": result = await this.listInstalled(scope, params); break;
        case "skills/installed/content/read": result = await this.readContent(scope, text(params.name)); break;
        case "skills/enabled/set": result = await this.setEnabled(scope, params); break;
        case "skills/catalog/sources/list": result = await this.listSources(scope); break;
        case "skills/catalog/official/list": result = await this.listOfficial(scope, params); break;
        case "skills/catalog/search": result = await this.search(scope, params); break;
        case "skills/catalog/preview": result = await this.preview(scope, text(params.identifier)); break;
        case "skills/catalog/scan": result = await this.scan(scope, text(params.identifier)); break;
        case "skills/install": result = await this.spawn(scope, "install", text(params.identifier), params); break;
        case "skills/uninstall": result = await this.spawn(scope, "uninstall", text(params.name), params); break;
        case "skills/update": result = await this.spawn(scope, "update", undefined, params); break;
        case "skills/action/read": result = await this.readAction(scope, text(params.actionId), params); break;
        default: throw new ProfileSkillsDomainError("UNSUPPORTED_OPERATION", `Unsupported Profile Skills method: ${method}`, false, { scope });
      }
      return result as ProfileSkillsMethodResult<TMethod>;
    } catch (error) {
      throw this.translateProviderError(error, method, scope, params);
    }
  }

  private translateProviderError(
    error: unknown,
    method: ProfileSkillsMethod,
    scope: ProfileSkillScope,
    params: Record<string, unknown>,
  ): Error {
    if (error instanceof ProfileSkillsDomainError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    let code: ProfileSkillsErrorCode = "INTERNAL";
    let retryable = false;
    if (/policy|scan.*block|blocked/iu.test(message)) code = "POLICY_BLOCKED";
    else if (/already installed/iu.test(message)) code = "ALREADY_INSTALLED";
    else if (/not installed/iu.test(message)) code = "NOT_INSTALLED";
    else if (/http (502|503|504)|timed out|timeout|transport|closed|unavailable/iu.test(message)) {
      code = "PROVIDER_UNAVAILABLE";
      retryable = true;
    } else if (/http 404/iu.test(message)) {
      code = method === "skills/action/read"
        ? "ACTION_NOT_FOUND"
        : method.startsWith("skills/catalog/") || method === "skills/install"
          ? "CATALOG_ENTRY_NOT_FOUND"
          : normalized.includes("profile")
            ? "PROFILE_NOT_FOUND"
            : "SKILL_NOT_FOUND";
    } else if (/http 409|already running|conflict/iu.test(message)) {
      code = "OPERATION_CONFLICT";
      retryable = true;
    } else if (/http 429|rate.?limit/iu.test(message)) {
      code = "SOURCE_UNAVAILABLE";
      retryable = true;
    }
    return new ProfileSkillsDomainError(code, message, retryable, {
      scope,
      ...(optionalText(params.actionId) === undefined ? {} : { actionId: optionalText(params.actionId) }),
      ...(optionalText(params.operationId) === undefined ? {} : { operationId: optionalText(params.operationId) }),
    });
  }

  private async listInstalled(scope: ProfileSkillScope, params: Record<string, unknown>): Promise<ProfileSkillsInstalledListResult> {
    const [response, sources] = await Promise.all([
      this.get<unknown[]>(`/api/skills?${profileQuery(scope)}`),
      this.get(`/api/skills/hub/sources?${profileQuery(scope)}`).catch(() => null),
    ]);
    const identifiersByName = new Map<string, string | null>();
    for (const [identifier, value] of Object.entries(record(record(sources).installed))) {
      const name = optionalText(record(value).name);
      if (name === undefined) continue;
      identifiersByName.set(name, identifiersByName.has(name) ? null : identifier);
    }
    const all = (Array.isArray(response) ? response : [])
      .map((value) => installedSkill(value, identifiersByName.get(text(record(value).name)) ?? undefined))
      .filter((entry): entry is ProfileSkillInstalled => entry !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
    return { ...slicePage(all, params.cursor, params.limit), revision: opaqueRevision(all) };
  }

  private async readContent(scope: ProfileSkillScope, name: string): Promise<ProfileSkillsContentReadResult> {
    this.requireValue(name, "Skill name", scope);
    const response = record(await this.get(`/api/skills/content?name=${encodeURIComponent(name)}&${profileQuery(scope)}`));
    const content = text(response.content);
    return { name: text(response.name, name), content, revision: opaqueRevision({ name, content }) };
  }

  private async setEnabled(scope: ProfileSkillScope, params: Record<string, unknown>): Promise<ProfileSkillsEnabledSetResult> {
    const name = text(params.name).trim();
    const operationId = text(params.operationId).trim();
    const expectedRevision = text(params.expectedRevision).trim();
    this.requireValue(name, "Skill name", scope);
    this.requireValue(operationId, "operationId", scope);
    this.requireValue(expectedRevision, "expectedRevision", scope);
    if (typeof params.enabled !== "boolean") throw new ProfileSkillsDomainError("INVALID_IDENTIFIER", "enabled must be a boolean", false, { scope, operationId });
    const fingerprint = stableStringify({ method: "skills/enabled/set", scope, name, enabled: params.enabled, expectedRevision });
    const replay = this.replayOperation<ProfileSkillsEnabledSetResult>(scope, operationId, fingerprint);
    if (replay !== null) return replay;
    await this.requireRevision(scope, expectedRevision, operationId);
    await this.post("/api/skills/toggle", { name, enabled: params.enabled, profile: scope.profileId }, "PUT");
    const revision = (await this.listInstalled(scope, {})).revision;
    const result = { name, enabled: params.enabled, revision, operationId };
    this.recordOperation(scope, operationId, fingerprint, result);
    this.emit({ method: "skills/installed/changed", params: { scope, revision, cause: "enablement" } });
    return result;
  }

  private async listSources(scope: ProfileSkillScope): Promise<ProfileSkillsCatalogSourcesListResult> {
    const response = record(await this.get(`/api/skills/hub/sources?${profileQuery(scope)}`));
    const installed = record(response.installed);
    const data = (Array.isArray(response.sources) ? response.sources : []).map((value) => {
      const row = record(value);
      return {
        id: text(row.id),
        label: text(row.label, text(row.id)),
        available: row.available !== false,
        searchable: row.searchable !== false,
        rateLimited: row.rate_limited === true,
      };
    }).filter((source) => source.id !== "");
    const featured = (Array.isArray(response.featured) ? response.featured : [])
      .map((value) => {
        const row = record(value);
        return catalogEntry(value, installed[text(row.identifier)]);
      })
      .filter((entry): entry is ProfileSkillCatalogEntry => entry !== null);
    return { data, indexAvailable: response.index_available === true, featured, revision: opaqueRevision({ data, featured }) };
  }

  private async listOfficial(scope: ProfileSkillScope, params: Record<string, unknown>): Promise<ProfileSkillsCatalogOfficialListResult> {
    const response = record(await this.get(`/api/skills/hub/official?${profileQuery(scope)}`));
    const all = (Array.isArray(response.skills) ? response.skills : [])
      .map((value) => catalogEntry(value, record(value).installed, "official"))
      .filter((entry): entry is ProfileSkillCatalogEntry => entry !== null);
    return { ...slicePage(all, params.cursor, params.limit), revision: opaqueRevision(all) };
  }

  private async search(scope: ProfileSkillScope, params: Record<string, unknown>): Promise<ProfileSkillsCatalogSearchResult> {
    const query = text(params.query).trim();
    const source = text(params.source, "all").trim() || "all";
    const limit = typeof params.limit === "number"
      ? Math.min(Math.max(Math.floor(params.limit), 1), DEFAULT_MAX_PAGE_SIZE)
      : 20;
    if (params.cursor !== undefined && params.cursor !== null) cursorOffset(params.cursor);
    const response = record(await this.get(
      `/api/skills/hub/search?q=${encodeURIComponent(query)}&source=${encodeURIComponent(source)}&limit=${limit}&${profileQuery(scope)}`,
    ));
    const installed = record(response.installed);
    const data = (Array.isArray(response.results) ? response.results : [])
      .map((value) => {
        const row = record(value);
        return catalogEntry(value, installed[text(row.identifier)]);
      })
      .filter((entry): entry is ProfileSkillCatalogEntry => entry !== null);
    const sourceCounts = Object.fromEntries(Object.entries(record(response.source_counts))
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
    return { data, nextCursor: null, sourceCounts, timedOutSources: stringList(response.timed_out) };
  }

  private async preview(scope: ProfileSkillScope, identifier: string): Promise<ProfileSkillsCatalogPreviewResult> {
    this.requireValue(identifier, "Skill identifier", scope);
    const response = record(await this.get(
      `/api/skills/hub/preview?identifier=${encodeURIComponent(identifier)}&${profileQuery(scope)}`,
    ));
    const entry = catalogEntry(response);
    if (entry === null) throw new ProfileSkillsDomainError("CATALOG_ENTRY_NOT_FOUND", `Skill not found: ${identifier}`, false, { scope });
    return { entry, skillMarkdown: text(response.skill_md), files: stringList(response.files) };
  }

  private async scan(scope: ProfileSkillScope, identifier: string): Promise<ProfileSkillsCatalogScanResult> {
    this.requireValue(identifier, "Skill identifier", scope);
    const response = record(await this.get(
      `/api/skills/hub/scan?identifier=${encodeURIComponent(identifier)}&${profileQuery(scope)}`,
    ));
    const rawPolicy = text(response.policy);
    const policy = rawPolicy === "allow" || rawPolicy === "ask" || rawPolicy === "block" ? rawPolicy : "ask";
    return {
      scan: {
        identifier: text(response.identifier, identifier),
        name: text(response.name),
        source: text(response.source),
        trustLevel: text(response.trust_level),
        verdict: text(response.verdict),
        summary: text(response.summary),
        policy,
        ...(optionalText(response.policy_reason) === undefined ? {} : { policyReason: optionalText(response.policy_reason) }),
        findings: (Array.isArray(response.findings) ? response.findings : []).map((value) => {
          const row = record(value);
          return {
            severity: text(row.severity),
            category: text(row.category),
            file: text(row.file),
            ...(finiteNumber(row.line) === undefined ? {} : { line: finiteNumber(row.line) }),
            description: text(row.description),
          };
        }),
        severityCounts: Object.fromEntries(Object.entries(record(response.severity_counts))
          .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))),
      },
    };
  }

  private async spawn(
    scope: ProfileSkillScope,
    kind: ProfileSkillActionKind,
    target: string | undefined,
    params: Record<string, unknown>,
  ): Promise<ProfileSkillsActionResult> {
    const operationId = text(params.operationId).trim();
    this.requireValue(operationId, "operationId", scope);
    if (kind !== "update") this.requireValue(target ?? "", kind === "install" ? "Skill identifier" : "Skill name", scope);
    const expectedRevision = optionalText(params.expectedRevision)?.trim();
    const fingerprint = stableStringify({ method: `skills/${kind}`, scope, target, expectedRevision });
    const replay = this.replayOperation<ProfileSkillsActionResult>(scope, operationId, fingerprint);
    if (replay !== null) return replay;
    if (expectedRevision !== undefined) await this.requireRevision(scope, expectedRevision, operationId);
    const conflicting = Object.values(this.journal.actions).find((row) => (
      row.action.scope.profileId === scope.profileId
      && row.action.kind === kind
      && row.action.target === target
      && (row.action.state === "accepted" || row.action.state === "running")
    ));
    if (conflicting !== undefined) {
      throw new ProfileSkillsDomainError("OPERATION_CONFLICT", `A ${kind} action is already running for this target`, true, {
        scope,
        operationId,
        actionId: conflicting.action.actionId,
      });
    }
    const path = kind === "install"
      ? "/api/skills/hub/install"
      : kind === "uninstall"
        ? "/api/skills/hub/uninstall"
        : "/api/skills/hub/update";
    const body = kind === "install"
      ? { identifier: target, profile: scope.profileId }
      : kind === "uninstall"
        ? { name: target, profile: scope.profileId }
        : { profile: scope.profileId };
    const receipt = record(await this.post<HermesActionReceipt>(path, body));
    const providerActionName = text(receipt.name).trim();
    if (providerActionName === "") throw new ProfileSkillsDomainError("INTERNAL", "Hermes did not return an Action identity", true, { scope, operationId });
    const actionId = `skills-action-${crypto.randomUUID()}`;
    const action: ProfileSkillAction = {
      actionId,
      operationId,
      scope,
      kind,
      ...(target === undefined ? {} : { target }),
      state: "accepted",
      startedAtMs: Date.now(),
      logLines: [],
    };
    const result = { action };
    this.writeAction(actionId, { providerActionName, fingerprint, action, invalidationPublished: false });
    this.recordOperation(scope, operationId, fingerprint, result);
    this.emit({ method: "skills/action/updated", params: { action } });
    this.schedulePoll(actionId, 0);
    return clone(result);
  }

  private async readAction(
    scope: ProfileSkillScope,
    actionId: string,
    params: Record<string, unknown>,
  ): Promise<ProfileSkillsActionResult> {
    const row = this.journal.actions[actionId];
    if (row === undefined || row.action.scope.profileId !== scope.profileId) {
      throw new ProfileSkillsDomainError("ACTION_NOT_FOUND", `Profile Skills Action not found: ${actionId}`, false, { scope, actionId });
    }
    if (row.action.state === "accepted" || row.action.state === "running") {
      await this.pollAction(actionId, typeof params.maxLogLines === "number" ? params.maxLogLines : undefined, false);
    }
    return { action: clone(this.journal.actions[actionId]!.action) };
  }

  private async pollAction(actionId: string, requestedLines?: number, reschedule = true): Promise<void> {
    const row = this.journal.actions[actionId];
    if (row === undefined) return;
    if (row.action.state === "succeeded" || row.action.state === "failed" || row.action.state === "cancelled") {
      if (!row.invalidationPublished) await this.publishInstalledInvalidation(actionId, row, reschedule);
      return;
    }
    if (this.client === null) return;
    const maximum = typeof requestedLines === "number"
      ? Math.min(Math.max(Math.floor(requestedLines), 1), DEFAULT_MAX_LOG_LINES)
      : DEFAULT_MAX_LOG_LINES;
    try {
      const status = await this.get<HermesActionStatus>(
        `/api/actions/${encodeURIComponent(row.providerActionName)}/status?lines=${maximum}`,
      );
      const lines = sanitizeLines(status.lines, maximum);
      const running = status.running === true;
      const exitCode = typeof status.exit_code === "number" ? status.exit_code : undefined;
      const state: ProfileSkillAction["state"] = running
        ? "running"
        : exitCode === 0
          ? "succeeded"
          : "failed";
      const terminal = state !== "running";
      const action: ProfileSkillAction = {
        ...row.action,
        state,
        ...(exitCode === undefined ? {} : { exitCode }),
        logLines: lines,
        logCursor: opaqueRevision(lines),
        ...(terminal ? { completedAtMs: Date.now() } : {}),
        ...(state !== "failed" ? {} : {
          error: {
            domain: "profile-skills",
            code: lines.some((line) => /policy|scan.*block|blocked/iu.test(line)) ? "POLICY_BLOCKED" : "INTERNAL",
            retryable: false,
            scope: row.action.scope,
            actionId,
            operationId: row.action.operationId,
          },
        }),
      };
      this.writeAction(actionId, { ...row, action });
      this.emit({ method: "skills/action/updated", params: { action } });
      if (terminal && !row.invalidationPublished) {
        await this.publishInstalledInvalidation(actionId, this.journal.actions[actionId]!, reschedule);
      } else if (running && reschedule) {
        this.schedulePoll(actionId, POLL_INTERVAL_MS);
      }
    } catch {
      // A status read is observational. A transient HTTP/TAT failure never
      // changes an accepted provider Action into a failed mutation.
      if (reschedule && this.client !== null) this.schedulePoll(actionId, POLL_INTERVAL_MS);
    }
  }

  private async publishInstalledInvalidation(
    actionId: string,
    row: PersistedAction,
    reschedule: boolean,
  ): Promise<void> {
    try {
      const revision = (await this.listInstalled(row.action.scope, {})).revision;
      this.writeAction(actionId, { ...row, invalidationPublished: true });
      this.emit({
        method: "skills/installed/changed",
        params: {
          scope: row.action.scope,
          revision,
          cause: row.action.kind,
          actionId,
        },
      });
    } catch {
      if (reschedule && this.client !== null) this.schedulePoll(actionId, POLL_INTERVAL_MS);
    }
  }

  private schedulePoll(actionId: string, delay: number): void {
    const existing = this.timers.get(actionId);
    if (existing !== undefined) clearTimeout(existing);
    if (this.client === null || this.disposed) return;
    const timer = setTimeout(() => {
      this.timers.delete(actionId);
      void this.pollAction(actionId);
    }, delay);
    this.timers.set(actionId, timer);
  }

  private async requireRevision(scope: ProfileSkillScope, expected: string, operationId: string): Promise<void> {
    const current = (await this.listInstalled(scope, {})).revision;
    if (current !== expected) {
      throw new ProfileSkillsDomainError("REVISION_MISMATCH", "Profile Skills changed before this mutation", false, {
        scope,
        operationId,
        currentRevision: current,
      });
    }
  }

  private replayOperation<T>(scope: ProfileSkillScope, operationId: string, fingerprint: string): T | null {
    const key = this.operationKey(scope, operationId);
    const previous = this.journal.operations[key];
    if (previous === undefined) return null;
    if (previous.fingerprint !== fingerprint) {
      throw new ProfileSkillsDomainError("OPERATION_CONFLICT", "operationId was already used for a different Profile Skills command", false, { scope, operationId });
    }
    return clone(previous.result) as T;
  }

  private recordOperation(scope: ProfileSkillScope, operationId: string, fingerprint: string, result: unknown): void {
    const operations = { ...this.journal.operations };
    operations[this.operationKey(scope, operationId)] = { fingerprint, result: clone(result) };
    const keys = Object.keys(operations);
    while (keys.length > MAX_JOURNAL_OPERATIONS) delete operations[keys.shift()!];
    this.journal = { ...this.journal, operations };
    this.persistJournal();
  }

  private writeAction(actionId: string, row: PersistedAction): void {
    this.journal = { ...this.journal, actions: { ...this.journal.actions, [actionId]: clone(row) } };
    this.persistJournal();
  }

  private operationKey(scope: ProfileSkillScope, operationId: string): string {
    return `${scope.profileId}\u0000${operationId}`;
  }

  private requireValue(value: string, label: string, scope: ProfileSkillScope): void {
    if (value.trim() === "") throw new ProfileSkillsDomainError("INVALID_IDENTIFIER", `${label} is required`, false, { scope });
  }

  private http(): { readonly client: JsonHttpClient; readonly token: string } {
    if (this.client === null || this.sessionToken === null) {
      throw new ProfileSkillsDomainError("PROVIDER_UNAVAILABLE", "Hermes Dashboard is not connected", true);
    }
    return { client: this.client, token: this.sessionToken };
  }

  private async get<T>(path: string): Promise<T> {
    const { client, token } = this.http();
    return await client.fetchJson<T>(path, { headers: { "X-Hermes-Session-Token": token } });
  }

  private async post<T = unknown>(path: string, json: unknown, method = "POST"): Promise<T> {
    const { client, token } = this.http();
    return await client.fetchJson<T>(path, {
      method,
      headers: { "X-Hermes-Session-Token": token },
      json,
    });
  }

  private emit(event: ProfileSkillsEvent): void {
    for (const listener of this.listeners) listener(clone(event));
  }

  private readJournal(): JournalDocument {
    try { return parseJournal(this.storage?.getItem(this.storageKey) ?? null); }
    catch { return emptyJournal(); }
  }

  private persistJournal(): void {
    try {
      const actions = Object.fromEntries(Object.entries(this.journal.actions).map(([actionId, row]) => [
        actionId,
        {
          ...row,
          // Provider logs are presentation data and may contain secrets. Only
          // the attachment identity/state needed for reconnect is durable.
          action: { ...row.action, logLines: [], logCursor: undefined },
        },
      ]));
      this.storage?.setItem(this.storageKey, JSON.stringify({ ...this.journal, actions }));
    }
    catch { /* persistence is recovery metadata, never provider truth */ }
  }
}

export function browserProfileSkillsJournalStorage(): ProfileSkillsJournalStorage | undefined {
  try { return globalThis.localStorage; }
  catch { return undefined; }
}
