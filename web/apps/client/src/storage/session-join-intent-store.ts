interface SessionStorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface JoinIntentEnvelope {
  expiresAt: number;
  schemaVersion: 1;
  token: string;
}

const intentTTL = 30 * 60_000;

export class SessionJoinIntentStore {
  private static readonly storageKey = "raft.client.join-intent.v1";

  public constructor(private readonly storage: SessionStorageLike) {}

  public capture(fragment: string, now = Date.now()): boolean {
    if (!fragment.startsWith("#")) return false;
    const parameters = new URLSearchParams(fragment.slice(1));
    const token = parameters.get("token")?.trim();
    if (!token || !validJoinToken(token)) return false;
    this.storage.setItem(
      SessionJoinIntentStore.storageKey,
      JSON.stringify({
        expiresAt: now + intentTTL,
        schemaVersion: 1,
        token,
      } satisfies JoinIntentEnvelope),
    );
    return true;
  }

  public clear(): void {
    this.storage.removeItem(SessionJoinIntentStore.storageKey);
  }

  public load(now = Date.now()): string | null {
    const raw = this.storage.getItem(SessionJoinIntentStore.storageKey);
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isJoinIntentEnvelope(value) || now >= value.expiresAt) {
        this.clear();
        return null;
      }
      return value.token;
    } catch {
      this.clear();
      return null;
    }
  }
}

function isJoinIntentEnvelope(value: unknown): value is JoinIntentEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.expiresAt === "number" &&
    Number.isSafeInteger(candidate.expiresAt) &&
    typeof candidate.token === "string" &&
    validJoinToken(candidate.token)
  );
}

function validJoinToken(token: string): boolean {
  return token.startsWith("rfi_") && token.length >= 20;
}
