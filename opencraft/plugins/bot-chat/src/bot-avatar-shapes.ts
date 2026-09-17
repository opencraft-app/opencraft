export const BOT_AVATAR_SHAPE_NAMES = [
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "wedge",
  "hex",
  "gem",
  "crystal",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf",
] as const;

export type BotAvatarShapeName = (typeof BOT_AVATAR_SHAPE_NAMES)[number];
