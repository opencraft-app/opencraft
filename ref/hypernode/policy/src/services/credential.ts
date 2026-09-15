import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  CodexCredentialIdentity,
} from "../types/credential.ts";
import type { HostUserRecord } from "../types/host-policy.ts";
import type {
  TransparentTurnCredential,
  TransparentTurnProvider,
} from "../types/transparent-turn-execution.ts";

type Dependencies = "modelGateway" | "userDirectory";

interface ParsedAuth {
  auth_mode?: string;
  tokens?: {
    account_id?: string;
  };
}

interface CredentialIdentitySeed {
  accountIdentity: string;
  authMode: string;
}

function utf8Decode(bytes: ArrayLike<number>): string {
  let result = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++] ?? 0;
    let value: number;
    if (first < 0x80) value = first;
    else if ((first & 0xe0) === 0xc0 && index < bytes.length) {
      value = ((first & 0x1f) << 6) | ((bytes[index++] ?? 0) & 0x3f);
    } else if ((first & 0xf0) === 0xe0 && index + 1 < bytes.length) {
      value = ((first & 0x0f) << 12) | (((bytes[index++] ?? 0) & 0x3f) << 6) |
        ((bytes[index++] ?? 0) & 0x3f);
    } else if ((first & 0xf8) === 0xf0 && index + 2 < bytes.length) {
      value = ((first & 7) << 18) | (((bytes[index++] ?? 0) & 0x3f) << 12) |
        (((bytes[index++] ?? 0) & 0x3f) << 6) | ((bytes[index++] ?? 0) & 0x3f);
    } else value = 0xfffd;
    result += String.fromCodePoint(value);
  }
  return result;
}

function parsedAuth(value: unknown): ParsedAuth | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as ParsedAuth;
}

export function credentialIdentityFromAuth(
  authValue: unknown,
  user: Pick<HostUserRecord, "id" | "codexAuthMode">,
): CredentialIdentitySeed | null {
  const auth = parsedAuth(authValue);
  const accountId = auth?.tokens?.account_id;
  if (auth?.auth_mode === "chatgpt" && typeof accountId === "string" && accountId) {
    return { accountIdentity: `chatgpt:${accountId}`, authMode: "chatgpt" };
  }
  if (auth?.auth_mode === "apikey" || auth?.auth_mode === "apiKey") {
    return { accountIdentity: `api-key:${user.id}`, authMode: "apiKey" };
  }
  if (user.codexAuthMode === "managed") {
    return { accountIdentity: `managed:${user.id}`, authMode: "managed" };
  }
  return null;
}

function providerVisibility(provider: TransparentTurnProvider): string | null {
  const visibility = provider["visibility"];
  return typeof visibility === "string" ? visibility : null;
}

function credentialLoaded(username: string, providerId: string): boolean {
  return globalThis.hostModelGateway?.credentialLoaded?.(username, providerId) === true;
}

export class CredentialService extends Service {
  static inject = [
    "modelGateway",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "credential");
    this.codexFallbackSource = null;
  }

  private codexFallbackSource: {
    ensureActiveForUser(userId: string | null | undefined): unknown;
  } | null;

  attachCodexFallbackSource(source: {
    ensureActiveForUser(userId: string | null | undefined): unknown;
  }): () => void {
    if (!source || typeof source.ensureActiveForUser !== "function") {
      throw new Error("invalid Codex credential fallback source");
    }
    if (this.codexFallbackSource && this.codexFallbackSource !== source) {
      throw new Error("Codex credential fallback source is already attached");
    }
    this.codexFallbackSource = source;
    return () => {
      if (this.codexFallbackSource === source) this.codexFallbackSource = null;
    };
  }

  resolve(connection: AppServerConnection): TransparentTurnCredential | null {
    return this.resolveUser(connection.identity?.id);
  }

  resolveCodexUser(userId: string | undefined): CodexCredentialIdentity | null {
    const user = userId ? this.ctx.userDirectory.find(userId) : null;
    if (!user) return null;
    let identity = this.readCodexIdentity(user);
    if (!identity && this.codexFallbackSource?.ensureActiveForUser(user.id)) {
      identity = this.readCodexIdentity(user);
    }
    if (!identity) return null;
    return {
      ...identity,
      userId: user.id,
      username: user.username,
      installationId: user.installationId ?? null,
      credentialRef: user.codexCredentialRef ?? null,
      providerId: null,
    };
  }

  private readCodexIdentity(user: HostUserRecord): CredentialIdentitySeed | null {
    try {
      return credentialIdentityFromAuth(
        JSON.parse(utf8Decode(hostIdentity.readCodexAuth(user.username))),
        user,
      );
    } catch {
      return null;
    }
  }

  resolveProvider(
    userId: string | undefined,
    provider: TransparentTurnProvider,
  ): TransparentTurnCredential | null {
    const user = userId ? this.ctx.userDirectory.find(userId) : null;
    const providerId = provider.providerId ?? provider.id ?? null;
    if (!user || !providerId || !credentialLoaded(user.username, providerId)) return null;
    return {
      accountIdentity: providerVisibility(provider) === "public"
        ? `model-provider:public:${providerId}`
        : `model-provider:${user.id}:${providerId}`,
      authMode: "apiKey",
      userId: user.id,
      username: user.username,
      installationId: user.installationId ?? null,
      credentialRef: null,
      providerId,
    };
  }

  resolveUser(userId: string | undefined): TransparentTurnCredential | null {
    const user = userId ? this.ctx.userDirectory.find(userId) : null;
    if (!user) return null;
    const provider = this.ctx.modelGateway.activeForUser(userId);
    if (provider) {
      const providerId = provider.providerId ?? provider.id ?? null;
      if (!providerId) return null;
      let loaded = credentialLoaded(user.username, providerId);
      if (!loaded && providerVisibility(provider) === "public") {
        this.ctx.modelGateway.ensureRuntimeProvider(user.id, providerId);
        loaded = credentialLoaded(user.username, providerId);
      }
      if (!loaded) return null;
      return {
        accountIdentity: providerVisibility(provider) === "public"
          ? `model-provider:public:${providerId}`
          : `model-provider:${user.id}:${providerId}`,
        authMode: "apiKey",
        userId: user.id,
        username: user.username,
        installationId: user.installationId ?? null,
        credentialRef: null,
        providerId,
      };
    }
    return this.resolveCodexUser(userId);
  }
}
