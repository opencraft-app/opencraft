import { request } from "node:http";
import { isAbsolute } from "node:path";

export const CODEX_CORE_PROTOCOL_VERSION = 1;
export interface CodexCoreHealth {
  readonly protocolVersion: typeof CODEX_CORE_PROTOCOL_VERSION;
  readonly pid: number;
  readonly codexPid: number;
  readonly nativeSocket: string;
}

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
      || typeof value.nativeSocket !== "string" || !isAbsolute(value.nativeSocket)) {
      throw new Error("Codex core returned an incompatible health response");
    }
    return value as CodexCoreHealth;
  }

  accountRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/accounts", { method, params });
  }

  private request(method: string, path: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const req = request({ socketPath: this.endpoint, method, path,
        headers: { authorization: `Bearer ${this.authToken}`, "content-type": "application/json" },
        signal: AbortSignal.any([AbortSignal.timeout(path === "/health" ? 5_000 : 120_000), ...(signal ? [signal] : [])]),
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
            if (res.statusCode !== 200) throw new Error(typeof value?.error === "string" ? value.error : `HTTP ${res.statusCode}`);
            resolve(value);
          } catch (error) { reject(new Error(`Codex core request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
        });
      });
      req.on("error", error => reject(new Error(`Codex core unavailable at ${this.endpoint}: ${error.message}`, { cause: error })));
      req.end(body);
    });
  }
}
