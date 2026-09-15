import { Context, Service } from "@deepseek-ai/cordis";
import type {
  DshRuntimeDrainResult,
  DshRuntimeHostPort,
  DshRuntimeUser,
} from "../types/engine.ts";

/**
 * Process boundary for the Node/Cordis DSH runtime. It deliberately knows
 * nothing about Docker, Btrfs or workspace paths; those enter the engine only
 * through WorkspaceAttachmentService.
 */
export class DshRuntimeHostService extends Service implements DshRuntimeHostPort {
  private readonly processes = new Set<string>();

  constructor(ctx: Context) {
    super(ctx, "dshRuntimeHost");
    ctx.effect(() => () => {
      for (const processId of [...this.processes]) this.stop(processId, 1_000);
    });
  }

  start(processId: string, user: DshRuntimeUser | null, providerId: string): void {
    if (!user?.username) throw new Error("DSH runtime requires an authenticated user");
    if (!providerId) throw new Error("DSH runtime requires a model provider");
    hostProcess.spawnDshEngineWorkerForUser(
      processId,
      ".",
      user.username,
      user.linuxUid,
      user.linuxGid,
      user.installationId,
      providerId,
    );
    this.processes.add(processId);
  }

  send(processId: string, message: string | Record<string, unknown>): void {
    hostProcess.write(processId, `${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }

  drain(processId: string): DshRuntimeDrainResult {
    return hostProcess.drain(processId);
  }

  stop(processId: string, timeoutMs = 2_000): void {
    if (!this.processes.delete(processId)) return;
    try {
      hostProcess.terminate(processId, timeoutMs);
    } catch {
      try {
        hostProcess.kill(processId);
      } catch {
        // The worker is already gone. Runtime retirement remains idempotent.
      }
    }
  }
}
