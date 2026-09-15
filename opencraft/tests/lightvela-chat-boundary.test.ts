import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

test("Tencent IM Chat and Codex ChatUI remain separate dependency graphs", () => {
  const collaborationRoot = new URL(
    "../plugins/lightvela-collaboration/src/",
    import.meta.url,
  ).pathname;
  const hermesRoot = new URL("../plugins/lightvela-hermes/src/", import.meta.url).pathname;
  const collaborationForbidden = [
    /@opencraft\/appserver-/u,
    /@opencraft\/chat-/u,
    /@opencraft\/composer-/u,
    /@opencraft\/timeline-/u,
    /plugins\/lightvela-hermes/u,
  ];
  const hermesForbidden = [
    /@tencentcloud\/chat/u,
    /tim-upload-plugin/u,
    /plugin-lightvela-collaboration/u,
  ];

  for (const file of sourceFiles(collaborationRoot)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of collaborationForbidden) {
      assert.doesNotMatch(source, pattern, `${file} crosses into Codex ChatUI`);
    }
  }
  for (const file of sourceFiles(hermesRoot)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of hermesForbidden) {
      assert.doesNotMatch(source, pattern, `${file} crosses into Tencent IM Chat`);
    }
  }
});
