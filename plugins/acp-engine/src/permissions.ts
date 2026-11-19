import { permissionModeProfileId, projectPermissionProfileCatalog, type OpenCraftPermissionMode } from "@opencraft/appserver-protocol";

/** These are codex-acp execution policies, not the core Codex profile IDs. */
export function codexAcpPermissionMode(id: string): OpenCraftPermissionMode | null {
  switch (id) {
    case "read-only": return "read-only";
    case "workspace-write": return "accept-edits";
    case "agent": return "auto";
    case "agent-full-access": return "full";
    default: return null;
  }
}
export interface AcpPermissionConfig {
  id: string; currentValue: string;
  options: { value: string; name: string; description: string | null }[];
}
const record = (input: unknown): Record<string, unknown> | null =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;

export function readCodexPermissionConfig(result: unknown): AcpPermissionConfig | null {
  const configOptions = record(result)?.configOptions;
  if (!Array.isArray(configOptions)) return null;
  const option = configOptions.map(record).find(option => option?.category === "mode" && option.type === "select");
  if (typeof option?.id !== "string" || !option.id || typeof option.currentValue !== "string" || !Array.isArray(option.options)) return null;
  const options: AcpPermissionConfig["options"] = [];
  const seen = new Set<string>();
  for (const entry of option.options) {
    const group = record(entry);
    for (const input of Array.isArray(group?.options) ? group.options : [entry]) {
      const choice = record(input);
      if (typeof choice?.value !== "string" || !choice.value || choice.value.startsWith("opencraft:") || typeof choice.name !== "string") continue;
      if (seen.has(choice.value)) return null;
      seen.add(choice.value);
      options.push({ value: choice.value, name: choice.name, description: typeof choice.description === "string" ? choice.description : null });
    }
  }
  if (!seen.has(option.currentValue)) return null;
  return { id: option.id, currentValue: option.currentValue, options };
}
export function acpPermissionProfiles(config: AcpPermissionConfig | undefined) {
  return projectPermissionProfileCatalog((config?.options ?? []).map(option => ({ id: option.value, description: option.description, allowed: true,
    openCraftLabel: option.name })), profile => codexAcpPermissionMode(profile.id));
}
interface CodexAcpPermissionSettings {
  permissions: string;
  activePermissionProfile: { id: string; extends: null };
  approvalPolicy?: "never" | "on-request";
  approvalsReviewer?: "user" | "auto_review";
  sandbox?: "danger-full-access" | "read-only" | "workspace-write";
}
export function codexAcpPermissionSettings(id: string): CodexAcpPermissionSettings {
  const mode = codexAcpPermissionMode(id);
  if (!mode) return { permissions: id, activePermissionProfile: { id, extends: null } };
  const sandbox = mode === "full" ? "danger-full-access" : mode === "read-only" ? "read-only" : "workspace-write";
  return { permissions: permissionModeProfileId(mode), approvalPolicy: mode === "full" ? "never" : "on-request",
    approvalsReviewer: mode === "auto" ? "auto_review" : "user", sandbox,
    activePermissionProfile: { id: permissionModeProfileId(mode), extends: null } };
}
