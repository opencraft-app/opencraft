import {describe, expect, test} from "bun:test";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";

describe("Human TUI builder", () => {
  test("produces byte-identical source-provenanced artifacts", async () => {
    const repositoryRoot = resolve(import.meta.dir, "../../../..");
    const first = await mkdtemp(`${tmpdir()}/vela-tui-first-`);
    const second = await mkdtemp(`${tmpdir()}/vela-tui-second-`);

    await build(repositoryRoot, first);
    await build(repositoryRoot, second);

    for (const name of [
      "human-client.bundle.js",
      "human-client.bundle.sha256",
      "human-client.bundle.manifest.json",
    ]) {
      expect(await readFile(resolve(first, name))).toEqual(
        await readFile(resolve(second, name)),
      );
    }
    const bundle = await readFile(resolve(first, "human-client.bundle.js"), "utf8");
    const manifest = JSON.parse(
      await readFile(
        resolve(first, "human-client.bundle.manifest.json"),
        "utf8",
      ),
    ) as {
      schema: string;
      sourceInputs: Array<{path: string}>;
    };
    expect(bundle).toContain("__velaTui");
    expect(bundle).not.toContain("@tencentcloud/chat");
    expect(manifest.schema).toBe("vela-human-tui-build/v1");
    expect(manifest.sourceInputs.map((input) => input.path)).toContain(
      "web/bun.lock",
    );
  });

  test("check mode detects stale artifacts without rewriting them", async () => {
    const repositoryRoot = resolve(import.meta.dir, "../../../..");
    const tracked = await mkdtemp(`${tmpdir()}/vela-tui-tracked-`);
    await build(repositoryRoot, tracked);

    expect(await check(repositoryRoot, tracked)).toBe(0);
    const hashPath = resolve(tracked, "human-client.bundle.sha256");
    await writeFile(hashPath, "stale\n");

    expect(await check(repositoryRoot, tracked)).not.toBe(0);
    expect(await readFile(hashPath, "utf8")).toBe("stale\n");
  });
});

async function build(repositoryRoot: string, outputDirectory: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "build-human-tui.ts"),
      "--repository-root",
      repositoryRoot,
      "--output-dir",
      outputDirectory,
    ],
    {cwd: repositoryRoot, stderr: "pipe", stdout: "pipe"},
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(await new Response(child.stderr).text());
  }
}

async function check(repositoryRoot: string, artifactDirectory: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "build-human-tui.ts"),
      "--repository-root",
      repositoryRoot,
      "--check-dir",
      artifactDirectory,
    ],
    {cwd: repositoryRoot, stderr: "pipe", stdout: "pipe"},
  );
  return child.exited;
}
