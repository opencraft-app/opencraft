const ACTOR_WORKSPACE = /^actor-[0-9a-f]{56}$/u;
export const CODEX_WORKBENCH_HOST_ID = "local-codex";

export interface CodexWorkspaceTarget {
  readonly workspace: string;
  readonly ownerActorId?: string;
}

export function isCodexActorWorkspace(value: string): boolean {
  return ACTOR_WORKSPACE.test(value);
}

export function isCodexWorkspaceOwner(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("human://") &&
    value.length > "human://".length &&
    value.length <= 1024 &&
    !/[\x00-\x1f\x7f]/u.test(value)
  );
}

/** Account generation fences permission. A later login to the same Actor retains placement. */
export async function codexActorWorkspace(machine: string, actorId: string): Promise<string> {
  const key = new TextEncoder().encode(JSON.stringify([machine, actorId]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", key));
  return "actor-" + Array.from(digest.subarray(0, 28), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function codexWorkspaceTarget(
  routing: { readonly workspace: string; readonly machine: string; readonly isolateActors: boolean },
  actorId: string,
  existingWorkspace?: string,
): Promise<CodexWorkspaceTarget | null> {
  if (existingWorkspace === routing.workspace || (existingWorkspace === undefined && !routing.isolateActors))
    return { workspace: routing.workspace };
  if (!isCodexWorkspaceOwner(actorId)) return null;
  const workspace = await codexActorWorkspace(routing.machine, actorId);
  return existingWorkspace === undefined || existingWorkspace === workspace
    ? { workspace, ownerActorId: actorId }
    : null;
}
