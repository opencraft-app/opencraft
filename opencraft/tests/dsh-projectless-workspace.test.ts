import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { DshAppServerAdapter } from "../apps/local-agent-host/src/dsh-appserver-adapter.js";
import type { DshClient } from "../apps/local-agent-host/src/dsh-client.js";
import {
  LocalWorkspaceResolutionError,
  LocalWorkspaceResolver,
} from "../apps/local-agent-host/src/projectless-workspace.js";

test("Projectless Threads receive isolated Host-owned directories below OpenCraft", async () => {
  const parent = await mkdtemp(join(tmpdir(), "opencraft-projectless-"));
  const root = join(parent, "OpenCraft");
  const ids = ["first", "second"];
  const resolver = new LocalWorkspaceResolver({
    projectlessRoot: root,
    createId: () => ids.shift()!,
  });
  try {
    const first = await resolver.resolve({});
    const second = await resolver.resolve({ cwd: null });
    const canonicalRoot = await realpath(root);
    assert.equal(first.kind, "projectless");
    assert.equal(second.kind, "projectless");
    assert.equal(first.cwd, join(canonicalRoot, "thread-first"));
    assert.equal(second.cwd, join(canonicalRoot, "thread-second"));
    assert.deepEqual(first.runtimeWorkspaceRoots, [first.cwd]);
    assert.equal(relative(canonicalRoot, first.cwd), "thread-first");
    await access(first.cwd);
    await access(second.cwd);

    await first.rollback();
    await assert.rejects(access(first.cwd), { code: "ENOENT" });
    await access(root);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("explicit Project paths are canonicalized and never replaced by Projectless storage", async () => {
  const parent = await mkdtemp(join(tmpdir(), "opencraft-project-workspace-"));
  const root = join(parent, "project");
  const nested = join(root, "nested");
  await mkdir(nested, { recursive: true });
  const resolver = new LocalWorkspaceResolver({ projectlessRoot: join(parent, "OpenCraft") });
  try {
    const resolved = await resolver.resolve({ cwd: nested, runtimeWorkspaceRoots: [root, root] });
    const canonicalRoot = await realpath(root);
    const canonicalNested = await realpath(nested);
    assert.equal(resolved.kind, "project");
    assert.equal(resolved.cwd, canonicalNested);
    assert.deepEqual(resolved.runtimeWorkspaceRoots, [canonicalRoot]);
    await resolved.rollback();
    await access(nested);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("explicit stale, relative, and file-valued workspace paths fail at the Host boundary", async () => {
  const parent = await mkdtemp(join(tmpdir(), "opencraft-invalid-workspace-"));
  const file = join(parent, "file.txt");
  await writeFile(file, "fixture");
  const resolver = new LocalWorkspaceResolver({ projectlessRoot: join(parent, "OpenCraft") });
  try {
    await assert.rejects(
      resolver.resolve({ cwd: "relative/project" }),
      (error: unknown) => error instanceof LocalWorkspaceResolutionError
        && error.domainData.code === "WORKSPACE_PATH_INVALID",
    );
    await assert.rejects(
      resolver.resolve({ cwd: join(parent, "missing") }),
      (error: unknown) => error instanceof LocalWorkspaceResolutionError
        && error.domainData.code === "WORKSPACE_NOT_FOUND",
    );
    await assert.rejects(
      resolver.resolve({ cwd: file }),
      (error: unknown) => error instanceof LocalWorkspaceResolutionError
        && error.domainData.code === "WORKSPACE_NOT_DIRECTORY",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a failed engine creation rolls back only its newly allocated Projectless directory", async () => {
  let rollbacks = 0;
  const client = {
    call: async (method: string) => {
      if (method === "settings.describe") return {
        namespaces: [{ ns: "agent-default-model", value: { provider: "fixture", model: "model" } }],
      };
      if (method === "llm.models") return {
        groups: [{ id: "fixture", name: "Fixture", models: [{ id: "model", name: "Model" }] }],
        failures: [],
      };
      if (method === "llm.providers") return { providers: [] };
      return {};
    },
  } as unknown as DshClient;
  const adapter = new DshAppServerAdapter(client);
  adapter.setWorkspaceResolver({
    resolve: async () => ({
      cwd: "/fixture/OpenCraft/thread-test",
      runtimeWorkspaceRoots: ["/fixture/OpenCraft/thread-test"],
      kind: "projectless",
      rollback: async () => { rollbacks += 1; },
    }),
  });
  adapter.setThreadEngine({
    create: async () => { throw new Error("synthetic create failure"); },
    describe: async () => ({}),
    resume: async () => ({}),
    fork: async () => ({}),
    inject: async () => ({}),
    release: async () => ({}),
  });

  await assert.rejects(adapter.dispatch("thread/start", {}), /synthetic create failure/);
  assert.equal(rollbacks, 1);
  adapter.close();
});
