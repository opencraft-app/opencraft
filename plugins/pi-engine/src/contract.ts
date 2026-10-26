import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { permissionModeProfileId } from "@opencraft/appserver-protocol";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";

type Value = Record<string, any>;
export const fullAccessProfile = permissionModeProfileId("full");
export const piModel = (provider: string, model: string) => `pi:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`;
export function selection(model: string) {
  const match = typeof model === "string" && /^pi:([^:]+):(.+)$/u.exec(model);
  if (!match) throw new Error("This thread belongs to Pi; select a Pi model or create a new thread to change engines");
  return { provider: decodeURIComponent(match[1]!), modelId: decodeURIComponent(match[2]!) };
}
export function assertPiFields(params: Value) {
  const sandbox = params.sandboxPolicy;
  if (params.permissions != null && params.permissions !== fullAccessProfile
    || params.sandbox != null && params.sandbox !== "danger-full-access"
    || sandbox != null && (typeof sandbox !== "object" || sandbox.type !== "dangerFullAccess" || Object.keys(sandbox).some(key => key !== "type"))
    || params.approvalPolicy != null && params.approvalPolicy !== "never")
    throw new Error("Pi supports Full access only; choose Full access or use another engine for restricted permissions");
  // Workbench may resend both a named profile and its resolved native policy.
  // Every supplied value was checked above; redundant Full access is equivalent.
  const neutral: Record<string, (v: any) => boolean> = {
    ephemeral: v => typeof v === "boolean", outputSchema: () => false, collaborationMode: () => false, toolOutput: () => false,
    serviceTier: v => v === "default", serviceTierForTurn: v => v === "default", serviceName: () => false,
    approvalsReviewer: v => v === "user", summary: v => v === "auto",
    allowProviderModelFallback: v => v === false, daybreakEnabled: v => v === false,
    experimentalRawEvents: v => v === false, mockExperimentalField: () => false,
    selectedCapabilityRoots: v => Array.isArray(v) && v.length === 0,
    environments: v => Array.isArray(v) && v.length === 0,
    disabledPluginIds: v => Array.isArray(v) && v.length === 0,
    cyberAccessProgram: () => false, history: () => false,
    // Initial pages use the same bounded projection and cursor semantics as later reads.
    initialTurnsPage: v => typeof v === "object" && !Array.isArray(v)
      && Object.keys(v).every(key => ["limit", "itemsView", "sortDirection"].includes(key))
      && (v.limit == null || Number.isSafeInteger(v.limit) && v.limit > 0)
      && (v.itemsView == null || ["full", "summary", "notLoaded"].includes(v.itemsView))
      && (v.sortDirection == null || ["asc", "desc"].includes(v.sortDirection)),
    responsesapiClientMetadata: v => typeof v === "object" && Object.keys(v).length === 0,
  };
  for (const [field, accepts] of Object.entries(neutral)) if (params[field] != null && !accepts(params[field]))
    throw new Error(`Pi does not support ${field}`);
  if (params.config != null && (typeof params.config !== "object" || Array.isArray(params.config)
    || Object.keys(params.config).some(key => key !== "model_reasoning_effort"))) throw new Error("Pi does not support these config overrides");
  for (const field of ["baseInstructions", "developerInstructions"]) if (params[field] != null && typeof params[field] !== "string") throw new Error(`Invalid ${field}`);
}
export async function workspace(params: Value, previous: string) {
  const cwd = params.cwd ?? previous;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Pi cwd must be an absolute workspace directory");
  if (!(await stat(cwd)).isDirectory()) throw new Error("Pi cwd must be a directory");
  const normalized = resolve(cwd);
  // A New chat without a selected workspace sends []; inherit the Host/session
  // cwd just as when roots are omitted. Non-empty roots still describe one cwd.
  const roots = params.runtimeWorkspaceRoots;
  if (roots != null && (!Array.isArray(roots) || roots.length > 1
    || roots.length === 1 && (typeof roots[0] !== "string" || !isAbsolute(roots[0]) || resolve(roots[0]) !== normalized)))
    throw new Error("Pi supports one runtimeWorkspaceRoot equal to cwd");
  return normalized;
}
export function thinking(model: Value, effort: unknown, explicit: boolean) {
  const supported = getSupportedThinkingLevels(model as any) as readonly string[];
  const level = effort === "none" ? "off" : effort;
  if (typeof level === "string" && supported.includes(level)) return level;
  if (level != null && explicit) throw new Error(`Pi model does not support reasoning effort ${String(effort)}`);
  return supported.includes("medium") ? "medium" : supported[0] ?? "off";
}
export function compareThreads(params: Value) {
  const key = params.sortKey === "updated_at" ? "updatedAt" : "createdAt", sign = params.sortDirection === "asc" ? 1 : -1;
  return (a: Value, b: Value) => sign * (a[key] - b[key]) || String(a.id).localeCompare(String(b.id));
}
