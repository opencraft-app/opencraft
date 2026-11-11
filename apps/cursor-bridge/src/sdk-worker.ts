/** Vendor runtime and storage live off the bridge's network event loop. */
import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { sdkErrorKind } from "./sdk-errors.js";
import { createWriteStream } from "node:fs";
import { hasCursorCredentials } from "./credentials.js";
import { parentPort } from "node:worker_threads";
import { Agent, Cursor, JsonlLocalAgentStore, ConfigurationError, type SDKAgent, type Run } from "@cursor/sdk";

const port = parentPort!;
const trace = process.env.CURSOR_BRIDGE_TRACE ? createWriteStream(process.env.CURSOR_BRIDGE_TRACE, { flags: "a", mode: 0o600 }) : undefined;
trace?.on("error", () => {});
function record(event: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => { if (trace) trace.write(JSON.stringify(event) + "\n", () => resolve()); else resolve(); });
}
let agent: SDKAgent | undefined;
const runs = new Map<string, Run>();
port.on("message", async (request: { id: number; method: string; params: Record<string, string> }) => {
  const { id, method, params: p } = request;
  try {
    let result: unknown;
    if (["auth", "models", "create"].includes(method)) {
      const available = await hasCursorCredentials(process.env, () => Cursor.auth.status());
      if (method === "auth") { port.postMessage({ id, result: available }); return; }
      if (!available) { port.postMessage({ id, error: "auth" }); return; }
    }
    if (method === "models") result = (await Cursor.models.list()).map((m) => ({ id: m.id, name: m.displayName }));
    else if (method === "create") {
      try {
        if (!(await stat(p.cwd)).isDirectory()) throw Error("not a directory");
        await access(p.cwd, constants.R_OK | constants.X_OK);
        await mkdir(p.stateDirectory, { recursive: true, mode: 0o700 });
        if (!(await stat(p.stateDirectory)).isDirectory()) throw Error("not a directory");
        await access(p.stateDirectory, constants.R_OK | constants.W_OK | constants.X_OK);
      } catch { throw new ConfigurationError("Workspace or private SDK state directory is not available"); }
      agent = await Agent.create({ model: { id: p.model }, tools: ["shell"],
        local: { cwd: p.cwd, store: new JsonlLocalAgentStore(p.stateDirectory), settingSources: [], autoReview: false, sandboxOptions: { enabled: false }, enableAgentRetries: false } });
      result = { agentId: agent.agentId };
      await record({ operation: "create", agentId: agent.agentId });
    } else if (method === "send") {
      if (!agent) throw Error("agent unavailable");
      const run = await agent.send(p.text);
      runs.set(run.id, run);
      await record({ operation: "send", runId: run.id });
      port.postMessage({ id, result: { id: run.id, supportsSteer: typeof run.steer === "function" } });
      void (async () => {
        try {
          for await (const message of run.stream()) {
            await record({ operation: "stream", runId: run.id, type: message.type,
              ...(message.type === "tool_call" ? { callId: message.call_id, name: message.name, status: message.status } : {}) });
            port.postMessage({ event: "message", runId: run.id, message });
          }
          const terminal = await run.wait();
          await record({ operation: "terminal", runId: run.id, status: terminal.status });
          port.postMessage({ event: "terminal", runId: run.id, result: terminal });
        } catch { port.postMessage({ event: "terminal", runId: run.id, error: "SDK run failed; inspect private native logs" }); }
      })();
      return;
    } else if (method === "steer") {
      const run = runs.get(p.runId);
      if (!run?.steer) throw Error("SDK run has no steer");
      const delivery = run.steer(p.text);
      void delivery.catch(() => {});
      await record({ operation: "steer-dispatch", runId: run.id });
      result = await delivery;
      await record({ operation: "steer", runId: run.id, outcome: result });
    } else if (method === "cancel") {
      const run = runs.get(p.runId);
      if (!run) throw Error("SDK run unavailable");
      await run.cancel(); result = await run.wait();
    } else if (method === "close") { if (agent) await agent[Symbol.asyncDispose](); result = {}; }
    else throw Error("unsupported SDK operation");
    port.postMessage({ id, result });
  } catch (error) {
    // No raw errors/paths/credentials are sent to the Host or public recording.
    let classification = sdkErrorKind(method, error);
    if (method === "create" && agent) {
      try { await agent[Symbol.asyncDispose](); agent = undefined; }
      catch { classification = "unknown-outcome"; }
    }
    await record({ operation: method, error: classification });
    port.postMessage({ id, error: classification });
  }
});
