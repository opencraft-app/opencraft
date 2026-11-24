import { combineAbortSignals } from "@opencraft/appserver-client/transport";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { ASSETS_MANIFEST, createAssetsExtension, e2bAssetProvider } from "./index.js";
import type { AssetProvider } from "./providers.js";
import type { AssetConnections, AssetsAccount } from "./ports.js";
import { parseGitProviders, type GitProviderDescriptor } from "./git/contract.js";

const STATUS_PATH = "/__opencraft_assets/status";

/** Trusted product presentation over a Git host advertised by the server. */
export interface ServerAssetsContribution {
  readonly git?: {
    readonly host: string;
    load(fetcher: typeof fetch): Promise<{
      readonly provider: Omit<AssetProvider, "host" | "editor">;
      useConnections(git: AssetConnections, scope: string, onUnauthorized: () => void): AssetConnections;
    }>;
  };
}

/** Resource-account projection only. Login, Actor identity, credentials and
 * permission checks remain with the existing host. A stale scope grants nothing. */
export class ServerAssetsAccount implements AssetsAccount {
  private scope: string | null = null;
  private available = false;
  private gitHosts: readonly string[] = [];
  private gitProviders: readonly GitProviderDescriptor[] = [];
  private environment = false;
  private closed = false;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  constructor(private readonly fetcher: typeof fetch) {}
  getScope = () => this.scope;
  getAvailable = () => this.available;
  getGitHosts = () => this.gitHosts;
  /** Advertised provider metadata; a server without it only offers token hosts. */
  getGitProviders = () => this.gitProviders;
  /** The server serves the signed-in person's ENV settings. */
  getEnvironment = () => this.environment;
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
      let gitProviders: readonly GitProviderDescriptor[] = [];
      let scope: string | null,
        available = false,
        environment = false;
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
        const input = (await response.json()) as {
          version?: unknown;
          scope?: unknown;
          gitHosts?: unknown;
          gitProviders?: unknown;
          environment?: unknown;
        };
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
        if (input.environment !== undefined && input.environment !== true) throw Error("assets_unavailable");
        environment = input.environment === true;
        gitHosts = Array.isArray(input.gitHosts) ? [...new Set(input.gitHosts as string[])] : [];
        try {
          gitProviders =
            input.gitProviders === undefined
              ? gitHosts.map((host) => ({ host, auth: "token" as const }))
              : parseGitProviders(input.gitProviders);
        } catch {
          throw Error("assets_unavailable");
        }
        // Provider metadata describes exactly the advertised hosts, never more.
        if (gitProviders.length !== gitHosts.length || gitProviders.some((p) => !gitHosts.includes(p.host)))
          throw Error("assets_unavailable");
        scope = input.scope as string | null;
        available = true;
      }
      if (this.closed || generation !== this.generation) return;
      const changed = this.scope !== scope;
      this.gitHosts = gitHosts;
      this.gitProviders = gitProviders;
      this.scope = scope;
      this.available = available;
      this.environment = environment;
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
  options?: {
    readonly contribution?: ServerAssetsContribution;
    readonly subscribeIdentity?: (listener: () => void) => () => void;
  },
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
      const unsubscribe = options?.subscribeIdentity?.(refresh);
      if (unsubscribe) api.subscriptions.add(unsubscribe);
      // Registration stays light. The concrete form/controller are only loaded
      // when the host actually mounts this deferred page, not on startup.
      // GitHub's token flow and SSH-key hosts have editors in this client.
      const gitProviders = account.getGitProviders().filter((p) => p.auth === "ssh" || p.host === "github.com");
      const personalEnvironment = account.getEnvironment();
      const contributionGit = options?.contribution?.git;
      return createAssetsExtension(async () => {
        if (disposed) throw Error("Assets extension retired");
        const [git, environment, augmentation] = await Promise.all([
          gitProviders.length ? import("./git/client.js") : null,
          personalEnvironment ? import("./environment.js") : null,
          contributionGit && gitProviders.some(provider => provider.host === contributionGit.host)
            ? contributionGit.load(fetcher)
            : undefined,
        ]);
        if (disposed) throw Error("Assets extension retired");
        const providers = git?.gitAssetProviders(gitProviders) ?? [];
        const useAugmentedConnections = augmentation?.useConnections ?? ((base: AssetConnections) => base);
        return {
          account,
          fetcher,
          endpoint: "/__opencraft_assets/configurations",
          providers: [e2bAssetProvider, ...providers.map(provider => augmentation && provider.host === contributionGit?.host
            ? { ...provider, ...augmentation.provider }
            : provider)],
          useConnections: git
            ? function useConnections(scope, onUnauthorized) {
              const base = git.useGitAssetConnections(fetcher, scope, onUnauthorized, gitProviders);
              return useAugmentedConnections(base, scope, onUnauthorized);
            }
            : undefined,
          ...(environment ? { VariablesEditor: environment.createAssetVariablesEditor(fetcher, account) } : {}),
        };
      }).activate(api);
    },
  };
}
