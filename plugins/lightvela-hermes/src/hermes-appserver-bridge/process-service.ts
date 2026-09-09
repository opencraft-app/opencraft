import type { ProcessOutput, ProcessSnapshot } from "@opencraft/appserver-protocol";
import { HermesTatTerminalService } from "./tat-terminal";

/** Host transport lifetime, not bridge/socket lifetime. No persistence across page reloads. */
export class HermesProcessService {
  private records = new Map<string, ProcessSnapshot>();
  private listeners = new Set<(event: { jsonrpc: "2.0"; method: string; params: unknown }) => void>();
  private remove: () => void;
  constructor(private terminal: HermesTatTerminalService) {
    this.remove = terminal.subscribeNotification(({ params }) => {
      const record = this.records.get(params.processId);
      if (!record) return;
      const output: ProcessOutput = { processHandle: params.processId, sequence: ++record.nextSequence,
        stream: params.stream, deltaBase64: params.deltaBase64 };
      record.output.push(output);
      let size = record.output.reduce((sum, row) => sum + row.deltaBase64.length, 0);
      while (size > 4 * 1024 * 1024 && record.output.length > 1) {
        size -= record.output.shift()!.deltaBase64.length;
        record.truncated = true;
      }
      this.emit("process/outputDelta", output);
    });
  }
  subscribeNotification(listener: (event: { jsonrpc: "2.0"; method: string; params: unknown }) => void) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private emit(method: string, params: unknown) {
    for (const listener of this.listeners) listener({ jsonrpc: "2.0", method, params });
  }
  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "process/list") return { processes: [...this.records.values()].map(({ output, ...record }) => ({ ...record })) };
    const id = params.processHandle;
    if (typeof id !== "string" || !id) throw new Error("processHandle is required");
    if (method === "process/spawn") {
      if (this.records.has(id)) throw new Error(`Process already exists: ${id}`);
      const record: ProcessSnapshot = { processHandle: id, phase: "running", exitCode: null,
        output: [], nextSequence: 0, truncated: false };
      this.records.set(id, record);
      try {
        const completion = this.terminal.exec({ ...params, processId: id, tty: true, streamStdin: true });
        void completion.then(result => this.exit(record, result.exitCode), () => this.exit(record, 1));
        const ready = this.terminal.whenReady(id);
        await ready;
        return { processHandle: id };
      } catch (error) { this.records.delete(id); throw error; }
    }
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown Hermes process: ${id}; create a new terminal`);
    if (method === "process/attach") {
      const after = params.afterSequence ?? 0;
      if (!Number.isSafeInteger(after) || Number(after) < 0) throw new Error("Invalid output cursor");
      return { ...record, output: record.output.filter(row => row.sequence > Number(after)),
        truncated: record.truncated && Number(after) < (record.output[0]?.sequence ?? 1) - 1 };
    }
    if (method === "process/kill" && record.phase === "exited") return {};
    if (record.phase !== "running") throw new Error("Terminal has exited");
    const translated = { ...params, processId: id };
    switch (method) {
      case "process/writeStdin": await this.terminal.write(translated); break;
      case "process/resizePty": await this.terminal.resize(translated); break;
      case "process/kill": await this.terminal.terminate(translated); break;
      default: throw new Error(`Unsupported process method: ${method}`);
    }
    return {};
  }
  private exit(record: ProcessSnapshot, exitCode: number) {
    record.phase = "exited"; record.exitCode = exitCode;
    this.emit("process/exited", { processHandle: record.processHandle, exitCode });
  }
  dispose() { this.remove(); this.listeners.clear(); this.terminal.dispose(); this.records.clear(); }
}
