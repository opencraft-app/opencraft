/**
 * Production Pi owner adapter. It opens the *existing* pi-durable session
 * implementation (`PiDurableSession`), not a Pi RPC child and not a second
 * transcript writer. One bridge-owned Thread maps to one pi-durable SQLite
 * file, guarded by that owner's lockfile. Bridge metadata lives beside it so a
 * restarted generation can resume the same native session only through
 * `session/resume`; `session/create` never adopts an existing file.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { PiDurableSession, createPiModels } from "@opencraft/plugin-pi-engine/session";
import { projectPiSnapshot, tokenUsage } from "@opencraft/plugin-pi-engine/projection";
import type { PiModelInfo, PiModelRef, PiOwnerCreate, PiOwnerFactory, PiOwnerPort, PiProjectedSnapshot } from "./types.js";

interface SessionMetadata {
  readonly version: 1;
  readonly routeId: string;
  readonly ownerThreadId: string;
  readonly nativeSessionId: string;
  readonly file: string;
  readonly cwd: string;
  readonly model: PiModelRef;
  readonly thinkingLevel: string;
  readonly baseInstructions?: string;
  readonly developerInstructions?: string;
  readonly createdAtMs: number;
  readonly closedAtMs?: number;
}

export interface DurablePiOwnerFactoryOptions {
  readonly dataDir: string;
  readonly agentDirectory: string;
  readonly modelPolicyPath?: string;
  readonly now?: () => number;
  /** Test-only fast lock contention; production keeps the native default. */
  readonly lockRetries?: number;
}

function parseModel(value: string | PiModelRef): PiModelRef {
  if (typeof value !== "string") {
    if (!value || typeof value.provider !== "string" || typeof value.modelId !== "string" || !value.provider || !value.modelId) {
      throw new Error("Pi model must be pi:provider:model, provider/model, or {provider,modelId}");
    }
    return { provider: value.provider, modelId: value.modelId };
  }
  const prefixed = /^pi:([^:]+):(.+)$/u.exec(value);
  if (prefixed) return { provider: decodeURIComponent(prefixed[1]!), modelId: decodeURIComponent(prefixed[2]!) };
  const slash = /^([^/]+)\/(.+)$/u.exec(value);
  if (slash) return { provider: slash[1]!, modelId: slash[2]! };
  throw new Error("Pi model must be pi:provider:model, provider/model, or {provider,modelId}");
}

function piModelId(model: PiModelRef): string {
  return `pi:${encodeURIComponent(model.provider)}:${encodeURIComponent(model.modelId)}`;
}

function ownerThreadId(routeId: string): string {
  return `pi_bridge_${createHash("sha256").update(routeId).digest("hex").slice(0, 24)}`;
}

function normalizeThinking(model: Value, requested: string | undefined): string {
  const supported = getSupportedThinkingLevels(model as never) as readonly string[];
  const level = requested === "none" ? "off" : requested;
  if (typeof level === "string" && supported.includes(level)) return level;
  if (requested !== undefined) throw new Error(`Pi model does not support reasoning effort ${requested}`);
  return supported.includes("medium") ? "medium" : supported[0] ?? "off";
}

type Value = Record<string, any>;

class DurablePiOwner implements PiOwnerPort {
  private listener?: (snapshot: PiProjectedSnapshot) => void;
  private exitListener?: (error: Error) => void;
  constructor(
    readonly info: PiOwnerCreate,
    private readonly session: PiDurableSession,
    private readonly contextWindow: number | null,
  ) {}

  private project(raw: Awaited<ReturnType<PiDurableSession["snapshot"]>>): PiProjectedSnapshot {
    const turns = projectPiSnapshot({ id: this.info.ownerThreadId, cwd: this.info.cwd, tools: [] }, raw);
    const submissions = new Map<string, { status: "queued" | "placed" | "done" | "unanswered"; entry?: number; reason?: string }>();
    for (const record of raw.submissions) {
      if (record.type !== "input" || !record.requestId) continue;
      submissions.set(record.requestId, {
        status: record.status,
        ...(record.entry === undefined ? {} : { entry: record.entry }),
        ...(record.reason === undefined ? {} : { reason: record.reason }),
      });
    }
    const active = [...turns].reverse().find(turn => turn.status === "inProgress");
    return {
      turns,
      submissions,
      activeTurnId: active === undefined ? null : String(active.id),
      usage: tokenUsage(raw, this.contextWindow) as PiProjectedSnapshot["usage"],
    };
  }

  async snapshot(): Promise<PiProjectedSnapshot> {
    return this.project(await this.session.snapshot());
  }

  async submit(content: readonly Record<string, unknown>[], data: Record<string, unknown>, requestId: string): Promise<void> {
    await this.session.submit([...content], data, requestId);
  }

  async steer(content: readonly Record<string, unknown>[], data: Record<string, unknown>, requestId: string, expectedTurnId: string): Promise<void> {
    await this.session.steer([...content], data, requestId, expectedTurnId);
  }

  execution(requestId: string): Promise<"running" | "completed" | "failed" | null> {
    return this.session.execution(requestId);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  close(): Promise<void> {
    return this.session.close();
  }

  setSnapshotListener(listener: (snapshot: PiProjectedSnapshot) => void): void {
    this.listener = listener;
  }

  setExitListener(listener: (error: Error) => void): void {
    this.exitListener = listener;
  }

  onSnapshot(raw: Awaited<ReturnType<PiDurableSession["snapshot"]>>): void {
    if (this.listener) this.listener(this.project(raw));
  }

  onExit(error: Error): void {
    this.exitListener?.(error);
  }
}

export class DurablePiOwnerFactory implements PiOwnerFactory {
  private readonly dataDir: string;
  private readonly agentDirectory: string;
  private readonly sessionsDir: string;
  private readonly metadata = new Map<string, SessionMetadata>();
  private readonly modelsRuntime: ReturnType<typeof createPiModels>;
  private readonly now: () => number;

  constructor(private readonly options: DurablePiOwnerFactoryOptions) {
    if (!isAbsolute(options.dataDir) || !isAbsolute(options.agentDirectory)) {
      throw new Error("Pi bridge dataDir and agentDirectory must be absolute");
    }
    this.dataDir = resolve(options.dataDir);
    this.agentDirectory = resolve(options.agentDirectory);
    this.sessionsDir = join(this.dataDir, "sessions");
    this.now = options.now ?? (() => Date.now());
    this.modelsRuntime = createPiModels(this.agentDirectory);
  }

  async models(): Promise<readonly PiModelInfo[]> {
    const available = (await this.modelsRuntime).getAvailableSnapshot();
    return available.map((model: Value) => {
      const ref = { provider: String(model.provider), modelId: String(model.id) };
      const levels = getSupportedThinkingLevels(model as never) as readonly string[];
      return {
        id: piModelId(ref),
        provider: ref.provider,
        modelId: ref.modelId,
        displayName: typeof model.name === "string" ? model.name : ref.modelId,
        contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : null,
        inputModalities: Array.isArray(model.input) ? model.input : ["text"],
        supportedReasoningEfforts: levels,
        defaultReasoningEffort: levels.includes("medium") ? "medium" : levels[0] ?? "off",
        cost: model.cost ?? null,
      };
    });
  }

  private async model(ref: PiModelRef): Promise<{ model: Value; contextWindow: number | null; thinkingLevel: string } | null> {
    const runtime = await this.modelsRuntime;
    const found = runtime.getAvailableSnapshot().find((candidate: Value) =>
      candidate.provider === ref.provider && candidate.id === ref.modelId);
    if (!found) return null;
    return {
      model: found,
      contextWindow: typeof found.contextWindow === "number" ? found.contextWindow : null,
      thinkingLevel: normalizeThinking(found, undefined),
    };
  }

  async create(input: {
    readonly routeId: string;
    readonly cwd: string;
    readonly model: string | PiModelRef;
    readonly thinkingLevel?: string;
    readonly baseInstructions?: string;
    readonly developerInstructions?: string;
  }): Promise<PiOwnerPort> {
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    const cwd = resolve(input.cwd);
    const info = await stat(cwd).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error("Pi bridge cwd must be an existing absolute directory");
    const ref = parseModel(input.model);
    const resolved = await this.model(ref);
    if (!resolved) throw new Error(`Pi model is unavailable: ${piModelId(ref)}`);
    const thinkingLevel = input.thinkingLevel === undefined
      ? resolved.thinkingLevel
      : normalizeThinking(resolved.model, input.thinkingLevel);
    const ownerId = ownerThreadId(input.routeId);
    const file = join(this.sessionsDir, `${ownerId}.sqlite`);
    const metaFile = join(this.sessionsDir, `${ownerId}.json`);
    const existing = await readFile(metaFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing !== null) throw new Error("Bridge-owned Pi session already exists; use session/resume");
    const nativeExists = await stat(file).then(() => true).catch(() => false);
    if (nativeExists) throw new Error("Orphaned native Pi session needs explicit recovery; create refused");
    const create: PiOwnerCreate = {
      routeId: input.routeId,
      ownerThreadId: ownerId,
      nativeSessionId: `pi_bridge_${randomUUID()}`,
      cwd,
      model: ref,
      thinkingLevel,
      ...(input.baseInstructions === undefined ? {} : { baseInstructions: input.baseInstructions }),
      ...(input.developerInstructions === undefined ? {} : { developerInstructions: input.developerInstructions }),
    };
    const owner = await this.open(create, file);
    const metadata: SessionMetadata = {
      version: 1,
      routeId: create.routeId,
      ownerThreadId: ownerId,
      nativeSessionId: create.nativeSessionId,
      file,
      cwd,
      model: ref,
      thinkingLevel,
      ...(input.baseInstructions === undefined ? {} : { baseInstructions: input.baseInstructions }),
      ...(input.developerInstructions === undefined ? {} : { developerInstructions: input.developerInstructions }),
      createdAtMs: this.now(),
    };
    try {
      await this.writeMetadata(metaFile, metadata);
    } catch (error) {
      await owner.close().catch(() => {});
      throw error;
    }
    this.metadata.set(input.routeId, metadata);
    return owner;
  }

  async resume(input: { readonly routeId: string }): Promise<PiOwnerPort> {
    const ownerId = ownerThreadId(input.routeId);
    const metaFile = join(this.sessionsDir, `${ownerId}.json`);
    const raw = await readFile(metaFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (raw === null) throw new Error("No bridge-owned Pi session to resume");
    const metadata = JSON.parse(raw) as SessionMetadata;
    if (metadata.version !== 1 || metadata.routeId !== input.routeId || metadata.ownerThreadId !== ownerId) {
      throw new Error("Pi bridge session metadata does not match this thread");
    }
    const file = join(this.sessionsDir, `${ownerId}.sqlite`);
    const native = await stat(file).catch(() => undefined);
    if (!native?.isFile()) throw new Error("Bridge-owned Pi session database is missing; explicit recovery required");
    const create: PiOwnerCreate = {
      routeId: metadata.routeId,
      ownerThreadId: metadata.ownerThreadId,
      nativeSessionId: metadata.nativeSessionId,
      cwd: metadata.cwd,
      model: metadata.model,
      thinkingLevel: metadata.thinkingLevel,
      ...(metadata.baseInstructions === undefined ? {} : { baseInstructions: metadata.baseInstructions }),
      ...(metadata.developerInstructions === undefined ? {} : { developerInstructions: metadata.developerInstructions }),
    };
    const owner = await this.open(create, file);
    this.metadata.set(input.routeId, metadata);
    return owner;
  }

  private async open(info: PiOwnerCreate, file: string): Promise<DurablePiOwner> {
    const models = await this.modelsRuntime;
    const resolved = await this.model(info.model);
    if (!resolved) throw new Error(`Pi model is unavailable: ${piModelId(info.model)}`);
    let holder: DurablePiOwner | undefined;
    const session = await PiDurableSession.open({
      threadId: info.ownerThreadId,
      cwd: info.cwd,
      file,
      agentDirectory: this.agentDirectory,
      models,
      ...(this.options.modelPolicyPath === undefined ? {} : { modelPolicyPath: this.options.modelPolicyPath }),
      shell: false,
      ...(this.options.lockRetries === undefined ? {} : { lockRetries: this.options.lockRetries }),
      tools: [],
      onSnapshot: snapshot => holder?.onSnapshot(snapshot),
      onTool: async () => {
        throw new Error("Pi bridge declares no platform tools");
      },
      onExit: error => holder?.onExit(error),
    });
    holder = new DurablePiOwner(info, session, resolved.contextWindow);
    try {
      await session.configure({
        model: info.model,
        cwd: info.cwd,
        thinkingLevel: info.thinkingLevel,
      });
      await session.instructions(info.baseInstructions, info.developerInstructions);
      return holder;
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
  }

  async close(owner: PiOwnerPort): Promise<void> {
    try {
      await owner.close();
    } finally {
      const metadata = this.metadata.get(owner.info.routeId);
      if (metadata) {
        this.metadata.delete(owner.info.routeId);
        const metaFile = join(this.sessionsDir, `${metadata.ownerThreadId}.json`);
        await this.writeMetadata(metaFile, { ...metadata, closedAtMs: this.now() }).catch(() => {});
      }
    }
  }

  private async writeMetadata(file: string, metadata: SessionMetadata): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(metadata), { mode: 0o600 });
    await rename(temporary, file);
  }
}
