import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  type AppServerWebSocket,
  WebSocketTransport,
} from "@opencraft/appserver-transport-websocket";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import WebSocket from "ws";

async function canonicalThreadId(): Promise<string> {
  if (process.env.OPENCRAFT_APPSERVER_THREAD_ID !== undefined) return process.env.OPENCRAFT_APPSERVER_THREAD_ID;
  const source = await readFile(new URL("../.opencraft/appserver-lab/canonical-thread.json", import.meta.url), "utf8");
  const parsed = JSON.parse(source) as { threadId?: unknown };
  if (typeof parsed.threadId !== "string") throw new Error("Canonical Thread identity is invalid");
  return parsed.threadId;
}

async function waitForAuthoritative(
  thread: Awaited<ReturnType<ReturnType<typeof createAppServerWorkbenchRuntime>["acquireThread"]>>,
): Promise<void> {
  if (thread.getSnapshot().authoritative) return;
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => undefined;
    const timeout = setTimeout(() => {
      unsubscribe();
      const snapshot = thread.getSnapshot();
      reject(new Error(
        `Thread ${thread.threadId} did not become authoritative: ${snapshot.phase}`
        + `${snapshot.error === null ? "" : ` (${snapshot.error.message})`}`,
      ));
    }, 10_000);
    const finish = () => {
      const snapshot = thread.getSnapshot();
      if (snapshot.phase === "error") {
        clearTimeout(timeout);
        unsubscribe();
        reject(snapshot.error ?? new Error(`Thread ${thread.threadId} Resume failed`));
        return;
      }
      if (!snapshot.authoritative) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    unsubscribe = thread.subscribe(finish);
    finish();
  });
}

test("real 9988 Workbench composes Resume, Replica and Conversation Runtime across reconnect", { timeout: 30_000 }, async () => {
  const preferredThreadId = await canonicalThreadId();
  const transport = new WebSocketTransport({
    url: process.env.OPENCRAFT_APPSERVER_WS_URL ?? "ws://127.0.0.1:9988/rpc",
    closeTimeoutMs: 250,
    createSocket: (url) => new WebSocket(url, {
      headers: {
        "x-hypernode-user": process.env.OPENCRAFT_HYPERNODE_USER ?? "skipzhang",
      },
    }) as unknown as AppServerWebSocket,
  });
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport,
    autoReconnect: false,
    requestTimeoutMs: 10_000,
  });
  try {
    await runtime.connect();
    const initialCatalog = await runtime.resources.threads.list({ limit: 5 });
    const threadId = initialCatalog.data.some((thread) => thread.id === preferredThreadId)
      ? preferredThreadId
      : initialCatalog.data[0]?.id;
    assert.ok(threadId, "The selected HyperNode user must expose at least one active Thread");
    const thread = await runtime.acquireThread(threadId);
    // Acquisition exposes Codex-style painted state immediately; the live
    // gate waits only where it specifically asserts authoritative Resume.
    await waitForAuthoritative(thread);
    const first = runtime.getSnapshot();
    const firstConversation = thread.getSnapshot();
    assert.equal(first.phase, "ready");
    assert.equal(firstConversation.authoritative, true);
    assert.equal(firstConversation.key.threadId, threadId);

    const workspaceRoot = firstConversation.execution.runtimeWorkspaceRoots[0]
      ?? firstConversation.execution.cwd;
    assert.ok(workspaceRoot, "The resumed Thread must expose a workspace root");
    const rootMetadata = await runtime.resources.fileSystem.getMetadata(workspaceRoot);
    assert.equal(rootMetadata.isDirectory, true);
    const rootDirectory = await runtime.resources.fileSystem.readDirectory(workspaceRoot);
    assert.ok(Array.isArray(rootDirectory.entries));
    const readableFile = rootDirectory.entries.find((entry) => entry.isFile);
    if (readableFile !== undefined) {
      const separator = workspaceRoot.endsWith("/") ? "" : "/";
      const file = await runtime.resources.fileSystem.readFile(
        `${workspaceRoot}${separator}${readableFile.fileName}`,
      );
      assert.equal(typeof file.dataBase64, "string");
    }
    const watch = await runtime.resources.fileSystem.watch(
      workspaceRoot,
      () => undefined,
    );
    assert.ok(watch.watchId.startsWith("vela:local:fs:"));
    await watch.dispose();

    const navigation = thread.getNavigation();
    await navigation.prepare();
    const firstNavigation = navigation.getSnapshot();
    assert.equal(firstNavigation.phase, "ready");
    assert.equal(firstNavigation.completeness, "complete");
    assert.equal(firstNavigation.error, null);

    assert.ok(Array.isArray(initialCatalog.data));
    assert.ok(initialCatalog.data.length > 0);

    const skills = await runtime.resources.composerCatalog.listSkills({
      cwds: firstConversation.execution.runtimeWorkspaceRoots,
      forceReload: false,
    });
    assert.ok(Array.isArray(skills.data));
    assert.ok(skills.data.every((entry) => Array.isArray(entry.skills)));

    const projects = await runtime.resources.projects.list({ limit: 100 });
    const catalogRoots = projects.data.flatMap((project) => project.roots.map((root) => root.path));
    const searchRoots = firstConversation.execution.runtimeWorkspaceRoots.length
      ? firstConversation.execution.runtimeWorkspaceRoots
      : catalogRoots.slice(0, 1);
    assert.ok(searchRoots.length > 0);
    let searchTimeout: ReturnType<typeof setTimeout> | undefined;
    let stopSearch: (() => Promise<void>) | null = null;
    const firstSearchUpdate = new Promise<readonly { readonly path: string }[]>((resolve, reject) => {
      searchTimeout = setTimeout(() => reject(new Error("fuzzy file search update timed out")), 10_000);
      void runtime.resources.composerCatalog.createFuzzyFileSearchSession({
        roots: searchRoots,
        onUpdated: ({ files }) => {
          clearTimeout(searchTimeout);
          resolve(files);
        },
      }).then(async (searchSession) => {
        stopSearch = () => searchSession.stop();
        try {
          await searchSession.update("package");
        } catch (cause) {
          await searchSession.stop();
          reject(cause);
        }
      }, reject);
    });
    const fuzzyFiles = await firstSearchUpdate;
    assert.ok(fuzzyFiles.some((entry) => entry.path.toLocaleLowerCase().includes("package")));
    if (stopSearch !== null) await stopSearch();

    const firstGeneration = first.connectionGeneration;
    await transport.close();
    await runtime.reconnect();
    const recovered = runtime.getSnapshot();
    const recoveredConversation = thread.getSnapshot();
    assert.equal(recovered.phase, "ready");
    assert.ok(recovered.connectionGeneration > firstGeneration);
    assert.equal(recoveredConversation.authoritative, true);
    assert.equal(recoveredConversation.key.threadId, threadId);
    await navigation.prepare();
    assert.match(navigation.getSnapshot().generation ?? "", new RegExp(`:${recovered.connectionGeneration}$`));
  } finally {
    await runtime.dispose();
  }
});
