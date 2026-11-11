import { CursorError } from "../../../apps/cursor-bridge/src/cursor.js";
import { InputFiles } from "../../../apps/cursor-bridge/src/input.js";
import { access, appendFile } from "node:fs/promises";
import { runCursorStdio } from "../../../apps/cursor-bridge/src/main.js";
import type { CursorRun } from "../../../apps/cursor-bridge/src/types.js";
import type { RunResult } from "@cursor/sdk";
let unblockPreparation: (() => void) | undefined;
let preparations = 0;
const prepare = InputFiles.prototype.prepare;
InputFiles.prototype.prepare = async function () {
  if (process.env.CURSOR_FIXTURE_OUTCOME === "preparing-cleanup" && ++preparations > 1) await new Promise<void>((resolve) => { unblockPreparation = resolve; });
  return prepare.call(this);
};
const dispose = InputFiles.prototype.dispose;
InputFiles.prototype.dispose = async function () {
  if (["cleanup-retry", "preparing-cleanup"].includes(process.env.CURSOR_FIXTURE_OUTCOME ?? "")) {
    try { await access(process.env.CURSOR_FIXTURE_LOG + ".cleanup-ok"); } catch { throw Error("fixture cleanup blocked"); }
  }
  await dispose.call(this);
};
let closes = 0;
let count = 0;
let creates = 0;
runCursorStdio({ hasCredentials: async () => process.env.CURSOR_FIXTURE_AUTH !== "missing", models: async () => [{ id: "fixture", name: "Fixture" }], create: async () => {
  if (process.env.CURSOR_FIXTURE_OUTCOME === "create-retry" && creates++ === 0) throw new CursorError("invalid", "Check the requested model");
  return ({
  agentId: "fixture-agent", close: async () => { if (process.env.CURSOR_FIXTURE_OUTCOME === "close-retry" && closes++ === 0) throw Error("fixture close blocked"); }, send: async () => {
    const id = `fixture-run-${++count}`;
    if (process.env.CURSOR_FIXTURE_LOG) await appendFile(process.env.CURSOR_FIXTURE_LOG, "send\n");
    let resolve!: (r: RunResult) => void;
    const terminal = new Promise<RunResult>((r) => { resolve = r; });
    const timer = setTimeout(() => resolve({ id, status: "finished" }), 200);
    const run: CursorRun = {
      id, steer: async () => {
        if (process.env.CURSOR_FIXTURE_LOG) await appendFile(process.env.CURSOR_FIXTURE_LOG, "steer\n");
        if (process.env.CURSOR_FIXTURE_OUTCOME === "unknown") throw Error("SDK response lost");
        return process.env.CURSOR_FIXTURE_OUTCOME === "followup" ? "revert_to_followup" : "complete_delivered";
      },
      async *stream() {
        yield { type: "tool_call", agent_id: "fixture-agent", run_id: id, call_id: `tool-${count}`, name: "shell", status: "running" };
        await terminal;
        yield { type: "tool_call", agent_id: "fixture-agent", run_id: id, call_id: `tool-${count}`, name: "shell", status: "completed" };
      },
      wait: () => terminal, cancel: async () => { clearTimeout(timer); unblockPreparation?.(); resolve({ id, status: "cancelled" }); },
    };
    return run;
  },
}); } });
