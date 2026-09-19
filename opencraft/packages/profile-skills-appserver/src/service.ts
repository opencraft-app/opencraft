import { Context, Service, type Fiber } from "@deepseek-ai/cordis";
import {
  AppServerRpcError,
  type AppServerClientRegistryService,
} from "@opencraft/appserver-client";
import {
  isProfileSkillsEvent,
  OPENCRAFT_PROFILE_SKILLS_EXTENSION,
  type SkillInstallScope,
  type ProfileSkillsCapability,
  type ProfileSkillsEvent,
  type ProfileSkillsMethod,
  type ProfileSkillsMethodParams,
  type ProfileSkillsMethodResult,
} from "@opencraft/appserver-protocol";

export type ProfileSkillsTarget = {
  readonly hostId: string;
  readonly profileId: string;
} | {
  readonly hostId: string;
  readonly scope: SkillInstallScope;
};

export type HostProfileSkillsEvent = ProfileSkillsEvent & { readonly hostId: string };

export class ProfileSkillsServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hostId: string,
    readonly retryable: boolean,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProfileSkillsServiceError";
  }
}

function capabilityFrom(value: unknown): ProfileSkillsCapability | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return (value as Partial<ProfileSkillsCapability>).version === 1
    ? value as ProfileSkillsCapability
    : null;
}

function domainError(error: unknown, hostId: string): ProfileSkillsServiceError {
  if (error instanceof ProfileSkillsServiceError) return error;
  if (error instanceof AppServerRpcError) {
    const data = typeof error.data === "object" && error.data !== null
      ? error.data as { readonly code?: unknown; readonly retryable?: unknown }
      : {};
    return new ProfileSkillsServiceError(
      typeof data.code === "string" ? data.code : "PROFILE_SKILLS_RPC_ERROR",
      error.message,
      hostId,
      data.retryable === true,
      { cause: error },
    );
  }
  return new ProfileSkillsServiceError(
    "PROFILE_SKILLS_TRANSPORT_ERROR",
    error instanceof Error ? error.message : String(error),
    hostId,
    true,
    { cause: error },
  );
}

const scopeFor = (target: ProfileSkillsTarget): SkillInstallScope => {
  if ("scope" in target) return target.scope;
  const normalized = target.profileId.trim();
  if (normalized === "") throw new TypeError("Profile Skills requires a non-empty profileId");
  return { type: "profile", profileId: normalized };
};

/**
 * Renderer-neutral Cordis request/event port for Profile-owned Skills.
 *
 * The service selects a Host client but owns neither its transport nor Skill
 * state. Profile identity is explicit on every wire request.
 */
export class AppServerProfileSkillsService extends Service {
  static inject = ["appServerClients"];

  private readonly clients: AppServerClientRegistryService;
  private readonly listeners = new Set<(event: HostProfileSkillsEvent) => void>();
  private readonly clientSubscriptions = new Map<string, () => void>();
  private readonly stopRegistryEvents: () => void;

  constructor(ctx: Context) {
    super(ctx, "profileSkills");
    this.clients = ctx.appServerClients;
    for (const client of this.clients.getAll()) this.observeClient(client.hostId);
    this.stopRegistryEvents = this.clients.subscribeEvent((event) => {
      if (event.type === "added") this.observeClient(event.hostId);
      else if (event.type === "removed") this.unobserveClient(event.hostId);
    });
    ctx.effect(() => () => this.disposeOwnedResources());
  }

  capability(hostId: string): ProfileSkillsCapability | null {
    const extensions = this.clients.get(hostId)?.initializeResult?.capabilities?.extensions;
    return capabilityFrom(extensions?.[OPENCRAFT_PROFILE_SKILLS_EXTENSION]);
  }

  supports(hostId: string): boolean {
    return this.capability(hostId) !== null;
  }

  /** Views can mount before Host initialize; capability readiness owns that race. */
  waitForCapability(
    hostId: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<ProfileSkillsCapability> {
    const immediate = this.capability(hostId);
    if (immediate !== null) return Promise.resolve(immediate);
    const timeoutMs = options.timeoutMs ?? 20_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      let stopStatus: () => void = () => undefined;
      let stopRegistry: () => void = () => undefined;
      let poll: ReturnType<typeof globalThis.setTimeout> | null = null;
      const cleanup = () => {
        stopStatus();
        stopRegistry();
        if (poll !== null) globalThis.clearTimeout(poll);
        globalThis.clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      };
      const fail = (code: string, message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new ProfileSkillsServiceError(code, message, hostId, true));
      };
      const check = () => {
        if (settled) return;
        const capability = this.capability(hostId);
        if (capability !== null) {
          settled = true;
          cleanup();
          resolve(capability);
          return;
        }
        if (poll !== null) globalThis.clearTimeout(poll);
        poll = globalThis.setTimeout(check, 50);
      };
      const observe = () => {
        stopStatus();
        const client = this.clients.get(hostId);
        stopStatus = client === null ? () => undefined : client.subscribeStatus(check);
        check();
      };
      const abort = () => fail("PROFILE_SKILLS_ACTIVATION_ABORTED", `Profile Skills activation for Host ${hostId} was aborted`);
      const timeout = globalThis.setTimeout(() => fail(
        "PROFILE_SKILLS_EXTENSION_UNAVAILABLE",
        `Host ${hostId} did not advertise ${OPENCRAFT_PROFILE_SKILLS_EXTENSION} version 1`,
      ), timeoutMs);
      stopRegistry = this.clients.subscribeEvent((event) => {
        if (event.hostId === hostId) observe();
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      else observe();
    });
  }

  subscribe(listener: (event: HostProfileSkillsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request<TMethod extends ProfileSkillsMethod>(
    hostId: string,
    method: TMethod,
    params: ProfileSkillsMethodParams<TMethod>,
  ): Promise<ProfileSkillsMethodResult<TMethod>> {
    if (!this.supports(hostId)) {
      return Promise.reject(new ProfileSkillsServiceError(
        "PROFILE_SKILLS_EXTENSION_UNAVAILABLE",
        `Host ${hostId} does not advertise ${OPENCRAFT_PROFILE_SKILLS_EXTENSION} version 1`,
        hostId,
        false,
      ));
    }
    return this.clients.getOrThrow(hostId).request(method, params).catch((error: unknown) => {
      throw domainError(error, hostId);
    });
  }

  listInstalled(target: ProfileSkillsTarget, options: Omit<ProfileSkillsMethodParams<"skills/installed/list">, "scope"> = {}) {
    return this.request(target.hostId, "skills/installed/list", {
      scope: scopeFor(target),
      ...options,
    });
  }

  readContent(target: ProfileSkillsTarget, name: string) {
    return this.request(target.hostId, "skills/installed/content/read", {
      scope: scopeFor(target),
      name,
    });
  }

  setEnabled(
    target: ProfileSkillsTarget,
    params: Omit<ProfileSkillsMethodParams<"skills/enabled/set">, "scope">,
  ) {
    return this.request(target.hostId, "skills/enabled/set", {
      scope: scopeFor(target),
      ...params,
    });
  }

  listCatalogSources(target: ProfileSkillsTarget) {
    return this.request(target.hostId, "skills/catalog/sources/list", { scope: scopeFor(target) });
  }

  listOfficial(
    target: ProfileSkillsTarget,
    options: Omit<ProfileSkillsMethodParams<"skills/catalog/official/list">, "scope"> = {},
  ) {
    return this.request(target.hostId, "skills/catalog/official/list", {
      scope: scopeFor(target),
      ...options,
    });
  }

  searchCatalog(
    target: ProfileSkillsTarget,
    params: Omit<ProfileSkillsMethodParams<"skills/catalog/search">, "scope">,
  ) {
    return this.request(target.hostId, "skills/catalog/search", {
      scope: scopeFor(target),
      ...params,
    });
  }

  preview(target: ProfileSkillsTarget, identifier: string) {
    return this.request(target.hostId, "skills/catalog/preview", {
      scope: scopeFor(target),
      identifier,
    });
  }

  scan(target: ProfileSkillsTarget, identifier: string) {
    return this.request(target.hostId, "skills/catalog/scan", {
      scope: scopeFor(target),
      identifier,
    });
  }

  install(
    target: ProfileSkillsTarget,
    params: Omit<ProfileSkillsMethodParams<"skills/install">, "scope">,
  ) {
    return this.request(target.hostId, "skills/install", {
      scope: scopeFor(target),
      ...params,
    });
  }

  uninstall(
    target: ProfileSkillsTarget,
    params: Omit<ProfileSkillsMethodParams<"skills/uninstall">, "scope">,
  ) {
    return this.request(target.hostId, "skills/uninstall", {
      scope: scopeFor(target),
      ...params,
    });
  }

  update(
    target: ProfileSkillsTarget,
    params: Omit<ProfileSkillsMethodParams<"skills/update">, "scope">,
  ) {
    return this.request(target.hostId, "skills/update", {
      scope: scopeFor(target),
      ...params,
    });
  }

  readAction(
    target: ProfileSkillsTarget,
    params: Omit<ProfileSkillsMethodParams<"skills/action/read">, "scope">,
  ) {
    return this.request(target.hostId, "skills/action/read", {
      scope: scopeFor(target),
      ...params,
    });
  }

  private observeClient(hostId: string): void {
    if (this.clientSubscriptions.has(hostId)) return;
    const client = this.clients.get(hostId);
    if (client === null) return;
    this.clientSubscriptions.set(hostId, client.subscribeNotification((notification) => {
      if (!isProfileSkillsEvent(notification)) return;
      const event = { ...notification, hostId } as HostProfileSkillsEvent;
      for (const listener of this.listeners) listener(event);
    }));
  }

  private unobserveClient(hostId: string): void {
    this.clientSubscriptions.get(hostId)?.();
    this.clientSubscriptions.delete(hostId);
  }

  private disposeOwnedResources(): void {
    this.stopRegistryEvents();
    for (const stop of this.clientSubscriptions.values()) stop();
    this.clientSubscriptions.clear();
    this.listeners.clear();
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    profileSkills: AppServerProfileSkillsService;
  }
}

export interface CordisProfileSkillsRuntime {
  readonly context: Context;
  readonly fiber: Fiber;
  readonly service: AppServerProfileSkillsService;
  dispose(): Promise<void>;
}

export async function createCordisProfileSkillsRuntime(context: Context): Promise<CordisProfileSkillsRuntime> {
  const fiber = context.plugin(AppServerProfileSkillsService);
  await fiber;
  return {
    context,
    fiber,
    service: context.profileSkills,
    dispose: () => fiber.dispose(),
  };
}
