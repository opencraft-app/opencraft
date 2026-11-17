import type { AppServerMethodResult, OnboardingSnapshot } from "@opencraft/appserver-protocol";
import type { AgentRuntimeAccess } from "@opencraft/workbench-runtime";
import type { AgentCatalogModel } from "../components/agent-directory";

export interface SettingsAgentDirectory {
  readonly native: OnboardingSnapshot | null;
  readonly models: readonly AgentCatalogModel[];
}

/** Catalog reads stay on their Host. No login action, history import or chat start. */
export async function readSettingsAgentDirectory(access: Pick<AgentRuntimeAccess, "ensureReady" | "request">, hostId: string, signal: AbortSignal): Promise<SettingsAgentDirectory> {
  await access.ensureReady(hostId);
  signal.throwIfAborted();
  const native = await access.request(hostId, "opencraft/agents/onboarding/history-agents", {}).catch(error => {
    const rpc = error as { code?: unknown; message?: unknown };
    const unsupported = rpc.code === -32601 || rpc.code === -32603 && rpc.message === "Method not supported by OpenCraft DSH host: opencraft/agents/onboarding/history-agents";
    if (!unsupported) throw error;
    return access.request(hostId, "opencraft/agents/onboarding/status", {});
  });
  signal.throwIfAborted();
  if (!native || !Array.isArray(native.agents)) throw new Error("Invalid Agent directory");
  return { native, models: [] };
}

/** API-engine models are independent from native Agent discovery. */
export async function readSettingsAgentModels(access: Pick<AgentRuntimeAccess, "ensureReady" | "request">, hostId: string, signal: AbortSignal): Promise<readonly AgentCatalogModel[]> {
  await access.ensureReady(hostId);
  const models: AgentCatalogModel[] = [], cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const page: AppServerMethodResult<"model/list"> = await access.request(hostId, "model/list", { cursor, limit: 100 });
    signal.throwIfAborted();
    if (!page || !Array.isArray(page.data) || page.nextCursor !== null && typeof page.nextCursor !== "string") throw new Error("Invalid model catalog");
    for (const model of page.data) if (model.agentId) models.push({ agentId: model.agentId, agentLabel: model.agentLabel ?? undefined,
      id: model.model, name: model.displayName, isDefault: model.isDefault });
    cursor = page.nextCursor;
    if (cursor !== null && cursors.has(cursor)) throw new Error("Repeated model catalog cursor");
    if (cursor !== null) cursors.add(cursor);
  } while (cursor !== null);
  return models;
}
