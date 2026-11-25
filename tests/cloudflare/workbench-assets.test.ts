import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { uploadWorkbenchAssets } from "../../scripts/cloudflare/workbench-assets.ts";

test("preview releases keep selected historical chunks while serving the new shell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-preview-assets-"));
  try {
    const current = join(directory, "current");
    const previous = join(directory, "previous");
    await Promise.all([
      mkdir(join(current, "assets"), { recursive: true }),
      mkdir(join(previous, "assets"), { recursive: true }),
    ]);
    const shell = '<script id="opencraft-deployment-config" type="application/json">{"url":"/apphost"}</script>';
    await Promise.all([
      writeFile(join(current, "index.html"), shell),
      writeFile(join(current, "version.json"), "current"),
      writeFile(join(current, "assets", "a-current.js"), "current module"),
      writeFile(join(previous, "index.html"), "old shell"),
      writeFile(join(previous, "version.json"), "old manifest"),
      writeFile(join(previous, "opencraft-app-sw.js"), "old worker"),
      writeFile(join(previous, "assets", "a-previous.js"), "old lazy module"),
      writeFile(join(previous, "assets", "a-previous.js.map"), "old map"),
    ]);
    const requests: unknown[] = [];
    const api = {
      accountId: "a".repeat(32),
      async call<T>(method: string, path: string, body: unknown): Promise<T> {
        assert.equal(method, "POST");
        assert.equal(path, "/workers/scripts/preview/assets-upload-session");
        requests.push(body);
        return { jwt: "upload-session", buckets: [] } as T;
      },
    };
    await uploadWorkbenchAssets(api, "preview", current, () => {}, [previous]);
    const request = requests[0] as { manifest: Record<string, { hash: string; size: number }> };
    assert.deepEqual(Object.keys(request.manifest).sort(), [
      "/assets/a-current.js",
      "/assets/a-previous.js",
      "/index.html",
      "/version.json",
    ]);
    assert.equal(request.manifest["/index.html"]?.size, shell.length);
    assert.equal(request.manifest["/version.json"]?.size, "current".length);
    await writeFile(join(previous, "assets", "a-current.js"), "conflicting module");
    await assert.rejects(
      uploadWorkbenchAssets(api, "preview", current, () => {}, [previous]),
      /Conflicting immutable Workbench asset/,
    );
    assert.equal(requests.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
