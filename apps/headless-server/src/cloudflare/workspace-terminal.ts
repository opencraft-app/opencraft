import { openTerminalOwnerLink, type TerminalOwnerLink } from "@opencraft/local-agent-host/terminal-owner-link";
import { parseWorkspaceEndpointUri, type WorkspaceRuntime } from "@opencraft/sandbox";

/** The workspace owner retains the token and returns a private Hands link to its caller. */
export async function openWorkspaceTerminal(
  runtime: Pick<WorkspaceRuntime, "workspaceId" | "describe" | "connect" | "fenced">,
  onNotification: (method: string, params: unknown) => void,
): Promise<TerminalOwnerLink> {
  const endpoint = parseWorkspaceEndpointUri(`workspace://${runtime.workspaceId}/endpoints/terminal`);
  let link: TerminalOwnerLink | undefined;
  try {
    return await runtime.fenced(endpoint, async () => {
      const descriptor = (await runtime.describe(endpoint)) as { token?: unknown } | null;
      const token = descriptor?.token;
      if (typeof token !== "string" || token.length < 32 || token.length > 512 || /[\x00-\x20\x7f]/u.test(token))
        throw new Error("Workspace terminal owner token unavailable");
      return (link = await openTerminalOwnerLink((onData) => runtime.connect(endpoint, onData), {
        token,
        onNotification,
      }));
    });
  } catch (error) {
    await link?.close().catch(() => {});
    throw error;
  }
}
