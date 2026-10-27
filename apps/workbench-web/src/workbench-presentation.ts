export const builtinThemeIds = Object.freeze({
  neutral: "opencraft.core.neutral", canvas: "opencraft.core.canvas",
  frost: "opencraft.core.frost", lavender: "opencraft.core.lavender",
  longing: "opencraft.core.longing",
  mist: "opencraft.core.mist", graphite: "opencraft.core.graphite",
});

/** Exact compatibility aliases only; extension-owned identifiers are opaque. */
export function normalizeBuiltinThemeId(id: string): string {
  switch (id) {
    case "vela.theme-pack.paper": return "opencraft.theme-pack.paper";
    case "vela.core.codex": return builtinThemeIds.neutral;
    case "vela.core.web": return builtinThemeIds.canvas;
    case "vela.core.frost": return builtinThemeIds.frost;
    case "vela.core.lavender": return builtinThemeIds.lavender;
    case "vela.core.mist": return builtinThemeIds.mist;
    case "vela.core.zencode":
    case "opencraft.core.zencode": return builtinThemeIds.graphite;
    default: return id;
  }
}

/** Trusted, synchronous build composition. Never inferred from product identity. */
export interface WorkbenchPresentationOptions {
  readonly iconStyle?: "standard" | "classic";
  readonly defaultThemeId?: string;
  readonly hiddenBuiltinThemeIds?: readonly string[];
}

export interface WorkbenchPresentation {
  readonly iconStyle: "standard" | "classic";
  readonly defaultThemeId?: string;
  readonly hiddenBuiltinThemeIds: readonly string[];
}

export function resolveWorkbenchPresentation(options: WorkbenchPresentationOptions = {}): WorkbenchPresentation {
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || (options.defaultThemeId !== undefined && typeof options.defaultThemeId !== "string")
    || (options.hiddenBuiltinThemeIds !== undefined && (!Array.isArray(options.hiddenBuiltinThemeIds)
      || options.hiddenBuiltinThemeIds.some(id => typeof id !== "string")))) {
    throw new TypeError("Invalid Workbench presentation options");
  }
  if (options.iconStyle !== undefined && options.iconStyle !== "standard" && options.iconStyle !== "classic") {
    throw new TypeError("Unknown Workbench icon style");
  }
  const defaultThemeId = options.defaultThemeId === undefined ? undefined : normalizeBuiltinThemeId(options.defaultThemeId.trim());
  const rawHiddenIds = [...(options.hiddenBuiltinThemeIds ?? [])];
  const hiddenBuiltinThemeIds = rawHiddenIds.map(normalizeBuiltinThemeId);
  if ((options.defaultThemeId !== undefined && !defaultThemeId)
    || rawHiddenIds.some(id => !id.trim() || id !== id.trim())
    || (defaultThemeId !== undefined && hiddenBuiltinThemeIds.includes(defaultThemeId))) {
    throw new TypeError("Invalid Workbench theme policy");
  }
  return Object.freeze({
    iconStyle: options.iconStyle ?? "standard",
    ...(defaultThemeId === undefined ? {} : { defaultThemeId }),
    hiddenBuiltinThemeIds: Object.freeze([...new Set(hiddenBuiltinThemeIds)]),
  });
}

/** Build-generated JSON, read once before the first appearance snapshot. */
export function parseWorkbenchPresentation(serialized?: string): WorkbenchPresentation {
  return resolveWorkbenchPresentation(serialized === undefined ? {} : JSON.parse(serialized));
}
