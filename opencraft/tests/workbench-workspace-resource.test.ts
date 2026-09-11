import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeBase64Bytes,
  decodeWorkspaceText,
  encodeBase64Text,
  joinWorkspacePath,
  parseWorkspaceResource,
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

test("workspace text codec preserves UTF-8 across the AppServer base64 boundary", () => {
  const source = "你好，DSH sandbox\nconst answer = 42;\n";
  const encoded = encodeBase64Text(source);
  assert.equal(decodeWorkspaceText(decodeBase64Bytes(encoded)), source);
  assert.equal(decodeWorkspaceText(new Uint8Array([0, 1, 2])), null);
});

test("workspace file presentation derives stable roots, paths, and languages", () => {
  assert.equal(joinWorkspacePath("/workspace/project/", "/src/main.ts"), "/workspace/project/src/main.ts");
  assert.equal(workspaceFileLanguage("/workspace/project/src/main.tsx"), "tsx");
  assert.deepEqual(
    workspaceRootsForResource(["/workspace/project", "/workspace/project"], null, "/workspace/project/src/main.ts"),
    ["/workspace/project"],
  );
  assert.deepEqual(
    workspaceRootsForResource([], "/workspace/project", "/workspace/project/src/main.ts"),
    ["/workspace/project"],
  );
});

