import { randomUUID } from "node:crypto";
import type { SandboxEnvironment } from "@opencraft/sandbox";
import type { DurableHostProcessService } from "@opencraft/local-agent-host/durable-process-service";
export type TerminalAdmissionPort = Pick<
  DurableHostProcessService,
  "probeTerminalAdmission" | "reserveTerminal" | "releaseTerminal" | "confirmTerminalResourceDestroyed"
>;
/** SDK wrapper over the existing Hands quota owner, not another counter. Counts
 * UI terminal processes, not every descendant/model tool process. A command
 * failure or terminate acknowledgement is NOT a positive exit receipt. */
export function withRemoteTerminalAdmission(
  environment: SandboxEnvironment,
  options: {
    port?: TerminalAdmissionPort;
    quotaOwner: string;
    resource: string;
    authorize?(): Promise<void>;
    onCleanupUnconfirmed(): void;
  },
) {
  let retired = false;
  const pending = new Set<Promise<unknown>>();
  const report = () => {
    try {
      options.onCleanupUnconfirmed();
    } catch {}
  };
  const owned: SandboxEnvironment = {
    resources: environment.resources,
    capabilities: { ...environment.capabilities, terminal: environment.capabilities.terminal && !!options.port },
    ...(environment.processLimits ? { processLimits: environment.processLimits } : {}),
    close: () => environment.close(),
    spawn(command, onOutput) {
      if (!command.terminal) return environment.spawn(command, onOutput);
      const work = (async () => {
        if (retired || !options.port) throw Error("Shared Hands terminal admission unavailable");
        const token = await options.port.reserveTerminal(options.quotaOwner, options.resource, randomUUID());
        try {
          if (retired) throw Error("Workspace terminal resource retired");
          await options.authorize?.();
          if (retired) throw Error("Workspace terminal resource retired");
        } catch (error) {
          await options.port.releaseTerminal(token, "not-created");
          throw error;
        }
        // From this point a thrown SDK call has unknown physical outcome. Retain its
        // receipt until positive child exit or confirmed entire resource deletion.
        const child = await environment.spawn(command, onOutput);
        void child.exited
          .then(
            () => options.port!.releaseTerminal(token, "exited"),
            () => {
              report();
            },
          )
          .catch(report);
        return child;
      })();
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    },
  };
  return {
    environment: owned,
    retire() {
      retired = true;
    },
    async confirmDestroyed() {
      retired = true;
      await Promise.allSettled([...pending]);
      if (options.port) await options.port.confirmTerminalResourceDestroyed(options.quotaOwner, options.resource);
    },
  };
}
