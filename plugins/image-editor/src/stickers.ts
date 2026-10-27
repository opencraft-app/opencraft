// Small built-in vector stickers render identically without system emoji fonts.
// Coordinates are shared by the picker SVG and the exported canvas pixels.
export const stickers = {
  "😀": [{ color: "#facc15", path: "M16 1A15 15 0 1 1 16 31A15 15 0 1 1 16 1Z" }, { color: "#111827", path: "M9 9H12V13H9ZM20 9H23V13H20ZM7 18H25C24 29 8 29 7 18Z" }, { color: "#ffffff", path: "M9 18H23V21H9Z" }],
  "❤️": [{ color: "#ef4444", path: "M16 29C9 23 1 17 1 10C1 0 12 0 16 7C20 0 31 0 31 10C31 17 23 23 16 29Z" }],
  "👍": [{ color: "#facc15", path: "M12 15L17 3C18 0 22 2 21 6L20 12H27C31 12 32 14 31 17L28 28C28 30 26 31 23 31H12ZM2 15H9V31H2Z" }],
  "⭐": [{ color: "#facc15", path: "M16 1L21 11L32 12L24 20L26 31L16 26L6 31L8 20L0 12L11 11Z" }],
  "✅": [{ color: "#22c55e", path: "M2 2H30V30H2Z" }, { color: "#ffffff", path: "M6 16L10 12L14 17L23 7L27 11L14 25Z" }],
} as const;
export type Sticker = keyof typeof stickers;

const previews = Object.fromEntries((Object.keys(stickers) as Sticker[]).map(value => [value,
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${stickers[value].map(layer => `<path d="${layer.path}" fill="${layer.color}"/>`).join("")}</svg>`)}`,
])) as Record<Sticker, string>;
export const stickerPreview = (value: Sticker): string => previews[value];
