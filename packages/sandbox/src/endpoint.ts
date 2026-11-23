import { SandboxFault, type SandboxEnvironment, type SandboxProcess } from "./contract.js";

/** Fixed guest relay: one stdio byte stream ↔ one stream socket connection inside
 * the environment. stdin EOF half-closes the socket's write side after pending bytes
 * are sent; target EOF ends the relay with code 0. Non-blocking socket writes keep
 * reading the target while the target is not reading us (no relay deadlock); stdin
 * is not read while 1 MiB is pending, so a slow target back-pressures the Host. */
export const endpointRelaySource = String.raw`import os,select,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.setblocking(False)
out=sys.stdout.buffer
pending=bytearray()
reading=True
shut=False
while True:
    r=[s]
    if reading and len(pending)<1048576: r.append(0)
    ready,writable,_=select.select(r,[s] if pending else [],[])
    if writable:
        try: del pending[:s.send(pending)]
        except BlockingIOError: pass
    if 0 in ready:
        data=os.read(0,65536)
        if data: pending+=data
        else: reading=False
    if not reading and not pending and not shut:
        s.shutdown(socket.SHUT_WR)
        shut=True
    if s in ready:
        try: data=s.recv(65536)
        except BlockingIOError: continue
        if not data: break
        out.write(data)
        out.flush()
s.close()
`;

/** Endpoint names an image's `workspace-agent` may publish. The agent fixes the name →
 * socket mapping inside the environment; Host callers never choose an in-environment path. */
export const SANDBOX_ENDPOINT_NAMES = Object.freeze([
  "control", "codex-control", "codex-native", "pi", "dsh", "exec", "terminal", "files", "browser",
] as const);
export type SandboxEndpointName = typeof SANDBOX_ENDPOINT_NAMES[number];
/** Default directory where the agent publishes named endpoints (an image/template property). */
export const SANDBOX_ENDPOINT_DIRECTORY = "/run/opencraft-agent/endpoints";
export function isSandboxEndpointName(value: unknown): value is SandboxEndpointName {
  return typeof value === "string" && (SANDBOX_ENDPOINT_NAMES as readonly string[]).includes(value);
}

/** A stream socket inside the selected environment: a named agent endpoint, or (only for
 * owners not yet supervised by `workspace-agent`, e.g. the E2B browser owner) a
 * caller-validated absolute path. */
export type SandboxEndpointTarget = { readonly name: SandboxEndpointName } | { readonly unix: string };
export interface SandboxEndpointOptions {
  readonly target: SandboxEndpointTarget;
  /** Where the environment's agent publishes named endpoints; a provider/image property. */
  readonly endpointDirectory?: string;
  /** Bytes from the target, in order. Called until the connection ends. */
  onData(data: Uint8Array): void;
  /** Absolute interpreter path provided by the image/template. */
  readonly python?: string;
  /** Relay cwd in the environment's filesystem. */
  readonly cwd?: string;
}
/** `ended`: target EOF or local close. `failed`: relay error, connect failure or lost transport. */
export type SandboxEndpointEnd = "ended" | "failed";
export interface SandboxEndpointConnection {
  /** Settles once; never rejects. The environment is unaffected either way. */
  readonly closed: Promise<SandboxEndpointEnd>;
  /** Resolves once the provider accepted the bytes (Host → target back-pressure). */
  write(data: Uint8Array): Promise<void>;
  /** Half-close: the target reads EOF; data from the target continues. */
  end(): Promise<void>;
  /** Idempotent. Rejects with SANDBOX_CLEANUP when relay termination is unconfirmed. */
  close(): Promise<void>;
}

const fault = (code: ConstructorParameters<typeof SandboxFault>[0], message: string) => new SandboxFault(code, message);
const maximumUnixPath = 107;

/** Provider-neutral private byte connection to a socket inside an environment. One
 * connection is one `attached` sandbox process: its failure ends only this connection,
 * never the environment. No reconnect or replay: a lost connection is reported once. */
export async function openSandboxEndpoint(
  environment: Pick<SandboxEnvironment, "spawn">,
  options: SandboxEndpointOptions,
): Promise<SandboxEndpointConnection> {
  const target = options.target as { name?: unknown; unix?: unknown } | undefined;
  const directory = options.endpointDirectory ?? SANDBOX_ENDPOINT_DIRECTORY;
  if (target && "name" in target && (!isSandboxEndpointName(target.name) || "unix" in target
    || typeof directory !== "string" || !directory.startsWith("/") || directory.endsWith("/")))
    throw fault("SANDBOX_POLICY", "Unknown sandbox endpoint name");
  const path = target && "name" in target ? `${directory}/${target.name as string}` : target?.unix;
  const python = options.python ?? "/usr/bin/python3";
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0") || /(^|\/)\.\.?(\/|$)/u.test(path)
    || new TextEncoder().encode(path).byteLength > maximumUnixPath || !python.startsWith("/") || python.includes("\0"))
    throw fault("SANDBOX_POLICY", "Invalid sandbox endpoint target");
  let finished = false, settle!: (end: SandboxEndpointEnd) => void, closing: Promise<void> | undefined;
  const closed = new Promise<SandboxEndpointEnd>(resolve => {
    settle = end => { if (!finished) { finished = true; resolve(end); } };
  });
  const child: SandboxProcess = await environment.spawn(
    { command: [python, "-I", "-u", "-c", endpointRelaySource, path], cwd: options.cwd ?? "/", env: {}, attached: true },
    output => { if (output.stream === "stdout" && !finished) options.onData(output.data); },
  );
  if (child.kind !== "process") {
    await child.terminate().catch(() => {});
    throw fault("SANDBOX_UNAVAILABLE", "Sandbox endpoint requires a pipe process");
  }
  void child.exited.then(exit => settle(exit.code === 0 ? "ended" : "failed"), () => settle("failed"));
  return {
    closed,
    async write(data) {
      if (finished) throw fault("SANDBOX_CLOSED", "Sandbox endpoint is closed");
      await child.writeStdin(data);
    },
    async end() {
      if (!finished) await child.closeStdin();
    },
    close() {
      return closing ??= (async () => {
        settle("ended");
        // Terminating an already exited relay is a no-op for conforming backends.
        try { await child.terminate(); }
        catch { throw fault("SANDBOX_CLEANUP", "Sandbox endpoint relay cleanup is unconfirmed"); }
      })();
    },
  };
}
