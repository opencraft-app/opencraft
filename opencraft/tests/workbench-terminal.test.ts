import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { AppServerTerminalController } from "@opencraft/workbench-runtime";
import { HostProcessService } from "../apps/local-agent-host/src/process-service";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import {
  createTerminalWorkbenchPanelPlugin,
  pasteIntoActiveTerminal,
  terminalBoxIsVisible,
  terminalGridSizeChanged,
  WorkbenchTerminalSessionRegistry,
} from "../plugins/terminal/src/index";

test("terminal grid helpers reject hidden boxes and duplicate PTY sizes", () => {
  assert.equal(terminalBoxIsVisible(640, 360), true);
  assert.equal(terminalBoxIsVisible(0, 360), false);
  assert.equal(terminalBoxIsVisible(640, 0), false);
  assert.equal(terminalBoxIsVisible(Number.NaN, 360), false);
  assert.equal(terminalGridSizeChanged(null, { cols: 80, rows: 24 }), true);
  assert.equal(terminalGridSizeChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }), false);
  assert.equal(terminalGridSizeChanged({ cols: 80, rows: 24 }, { cols: 79, rows: 24 }), true);
});

test("pasting uses xterm's paste path and never sends a late clipboard result to another terminal", () => {
  const calls: string[] = [];
  const first = { paste(text: string) { calls.push(`first:${text}`); }, focus() { calls.push("focus:first"); } };
  const second = { paste(text: string) { calls.push(`second:${text}`); }, focus() { calls.push("focus:second"); } };
  assert.equal(pasteIntoActiveTerminal(first, first, "echo one\necho two", true), true);
  assert.deepEqual(calls, ["first:echo one\necho two", "focus:first"]);
  assert.equal(pasteIntoActiveTerminal(first, second, "stale", true), false);
  assert.equal(pasteIntoActiveTerminal(second, second, "", true), false);
  assert.equal(pasteIntoActiveTerminal(second, second, "offline", false), false);
  assert.deepEqual(calls, ["first:echo one\necho two", "focus:first"]);
});

test("terminal visual inset is outside the measured xterm host", () => {
  const source = readFileSync(
    new URL("../plugins/terminal/src/index.tsx", import.meta.url),
    "utf8",
  );
  const styles = readFileSync(
    new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url),
    "utf8",
  );

  assert.match(source, /className="terminal-panel__inset"[\s\S]*?className="terminal-panel__host" ref=\{hostRef\}/u);
  assert.match(source, /terminal\.open\(host\)/u);
  assert.match(source, /resizeObserver\.observe\(host\)/u);
  assert.match(source, /resizeObserver\.observe\(host\);\s*fitAndPublish\(\);\s*scheduleFit\(\);/u);
  assert.match(source, /fontSet\.addEventListener\("loadingdone"/u);
  assert.match(source, /terminalGridSizeChanged\(lastPublishedGrid, nextGrid\)/u);
  assert.doesNotMatch(source, /terminal\.open\(slot\)|resizeObserver\.observe\(slot\)/u);
  assert.match(styles, /\.terminal-panel__inset\s*\{[\s\S]*?padding:\s*9px 10px;/u);
  assert.match(styles, /\.terminal-panel__host\s*\{[\s\S]*?width:\s*100%;[\s\S]*?overflow:\s*hidden;/u);
});

test("terminal measurement and rendering do not inherit application text tracking", () => {
  const source = readFileSync(new URL("../plugins/terminal/src/index.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");
  const boundary = styles.slice(styles.indexOf(".terminal-panel__host {"), styles.indexOf(".terminal-panel__status {"));
  assert.match(source, /letterSpacing:\s*0/u);
  assert.match(boundary, /letter-spacing:\s*normal/u);
  assert.match(boundary, /word-spacing:\s*normal/u);
  assert.match(boundary, /text-transform:\s*none/u);
  assert.doesNotMatch(boundary, /\.xterm-rows/u, "xterm owns the renderer's internal spacing compensation");
});

test("terminal contributes a direct shortcut and a type for the shared panel picker", async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  const registry = new WorkbenchTerminalSessionRegistry(() => { throw new Error("No host required for contribution test"); });
  const calls: string[] = [];
  registry.open = options => { calls.push(`new:${options.hostId}:${options.cwd}`); return "new"; };
  registry.restore = async hostId => { calls.push(`restore:${hostId}`); return ["restored"]; };
  try {
    await runtime.install(createTerminalWorkbenchPanelPlugin(registry));
    const actions = runtime.panels.getToolbarActionSnapshot();
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.label, "New terminal");
    assert.equal(actions[0]?.creationLabel, "Terminal");
    assert.equal("tabKind" in actions[0]!, false);
    assert.equal("items" in actions[0]!, false);
    const context = { hostId: "local", ownerId: "view", resourceOwnerId: "resource", cwd: "/workspace" };
    await actions[0]!.run(context);
    await actions[0]!.run(context);
    assert.deepEqual(calls, ["new:local:/workspace", "new:local:/workspace"]);
  } finally { await runtime.dispose(); await registry.dispose(); }
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Terminal test timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture() {
  const service = new HostProcessService();
  const peers = new Set<InMemoryAppServerPeer>();
  const methods: string[] = [];
  const remove = service.subscribe((method, params) => {
    for (const peer of peers) peer.send(encodeJsonRpcMessage({ method, params }));
  });
  const client = new JsonRpcAppServerClient({ hostId: "local", transport: new MemoryTransport({
    connected(peer) { peers.add(peer); },
    receive(frame, peer) {
      const message = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(message)) return;
      methods.push(message.method);
      try {
        const result = message.method === "initialize"
          ? { codexHome: "/tmp", platformFamily: "unix", platformOs: process.platform, userAgent: "test" }
          : service.dispatch(message.method, message.params);
        peer.send(encodeJsonRpcMessage({ id: message.id, result }));
      } catch (cause) {
        peer.send(encodeJsonRpcMessage({ id: message.id, error: { code: -32603, message: String(cause) } }));
      }
    },
  }) });
  await client.connect({ clientInfo: { name: "pty-test", version: "1" } });
  const controller = new AppServerTerminalController("local", client);
  return { service, controller, methods,
    disconnect() { for (const peer of peers) peer.close("test link loss"); peers.clear(); },
    async reconnect() { await client.connect({ clientInfo: { name: "pty-test", version: "1" } }); await controller.reconnect(); },
    async close() { remove(); await controller.dispose(); await client.close(); service.close(); } };
}

test("real shell uses process RPC for input, resize, output and exit", async () => {
  const f = await fixture();
  try {
    const session = f.controller.open({ command: ["/bin/bash", "--noprofile", "--norc"], cols: 80, rows: 24 });
    await session.resize(101, 37);
    await session.write(Buffer.from("stty size; printf 'PTY_%s\\n' VERIFIED; exit 7\n").toString("base64"));
    await waitFor(() => session.getSnapshot().phase === "exited");
    const output = session.getSnapshot().output.map(c => Buffer.from(c.deltaBase64, "base64").toString()).join("");
    assert.match(output, /37 101/);
    assert.match(output, /PTY_VERIFIED/);
    assert.equal(session.getSnapshot().exitCode, 7);
    assert.ok(f.methods.includes("process/spawn"));
    assert.ok(f.methods.includes("process/writeStdin"));
    assert.ok(f.methods.includes("process/resizePty"));
    assert.ok(f.methods.every(method => !method.startsWith("command/exec")));
  } finally { await f.close(); }
});

test("detaching does not kill the shell; a new attachment replays and can explicitly close it", async () => {
  const f = await fixture();
  try {
    const first = f.controller.open({ command: ["/bin/bash", "--noprofile", "--norc"], cols: 80, rows: 24 });
    await first.write(Buffer.from("export REATTACH_VALUE=survived\n").toString("base64"));
    const id = first.processId;
    await first.dispose();
    const listed = await f.controller.list();
    assert.equal(listed.processes.find(p => p.processHandle === id)?.phase, "running");
    const second = f.controller.attach(id);
    await second.write(Buffer.from("printf 'RESTORED_%s\\n' \"$REATTACH_VALUE\"\n").toString("base64"));
    await waitFor(() => second.getSnapshot().output.some(c => Buffer.from(c.deltaBase64, "base64").toString().includes("RESTORED_survived")));
    const seq = second.getSnapshot().output.map(c => c.sequence);
    assert.equal(new Set(seq).size, seq.length);
    await second.terminate();
    await waitFor(() => second.getSnapshot().phase === "exited");
  } finally { await f.close(); }
});

test("reconnecting restores the same projection only after AppServer initialization", async () => {
  const f = await fixture();
  try {
    const session = f.controller.open({ command: ["/bin/bash", "--noprofile", "--norc"], cols: 80, rows: 24 });
    await session.write(Buffer.from("export RECONNECTED=yes\n").toString("base64"));
    f.disconnect();
    assert.equal(session.getSnapshot().phase, "disconnected");
    await assert.rejects(session.write("YQ=="));
    await f.reconnect();
    assert.equal(session.getSnapshot().phase, "running");
    await session.write(Buffer.from("printf 'LINK_%s\\n' \"$RECONNECTED\"\n").toString("base64"));
    await waitFor(() => session.getSnapshot().output.some(c => Buffer.from(c.deltaBase64, "base64").toString().includes("LINK_yes")));
    assert.ok(f.methods.includes("process/attach"));
  } finally { await f.close(); }
});

test("host rejects duplicate process handles, invalid cursors and invalid dimensions", () => {
  const service = new HostProcessService();
  try {
    service.dispatch("process/spawn", { processHandle: "test", command: ["/bin/bash"], tty: true, size: { cols: 80, rows: 24 } });
    assert.throws(() => service.dispatch("process/spawn", { processHandle: "test" }), /already exists/);
    assert.throws(() => service.dispatch("process/attach", { processHandle: "test", afterSequence: -1 }), /cursor/);
    assert.throws(() => service.dispatch("process/resizePty", { processHandle: "test", size: { cols: 0, rows: 24 } }), /size/);
  } finally { service.close(); }
});
