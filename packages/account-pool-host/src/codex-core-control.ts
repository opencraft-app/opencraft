import { CodexAccountOperationError, parseAccountFailure } from "./account-diagnostics.js";
import { request } from "node:http";
import { Readable } from 'node:stream';
import { isAbsolute } from "node:path";
import type { createCodexAccountPoolLaunch } from "./codex-launch.js";

export const CODEX_CORE_PROTOCOL_VERSION = 1;
export interface CodexCoreHealth {
  readonly threadTitleToolVersion?: 1;
  readonly protocolVersion: typeof CODEX_CORE_PROTOCOL_VERSION;
  readonly pid: number;
  readonly codexPid: number;
  readonly nativeSocket: string;
  /** Present only when a separate runtime owner is configured. */
  readonly appServerPid?: number;
  readonly environmentVariablesVersion?: 1;
  /** Strict private Gateway placement admission. */
  readonly workspaceExecutionVersion?: 1;
  readonly callbackProtocolVersion?: 1;
  readonly callbackIncarnation?: string;
  readonly pendingCallbacks?: number;
  readonly pendingOrchestrationMutations?: number;
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

/** Temporary control-plane outage; callers may wait before starting execution. */
export class CodexCoreUnavailableError extends Error { override name = "CodexCoreUnavailableError"; }
class CodexCoreHttpError extends Error {
  constructor(readonly status: number, message: string) { super(`Codex core request failed: ${message}`); }
}

/** The owner is alive but its configured executor cannot execute work. */
export class CodexExecutionUnavailableError extends CodexCoreUnavailableError {
  constructor(readonly executionStatus: "pending" | "disconnected" | "unknown") { super("Execution environment unavailable"); }
}

/** Local authenticated control plane. Requests are never retried: mutations may have committed. */
export class CodexCoreControlClient {
  private healthFlight: { operation: Promise<CodexCoreHealth>; controller: AbortController;
    readers: number; settled: boolean; observation: "execution" | "native" } | null = null;
  constructor(private readonly endpoint: string, private readonly authToken: string) {
    if (!isAbsolute(endpoint)) throw new Error("Codex core endpoint must be an absolute Unix socket path");
    if (!authToken) throw new Error("Codex core requires the daemon authentication token");
  }

  /** Streams one private subscription call through the existing authenticated
   * Unix socket. The account proxy remains the credential and quota owner. */
  async subscriptionRequest(input:Request):Promise<Response> {
    const path=new URL(input.url).pathname;
    if(!/^\/personal\/[a-f0-9]{64}\/v1\/(responses|models)$/.test(path))throw Error('Invalid subscription route');
    return new Promise((resolve,reject)=>{
      const headers:Record<string,string>={authorization:'Bearer '+this.authToken,
        'x-opencraft-subscription-token':input.headers.get('authorization')?.replace(/^Bearer /,'')??''};
      if(input.headers.has('content-type'))headers['content-type']=input.headers.get('content-type')!;
      const outgoing=request({socketPath:this.endpoint,path,method:input.method,headers,signal:input.signal},incoming=>{
        const responseHeaders=new Headers();
        for(const [key,value]of Object.entries(incoming.headers))if(value!==undefined&&!['connection','transfer-encoding','keep-alive'].includes(key))responseHeaders.set(key,Array.isArray(value)?value.join(', '):value);
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>,{status:incoming.statusCode??502,headers:responseHeaders}));
      });
      outgoing.on('error',reject);
      if(input.body)Readable.fromWeb(input.body as import('node:stream/web').ReadableStream).on('error',error=>outgoing.destroy(error)).pipe(outgoing);
      else outgoing.end();
    });
  }

  async health(signal?: AbortSignal, observation: "execution" | "native" = "execution"): Promise<CodexCoreHealth> {
    const cancelled = () => signal?.reason instanceof Error ? signal.reason
      : new CodexCoreUnavailableError("Codex core is temporarily unavailable");
    if (signal?.aborted) throw cancelled();
    let flight = this.healthFlight;
    if (flight?.observation !== observation) flight = null;
    if (!flight) {
      const controller = new AbortController();
      flight = { operation: this.readHealth(controller.signal, observation === "native" ? "/native-health" : "/health"), controller, readers: 0, settled: false, observation };
      this.healthFlight = flight;
      const current = flight;
      const retire = () => {
        current.settled = true;
        if (this.healthFlight === current) this.healthFlight = null;
      };
      void current.operation.then(retire, retire);
    }
    const current = flight;
    current.readers++;
    // A recovery burst needs one live health observation, not one recursive
    // Core -> AppServer probe for each browser/read slot. No completed result is cached.
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", abort);
        current.readers--;
        if (!current.settled && current.readers === 0) {
          if (this.healthFlight === current) this.healthFlight = null;
          current.controller.abort();
        }
        return true;
      };
      const abort = () => { if (release()) reject(cancelled()); };
      signal?.addEventListener("abort", abort, { once: true });
      void current.operation.then(value => { if (release()) resolve({ ...value }); },
        error => { if (release()) reject(error); });
      if (signal?.aborted) abort();
    });
  }

  private async readHealth(signal: AbortSignal, path = "/health"): Promise<CodexCoreHealth> {
    let value: Partial<CodexCoreHealth> | null;
    try { value = await this.request("GET", path, undefined, signal) as Partial<CodexCoreHealth> | null; }
    catch (error) {
      if (path !== "/native-health" || signal.aborted || !(error instanceof CodexCoreUnavailableError || error instanceof CodexCoreHttpError && error.status === 404)) throw error;
      return this.readHealth(signal);
    }
    if (path === "/native-health" && (!value || value.protocolVersion !== CODEX_CORE_PROTOCOL_VERSION
      || !Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.codexPid) || typeof value.nativeSocket !== "string" || !isAbsolute(value.nativeSocket))) {
      // Some older control facades return a generic successful response for unknown routes.
      return this.readHealth(signal);
    }
    if (!value || value.protocolVersion !== CODEX_CORE_PROTOCOL_VERSION
      || !Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.codexPid)
      || (value.appServerPid !== undefined && (!Number.isSafeInteger(value.appServerPid) || value.appServerPid < 1))
      || value.threadTitleToolVersion !== undefined && value.threadTitleToolVersion !== 1
      || value.callbackIncarnation !== undefined && (typeof value.callbackIncarnation !== "string" || !value.callbackIncarnation)
      || value.callbackProtocolVersion !== undefined && (value.callbackProtocolVersion !== 1 || !Number.isSafeInteger(value.pendingCallbacks) || value.pendingCallbacks! < 0
        || !Number.isSafeInteger(value.pendingOrchestrationMutations) || value.pendingOrchestrationMutations! < 0)
      || typeof value.nativeSocket !== "string" || !isAbsolute(value.nativeSocket)
      // Multi-generation routing (Generation Router) was removed. A routed owner
      // would require per-generation HOME and execution identity; fail closed.
      || Object.hasOwn(value, "routingEpoch")) {
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

  /** Synthetic broker auth only; real account credentials remain in Core. */
  async brokerAuth(): Promise<{ accessToken: string; chatgptAccountId: string }> {
    const { auth } = (await this.appServerLaunch()).launch;
    if (auth.chatgptAccountId !== 'opencraft-account-pool') throw new Error('Core did not provide broker authentication');
    return { accessToken: auth.accessToken, chatgptAccountId: auth.chatgptAccountId };
  }

  async appServerHealth(observation: "execution" | "native" = "execution"): Promise<CodexAppServerHealth> {
    const value = await this.health(undefined, observation) as CodexAppServerHealth;
    if (!isAbsolute(value.dataDirectory ?? "") || typeof value.proxyBaseUrl !== "string") {
      throw new Error("Incompatible Codex AppServer owner");
    }
    return value;
  }

  private request(method: string, path: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const req = request({ socketPath: this.endpoint, method, path,
        headers: { authorization: `Bearer ${this.authToken}`, "content-type": "application/json" },
        signal: AbortSignal.any([AbortSignal.timeout(["/health", "/native-health", "/launch"].includes(path) ? 5_000 : 120_000), ...(signal ? [signal] : [])]),
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
            if (path === "/accounts" && res.statusCode !== 200) {
              const diagnostic = parseAccountFailure(value?.diagnostic);
              if (diagnostic) throw new CodexAccountOperationError(diagnostic);
            }
            if (res.statusCode === 503) {
              if (value?.code === "EXECUTION_ENVIRONMENT_UNAVAILABLE") throw new CodexExecutionUnavailableError(
                value.executionStatus === "pending" || value.executionStatus === "disconnected" ? value.executionStatus : "unknown");
              throw new CodexCoreUnavailableError("Codex core is temporarily unavailable");
            }
            if (res.statusCode !== 200) throw new CodexCoreHttpError(res.statusCode ?? 0, typeof value?.error === "string" ? value.error : `HTTP ${res.statusCode}`);
            resolve(value);
          } catch (error) { reject(error instanceof CodexCoreUnavailableError || error instanceof CodexAccountOperationError || error instanceof CodexCoreHttpError ? error
            : new Error(`Codex core request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
        });
      });
      req.on("error", error => reject(new CodexCoreUnavailableError(`Codex core unavailable at ${this.endpoint}: ${error.message}`, { cause: error })));
      req.end(body);
    });
  }
}
