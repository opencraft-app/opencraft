import { combineAbortSignals } from "@opencraft/appserver-client/transport";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { ASSETS_MANIFEST, createAssetsExtension, e2bAssetProvider } from "./index.js";
import type { AssetsAccount } from "./ports.js";

const STATUS_PATH = "/__opencraft_assets/status";
/** Resource-account projection only. Login, Actor identity, credentials and
 * permission checks remain with the existing host. A stale scope grants nothing. */
export class ServerAssetsAccount implements AssetsAccount {
  private scope: string | null = null;
  private available = false;
  private gitHosts: readonly string[] = [];
  private closed = false;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  constructor(private readonly fetcher: typeof fetch) {}
  getScope = () => this.scope;
  getAvailable = () => this.available;
  getGitHosts = () => this.gitHosts;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  refresh = async () => {
    const generation = ++this.generation;
    const request = combineAbortSignals([this.abort.signal, AbortSignal.timeout(5000)]);
    try {
      const response = await this.fetcher(STATUS_PATH, {
        credentials: "same-origin",
        cache: "no-store",
        signal: request.signal,
      });
      let gitHosts: readonly string[] = [];
      let scope: string | null,
        available = false;
      if (
        response.status === 404 ||
        response.status === 401 ||
        response.status === 403 ||
        (response.ok && !response.headers.get("content-type")?.includes("application/json"))
      )
        scope = null;
      else {
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
          throw Error("assets_unavailable");
        const input = (await response.json()) as { version?: unknown; scope?: unknown; gitHosts?: unknown };
        if (
          !input ||
          input.version !== 1 ||
          (input.scope !== null &&
            (typeof input.scope !== "string" ||
              !input.scope.startsWith("actor:human://") ||
              input.scope.length > 256 ||
              /[\x00-\x1f\x7f]/u.test(input.scope)))
        )
          throw Error("assets_unavailable");
        if (
          input.gitHosts !== undefined &&
          (!Array.isArray(input.gitHosts) ||
            input.gitHosts.some((h) => typeof h !== "string" || !/^[a-z0-9.-]{1,253}$/u.test(h)))
        )
          throw Error("assets_unavailable");
        gitHosts = Array.isArray(input.gitHosts) ? [...new Set(input.gitHosts as string[])] : [];
        scope = input.scope as string | null;
        available = true;
      }
      if (this.closed || generation !== this.generation) return;
      const changed = this.scope !== scope;
      this.gitHosts = gitHosts;
      this.scope = scope;
      this.available = available;
      if (changed) for (const listener of this.listeners) listener();
    } finally {
      request.dispose();
    }
  };
  dispose() {
    this.closed = true;
    ++this.generation;
    this.abort.abort();
    this.listeners.clear();
  }
}
/** Capability discovery is performed during activation, never during preload.
 * Private/anonymous hosts without the implemented route advertise no menu. */
export function createServerAssetsExtension(
  fetcher: typeof fetch,
  events: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = typeof window === "undefined"
    ? undefined
    : window,
): TrustedExtensionDefinition {
  return {
    manifest: ASSETS_MANIFEST,
    async activate(api) {
      const account = new ServerAssetsAccount(fetcher);
      let disposed = false;
      const refresh = () => {
        void account.refresh().catch(() => {
          /* Retain drafts on transient failure; the server still gates every request. */
        });
      };
      api.subscriptions.add(() => {
        disposed = true;
        account.dispose();
        for (const event of ["focus", "pageshow", "online"]) events?.removeEventListener(event, refresh);
      });
      await account.refresh();
      if (disposed || !account.getAvailable()) return;
      for (const event of ["focus", "pageshow", "online"]) events?.addEventListener(event, refresh);
      const github = account.getGitHosts().includes("github.com") ? await import("./git/client.js") : null;
      if (disposed) return;
      return createAssetsExtension({
        account,
        fetcher,
        endpoint: "/__opencraft_assets/configurations",
        providers: [e2bAssetProvider, ...(github ? [github.githubAssetProvider] : [])],
        useConnections: github
          ? (scope, onUnauthorized) => github.useGithubAssetConnections(fetcher, scope, onUnauthorized)
          : undefined,
      }).activate(api);
    },
  };
}
