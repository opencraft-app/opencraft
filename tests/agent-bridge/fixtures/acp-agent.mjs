#!/usr/bin/env node
/**
 * Deterministic ACP agent fixture. It exercises the bridge's ACP boundary
 * without a model, network or real tool:
 *
 * - initialize capabilities, optional `_meta.midTurnSteering`
 * - session/new modes and config options
 * - streaming message/thought/tool/plan/usage updates
 * - session/request_permission round trip
 * - optional concurrent-prompt native steering and user echo
 * - cancellation
 *
 * It appends every received frame to `ACP_FIXTURE_LOG` when set. It executes
 * no command from the transcript.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const nativeSteer = process.env.ACP_FIXTURE_NATIVE_STEER === "1";
const images = process.env.ACP_FIXTURE_IMAGE !== "0";
const permission = process.env.ACP_FIXTURE_PERMISSION === "1";
const modes = process.env.ACP_FIXTURE_MODES === "1";
const config = process.env.ACP_FIXTURE_CONFIG === "1";
const load = process.env.ACP_FIXTURE_LOAD === "1";
const fixtureModels = process.env.ACP_FIXTURE_MODELS === "1";
const clientCalls = process.env.ACP_FIXTURE_CLIENT === "1";
const delay = Number(process.env.ACP_FIXTURE_DELAY_MS ?? 60);
const sessionId = process.env.ACP_FIXTURE_SESSION_ID ?? "fixture-session-1";
const log = process.env.ACP_FIXTURE_LOG;

let nextServerId = 0;
const pendingServerRequests = new Map();
const active = new Map();
let mainPrompts = 0;

function write(frame) {
  const line = JSON.stringify({ jsonrpc: "2.0", ...frame });
  if (process.env.ACP_FIXTURE_SEND_LOG) appendFileSync(process.env.ACP_FIXTURE_SEND_LOG, line + "\n");
  process.stdout.write(line + "\n");
}
function response(id, result) {
  write({ id, result });
}
function failure(id, code, message) {
  write({ id, error: { code, message } });
}
function notify(method, params) {
  write({ method, params });
}
function serverRequest(method, params) {
  const id = `fixture:${++nextServerId}`;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    write({ id, method, params });
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function logFrame(frame) {
  if (log) appendFileSync(log, JSON.stringify(frame) + "\n");
}
function textOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
}
function imageCount(blocks) {
  return Array.isArray(blocks) ? blocks.filter((block) => block?.type === "image").length : 0;
}
function update(value) {
  notify("session/update", { sessionId, update: value });
}
function cancelActive() {
  const state = active.get(sessionId);
  const apply = () => {
    if (state !== undefined) state.cancelled = true;
    for (const [id, resolve] of pendingServerRequests) {
      pendingServerRequests.delete(id);
      resolve({ outcome: { outcome: "cancelled" } });
    }
  };
  const cancelDelay = Number(process.env.ACP_FIXTURE_CANCEL_DELAY_MS ?? 0);
  if (cancelDelay > 0) setTimeout(apply, cancelDelay);
  else apply();
}
async function finishPrompt(state, stopReason) {
  active.delete(sessionId);
  response(state.requestId, { stopReason });
}

async function runMainPrompt(requestId, params) {
  mainPrompts += 1;
  if (process.env.ACP_FIXTURE_PROMPT_ERROR_AFTER === "1" && mainPrompts > 1) {
    failure(requestId, -32603, "fixture prompt failure");
    return;
  }
  const state = { requestId, cancelled: false };
  active.set(sessionId, state);
  if (process.env.ACP_FIXTURE_CRASH === "1") {
    setTimeout(() => process.exit(1), delay);
    return;
  }
  if (process.env.ACP_FIXTURE_CRASH_AFTER_MS !== undefined) {
    setTimeout(() => process.exit(1), Number(process.env.ACP_FIXTURE_CRASH_AFTER_MS));
  }
  const blocks = params.prompt;
  const inputText = textOf(blocks);
  const imageTotal = imageCount(blocks);
  await sleep(delay);
  if (state.cancelled) return finishPrompt(state, "cancelled");
  if (imageTotal > 0) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `fixture received ${imageTotal} image(s)` } });
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "fixture thinking" } });
  update({ sessionUpdate: "plan", entries: [{ content: "inspect fixture input", priority: "medium", status: "completed" }] });
  if (clientCalls) {
    const path = `${process.cwd()}/fixture-client.txt`;
    await serverRequest("fs/write_text_file", { sessionId, path, content: "client ok" });
    const read = await serverRequest("fs/read_text_file", { sessionId, path });
    const terminal = await serverRequest("terminal/create", {
      sessionId,
      command: process.execPath,
      args: ["-e", "process.stdout.write('terminal ok')"],
      cwd: process.cwd(),
    });
    await serverRequest("terminal/wait_for_exit", { sessionId, terminalId: terminal?.terminalId });
    const output = await serverRequest("terminal/output", { sessionId, terminalId: terminal?.terminalId });
    await serverRequest("terminal/release", { sessionId, terminalId: terminal?.terminalId });
    const elicited = await serverRequest("elicitation/create", {
      sessionId,
      message: "Choose the fixture answer",
      requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
    });
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: "client-message",
      content: { type: "text", text: `client read=${read?.content} terminal=${output?.output} elicited=${JSON.stringify(elicited)}` },
    });
  }
  if (permission) {
    const answer = await serverRequest("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "fixture-tool-1",
        title: "write a fixture file",
        kind: "edit",
        rawInput: { command: "touch fixture.txt" },
      },
      options: process.env.ACP_FIXTURE_PERMISSION_ALLOW_ONLY === "1"
        ? [{ optionId: "allow", name: "Allow once", kind: "allow_once" }]
        : [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
    });
    if (state.cancelled) return finishPrompt(state, "cancelled");
    const outcome = answer?.outcome;
    if (outcome?.outcome !== "selected" || outcome.optionId !== "allow") {
      return finishPrompt(state, "cancelled");
    }
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture permission accepted" } });
  }
  update({
    sessionUpdate: "tool_call",
    toolCallId: "fixture-tool-1",
    title: "fixture tool",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "printf fixture", cwd: process.cwd() },
  });
  await sleep(delay);
  if (state.cancelled) return finishPrompt(state, "cancelled");
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "fixture-tool-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "fixture tool output" } }],
  });
  update({ sessionUpdate: "usage_update", used: 10, size: 1000 });
  for (const [index, word] of `fixture answer: ${inputText.trim()}`.split(/\s+/u).entries()) {
    if (state.cancelled) return finishPrompt(state, "cancelled");
    update({ sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: `${index === 0 ? "" : " "}${word}` } });
    await sleep(delay);
  }
  if (state.cancelled) return finishPrompt(state, "cancelled");
  return finishPrompt(state, "end_turn");
}

async function runSteer(requestId, params) {
  if (process.env.ACP_FIXTURE_STEER_NO_RESPONSE === "1") {
    if (process.env.ACP_FIXTURE_CRASH_ON_STEER_MS !== undefined) {
      setTimeout(() => process.exit(1), Number(process.env.ACP_FIXTURE_CRASH_ON_STEER_MS));
    }
    return;
  }
  const text = textOf(params.prompt);
  if (!nativeSteer) {
    failure(requestId, -32602, "A prompt is already in flight for this session");
    return;
  }
  if (!active.has(sessionId)) {
    void runMainPrompt(requestId, params);
    return;
  }
  // Amp-style echo: the adapter observes the user text on the active stream.
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  update({ sessionUpdate: "agent_message_chunk", messageId: "steer-message", content: { type: "text", text: "steer accepted" } });
  response(requestId, { stopReason: "end_turn" });
}

function sessionState() {
  return {
    ...(modes ? {
      modes: {
        currentModeId: "accept-edits",
        availableModes: [
          { id: "read-only", name: "Read only" },
          { id: "accept-edits", name: "Accept edits" },
          { id: "full", name: "Full access" },
        ],
      },
    } : {}),
    ...(config ? {
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "cheap",
          options: [{ value: "cheap", name: "Cheap" }, { value: "expensive", name: "Expensive" }],
        },
        {
          type: "select",
          id: "permissions",
          name: "Permissions",
          category: "permissions",
          currentValue: "off",
          options: [{ value: "on", name: "On" }, { value: "off", name: "Off" }],
        },
      ],
    } : {}),
    ...(fixtureModels ? {
      models: {
        currentModelId: "cheap",
        availableModels: [
          { modelId: "cheap", name: "Cheap", description: "Low cost" },
          { modelId: "expensive", name: "Expensive", description: "High capability" },
        ],
      },
    } : {}),
  };
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim().length === 0) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  logFrame(frame);
  if (frame.method === undefined && frame.id !== undefined) {
    const resolve = pendingServerRequests.get(frame.id);
    if (resolve !== undefined) {
      pendingServerRequests.delete(frame.id);
      resolve(frame.result ?? (frame.error ? { error: frame.error } : {}));
    }
    return;
  }
  if (frame.method === "session/cancel") {
    cancelActive();
    return;
  }
  const params = frame.params ?? {};
  switch (frame.method) {
    case "initialize":
      response(frame.id, {
        protocolVersion: 1,
        agentInfo: { name: "acp-fixture", title: "Deterministic ACP fixture", version: "1.0.0" },
        ...(nativeSteer ? { _meta: { midTurnSteering: true } } : {}),
        agentCapabilities: {
          loadSession: load,
          promptCapabilities: { image: images, embeddedContext: true },
          sessionCapabilities: load ? { resume: {} } : {},
        },
      });
      return;
    case "session/new":
      response(frame.id, { sessionId, ...sessionState() });
      return;
    case "session/load": {
      if (!load) {
        failure(frame.id, -32601, "session/load is not declared by this fixture");
        return;
      }
      const replayHistory = () => {
        update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "history question" } });
        update({ sessionUpdate: "agent_message_chunk", messageId: "history-message", content: { type: "text", text: "history answer" } });
        update({
          sessionUpdate: "tool_call",
          toolCallId: "history-tool",
          title: "history tool",
          kind: "read",
          status: "completed",
          rawInput: { path: "history.txt" },
          content: [{ type: "content", content: { type: "text", text: "history output" } }],
        });
      };
      if (process.env.ACP_FIXTURE_LOAD_AFTER === "1") {
        response(frame.id, sessionState());
        setTimeout(replayHistory, 10);
      } else {
        replayHistory();
        response(frame.id, sessionState());
      }
      return;
    }
    case "session/set_mode":
      response(frame.id, {});
      return;
    case "session/set_config_option":
      response(frame.id, {});
      return;
    case "session/prompt":
      if (active.has(sessionId)) void runSteer(frame.id, params);
      else void runMainPrompt(frame.id, params);
      return;
    default:
      if (frame.id !== undefined) failure(frame.id, -32601, `unsupported fixture method ${frame.method}`);
      return;
  }
}).on("close", () => process.exit(0));
