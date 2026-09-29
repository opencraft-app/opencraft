export interface BotIdentity {
  readonly botId: string;
  readonly instanceId: string;
  readonly profileId: string;
  readonly isDefault: boolean;
  readonly legacy: boolean;
}

export interface BotIdentityInput {
  readonly botId: string;
  readonly instanceId?: string;
  readonly profileId?: string;
  readonly isDefault?: boolean;
}

const requiredId = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new RangeError(`${field} must not be empty`);
  return normalized;
};

export function createBotIdentity(input: BotIdentityInput): BotIdentity {
  const botId = requiredId(input.botId, "botId");
  const instanceId = requiredId(input.instanceId ?? botId, "instanceId");
  const profileId = requiredId(input.profileId ?? "main", "profileId");
  const legacy = botId === instanceId && profileId === "main";
  return Object.freeze({
    botId,
    instanceId,
    profileId,
    isDefault: input.isDefault ?? legacy,
    legacy,
  });
}

export function sameBotInstance(left: BotIdentity, right: BotIdentity): boolean {
  return left.instanceId === right.instanceId;
}

const identityPart = (value: string): string => `${value.length}:${value}`;

/** Stable within one account/environment catalog; callers add environment scope outside this core slice. */
export function botIdentityKey(identity: BotIdentity): string {
  return [identity.instanceId, identity.botId, identity.profileId]
    .map(identityPart)
    .join("|");
}
