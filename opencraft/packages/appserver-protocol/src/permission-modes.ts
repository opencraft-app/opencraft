/** Host-authored presentation of a verified native permission profile. */
export const OPENCRAFT_PERMISSION_MODES_EXTENSION = "opencraft/permission-modes";

export const OPENCRAFT_PERMISSION_MODES_CAPABILITY = Object.freeze({ version: 1 });

export type OpenCraftPermissionMode = "read-only" | "accept-edits" | "auto" | "full";
const PERMISSION_MODE_PREFIX = "opencraft:permission-mode:";

export function permissionModeProfileId(mode: OpenCraftPermissionMode): string {
  return `${PERMISSION_MODE_PREFIX}${mode}`;
}

export function parsePermissionModeProfileId(id: string): OpenCraftPermissionMode | null {
  if (!id.startsWith(PERMISSION_MODE_PREFIX)) return null;
  const mode = id.slice(PERMISSION_MODE_PREFIX.length);
  return mode === "read-only" || mode === "accept-edits" || mode === "auto" || mode === "full"
    ? mode : null;
}

export interface OpenCraftPermissionProfile {
  readonly id: string;
  readonly description: string | null;
  readonly allowed: boolean;
  /** Absent for a native/custom profile whose policy cannot be verified. */
  readonly openCraftMode?: OpenCraftPermissionMode;
  readonly openCraftLabel?: string;
  /** The engine-owned profile bound to a product mode at catalog time. */
  readonly openCraftNativeProfileId?: string;
}

const MODE_LABELS: Readonly<Record<OpenCraftPermissionMode, string>> = {
  "read-only": "Read only",
  "accept-edits": "Accept edits",
  auto: "Auto review",
  full: "Full access",
};

export function permissionModeLabel(mode: OpenCraftPermissionMode): string {
  return MODE_LABELS[mode];
}

/** Only these built-in Codex IDs have a stable, known policy binding. */
export function codexPermissionMode(id: string): OpenCraftPermissionMode | null {
  switch (id) {
    case ":read-only": return "read-only";
    case ":workspace":
    case ":workspace_roots": return "accept-edits";
    case ":danger-full-access": return "full";
    default: return null;
  }
}

/** DSH resolves each preset to its actual sandbox and approval policy. */
export function dshPermissionMode(value: unknown): OpenCraftPermissionMode | null {
  if (typeof value !== "object" || value === null) return null;
  const policy = value as Record<string, unknown>;
  const sandbox = policy.sandbox;
  const mode = typeof sandbox === "object" && sandbox !== null
    ? (sandbox as Record<string, unknown>).mode
    : typeof sandbox === "string" ? sandbox : policy.mode;
  const approval = policy.approval;
  if (mode === "read-only" && (approval === "ask" || approval === "never")) return "read-only";
  if (mode === "workspace-write" && approval === "ask") return "accept-edits";
  if (mode === "danger-full-access" && approval === "never") return "full";
  return null;
}

export function projectPermissionProfileCatalog(
  profiles: readonly OpenCraftPermissionProfile[],
  classify: (profile: OpenCraftPermissionProfile) => OpenCraftPermissionMode | null,
): OpenCraftPermissionProfile[] {
  const bound = new Set<OpenCraftPermissionMode>();
  return profiles.map((profile) => {
    const mode = classify(profile);
    if (mode === null || bound.has(mode)) return profile;
    bound.add(mode);
    return {
      ...profile,
      id: permissionModeProfileId(mode),
      openCraftMode: mode,
      openCraftLabel: permissionModeLabel(mode),
      openCraftNativeProfileId: profile.id,
    };
  });
}
