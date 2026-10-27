import { performance } from "node:perf_hooks";
import { readFile, writeFile } from "node:fs/promises";
import WebSocket from "ws";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
// Explicit recovery probe: no Turn, tools, model or permission mutations.
class NativeReadTransport implements DuplexTransport {
    status: TransportStatus = { state: "idle" };
    socket: WebSocket | null = null;
    messages = new Set<(frame: string) => void>();
    statuses = new Set<(status: TransportStatus) => void>();
    pending = new Map<unknown, {
        method: string;
        start: number;
    }>();
    constructor(readonly endpoint: string, readonly samples: Record<string, unknown>[]) { }
    subscribeMessage(listener: (frame: string) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
    subscribeStatus(listener: (status: TransportStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
    publish(value: TransportStatus) { this.status = value; for (const listener of this.statuses)
        listener(value); }
    async connect() {
        this.publish({ state: "connecting" });
        const socket = new WebSocket(this.endpoint);
        this.socket = socket;
        socket.on("message", raw => {
            const frame = String(raw), value = JSON.parse(frame), pending = this.pending.get(value.id);
            if (pending) {
                this.samples.push({ method: pending.method, ms: performance.now() - pending.start,
                    bytes: Buffer.byteLength(frame), error: value.error?.code ?? null });
                this.pending.delete(value.id);
            }
            for (const listener of this.messages)
                listener(frame);
        });
        await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
        this.publish({ state: "open" });
    }
    async send(frame: string) {
        const value = JSON.parse(frame);
        if (value.id !== undefined)
            this.pending.set(value.id, { method: value.method, start: performance.now() });
        this.socket!.send(frame);
    }
    async close() { this.publish({ state: "closing" }); this.socket?.close(); this.publish({ state: "closed" }); }
}
const endpoint = process.env.OPENCRAFT_BENCHMARK_HOST_DESCRIPTOR
    ? JSON.parse(await readFile(process.env.OPENCRAFT_BENCHMARK_HOST_DESCRIPTOR, "utf8")).websocketUrl as string
    : process.env.OPENCRAFT_BENCHMARK_NATIVE_URL;
const threadId = process.env.OPENCRAFT_BENCHMARK_THREAD_ID;
if (!endpoint || !threadId)
    throw Error("Explicit OPENCRAFT_BENCHMARK_NATIVE_URL and OPENCRAFT_BENCHMARK_THREAD_ID required");
const rows = [];
for (let i = 0; i < Number(process.env.OPENCRAFT_BENCHMARK_SAMPLES ?? 5); i++) {
    const calls: Record<string, unknown>[] = [];
    const client = new JsonRpcAppServerClient({ hostId: "benchmark", transport: new NativeReadTransport(endpoint, calls), requestTimeoutMs: 60000 });
    await client.connect({ clientInfo: { name: "opencraft-loading-benchmark", version: "1" }, capabilities: { experimentalApi: true } });
    const capability = client.initializeResult?.capabilities?.extensions?.["opencraft/resume-history"] as {
        mode?: "paginated";
    } | undefined;
    const session = await createCordisThreadSessionRuntime({ client, hostKind: "durable", useTailHydration: true,
        historyModeHint: capability?.mode ?? null, requestTimeoutMs: 60000 });
    let firstVisibleMs: number | null = null;
    const start = performance.now();
    const stop = session.views.subscribeThread(threadId, () => {
        const view = session.views.get(threadId);
        if (firstVisibleMs === null && view?.turns.some(turn => turn.items?.length))
            firstVisibleMs = performance.now() - start;
    });
    try {
        const view = await session.resume.resume({ threadId });
        rows.push({ firstVisibleMs, readyMs: performance.now() - start, turns: view.turns.length,
            items: view.turns.reduce((n, t) => n + (t.items?.length ?? 0), 0), calls });
        console.log(JSON.stringify(rows.at(-1)));
    }
    finally {
        stop();
        await session.dispose();
        await client.close();
    }
}
if (process.env.OPENCRAFT_BENCHMARK_OUTPUT)
    await writeFile(process.env.OPENCRAFT_BENCHMARK_OUTPUT, JSON.stringify(rows, null, 2), { mode: 0o600 });
