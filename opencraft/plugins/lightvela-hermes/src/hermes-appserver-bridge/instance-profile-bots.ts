import type { AppServerBotDescriptor } from "@opencraft/appserver-protocol";

/** Control-plane identity; the native profile is never derived from a display name. */
export interface HermesInstanceProfileBot {
  readonly botId: string;
  readonly nativeProfile: string;
  readonly name: string;
  readonly description?: string;
  readonly status: AppServerBotDescriptor["status"];
}

/** Stable semantic revision; CTL list timestamps may be recomputed per read. */
export function instanceBotRevision(bot: HermesInstanceProfileBot): number {
  let hash = 2166136261;
  for (const character of JSON.stringify([bot.botId, bot.nativeProfile, bot.name, bot.description ?? "", bot.status])) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (hash >>> 0) + 1;
}

export function parseInstanceProfileBots(payload: unknown, instanceId: string): readonly HermesInstanceProfileBot[] {
  const record = payload as { items?: unknown } | null;
  if (!record || !Array.isArray(record.items)) throw new Error("Invalid instance Bot catalog");
  const botIds = new Set<string>();
  const profiles = new Set<string>();
  return record.items.map((item: unknown) => {
    const value = item as Record<string, unknown> | null;
    const string = (field: string): string => {
      const result = value?.[field];
      if (typeof result !== "string" || !result.trim()) throw new Error(`Invalid instance Bot ${field}`);
      return result;
    };
    if (string("instance_id") !== instanceId) throw new Error("Bot belongs to a different instance");
    const botId = string("bot_id");
    const profileId = string("profile_id");
    const nativeProfile = profileId === "main" ? "default" : profileId;
    if (value?.is_default === true && nativeProfile !== "default") throw new Error("Invalid default Bot profile");
    if (botIds.has(botId) || profiles.has(nativeProfile)) throw new Error("Ambiguous instance Bot identity");
    botIds.add(botId);
    profiles.add(nativeProfile);
    const status = string("status");
    return Object.freeze({
      botId, nativeProfile, name: string("name"),
      ...(typeof value?.description === "string" ? { description: value.description } : {}),
      status: status === "ready" ? "available" : status === "disabled" ? "disabled" : "unavailable",
    });
  });
}

/** Only an explicit native RPC method absence means the runtime capability is absent. */
export function isProfileBotsUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown };
  return value.code === -32601;
}
