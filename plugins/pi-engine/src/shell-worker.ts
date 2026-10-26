import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createEventBus, ModelRuntime, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
const packagedExtension = new URL("./pi-shell-extension.mjs", import.meta.url);
const { default: extensionFactory, commandResult } = await import((existsSync(packagedExtension) ? packagedExtension : new URL("./shell-extension.mjs", import.meta.url)).href);

// CLI extensions own process-global state. A process belongs to exactly one durable conversation.
const entry = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createExtensionRuntime, loadExtensionFromFactory } = await import(new URL("./core/extensions/loader.js", entry).href);
const { ExtensionRunner } = await import(new URL("./core/extensions/runner.js", entry).href);
const { cwd, directory } = JSON.parse(process.argv[2]!);
await mkdir(directory, { recursive: true });
const runtime = createExtensionRuntime();
const extension = await loadExtensionFromFactory(extensionFactory, cwd, createEventBus(), runtime);
const models = await ModelRuntime.create({ allowModelNetwork: false, authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json") });
const runner = new ExtensionRunner([extension], runtime, cwd, SessionManager.inMemory(cwd), new ModelRegistry(models));
let activeTools: string[] = ["interactive_shell"];
const send = (message: unknown) => { if (process.connected) process.send?.(message); };
runner.onError(() => send({ type: "fault", error: "Pi shell extension lifecycle failed" }));
const unsupported = () => { throw new Error("This CLI operation is not available in a headless Pi session"); };
runner.bindCore({
  sendMessage: (message: any, options: any) => send({ type: "notification", message, triggerTurn: options?.triggerTurn === true, commandResult: commandResult(message.details?.sessionId) }),
  sendUserMessage: unsupported, appendEntry: unsupported, setSessionName: unsupported,
  getSessionName: () => undefined, setLabel: unsupported,
  getActiveTools: () => activeTools,
  getAllTools: () => [...extension.tools.values()].map((tool: any) => tool.definition),
  getSettings: () => ({}), setActiveTools: (names: string[]) => { activeTools = names; }, refreshTools() {}, getCommands: () => [],
  setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel: unsupported,
}, {
  getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true,
  getSignal: () => undefined, abort: unsupported, hasPendingMessages: () => false, shutdown: unsupported,
  getContextUsage: () => undefined, compact: unsupported, getSystemPrompt: () => "",
});
runner.setUIContext(undefined, "rpc");
await runner.emit({ type: "session_start" });
const tool = extension.tools.get("interactive_shell")!.definition;
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  try { await runner.emit({ type: "session_shutdown", reason: "exit" }); }
  finally {
    // The upstream extension retains history timers. This isolated owner has no other work to keep alive.
    if (process.connected) process.send?.({ type: "closed" }, () => process.exit(0));
    else process.exit(0);
  }
}
let line = Promise.resolve();
process.on("message", (message: any) => {
  if (message?.type === "close") { void shutdown(); return; }
  if (message?.type !== "call" || closing) return;
  line = line.then(async () => {
    try {
      const result = await tool.execute(String(message.id), message.args, new AbortController().signal, undefined,
        runner.createToolContext(String(message.id), undefined));
      send({ type: "result", id: message.id, result });
    } catch { send({ type: "result", id: message.id, result: { isError: true, content: [{ type: "text", text: "Pi interactive shell operation failed" }] } }); }
  }).catch(() => send({ type: "fault", error: "Pi shell request failed" }));
});
process.on("disconnect", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
send({ type: "ready", description: tool.description, parameters: tool.parameters });
