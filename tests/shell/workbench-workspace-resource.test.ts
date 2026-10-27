import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeBase64Bytes,
  decodeWorkspaceText,
  encodeBase64Text,
  joinWorkspacePath,
  parseWorkspaceResource,
  reconcileWorkspaceSave,
  updateWorkspaceDraft,
  workspaceDraftConflicted,
  workspaceDraftKey,
  workspaceFileKind,
  workspaceFileLanguage,
  workspaceRootsForResource,
  workspacePathParent,
  writeWorkspaceResource,
} from "../../apps/workbench-web/src/panels/workspace-resource-model";

test("filesystem and drive roots remain valid directory identities", () => {
  assert.equal(workspacePathParent("/"), "/");
  assert.equal(workspacePathParent("C:/"), "C:/");
  assert.equal(workspacePathParent("C:\\"), "C:/");
  assert.deepEqual(workspaceRootsForResource(["/", "C:/", ""], null, "/"), ["/", "C:/"]);
  assert.deepEqual(workspaceRootsForResource([], null, "/"), ["/"]);
});

test("workspace resource URLs retain host paths and source locations", () => {
  assert.deepEqual(
    parseWorkspaceResource("file:///workspace/project/src/main.ts#L42C7-L45"),
    { path: "/workspace/project/src/main.ts", line: 42, column: 7 },
  );
  assert.deepEqual(
    parseWorkspaceResource("file:///C:/repo/main.ts#L3"),
    { path: "C:/repo/main.ts", line: 3, column: null },
  );
});

test("preview-only workspace resources reject writes before touching the Host or blob cache", async () => {
  const calls: string[] = [];
  const target = { hostId: "host-a", path: "/repo/README.md", key: workspaceDraftKey("host-a", "/repo/README.md"), text: "updated" };
  const writeFile = async (_path: string, _content: string) => { calls.push("write"); };
  const invalidate = async (_hostId: string, _path: string) => { calls.push("invalidate"); };
  await assert.rejects(writeWorkspaceResource(true, target, writeFile, invalidate), /read-only/);
  assert.deepEqual(calls, []);
  await writeWorkspaceResource(false, target, writeFile, invalidate);
  assert.deepEqual(calls, ["write", "invalidate"]);
});

test("workspace drafts retain Host/path identity across refresh and late save", () => {
  const first = workspaceDraftKey("host-a", "/repo/app.css");
  const second = workspaceDraftKey("host-b", "/repo/app.css");
  assert.notEqual(first, second);
  const drafts = updateWorkspaceDraft({}, first, "old", "local");
  assert.deepEqual(drafts[first], { baseText: "old", text: "local" });
  assert.equal(workspaceDraftConflicted(drafts[first], "external"), true);
  assert.equal(workspaceDraftConflicted(drafts[first], "old"), false);
  const changedWhileSaving = updateWorkspaceDraft(drafts, first, "old", "newer local");
  assert.deepEqual(reconcileWorkspaceSave(changedWhileSaving, first, "local")[first], {
    baseText: "local", text: "newer local",
  });
  assert.deepEqual(reconcileWorkspaceSave(drafts, first, "local"), {});
});

test("workspace text codec preserves UTF-8 across the AppServer base64 boundary", () => {
  const source = "你好，DSH sandbox\nconst answer = 42;\n";
  const encoded = encodeBase64Text(source);
  assert.equal(decodeWorkspaceText(decodeBase64Bytes(encoded)), source);
  assert.equal(decodeWorkspaceText(new Uint8Array([0, 1, 2])), null);
});

test("workspace file presentation derives stable roots, paths, and languages", () => {
  assert.equal(joinWorkspacePath("/workspace/project/", "/src/main.ts"), "/workspace/project/src/main.ts");
  assert.equal(workspaceFileLanguage("/workspace/project/src/main.tsx"), "tsx");
  assert.equal(workspaceFileLanguage("/workspace/README.MD"), "markdown");
  assert.equal(workspaceFileLanguage("/workspace/notes.markdown"), "markdown");
  assert.equal(workspaceFileLanguage("/workspace/report.htm"), "html");

  assert.equal(workspaceFileLanguage("/workspace/project/styles/site.scss"), "css");
  assert.equal(workspaceFileLanguage("/workspace/project/src/worker.mjs"), "javascript");
  assert.equal(workspaceFileKind("/workspace/project/styles/site.css"), "css");
  assert.equal(workspaceFileKind("/workspace/project/src/main.js"), "javascript");
  assert.equal(workspaceFileKind("/workspace/project/src/main.tsx"), "typescript");
  assert.equal(workspaceFileKind("/workspace/project/config.json"), "json");
  assert.equal(workspaceFileKind("/workspace/project/logo.png"), "image");
  assert.deepEqual(
    workspaceRootsForResource(["/workspace/project", "/workspace/project"], null, "/workspace/project/src/main.ts"),
    ["/workspace/project"],
  );
  assert.deepEqual(
    workspaceRootsForResource([], "/workspace/project", "/workspace/project/src/main.ts"),
    ["/workspace/project"],
  );
});
