import { randomUUID } from "node:crypto";
import type { SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";
import {
  connectSandboxBrowserOwner,
  type SandboxBrowserOwnerTransport,
} from "@opencraft/local-agent-host/sandbox-browser-owner";

/** One browser Owner per admitted compute incarnation. Runtime bytes are supplied
 * by the Hands image/template; only the private profile/socket live in /tmp. */
export function createSandboxBrowserRuntime(
  options: {
    sandbox: Pick<SandboxEnvironment, "spawn">;
    /** Explicit deployment policy, NOT a fallback after sandboxed launch failure. */
    isolation: "chromium-sandbox" | "isolated-vm-compatibility";
    authorize(): Promise<void>;
    assertCurrent(): void;
    onLost(): void;
    onCleanupUnconfirmed(): void;
  },
  dependencies: { connect?: typeof connectSandboxBrowserOwner } = {},
) {
  if (!["chromium-sandbox", "isolated-vm-compatibility"].includes(options.isolation))
    throw Error("Invalid browser isolation policy");
  const state = "/tmp/opencraft-browser-" + randomUUID(),
    socketPath = state + "/owner.sock";
  let closed = false,
    lost = false,
    process: SandboxProcess | undefined;
  let starting: Promise<void> | undefined, connecting: Promise<SandboxBrowserOwnerTransport> | undefined;
  let closing: Promise<void> | undefined, stopping: Promise<void> | undefined;
  let peer: SandboxBrowserOwnerTransport | undefined, rejectReady: ((error: Error) => void) | undefined;
  const unavailable = () => Error("Sandbox browser runtime unavailable");
  const current = () => {
    if (closed || lost) throw unavailable();
    options.assertCurrent();
  };
  const authorize = async () => {
    current();
    await options.authorize();
    current();
  };
  const lose = () => {
    if (closed || lost) return;
    lost = true;
    rejectReady?.(unavailable());
    options.onLost();
  };
  const stop = () => (process ? (stopping ??= process.terminate()) : Promise.resolve());
  const start = () =>
    (starting ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await authorize();
        const directory = "/opt/opencraft/runtime/browser";
        const flags = [
          "--ozone-platform=headless",
          "--ozone-override-screen-size=1920,1080",
          "--disable-gpu",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
          ...(options.isolation === "isolated-vm-compatibility"
            ? ["--no-sandbox", "--no-zygote", "--in-process-gpu", "--disable-dev-shm-usage"]
            : []),
        ];
        const executable = directory + "/electron/electron";
        const script = String.raw`const {mkdirSync}=require('node:fs');const {spawn}=require('node:child_process');
const {createBrowserOwner,installOwnerSignals}=require(${JSON.stringify(directory + "/owner.cjs")});
mkdirSync(${JSON.stringify(state)},{mode:0o700});mkdirSync(${JSON.stringify(state + "/profile")},{mode:0o700});
const env={...process.env,OPENCRAFT_BROWSER_DATA_DIR:${JSON.stringify(state + "/profile")},HOME:${JSON.stringify(state + "/profile")}};
for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','DISPLAY','WAYLAND_DISPLAY'])delete env[key];
createBrowserOwner({socketPath:${JSON.stringify(socketPath)},spawnWorker:()=>spawn(${JSON.stringify(executable)},${JSON.stringify([...flags, directory + "/worker.cjs"])},{env,stdio:['ignore','ignore','ignore','ipc']})})
.then(owner=>{installOwnerSignals(owner);process.stdout.write('OPENCRAFT_BROWSER_OWNER_READY\n')})
.catch(()=>{process.stderr.write('Browser owner startup failed\n');process.exitCode=1});`;
        let resolveReady!: () => void,
          bytes = "";
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        void ready.catch(() => {});
        timer = setTimeout(() => rejectReady?.(unavailable()), 30000);
        process = await options.sandbox.spawn(
          {
            command: [executable, "-e", script],
            cwd: "/tmp",
            env: { PATH: "/opt/opencraft/bin:/usr/local/bin:/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
          },
          (output) => {
            if (output.stream !== "stdout") return;
            bytes += Buffer.from(output.data).toString("utf8");
            if (bytes.length > 8192) {
              rejectReady?.(unavailable());
              return;
            }
            if (bytes.includes("OPENCRAFT_BROWSER_OWNER_READY\n")) resolveReady();
          },
        );
        void process.exited.then(lose, lose);
        await authorize();
        if (process.kind !== "process") throw unavailable();
        await process.closeStdin();
        await ready;
        await authorize();
      } catch (error) {
        try {
          await stop();
        } catch {
          options.onCleanupUnconfirmed();
        }
        throw error;
      } finally {
        clearTimeout(timer);
        rejectReady = undefined;
      }
    })());
  return {
    assertCurrent: current,
    async connect() {
      await authorize();
      await start();
      await authorize();
      if (peer?.connected) throw Error("Sandbox browser already attached");
      if (connecting) return connecting;
      connecting = (async () => {
        await peer?.close();
        await authorize();
        const connected = await (dependencies.connect ?? connectSandboxBrowserOwner)({
          sandbox: options.sandbox,
          socketPath,
          authorize,
          onLost: lose,
          onCleanupUnconfirmed: options.onCleanupUnconfirmed,
        });
        peer = connected;
        try {
          await authorize();
          return connected;
        } catch (error) {
          await connected.close();
          throw error;
        }
      })();
      try {
        return await connecting;
      } finally {
        connecting = undefined;
      }
    },
    close() {
      return (closing ??= (async () => {
        closed = true;
        rejectReady?.(unavailable());
        await Promise.allSettled([starting, connecting]);
        const outcomes = await Promise.allSettled([peer?.close(), stop()]);
        if (outcomes.some((result) => result.status === "rejected")) {
          options.onCleanupUnconfirmed();
          throw Error("Sandbox browser cleanup unconfirmed");
        }
      })());
    },
  };
}
