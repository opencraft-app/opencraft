import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  SandboxBackend,
  SandboxProcess,
  SandboxResources,
} from "@opencraft/sandbox";
export function localSandboxFixture(resources: SandboxResources) {
  const calls: {
      command: readonly string[];
      cwd: string;
      env: Record<string, string>;
    }[] = [],
    owners: string[] = [];
  let destroyed = 0;
  return {
    calls,
    owners,
    get destroyed() {
      return destroyed;
    },
    backend: (): SandboxBackend => ({
      id: "e2b",
      async initialize() {},
      async close() {},
      async create(identity) {
        owners.push(identity.owner);
        let ended = false;
        const children = new Set<ReturnType<typeof spawn>>();
        return {
          resources,
          capabilities: { terminal: false },
          async spawn(command, onOutput) {
            if (ended) throw Error("fixture closed");
            calls.push(command);
            const child = spawn(command.command[0]!, command.command.slice(1), {
              cwd: command.cwd,
              env: { PATH: "/usr/bin:/bin", ...command.env },
              stdio: ["pipe", "pipe", "pipe"],
            });
            children.add(child);
            child.stdout.on("data", (data) =>
              onOutput?.({ stream: "stdout", data }),
            );
            child.stderr.on("data", (data) =>
              onOutput?.({ stream: "stderr", data }),
            );
            const exited = new Promise<any>((resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code, signal) => {
                children.delete(child);
                resolve({ code, ...(signal ? { signal } : {}) });
              });
            });
            void exited.catch(() => {});
            return {
              kind: "process",
              id: randomUUID(),
              exited,
              writeStdin: async (data) => {
                child.stdin.write(data);
              },
              closeStdin: async () => {
                child.stdin.end();
              },
              terminate: async () => {
                child.kill("SIGKILL");
                await exited;
              },
            } as SandboxProcess;
          },
          async close() {
            if (ended) return;
            ended = true;
            destroyed++;
            for (const child of children) child.kill("SIGKILL");
            await Promise.all(
              [...children].map(
                (child) => new Promise((r) => child.once("close", r)),
              ),
            );
          },
        };
      },
    }),
  };
}
