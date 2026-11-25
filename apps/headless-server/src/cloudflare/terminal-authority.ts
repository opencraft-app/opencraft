import { isCodexActorWorkspace } from "./codex-workspace.js";
import type { InstallationCoreNamespace } from "./bindings.js";
import type { ClientAttachment } from "./client-attachment.js";
import { parseThreadPlacementReceipt, type ThreadPlacementReceipt } from "./thread-placement.js";

export const TERMINAL_AUTHORITY_PATH = "/__opencraft_internal/terminal-authority";
export const WORKSPACE_THREAD_RESOURCES_PATH = "/__opencraft_internal/workspace-thread-resources";
export type TerminalAdmission = "active" | "retired" | "denied";
export type TerminalScope = { readonly threadId: string | null; readonly draftScopeId: string | null };
export type ThreadResourceObservation = {
  readonly placement: ThreadPlacementReceipt;
  readonly state: "archived" | "active";
};

export function parseThreadResourceObservation(value: unknown): ThreadResourceObservation | null {
  const body = value as { placement?: unknown; state?: unknown } | null;
  const placement = parseThreadPlacementReceipt(body?.placement);
  const state = body?.state;
  return placement?.state === "placed" && (state === "active" || state === "archived") ? { placement, state } : null;
}

function requestTerminalAuthority(
  installation: ReturnType<InstallationCoreNamespace["get"]>,
  attachment: ClientAttachment,
  target?: TerminalScope & { workspace: string },
) {
  return installation.fetch(
    new Request(`https://installation.invalid${TERMINAL_AUTHORITY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachment, ...target }),
    }),
  );
}

export async function terminalWorkspace(
  installation: ReturnType<InstallationCoreNamespace["get"]>,
  attachment: ClientAttachment,
): Promise<string | null> {
  const response = await requestTerminalAuthority(installation, attachment);
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const body = (await response.json()) as { workspace?: unknown } | null;
  return typeof body?.workspace === "string" && isCodexActorWorkspace(body.workspace) ? body.workspace : null;
}

export async function terminalAdmission(
  installation: ReturnType<InstallationCoreNamespace["get"]>,
  attachment: ClientAttachment,
  target: TerminalScope & { workspace: string },
): Promise<{ admission: TerminalAdmission; threadId: string | null }> {
  const response = await requestTerminalAuthority(installation, attachment, target);
  if (response.status !== 200 && response.status !== 409) {
    await response.body?.cancel();
    return { admission: "denied", threadId: null };
  }
  const body = (await response.json()) as { threadId?: unknown } | null;
  const threadId = body?.threadId;
  if ((threadId !== null && typeof threadId !== "string") || (target.threadId !== null && target.threadId !== threadId))
    throw Error("Invalid terminal authority receipt");
  return { admission: response.status === 409 ? "retired" : "active", threadId };
}
