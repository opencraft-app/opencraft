import { readFile, writeFile } from "node:fs/promises";

import {
  createCordisAppServerRegistry,
  type AppServerClient,
} from "@opencraft/appserver-client";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import {
  RecordingTransport,
  ReplayTransport,
  type RecordedFrame,
} from "@opencraft/appserver-transport-replay";
import {
  type AppServerWebSocket,
  WebSocketTransport,
} from "@opencraft/appserver-transport-websocket";
import WebSocket from "ws";

import { LabUsageError, parseLabArgs, usageText } from "./args";
import { FaultInjectingTransport } from "./fault-injecting-transport";
import { NotificationJournal } from "./notification-journal";
import { NdjsonReporter } from "./reporter";
import { RequestJournal } from "./request-journal";
import { runLabCommand } from "./scenarios";

async function loadReplay(path: string): Promise<readonly RecordedFrame[]> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error("Replay recording must be a JSON array");
  return value as RecordedFrame[];
}

function observeClient(
  client: AppServerClient,
  reporter: NdjsonReporter,
  journal: RequestJournal,
  notifications: NotificationJournal,
): () => void {
  const removeStatus = client.subscribeStatus((status) => reporter.emit("transport.status", {
    hostId: client.hostId,
    state: status.state,
    reason: status.reason ?? null,
  }));
  const removeLifecycle = client.subscribeRequestLifecycle((event) => {
    journal.handle(event);
    reporter.emit(`request.lifecycle.${event.type}`, {
      hostId: event.hostId,
      id: "id" in event ? event.id : null,
      method: "method" in event ? event.method : null,
      pendingRequests: client.getPendingRequestCount(),
    });
  });
  const removeNotification = client.subscribeNotification((notification) => {
    const observation = notifications.handle(notification);
    if (observation.emitSample) {
      reporter.emit("appserver.notification", {
        method: notification.method,
        occurrence: observation.count,
        params: notification.params,
      });
    } else if (observation.emitSuppressedMarker) {
      reporter.emit("appserver.notification.suppressed", {
        method: notification.method,
        sampled: observation.count - 1,
      });
    }
  });
  const removeProtocolError = client.subscribeProtocolError((error) => reporter.emit("appserver.protocol-error", {
    error,
  }));
  return () => {
    removeStatus();
    removeLifecycle();
    removeNotification();
    removeProtocolError();
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const reporter = new NdjsonReporter({ write: (line) => process.stdout.write(line) });
  let options;
  try {
    options = parseLabArgs(argv);
  } catch (error) {
    reporter.emit("lab.usage-error", { error, usage: usageText });
    return error instanceof LabUsageError ? 2 : 1;
  }

  let recording: RecordingTransport | null = null;
  let runtime: Awaited<ReturnType<typeof createCordisAppServerRegistry>> | null = null;
  let removeObservers: (() => void) | null = null;
  let failure: unknown = null;
  let journal: RequestJournal | null = null;
  let notifications: NotificationJournal | null = null;
  try {
    let physicalTransport: DuplexTransport;
    if (options.replayPath !== undefined) {
      physicalTransport = new ReplayTransport({
        recording: await loadReplay(options.replayPath),
        match: "json-rpc",
        timing: "immediate",
      });
      reporter.emit("transport.selected", { kind: "replay", path: options.replayPath });
    } else {
      physicalTransport = new WebSocketTransport({
        url: options.url,
        closeTimeoutMs: 250,
        createSocket: (url) => new WebSocket(url) as unknown as AppServerWebSocket,
      });
      reporter.emit("transport.selected", { kind: "websocket", url: options.url });
    }
    if (options.recordPath !== undefined) {
      recording = new RecordingTransport({ transport: physicalTransport });
      physicalTransport = recording;
    }

    const faultTransport = new FaultInjectingTransport({ transport: physicalTransport });
    runtime = await createCordisAppServerRegistry();
    const client = runtime.clients.create({
      hostId: options.hostId,
      transport: faultTransport,
      requestTimeoutMs: options.timeoutMs,
    });
    journal = new RequestJournal();
    notifications = new NotificationJournal();
    removeObservers = observeClient(client, reporter, journal, notifications);
    await runLabCommand(options.command, {
      client,
      transport: faultTransport,
      reporter,
      options,
    });
  } catch (error) {
    failure = error;
  } finally {
    removeObservers?.();
    try {
      await runtime?.dispose();
    } catch (error) {
      failure ??= error;
    }
    if (recording !== null && options.recordPath !== undefined) {
      try {
        await writeFile(options.recordPath, `${JSON.stringify(recording.recording, null, 2)}\n`, "utf8");
        reporter.emit("recording.written", {
          path: options.recordPath,
          frames: recording.recording.length,
        });
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure !== null) {
    reporter.emit("lab.result", {
      status: "fail",
      error: failure,
      requests: journal?.getSnapshot() ?? [],
      notifications: notifications?.getSnapshot() ?? [],
    });
    return 1;
  }
  reporter.emit("lab.result", {
    status: "pass",
    requests: journal?.getSnapshot() ?? [],
    notifications: notifications?.getSnapshot() ?? [],
  });
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
