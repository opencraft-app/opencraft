import { request } from "node:http";
import { isAbsolute } from "node:path";
import type { createCodexAccountPoolLaunch } from "./codex-launch.js";

export const CODEX_CORE_PROTOCOL_VERSION = 1;
export interface CodexCoreHealth {
  readonly protocolVersion: typeof CODEX_CORE_PROTOCOL_VERSION;
  readonly pid: number;
  readonly codexPid: number;
  readonly nativeSocket: string;
  /** Present only when a separate runtime owner is configured. */
  readonly appServerPid?: number;
  readonly routingPid?: number;
  readonly routingEpoch?: string;
  readonly generationId?: string;
  readonly admissionEpoch?: number;
}

export interface CodexAppServerLaunch {
  readonly dataDirectory: string;
  readonly launch: ReturnType<typeof createCodexAccountPoolLaunch>;
}

export interface CodexAppServerHealth extends CodexCoreHealth {
  readonly dataDirectory: string;
  readonly proxyBaseUrl: string;
  readonly runtimeDataDirectory?: string;
  readonly codexHome?: string;
}

export interface CodexGenerationHostUsage {
  readonly routingEpoch: string;
  readonly lease: string;
  readonly sequence: number;
  readonly blockedThreadIds: readonly string[];
  readonly unscopedBusy: boolean;
  readonly discoveryComplete: boolean;
  readonly acknowledgedFenceEpoch: number;
}

export interface CodexGenerationFenceState {
  readonly routingEpoch: string;
  readonly fenceEpoch: number;
  readonly fencedGenerationIds: readonly string[];
  readonly legacyGenerationId: string | null;
  readonly defaultGenerationId: string | null;
  readonly routes?: readonly { threadId: string; generationId: string }[];
}

/** Trusted native-storage locations, owned by the routing registry, without file contents. */
export interface CodexGenerationDirectory {
  readonly protocolVersion: typeof CODEX_CORE_PROTOCOL_VERSION;
  readonly routingEpoch: string;
  readonly admissionEpoch: number;
  readonly homes: readonly { generationId: string; codexHome: string; incarnation: number }[];
  readonly route: { threadId: string; generationId: string } | null;
}

/** Temporary control-plane outage; callers may wait before starting execution. */
export class CodexCoreUnavailableError extends Error {}

/** Local authenticated control plane. Requests are never retried: mutations may have committed. */
export class CodexCoreControlClient {
  constructor(private readonly endpoint: string, private readonly authToken: string) {
    if (!isAbsolute(endpoint)) throw new Error("Codex core endpoint must be an absolute Unix socket path");
    if (!authToken) throw new Error("Codex core requires the daemon authentication token");
  }

  async health(signal?: AbortSignal): Promise<CodexCoreHealth> {
    const value = await this.request("GET", "/health", undefined, signal) as Partial<CodexCoreHealth> | null;
    if (!value || value.protocolVersion !== CODEX_CORE_PROTOCOL_VERSION
      || !Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.codexPid)
      || (value.appServerPid !== undefined && (!Number.isSafeInteger(value.appServerPid) || value.appServerPid < 1))
      || typeof value.nativeSocket !== "string" || !isAbsolute(value.nativeSocket)) {
      throw new Error("Codex core returned an incompatible health response");
    }
    return value as CodexCoreHealth;
  }

  accountRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/accounts", { method, params });
  }

  /** Private, synthetic broker credentials only; never returned by the gateway. */
  async appServerLaunch(signal?: AbortSignal): Promise<CodexAppServerLaunch> {
    const value = await this.request("GET", "/launch", undefined, signal) as CodexAppServerLaunch;
    if (!value || !isAbsolute(value.dataDirectory ?? "") || !value.launch
      || !Array.isArray(value.launch.args) || !value.launch.args.every(arg => typeof arg === "string")
      || typeof value.launch.env?.OPENCRAFT_CODEX_POOL_AUTH_TOKEN !== "string"
      || value.launch.auth?.type !== "chatgptAuthTokens"
      || typeof value.launch.auth.accessToken !== "string") throw new Error("Invalid Codex AppServer launch configuration");
    return value;
  }

  async appServerHealth(): Promise<CodexAppServerHealth> {
    const value = await this.health() as CodexAppServerHealth;
    if (!isAbsolute(value.dataDirectory ?? "") || typeof value.proxyBaseUrl !== "string") {
      throw new Error("Incompatible Codex AppServer owner");
    }
    return value;
  }

  async claimGenerationHost(instanceId: string, routingEpoch: string, signal?: AbortSignal): Promise<{ lease: string; routingEpoch: string }> {
    const value = await this.request("POST", "/generation-host", { operation: "claim", params: { instanceId, routingEpoch } }, signal) as { lease: string; routingEpoch: string };
    if (!value || typeof value.lease !== "string" || value.routingEpoch !== routingEpoch) throw new Error("Invalid generation Host lease");
    return value;
  }
  publishGenerationHost(value: CodexGenerationHostUsage, signal?: AbortSignal): Promise<CodexGenerationFenceState> {
    return this.request("POST", "/generation-host", { operation: "state", params: value }, signal) as Promise<CodexGenerationFenceState>;
  }

  /** A read never claims the Host lease or starts a retired native HOME. Legacy owners return null. */
  async generationDirectory(threadId?: string, signal?: AbortSignal): Promise<CodexGenerationDirectory | null> {
    const health = await this.health(signal);
    if (!health.routingEpoch) return null;
    const path = "/generation-directory" + (threadId === undefined ? "" : `?threadId=${encodeURIComponent(threadId)}`);
    const value = await this.request("GET", path, undefined, signal) as CodexGenerationDirectory | null;
    if (value?.routingEpoch !== health.routingEpoch) throw new CodexCoreUnavailableError("Codex routing owner changed during directory read");
    if (value.protocolVersion !== CODEX_CORE_PROTOCOL_VERSION || !Number.isSafeInteger(value.admissionEpoch) || value.admissionEpoch < 1
      || !Array.isArray(value.homes) || !value.homes.every(home => home && typeof home.generationId === "string"
        && typeof home.codexHome === "string" && isAbsolute(home.codexHome) && Number.isSafeInteger(home.incarnation) && home.incarnation >= 0)
      || new Set(value.homes.map(home => home.generationId)).size !== value.homes.length
      || new Set(value.homes.map(home => home.codexHome)).size !== value.homes.length
      || (value.route !== null && (!value.route || value.route.threadId !== threadId || !value.homes.some(home => home.generationId === value.route!.generationId)))) {
      throw new Error("Incompatible Codex generation directory");
    }
    return value;
  }

  private request(method: string, path: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const req = request({ socketPath: this.endpoint, method, path,
        headers: { authorization: `Bearer ${this.authToken}`, "content-type": "application/json" },
        signal: AbortSignal.any([AbortSignal.timeout(path === "/health" || path === "/launch" ? 5_000 : 120_000), ...(signal ? [signal] : [])]),
      }, res => {
        let response = "";
        res.on("error", reject);
        res.on("data", chunk => {
          response += String(chunk);
          if (Buffer.byteLength(response) > 4 * 1024 * 1024) req.destroy(new Error("Codex core response too large"));
        });
        res.on("end", () => {
          try {
            const value = JSON.parse(response);
            if (res.statusCode === 503) throw new CodexCoreUnavailableError("Codex core is temporarily unavailable");
            if (res.statusCode !== 200) throw new Error(typeof value?.error === "string" ? value.error : `HTTP ${res.statusCode}`);
            resolve(value);
          } catch (error) { reject(error instanceof CodexCoreUnavailableError ? error
            : new Error(`Codex core request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
        });
      });
      req.on("error", error => reject(new CodexCoreUnavailableError(`Codex core unavailable at ${this.endpoint}: ${error.message}`, { cause: error })));
      req.end(body);
    });
  }
}
