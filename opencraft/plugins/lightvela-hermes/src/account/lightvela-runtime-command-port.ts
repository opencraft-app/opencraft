import type { AppServerClient, AppServerClientRegistryService } from "@opencraft/appserver-client";
import type { AppServerNotification, CommandExecResponse } from "@opencraft/appserver-protocol";
import { Utf8StreamDecoder } from "../lib/utf8";

import {
  LIGHTVELA_HERMES_HOST_ID,
  LIGHTVELA_HOST_BINDING_EXTENSION,
  parseLightVelaHostBindingCapability,
} from "../host/lightvela-hermes-host-identity";
import type {
  LightVelaDebugCommandChunk,
  LightVelaDebugCommandResult,
} from "./lightvela-account-service";

export interface LightVelaRuntimeCommandOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Returns null only before accepting ownership. Once accepted, failures belong
 * to AppServer and must not be retried through the control-plane HTTP API.
 */
export interface LightVelaRuntimeCommandPort {
  execIfAvailable(
    botId: string,
    command: string,
    onChunk: ((chunk: LightVelaDebugCommandChunk) => void) | undefined,
    options?: LightVelaRuntimeCommandOptions,
  ): Promise<LightVelaDebugCommandResult | null>;
  /** Borrow a Host extension method without opening another TAT session. */
  requestIfAvailable?<TResult>(
    botId: string,
    method: string,
    params: unknown,
    options?: LightVelaRuntimeCommandOptions,
  ): Promise<TResult | null>;
}

function randomProcessId(): string {
  return `lightvela-command:${crypto.randomUUID()}`;
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function boundClient(
  clients: AppServerClientRegistryService,
  botId: string,
): AppServerClient | null {
  const client = clients.get(LIGHTVELA_HERMES_HOST_ID);
  if (client?.status.state !== "open") return null;
  const extensions = client.initializeResult?.capabilities?.extensions;
  const binding = parseLightVelaHostBindingCapability(
    extensions?.[LIGHTVELA_HOST_BINDING_EXTENSION],
  );
  return binding?.instanceId === botId ? client : null;
}

export class AppServerLightVelaRuntimeCommandPort implements LightVelaRuntimeCommandPort {
  constructor(private readonly clients: AppServerClientRegistryService) {}

  async requestIfAvailable<TResult>(
    botId: string,
    method: string,
    params: unknown,
    options: LightVelaRuntimeCommandOptions = {},
  ): Promise<TResult | null> {
    const client = boundClient(this.clients, botId);
    if (client === null) return null;
    return await client.requestRaw<TResult>(method, params, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30_000,
      priority: "user-blocking",
    });
  }

  async execIfAvailable(
    botId: string,
    command: string,
    onChunk: ((chunk: LightVelaDebugCommandChunk) => void) | undefined,
    options: LightVelaRuntimeCommandOptions = {},
  ): Promise<LightVelaDebugCommandResult | null> {
    const client = boundClient(this.clients, botId);
    if (client === null) return null;

    const processId = randomProcessId();
    const stdoutDecoder = new Utf8StreamDecoder();
    const stderrDecoder = new Utf8StreamDecoder();
    let output = "";
    const consume = (stream: "stdout" | "stderr", deltaBase64: string): void => {
      const decoder = stream === "stdout" ? stdoutDecoder : stderrDecoder;
      const chunk = decoder.decode(decodeBase64Bytes(deltaBase64), { stream: true });
      if (chunk === "") return;
      output += chunk;
      onChunk?.({ stream, chunk });
    };
    const unsubscribe = client.subscribeNotification((notification: AppServerNotification) => {
      if (notification.method !== "command/exec/outputDelta") return;
      if (notification.params === null || typeof notification.params !== "object") return;
      const params = notification.params as Record<string, unknown>;
      if (params.processId !== processId) return;
      if (params.stream !== "stdout" && params.stream !== "stderr") return;
      if (typeof params.deltaBase64 !== "string") return;
      consume(params.stream, params.deltaBase64);
    });

    let completed = false;
    try {
      const result: CommandExecResponse = await client.request("command/exec", {
        command: ["/bin/bash", "--noprofile", "--norc", "-lc", command],
        processId,
        streamStdoutStderr: true,
        ...(options.timeoutMs === undefined || options.timeoutMs <= 0
          ? { disableTimeout: true }
          : { timeoutMs: options.timeoutMs }),
      }, {
        signal: options.signal,
        // The remote command owns its timeout. The client request must remain
        // alive long enough to receive the protocol's terminal response.
        timeoutMs: 0,
        priority: "user-blocking",
      });
      completed = true;
      const stdoutTail = stdoutDecoder.decode();
      const stderrTail = stderrDecoder.decode();
      for (const [stream, chunk] of [["stdout", stdoutTail], ["stderr", stderrTail]] as const) {
        if (chunk === "") continue;
        output += chunk;
        onChunk?.({ stream, chunk });
      }
      if (result.stdout !== "") {
        output += result.stdout;
        onChunk?.({ stream: "stdout", chunk: result.stdout });
      }
      if (result.stderr !== "") {
        output += result.stderr;
        onChunk?.({ stream: "stderr", chunk: result.stderr });
      }
      return {
        status: result.exitCode === 0 ? "SUCCESS" : "FAILED",
        exitCode: result.exitCode,
        output,
      };
    } finally {
      unsubscribe();
      if (!completed) {
        void client.request("command/exec/terminate", { processId }, {
          timeoutMs: 5_000,
          priority: "user-blocking",
        }).catch(() => undefined);
      }
    }
  }
}
