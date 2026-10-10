import assert from "node:assert/strict";
import test from "node:test";
import { AppServerRpcError } from "@opencraft/appserver-client";

import type { Project } from "@opencraft/appserver-protocol/generated/v2";

import {
  buildDraftWorkspaceOptions,
  resolveProjectCwd,
  resolveDraftDirectorySelection,
  searchDraftWorkspaceOptions,
} from "../apps/workbench-web/src/runtime/draft-workspace-model";

const project: Project = {
  id: "project:multi-root",
  name: "Monorepo",
  roots: [{ path: "/repo/client" }, { path: "/repo/server" }],
  metadata: { branch: "feature/draft-session" },
  position: 0,
  createdAt: 1,
  updatedAt: 1,
};

test("every Project root is a selectable cwd without losing the aggregate root set", () => {
  const options = buildDraftWorkspaceOptions([project]);
  assert.deepEqual(options.map((option) => option.cwd), ["/repo/client", "/repo/server"]);
  assert.deepEqual(options[1]?.runtimeWorkspaceRoots, ["/repo/client", "/repo/server"]);
  assert.equal(options[1]?.projectId, project.id);
  assert.equal(options[1]?.branch, "feature/draft-session");
  assert.equal(options[1]?.rootLabel, "server");
});

test("Server directory selection does not require a Project API or invent a local Project", async () => {
  const missing = new AppServerRpcError({ code: -32601, message: "Method unavailable" });
  let calls = 0;
  const createProject = async () => { calls++; throw missing; };
  for (const projectCatalogError of [missing, null]) {
    const result = await resolveDraftDirectorySelection({ path: "/remote/repo", projects: [], projectCatalogError, createProject });
    assert.deepEqual(result, { workspace: { cwd: "/remote/repo", runtimeWorkspaceRoots: ["/remote/repo"] }, createdProject: false });
  }
  assert.equal(calls, 1, "known unsupported catalog avoids a knowingly unsupported mutation");
});

test("directory selection preserves Server Project identity and distinguishes failed creation", async () => {
  let calls = 0;
  const createProject = async () => { calls++; return { project }; };
  const existing = await resolveDraftDirectorySelection({ path: "/repo/server", projects: [project], projectCatalogError: null, createProject });
  assert.equal(existing.workspace.projectId, project.id); assert.equal(calls, 0);
  const created = await resolveDraftDirectorySelection({ path: "/repo/client", projects: [], projectCatalogError: null, createProject });
  assert.equal(created.createdProject, true); assert.equal(calls, 1);
  for (const error of [new Error("Network lost"), new AppServerRpcError({ code: -32000, message: "Denied" })]) {
    await assert.rejects(resolveDraftDirectorySelection({ path: "/remote/repo", projects: [], projectCatalogError: null,
      createProject: async () => { throw error; } }), failure => failure === error);
  }
});

test("Project search uses deterministic fuzzy ordering across names, roots and paths", () => {
  const options = buildDraftWorkspaceOptions([
    project,
    {
      ...project,
      id: "project:docs",
      name: "Documentation",
      roots: [{ path: "/repo/guides" }],
      position: 1,
    },
  ]);
  assert.deepEqual(
    searchDraftWorkspaceOptions(options, "srv").map((option) => option.cwd),
    ["/repo/server"],
  );
  assert.deepEqual(
    searchDraftWorkspaceOptions(options, "doc").map((option) => option.cwd),
    ["/repo/guides"],
  );
});

test("directory selection preserves a requested secondary Project root", () => {
  assert.equal(resolveProjectCwd(project, "/repo/server"), "/repo/server");
  assert.equal(resolveProjectCwd(project, "/repo/unknown"), "/repo/client");
  assert.throws(() => resolveProjectCwd({ ...project, roots: [] }, "/repo"), /no workspace root/u);
});
