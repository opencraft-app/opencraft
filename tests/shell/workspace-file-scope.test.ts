import test from "node:test";
import assert from "node:assert/strict";
import type { AppServerWorkbenchRuntime, AppServerFileSystemResourcePort } from "@opencraft/workbench-runtime";
import {
  workspaceFileRuntime,
  unavailableWorkspaceFiles,
} from "../../apps/workbench-web/src/runtime/workspace-file-runtime";
import { fileBlobResource, loadFileBlob } from "../../apps/workbench-web/src/runtime/blob-files";

test("workspace file caches separate identical paths and Blob reads never use Host HTTP", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    get() {
      throw Error("Host HTTP path must not be consulted");
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  });
  let local = 0;
  const host = {
    resources: {
      host: { getConnectionGeneration: () => 1 },
      fileSystem: {
        async readFile() {
          local++;
          throw Error("local fallback");
        },
      },
    },
  } as unknown as AppServerWorkbenchRuntime;
  const files = (value: string): AppServerFileSystemResourcePort => ({
    ...unavailableWorkspaceFiles,
    async readFile() {
      return { dataBase64: btoa(value) };
    },
  });
  const a = workspaceFileRuntime(host, files("a")),
    b = workspaceFileRuntime(host, files("b"));
  assert.notEqual(fileBlobResource(a, "host", "/workspace/x").scope, fileBlobResource(b, "host", "/workspace/x").scope);
  assert.equal(await (await loadFileBlob(a, "host", "/workspace/x", new AbortController().signal)).text(), "a");
  assert.equal(await (await loadFileBlob(b, "host", "/workspace/x", new AbortController().signal)).text(), "b");
  const pending = workspaceFileRuntime(host, unavailableWorkspaceFiles);
  await assert.rejects(loadFileBlob(pending, "host", "/workspace/x", new AbortController().signal), /unavailable/);
  assert.equal(local, 0);
});

import { openWorkspaceFiles } from "../../packages/workbench-runtime/src/workspace-files";
import type { AppServerClient } from "@opencraft/appserver-client";
test("workspace file port captures authority and rejects retired reads/writes", async () => {
  let current = true;
  const calls: { method: string; params: unknown }[] = [];
  let finish: (() => void) | undefined;
  const owner = {
    initializeResult: { capabilities: { extensions: { "opencraft/workspace-placement": { fileScopeVersion: 1 } } } },
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === "workspace/files/scope") return { kind: "workspace", threadId: "A", root: "/workspace" };
      if (method === "fs/readFile")
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return { dataBase64: "YQ==" };
    },
  } as unknown as AppServerClient;
  const guard = () => {
    if (!current) throw Error("retired");
  };
  const opened = await openWorkspaceFiles(owner, "A", unavailableWorkspaceFiles, guard);
  const pending = opened.files.readFile("/workspace/a");
  current = false;
  finish!();
  await assert.rejects(pending, /retired/);
  await assert.rejects(opened.files.writeFile("/workspace/a", "Yg=="), /retired/);
  await assert.rejects(openWorkspaceFiles(owner, "A", unavailableWorkspaceFiles, guard), /retired/);
  assert.deepEqual(calls, [
    { method: "workspace/files/scope", params: { threadId: "A" } },
    { method: "fs/readFile", params: { path: "/workspace/a", workspaceThreadId: "A" } },
  ]);
});
