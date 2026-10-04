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
} from "../apps/workbench-web/src/panels/workspace-resource-model";

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
