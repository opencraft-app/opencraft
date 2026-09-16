import { botIdentityKey, createBotIdentity, type BotIdentity } from "./bot-identity";
import { normalizeBotLifecycle, type BotLifecycle } from "./bot-lifecycle";

export interface BotCatalogSourceRecord {
  readonly id: string;
  readonly instanceId?: string;
  readonly profileId?: string;
  readonly isDefault?: boolean;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface BotCatalogEntry<T extends BotCatalogSourceRecord = BotCatalogSourceRecord> {
  readonly key: string;
  readonly identity: BotIdentity;
  readonly lifecycle: BotLifecycle;
  readonly source: T;
}

export function projectBotCatalog<T extends BotCatalogSourceRecord>(records: readonly T[]): readonly BotCatalogEntry<T>[] {
  const byIdentity = new Map<string, BotCatalogEntry<T>>();
  for (const source of records) {
    const identity = createBotIdentity({
      botId: source.id,
      instanceId: source.instanceId,
      profileId: source.profileId,
      isDefault: source.isDefault,
    });
    const key = botIdentityKey(identity);
    if (byIdentity.has(key)) continue;
    byIdentity.set(key, Object.freeze({key, identity, lifecycle: normalizeBotLifecycle(source.status), source}));
  }
  return Object.freeze([...byIdentity.values()]);
}

export function resolveSelectedBotKey(
  entries: readonly BotCatalogEntry[],
  input: { readonly requestedKey?: string | null; readonly currentKey?: string | null },
): string | null {
  const available = new Set(entries.map((entry) => entry.key));
  const requested = input.requestedKey?.trim();
  if (requested && available.has(requested)) return requested;
  const current = input.currentKey?.trim();
  if (current && available.has(current)) return current;
  return entries[0]?.key ?? null;
}
