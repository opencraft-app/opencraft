import { homedir } from "node:os";
import { InteractionFault, InteractionResponseNotDispatched } from "@opencraft/app-host-server/interactions";
import { DshClientError, type DshStreamEnvelope } from "./dsh-client.js";
import { DshRoutedClient } from "./dsh-routed-client.js";
import type { DshRoutingReader } from "./dsh-routing-projection.js";

export const DSH_UNAVAILABLE = "DSH_UNAVAILABLE";

/**
 * Stands in for the DSH runtime when none is installed. OpenCraft does not
 * distribute DSH, so a host starts without it: the catalog, model and settings
 * reads it needs at initialization are empty, and anything that would run a
 * DSH thread fails with an explicit "not installed" error. Connected agents
 * and other engines on the same host are unaffected.
 */
export class AbsentDshClient extends DshRoutedClient {
  constructor(
    routing: DshRoutingReader,
    private readonly reason = "DeepSeek Harness (DSH) is not installed on this computer",
  ) {
    super("http://127.0.0.1:0", routing);
  }

  override async call<TResult>(method: string): Promise<TResult> {
    switch (method) {
      case "host.describe":
        return { home: homedir(), cwd: homedir(), version: "not installed" } as TResult;
      case "session.list":
        return { items: [] } as TResult;
      case "settings.describe":
        return { namespaces: [] } as TResult;
      case "llm.providers":
        return { providers: [] } as TResult;
      case "llm.models":
        return { groups: [], failures: [] } as TResult;
      default:
        throw new DshClientError(DSH_UNAVAILABLE, this.reason);
    }
  }

  override async respond(): Promise<never> {
    throw new InteractionResponseNotDispatched(new InteractionFault({ code: DSH_UNAVAILABLE }, this.reason));
  }

  /** No native events exist; the stream stays open, quietly, until its generation ends. */
  override async stream(
    _path: "/api/events.mux" | "/api/events.host",
    _onFrame: (frame: DshStreamEnvelope) => void,
    signal: AbortSignal,
    onOpen?: () => void,
  ): Promise<void> {
    onOpen?.();
    if (signal.aborted) return;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}
