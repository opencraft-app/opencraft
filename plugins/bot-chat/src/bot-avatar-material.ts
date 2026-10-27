export interface BotAvatarMaterial {
  readonly base: string;
  readonly highlight: string;
  readonly shadow: string;
}

/** Stable identity material. Activity state is deliberately not an input. */
export function createBotAvatarMaterial(base: string): BotAvatarMaterial {
  return Object.freeze({
    base,
    highlight: `color-mix(in srgb, ${base} 76%, var(--color-text, white))`,
    shadow: `color-mix(in srgb, ${base} 82%, var(--color-background-primary))`,
  });
}
