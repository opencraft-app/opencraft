import {
  SandboxFault,
  type SandboxCommand,
  type SandboxExit,
  type SandboxOutput,
  type SandboxProcess,
} from "./contract.js";

/** Backend-neutral process broker for providers whose control channel is a text
 * stream to one guest process (`python3 -u <brokerSource>`). ASCII NDJSON framing
 * preserves arbitrary stdout/stderr/stdin bytes as base64 over text callbacks.
 *
 * Host → broker: `start` (once), `stdin`, `resize` (terminal), `eof` (pipes),
 * `terminate`. Broker → host: `started`, `output`, `exit`, `error` (optional `reason`
 * from a fixed vocabulary, e.g. `start-failed`; never raw diagnostics). Lines are at
 * most 400000 bytes. A terminal is one output stream; termination kills the whole
 * process group. This process is transport only: no Bot identity, memory, model or
 * API credentials. */
export const brokerSource = String.raw`import base64,errno,fcntl,json,os,pty,signal,struct,subprocess,sys,termios,threading
lock=threading.Lock()
child=None
master=None
def size(fd,value):
    cols,rows=value["cols"],value["rows"]
    if type(cols) is not int or type(rows) is not int or not (0<cols<=1000 and 0<rows<=1000): raise ValueError()
    fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",rows,cols,0,0))
def terminal_session():
    os.setsid()
    fcntl.ioctl(0,termios.TIOCSCTTY,0)
def emit(value):
    with lock:
        sys.stdout.write(json.dumps(value,separators=(',',':'))+'\n')
        sys.stdout.flush()
def stop():
    if child is not None:
        try: os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError: pass
def output(pipe,stream):
    try:
        while True:
            try: data=os.read(pipe if type(pipe) is int else pipe.fileno(),32768)
            except OSError as error:
                if pipe==master and error.errno==errno.EIO: break
                raise
            if not data: break
            emit({'type':'output','stream':stream,'data':base64.b64encode(data).decode('ascii')})
    except BaseException:
        stop()
def wait(readers):
    code=child.wait()
    for reader in readers: reader.join()
    emit({'type':'exit','code':code if code>=0 else None,'signal':signal.Signals(-code).name if code<0 else None})
    os._exit(0)
try:
    for line in iter(lambda:sys.stdin.buffer.readline(400001),b''):
        if len(line)>400000 or not line.endswith(b'\n'): raise ValueError()
        message=json.loads(line)
        kind=message['type']
        if kind=='start' and child is None:
            command=message['command']
            if command.get('terminal'):
                master,slave=pty.openpty()
                size(slave,command['terminal'])
                try:
                    child=subprocess.Popen(command['command'],cwd=command['cwd'],env={**os.environ,'TERM':'xterm-256color',**command['env']},stdin=slave,stdout=slave,stderr=slave,preexec_fn=terminal_session)
                finally: os.close(slave)
            else:
                child=subprocess.Popen(command['command'],cwd=command['cwd'],env={**os.environ,**command['env']},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            emit({'type':'started'})
            readers=([threading.Thread(target=output,args=(master,'stdout'),daemon=True)] if master is not None else [threading.Thread(target=output,args=(child.stdout,'stdout'),daemon=True),threading.Thread(target=output,args=(child.stderr,'stderr'),daemon=True)])
            for reader in readers: reader.start()
            threading.Thread(target=wait,args=(readers,),daemon=True).start()
        elif kind=='stdin' and child is not None:
            data=base64.b64decode(message['data'],validate=True)
            if master is not None:
                while data:
                    count=os.write(master,data)
                    if count<=0: raise OSError()
                    data=data[count:]
            else:
                child.stdin.write(data)
                child.stdin.flush()
        elif kind=='resize' and master is not None:
            size(master,message['size'])
        elif kind=='eof' and child is not None and master is None:
            child.stdin.close()
        elif kind=='terminate' and child is not None:
            stop()
        else:
            raise ValueError()
    stop()
except BaseException:
    try: emit({'type':'error','reason':'start-failed'} if child is None else {'type':'error'})
    finally: stop()
    os._exit(2)
`;

/** A provider's live duplex channel to one running broker process. */
export interface SandboxBrokerChannel {
  /** Deliver one complete newline-terminated frame to the broker's stdin. */
  write(frame: string): Promise<void>;
  /** Settles when the provider observes the broker process end (either way). */
  readonly ended: Promise<unknown>;
  /** Optional: release the transport once this process failed and will never use it
   * again (end the broker's control input so it kills its session; a provider whose
   * handle loss does not end the guest process must stop it here, without signalling a
   * process that already exited). Called at most once; never throws. */
  dispose?(): void;
}
/** Provider port: upload/launch the broker and stream its stdout as text chunks.
 * Broker stderr is diagnostic only and must not be delivered. */
export type SandboxBrokerLaunch = (onStdout: (chunk: string) => void) => Promise<SandboxBrokerChannel>;
export interface SandboxBrokerOptions {
  /** Opaque process ID chosen by the provider. */
  readonly id: string;
  readonly command: SandboxCommand;
  readonly onOutput?: (output: SandboxOutput) => void;
  readonly requestTimeoutMs: number;
  /** Provider name used only in fault messages. */
  readonly label: string;
  readonly launch: SandboxBrokerLaunch;
  /** Retires the whole environment after transport loss or unacknowledged termination
   * of a non-attached process. Never called for `command.attached` processes. */
  closeEnvironment(): Promise<void>;
}

const fault = (code: ConstructorParameters<typeof SandboxFault>[0], message: string, cause?: unknown) =>
  new SandboxFault(code, message, cause === undefined ? undefined : { cause });
/** A broker `error` frame may name why it refused or failed, from a fixed vocabulary
 * (e.g. `policy`, `interpreter-unavailable`); anything else is reported without a reason. */
const brokerReason = (value: unknown) =>
  typeof value === "string" && /^[a-z][a-z-]{0,63}$/u.test(value) ? value : undefined;
export const encodeBrokerFrame = (value: unknown) =>
  JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029") + "\n";
const toBase64 = (data: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (value: string) => {
  const binary = atob(value),
    data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return data;
};
const encoder = new TextEncoder();

/** Start one command through a launched broker. Transport loss never reconnects or
 * replays input; the caller still owns environment close and admission capacity. */
export async function startBrokerProcess(options: SandboxBrokerOptions): Promise<SandboxProcess> {
  const { id, command, onOutput, requestTimeoutMs, label, closeEnvironment } = options;
  // `attached` is Host-side lifetime only; the guest broker receives the plain command.
  const { attached: attachedFlag, ...wireCommand } = command;
  const attached = attachedFlag === true;
  let resolveStart!: () => void,
    rejectStart!: (error: Error) => void,
    resolveExit!: (exit: SandboxExit) => void,
    rejectExit!: (error: Error) => void;
  let started = false,
    finished = false,
    broken = false,
    buffer = "",
    stdinClosed = false,
    // First observed reason the transport broke; carried as `cause` so callers can diagnose it.
    cause: Error | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  const exited = new Promise<SandboxExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  void ready.catch(() => {});
  void exited.catch(() => {});
  let channel: SandboxBrokerChannel | undefined;
  const failure = (reason?: unknown) => {
    if (broken || finished) return;
    broken = true;
    cause =
      reason instanceof Error ? reason : Error(reason === undefined ? label + " transport ended" : String(reason));
    const error = fault("SANDBOX_START", label + " execution transport failed", cause);
    rejectStart(error);
    rejectExit(error);
    try {
      channel?.dispose?.();
    } catch {}
    // Do not reconnect or replay process input. The caller still owns close()/capacity.
    // An attached relay ends alone: losing its control stream EOFs the guest broker,
    // which kills its process group; environment close reclaims anything left.
    if (attached) return;
    // Defer until the pending launch leaves the environment's tracked set.
    setTimeout(() => {
      void closeEnvironment().catch(() => {});
    }, 0);
  };
  const accept = (chunk: string) => {
    if (broken) return;
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) break;
      if (at > 512 * 1024) {
        failure(Error(label + " broker frame exceeds its budget"));
        return;
      }
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const value = JSON.parse(line);
        if (value.type === "started" && !started) {
          started = true;
          resolveStart();
        } else if (
          value.type === "output" &&
          started &&
          !finished &&
          (value.stream === "stdout" || value.stream === "stderr") &&
          typeof value.data === "string"
        )
          onOutput?.({ stream: value.stream, data: fromBase64(value.data) });
        else if (
          value.type === "exit" &&
          started &&
          !finished &&
          (value.code === null || Number.isSafeInteger(value.code))
        ) {
          finished = true;
          resolveExit({ code: value.code, ...(value.signal ? { signal: String(value.signal) } : {}) });
        } else if (value.type === "error") {
          const reason = brokerReason(value.reason);
          throw Error(label + " broker reported an error" + (reason ? ": " + reason : ""));
        } else throw Error(label + " broker sent an unexpected frame");
      } catch (error) {
        failure(error instanceof SyntaxError ? Error(label + " broker sent an invalid frame") : error);
        return;
      }
    }
    if (buffer.length > 512 * 1024) failure(Error(label + " broker frame exceeds its budget"));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Broker receives argv/cwd/payload environment privately through stdin, not launcher argv.
    const launched = (channel = await options.launch(accept));
    // Launch completed after a failure (e.g. the start timer): release it now.
    if (broken) launched.dispose?.();
    void launched.ended.then(() => {
      if (!finished)
        failure(
          Error(
            started ? label + " broker transport ended" : label + " broker transport ended before the process started",
          ),
        );
    }, failure);
    timer = setTimeout(
      () => failure(Error(label + " broker did not confirm the start in time")),
      Math.min(requestTimeoutMs, 15000),
    );
    const input = encodeBrokerFrame({ type: "start", command: wireCommand });
    if (encoder.encode(input).byteLength > 384 * 1024) throw Error(label + " start frame exceeds its budget");
    await launched.write(input);
    await ready;
  } catch (error) {
    failure(error);
    throw fault("SANDBOX_START", label + " process could not start", cause);
  } finally {
    clearTimeout(timer);
  }
  let input = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const next = input.then(operation);
    input = next.catch(() => {});
    return next;
  };
  const sendFrame = async (value: unknown, reconcileEofExit = false) => {
    if (broken || finished) throw fault("SANDBOX_CLOSED", label + " process is closed");
    try {
      await channel!.write(encodeBrokerFrame(value));
    } catch (error) {
      // A transport can reject EOF after a short-lived broker has exited while
      // its final stdout frame is still in flight. Only that framed exit is
      // authoritative; transport absence alone cannot confirm completion. Never
      // retry EOF, acknowledge ordinary input this way, or revive a broken pipe.
      if (reconcileEofExit && !broken) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited.catch(() => {}),
            new Promise<void>((resolve) => {
              deadline = setTimeout(resolve, Math.min(1000, requestTimeoutMs));
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
        if (finished && !broken) return;
      }
      failure(error);
      throw fault("SANDBOX_START", label + " input transport failed", cause);
    }
  };
  const process = {
    id,
    exited,
    async writeStdin(data: Uint8Array) {
      if (stdinClosed) throw fault("SANDBOX_CLOSED", label + " process stdin is closed");
      // One bounded chunk at a time; preserve ordering against concurrent writes/EOF.
      return enqueue(async () => {
        for (let offset = 0; offset < data.length; offset += 128 * 1024)
          await sendFrame({ type: "stdin", data: toBase64(data.subarray(offset, offset + 128 * 1024)) });
      });
    },
    async closeStdin() {
      if (stdinClosed || finished) return;
      stdinClosed = true;
      await enqueue(async () => {
        if (finished) return;
        try {
          await sendFrame({ type: "eof" }, true);
        } catch (error) {
          if (!finished) throw error;
        }
      });
    },
    async terminate() {
      if (finished) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          enqueue(() => sendFrame({ type: "terminate" })).then(() => exited),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(fault("SANDBOX_START", label + " termination was not acknowledged")),
              Math.min(requestTimeoutMs, 15000),
            );
          }),
        ]);
      } catch {
        if (attached) {
          failure(Error(label + " attached process termination was not acknowledged"));
          throw fault(
            "SANDBOX_CLEANUP",
            label + " attached process termination was not acknowledged; environment close reclaims it",
          );
        }
        await closeEnvironment();
        throw fault("SANDBOX_START", label + " process termination required environment teardown");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
  if (!command.terminal) return { kind: "process", ...process };
  const { closeStdin: _closeStdin, ...terminal } = process;
  return {
    kind: "terminal",
    ...terminal,
    async resize(size: { cols: number; rows: number }) {
      if (![size.cols, size.rows].every((v) => Number.isInteger(v) && v > 0 && v <= 1000))
        throw fault("SANDBOX_POLICY", "Invalid terminal size");
      await enqueue(() => sendFrame({ type: "resize", size }));
    },
  };
}
