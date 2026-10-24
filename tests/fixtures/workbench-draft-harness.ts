import assert from "node:assert/strict";

import test from "node:test";


import { createCordisAppServerRegistry } from "@opencraft/appserver-client";

import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  parseJsonRpcMessage,
  OPENCRAFT_RESUME_HISTORY_EXTENSION,
  type JsonRpcRequest,
} from "@opencraft/appserver-protocol";

import {
  MemoryTransport,
  type InMemoryAppServer,
  type InMemoryAppServerPeer,
} from "@opencraft/appserver-transport-memory";

import type { SubmitIntent } from "@opencraft/composer-core";

import { createConversationKey, asTurnId } from "@opencraft/chat-core";

import {
  createAppServerWorkbenchRuntime,
  createConversationScopeRegistry,
} from "@opencraft/workbench-runtime";

export interface DraftHarness {
  readonly requests: JsonRpcRequest[];
  readonly transport: MemoryTransport;
  releaseTurn(): void;
  releaseResume(): void;
  releaseCapabilityRegistration(): void;
  failCapabilityRegistration(): void;
  releaseUnsubscribe(): void;
  failNextUnsubscribe(): void;
  holdFork(): void;
  holdInterrupt(): void;
  releaseInterrupt(): void;
  releaseFork(): void;
  publishFork(): void;
  notifySkillsChanged(): void;
  notify(method: string, params: unknown): void;
  notifyFsChanged(watchId: string, changedPaths: readonly string[]): void;
}

export function protocolThread(id: string) {
  return {
    id,
    sessionId: `session:${id}`,
    name: "Draft fixture",
    cwd: "/workspace",
    path: `/rollouts/${id}.jsonl`,
    historyMode: "paginated",
    status: { type: "idle" },
    turns: [],
  };
}

export function createHarness(
  delayTurn = false,
  delayResume = false,
  historyTurns: readonly unknown[] = [],
  delayUnsubscribe = false,
  models: readonly Record<string, unknown>[] = [{ id: "fixture-model", model: "fixture-model", isDefault: true, inputModalities: ["text"], supportedReasoningEfforts: [{reasoningEffort:"medium",description:"Medium"}], defaultReasoningEffort:"medium" }],
  declareResumeHistory: boolean | "message-window" = false,
  delayCapabilityRegistration = false,
  firstTurnDurability = false,
  rejectTurn = false,
  lifecycleCapability: unknown = undefined,
): DraftHarness {
  const requests: JsonRpcRequest[] = [];
  let releaseTurn = () => undefined;
  let releaseResume = () => undefined;
  let releaseCapabilityRegistration = () => undefined;
  let failCapabilityRegistration = () => undefined;
  let releaseUnsubscribe = () => undefined;
  let failUnsubscribe = false;
  let releaseFork = () => undefined;
  let holdFork = false;
  let holdInterrupt = false;
  let releaseInterrupt = () => undefined;
  let forkPublished = false;
  let activePeer: InMemoryAppServerPeer | null = null;
  const fixtureThread = (id: string) => ({ ...protocolThread(id), historyMode: declareResumeHistory === "message-window" ? "message-window" : "paginated" });
  const server: InMemoryAppServer = {
    connected(peer) {
      activePeer = peer;
    },
    receive(frame, peer) {
      const message = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(message)) return;
      requests.push(message);
      const send = (result: unknown) => peer.send(encodeJsonRpcMessage({
        id: message.id,
        result,
      }));
      if (message.method === "initialize") {
        send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "draft-test",
          capabilities: { extensions: {
            ...(declareResumeHistory
              ? { [OPENCRAFT_RESUME_HISTORY_EXTENSION]: { version: 1, mode: declareResumeHistory === "message-window" ? "message-window" : "paginated" } }
              : {}),
            ...(delayCapabilityRegistration
              ? { "opencraft/host-capabilities": { version: 1 } }
              : {}),
            ...(firstTurnDurability
              ? { "opencraft/thread-start-durability": { version: 1, durableAfter: "first-turn-accepted" } }
              : {}),
            ...(lifecycleCapability === undefined
              ? {}
              : { "opencraft/thread-lifecycle": lifecycleCapability }),
          } } });
      } else if (message.method === "model/list") {
        send({ data: models, nextCursor:null });
      } else if (message.method === "config/read") {
        send({
          config: { model: "gpt-5.6", model_reasoning_effort: "high" },
          origins: {},
          layers: null,
        });
      } else if (message.method === "config/batchWrite") {
        send({
          status: "ok",
          version: "fixture-version",
          filePath: "/tmp/config.toml",
          overriddenMetadata: null,
        });
      } else if (message.method === "thread/list") {
        send({ data: [fixtureThread("thread-created"), ...(forkPublished ? [fixtureThread("thread-fork")] : [])], nextCursor: null });
      } else if (message.method === "thread/fork") {
        const ephemeral = (message.params as { ephemeral?: boolean }).ephemeral === true;
        const respond = () => send({ thread: { ...fixtureThread(ephemeral ? "thread-fork-ephemeral" : "thread-fork"), forkedFromId: "thread-created", ephemeral },
          model: "fixture-model", modelProvider: "openai", cwd: "/workspace", approvalPolicy: "on-request", approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] }, runtimeWorkspaceRoots: ["/workspace"],
        });
        if (holdFork) releaseFork = respond;
        else respond();
      } else if (message.method === "thread/read" && (historyTurns.length > 0 || declareResumeHistory === "message-window")) {
        const threadId = (message.params as { threadId?: string }).threadId ?? "thread-created";
        send({ thread: fixtureThread(threadId) });
      } else if (message.method === "thread/start") {
        send({ thread: fixtureThread("thread-created") });
      } else if (message.method === "turn/start") {
        const respond = () => rejectTurn
          ? peer.send(encodeJsonRpcMessage({ id: message.id, error: { code: -32000, message: "first turn rejected" } }))
          : send({ turn: { id: "turn-created" } });
        if (delayTurn) releaseTurn = respond;
        else respond();
      } else if (message.method === "thread/resume") {
        const threadId = (message.params as { threadId?: string }).threadId ?? "thread-created";
        const respond = () => send({
          thread: fixtureThread(threadId),
          model: "fixture-model",
          modelProvider: "openai",
          serviceTier: "default",
          reasoningEffort: "medium",
          cwd: "/workspace",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] },
          activePermissionProfile: { id: "workspace" },
          runtimeWorkspaceRoots: ["/workspace"],
          instructionSources: [],
          turnsBackwardsCursor: historyTurns.length > 0 ? "history:0" : null,
          itemsBackwardsCursor: null,
          initialTurnsPage: { data: [], nextCursor: null },
        });
        if (delayResume) releaseResume = respond;
        else respond();
      } else if (message.method === "runtime/capabilities/register") {
        const respond = () => send({ registered: 1 });
        if (delayCapabilityRegistration) {
          releaseCapabilityRegistration = respond;
          failCapabilityRegistration = () => peer.send(encodeJsonRpcMessage({
            id: message.id,
            error: { code: -32000, message: "fixture capability failure" },
          }));
        }
        else respond();
      } else if (message.method === "thread/unsubscribe") {
        if (failUnsubscribe) {
          failUnsubscribe = false;
          peer.send(encodeJsonRpcMessage({ id: message.id, error: { code: -32000, message: "Synthetic detach failure" } }));
          return;
        }
        const respond = () => send({ status: "unsubscribed" });
        if (delayUnsubscribe) releaseUnsubscribe = respond; else respond();
      } else if (message.method === "thread/turns/list") {
        send({ data: historyTurns, nextCursor: null });
      } else if (message.method === "thread/items/list") {
        const turnId = (message.params as { turnId?: string }).turnId;
        const turn = historyTurns.find((candidate) => (
          typeof candidate === "object"
          && candidate !== null
          && (candidate as { id?: unknown }).id === turnId
        )) as { items?: readonly unknown[] } | undefined;
        send({ data: turn?.items ?? [], nextCursor: null });
      } else if (message.method === "project/list") {
        send({
          data: [{
            id: "project-one",
            name: "one",
            roots: [{ path: "/workspace/projects/one" }],
            metadata: {},
            position: 0,
            createdAt: 1,
            updatedAt: 1,
          }],
          nextCursor: null,
        });
      } else if (message.method === "project/create") {
        const params = message.params as {
          name: string;
          roots: Array<{ path: string }>;
          metadata?: Record<string, string> | null;
        };
        send({
          project: {
            id: "project-created",
            name: params.name,
            roots: params.roots,
            metadata: params.metadata ?? {},
            position: 1,
            createdAt: 2,
            updatedAt: 2,
          },
        });
      } else if (message.method === "fs/readDirectory") {
        send({
          entries: [
            { fileName: "one", isDirectory: true, isFile: false },
            { fileName: "README.md", isDirectory: false, isFile: true },
          ],
        });
      } else if (message.method === "fs/getMetadata") {
        send({
          isDirectory: false,
          isFile: true,
          isSymlink: false,
          createdAtMs: 1,
          modifiedAtMs: 2,
        });
      } else if (message.method === "fs/readFile") {
        send({ dataBase64: btoa("hello from sandbox\n") });
      } else if (message.method === "fs/writeFile") {
        send({});
      } else if (message.method === "turn/interrupt" && holdInterrupt) {
        releaseInterrupt = () => send({});
      } else if (message.method === "fs/watch") {
        send({ path: (message.params as { path: string }).path });
      } else if (message.method === "fs/unwatch") {
        send({});
      } else if (message.method === "skills/list") {
        send({
          data: [{
            cwd: "/workspace",
            skills: [{
              name: "repo-review",
              description: "Review this repository",
              interface: {
                displayName: "Repository review",
                shortDescription: "Inspect the current changes",
                iconSmallUrl: null,
                iconLargeUrl: null,
              },
              path: "/workspace/.agents/skills/repo-review/SKILL.md",
              scope: "repo",
              enabled: true,
            }],
            errors: [],
          }],
        });
      } else {
        send({});
      }
    },
  };
  return {
    requests,
    transport: new MemoryTransport(server),
    releaseTurn: () => releaseTurn(),
    releaseResume: () => releaseResume(),
    releaseCapabilityRegistration: () => releaseCapabilityRegistration(),
    failCapabilityRegistration: () => failCapabilityRegistration(),
    releaseUnsubscribe: () => releaseUnsubscribe(),
    failNextUnsubscribe: () => { failUnsubscribe = true; },
    holdFork: () => { holdFork = true; },
    holdInterrupt: () => { holdInterrupt = true; },
    releaseInterrupt: () => releaseInterrupt(),
    releaseFork: () => releaseFork(),
    publishFork: () => { forkPublished = true; },
    notifySchedulesChanged: () => activePeer?.send(encodeJsonRpcMessage({ method: "opencraft/schedules/changed", params: {} })),
    notify: (method, params) => activePeer?.send(encodeJsonRpcMessage({ method, params } as any)),
    notifySkillsChanged: () => activePeer?.send(encodeJsonRpcMessage({
      method: "skills/changed",
      params: {},
    })),
    notifyFsChanged: (watchId, changedPaths) => activePeer?.send(encodeJsonRpcMessage({
      method: "fs/changed",
      params: { watchId, changedPaths },
    })),
  };
}

export const oneDynamicTool = [{
  type: "function" as const,
  name: "read_workspace",
  description: "Read the current workspace",
  inputSchema: { type: "object" },
}];

export function intent(target: Extract<SubmitIntent["target"], { type: "new-thread" }>): SubmitIntent {
  return {
    commandId: "command-draft",
    clientMessageId: "message-draft",
    target,
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: "Build it" }] }],
    },
    attachments: [],
    context: [],
    selections: {},
    options: { autoContext: true },
    createdAt: 1,
  };
}

export async function waitForRequest(harness: DraftHarness, method: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (harness.requests.some((request) => request.method === method)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${method}`);
}

export async function waitForAuthoritative(
  lease: Awaited<ReturnType<ReturnType<typeof createAppServerWorkbenchRuntime>["acquireThread"]>>,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (lease.getSnapshot().authoritative) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for authoritative Thread ${lease.threadId}`);
}