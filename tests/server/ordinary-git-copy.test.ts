import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxCommand, SandboxEnvironment, SandboxOutput, SandboxProcess } from "@opencraft/sandbox";
import type { ResolvedWorkspaceSelection } from "@opencraft/execution-environment/workspace-selection";
import {
  ordinaryGitGenerationPath,
  prepareOrdinaryGitCopy,
} from "../../apps/headless-server/src/workspaces/ordinary-git-copy.js";

type GitSource = Extract<ResolvedWorkspaceSelection["source"], { kind: "git" }>;
const remote = "https://git.example.test/team/repo.git";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function selection(source: Partial<GitSource> = {}): ResolvedWorkspaceSelection {
  return {
    version: 1,
    environment: {
      configurationId: "configuration-1",
      configurationRevision: "a".repeat(64),
      templateId: "template-1",
      cpuMillis: 1000,
      memoryBytes: 1024 ** 3,
    },
    source: {
      kind: "git",
      repositoryId: "repository-1",
      commit: "b".repeat(40),
      libraryId: "library-1",
      authorizationDomain: "domain-1",
      generation: "generation-1",
      relativePath: "pkg",
      ...source,
    },
  };
}

/** Records the command, stdin and cleanup; replies with a fixed receipt. */
function scriptedSandbox(reply: { stdout?: string; code?: number | null; kind?: "process" | "terminal" } = {}) {
  const calls = { spawned: [] as SandboxCommand[], stdin: [] as string[], closedStdin: 0, terminated: 0 };
  const sandbox: Pick<SandboxEnvironment, "spawn"> = {
    async spawn(command, onOutput) {
      calls.spawned.push(command);
      let finish!: (code: number | null) => void;
      const exited = new Promise<{ code: number | null }>((resolve) => {
        finish = (code) => resolve({ code });
      });
      const common = {
        id: "process-1",
        exited,
        async writeStdin(data: Uint8Array) {
          calls.stdin.push(Buffer.from(data).toString("utf8"));
        },
        async terminate() {
          calls.terminated += 1;
          finish(null);
        },
      };
      if (reply.kind === "terminal") return { ...common, kind: "terminal", async resize() {} } as SandboxProcess;
      return {
        ...common,
        kind: "process",
        async closeStdin() {
          calls.closedStdin += 1;
          if (reply.stdout !== undefined)
            onOutput?.({ stream: "stdout", data: new TextEncoder().encode(reply.stdout) } satisfies SandboxOutput);
          onOutput?.({ stream: "stderr", data: new TextEncoder().encode("diagnostic\n") });
          finish(reply.code === undefined ? 0 : reply.code);
        },
      } as SandboxProcess;
    },
  };
  return { sandbox, calls };
}

test("generation path is derived from hashed identities and a validated generation", () => {
  const source = selection().source as GitSource;
  assert.equal(
    ordinaryGitGenerationPath(source),
    `/shared/git/${sha256("domain-1")}/${sha256("repository-1")}/generation-1.git`,
  );
  // Another authorization domain or repository never shares a generation directory.
  assert.notEqual(
    ordinaryGitGenerationPath({ ...source, authorizationDomain: "domain-2" }),
    ordinaryGitGenerationPath(source),
  );
  assert.notEqual(
    ordinaryGitGenerationPath({ ...source, repositoryId: "repository-2" }),
    ordinaryGitGenerationPath(source),
  );
  // Identities are hashed, so path syntax inside them cannot escape the layout.
  assert.match(
    ordinaryGitGenerationPath({ ...source, repositoryId: "../../etc", authorizationDomain: "/" }),
    /^\/shared\/git\/[a-f0-9]{64}\/[a-f0-9]{64}\/generation-1\.git$/,
  );
  assert.equal(
    ordinaryGitGenerationPath({ ...source, generation: "2026.10:release_1-a" }).endsWith("/2026.10:release_1-a.git"),
    true,
  );
  for (const generation of ["", "../x", ".hidden", "-flag", "a/b", "a b", "x".repeat(161)])
    assert.throws(() => ordinaryGitGenerationPath({ ...source, generation }), /Invalid Git generation/, generation);
});

test("preparation rejects unusable selections and remotes before authorization or spawn", async () => {
  const { sandbox, calls } = scriptedSandbox();
  let authorized = 0;
  const prepare = (input: { selection?: unknown; remote?: string }) =>
    prepareOrdinaryGitCopy({
      sandbox,
      selection: (input.selection ?? selection()) as ResolvedWorkspaceSelection,
      remote: input.remote ?? remote,
      authorize: async () => {
        authorized += 1;
      },
    });
  const base = selection();
  await assert.rejects(prepare({ selection: { ...base, source: { kind: "empty" } } }), /Git source required/);
  await assert.rejects(
    prepare({
      selection: {
        ...base,
        source: {
          kind: "library-reference",
          libraryId: "library-1",
          authorizationDomain: "domain-1",
          generation: "generation-1",
          relativePath: "",
        },
      },
    }),
    /Git source required/,
  );
  for (const source of [{ commit: "B".repeat(40) }, { relativePath: "../escape" }, { generation: "../x" }])
    await assert.rejects(prepare({ selection: selection(source) }), /Invalid resolved workspace selection/);
  await assert.rejects(prepare({ selection: { ...base, extra: true } }), /Invalid resolved workspace selection/);
  for (const value of [
    "http://git.example.test/team/repo.git",
    "ssh://git.example.test/team/repo.git",
    "https://user@git.example.test/team/repo.git",
    "https://user:secret@git.example.test/team/repo.git",
    "https://git.example.test/team/repo.git?token=1",
    "https://git.example.test/team/repo.git#main",
    // Accepted only in canonical URL form, so stored and checked-out remotes match exactly.
    "https://GIT.example.test/team/repo.git",
    "https://git.example.test",
  ])
    await assert.rejects(prepare({ remote: value }), /Invalid canonical Git remote/, value);
  await assert.rejects(prepare({ remote: "not a url" }));
  assert.equal(authorized, 0);
  assert.equal(calls.spawned.length, 0);
});

test("preparation runs one offline process with the derived generation and returns the derived cwd", async () => {
  const { sandbox, calls } = scriptedSandbox({ stdout: JSON.stringify({ cwd: "/workspace/project/pkg" }) });
  const order: string[] = [];
  const result = await prepareOrdinaryGitCopy({
    sandbox: {
      async spawn(command, onOutput) {
        order.push("spawn");
        return sandbox.spawn(command, onOutput);
      },
    },
    selection: selection(),
    remote,
    authorize: async () => {
      order.push("authorize");
    },
  });
  assert.deepEqual(result, { cwd: "/workspace/project/pkg" });
  assert.deepEqual(order, ["authorize", "spawn", "authorize"]);
  const [command] = calls.spawned;
  assert.equal(command!.command[0], "/usr/bin/python3");
  assert.equal(command!.command[1], "-c");
  assert.equal(command!.command.length, 3);
  assert.equal(command!.cwd, "/workspace");
  assert.deepEqual(command!.env, { PATH: "/usr/local/bin:/usr/bin:/bin" });
  assert.equal(command!.terminal, undefined);
  assert.equal(calls.closedStdin, 1);
  // The script receives the normalized selection and the publisher-owned base path only.
  const source = selection().source as GitSource;
  assert.deepEqual(JSON.parse(calls.stdin.join("")), {
    source,
    remote,
    base: ordinaryGitGenerationPath(source),
  });
  assert.equal(calls.terminated, 1, "the process is always released");

  const root = scriptedSandbox({ stdout: JSON.stringify({ cwd: "/workspace/project" }) });
  assert.deepEqual(
    await prepareOrdinaryGitCopy({
      sandbox: root.sandbox,
      selection: selection({ relativePath: "" }),
      remote,
      authorize: async () => {},
    }),
    { cwd: "/workspace/project" },
  );
});

test("preparation rejects failed, oversized, mismatched or unauthorized results and always terminates", async () => {
  const cases: {
    name: string;
    reply: Parameters<typeof scriptedSandbox>[0];
    error: RegExp;
    authorizeFailsAt?: number;
  }[] = [
    {
      name: "nonzero exit",
      reply: { code: 1, stdout: JSON.stringify({ cwd: "/workspace/project/pkg" }) },
      error: /preparation failed/,
    },
    {
      name: "killed",
      reply: { code: null, stdout: JSON.stringify({ cwd: "/workspace/project/pkg" }) },
      error: /preparation failed/,
    },
    {
      name: "oversized output",
      reply: { stdout: JSON.stringify({ cwd: "/workspace/project/pkg", pad: "x".repeat(5000) }) },
      error: /preparation failed/,
    },
    // The receipt can only confirm the cwd derived from the durable selection.
    {
      name: "other cwd",
      reply: { stdout: JSON.stringify({ cwd: "/workspace/project/other" }) },
      error: /Invalid Git copy receipt/,
    },
    { name: "no receipt", reply: { stdout: "null" }, error: /Invalid Git copy receipt/ },
    { name: "terminal", reply: { kind: "terminal" }, error: /requires a nonterminal process/ },
    {
      name: "revoked",
      reply: { stdout: JSON.stringify({ cwd: "/workspace/project/pkg" }) },
      error: /revoked/,
      authorizeFailsAt: 2,
    },
  ];
  for (const { name, reply, error, authorizeFailsAt } of cases) {
    const { sandbox, calls } = scriptedSandbox(reply);
    let authorized = 0;
    await assert.rejects(
      prepareOrdinaryGitCopy({
        sandbox,
        selection: selection(),
        remote,
        authorize: async () => {
          if (++authorized === authorizeFailsAt) throw Error("revoked");
        },
      }),
      error,
      name,
    );
    assert.equal(calls.terminated, 1, name);
  }
  const { sandbox, calls } = scriptedSandbox();
  await assert.rejects(
    prepareOrdinaryGitCopy({
      sandbox,
      selection: selection(),
      remote,
      authorize: async () => Promise.reject(Error("denied")),
    }),
    /denied/,
  );
  assert.equal(calls.spawned.length, 0, "an unauthorized preparation never reaches the sandbox");
});

const tools = ["python3", "git"].every((name) => spawnSync(name, ["--version"]).status === 0);

/** Runs the real preparation script on the local machine, with /workspace and the
 * generation base mapped to private temporary directories. */
async function localSandbox(root: string, base: string) {
  const sent: Record<string, unknown>[] = [];
  const sandbox: Pick<SandboxEnvironment, "spawn"> = {
    async spawn(command, onOutput) {
      const marker = "pathlib.Path('/workspace')";
      const script = command.command[2]!;
      assert.equal(script.split(marker).length, 2, "the script names its private root once");
      const child = spawnProcess("python3", ["-c", script.replace(marker, `pathlib.Path(${JSON.stringify(root)})`)], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.resume();
      const exited = new Promise<{ code: number | null }>((resolve) =>
        child.on("close", (code) => {
          const text = Buffer.concat(stdout).toString("utf8").split(root).join("/workspace");
          onOutput?.({ stream: "stdout", data: new TextEncoder().encode(text) });
          resolve({ code });
        }),
      );
      let input = "";
      return {
        id: "local",
        kind: "process",
        exited,
        async writeStdin(data: Uint8Array) {
          input += Buffer.from(data).toString("utf8");
        },
        async closeStdin() {
          const value = JSON.parse(input);
          sent.push(value);
          child.stdin.end(JSON.stringify({ ...value, base }));
        },
        async terminate() {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await exited;
        },
      } satisfies SandboxProcess;
    },
  };
  return { sandbox, sent };
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ordinary-git-copy-")));
  const upstream = join(directory, "upstream");
  await mkdir(join(upstream, "pkg"), { recursive: true });
  git(directory, "init", "-q", "-b", "main", upstream);
  await writeFile(join(upstream, "pkg", "index.txt"), "first\n");
  await writeFile(join(upstream, "README.md"), "root\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-q", "-m", "first");
  const commit = git(upstream, "rev-parse", "HEAD");
  const base = join(directory, "generation.git");
  git(directory, "clone", "-q", "--bare", "--no-local", upstream, base);
  const source = selection({ commit }).source as GitSource;
  const manifest = {
    version: 1,
    remote,
    repositoryId: source.repositoryId,
    authorizationDomain: source.authorizationDomain,
    generation: source.generation,
    commit,
  };
  await writeFile(join(base, "opencraft-generation.json"), JSON.stringify(manifest));
  const root = join(directory, "workspace");
  await mkdir(root);
  return { directory, root, base, commit, manifest };
}

test(
  "the preparation script creates, restores and refuses private Git copies",
  { skip: !tools && "python3 and git are required" },
  async (t) => {
    const { directory, root, base, commit, manifest } = await fixture();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { sandbox, sent } = await localSandbox(root, base);
    const prepare = (source: Partial<GitSource> = {}) =>
      prepareOrdinaryGitCopy({
        sandbox,
        selection: selection({ commit, ...source }),
        remote,
        authorize: async () => {},
      });

    assert.deepEqual(await prepare(), { cwd: "/workspace/project/pkg" });
    assert.equal(sent[0]!.base, ordinaryGitGenerationPath(selection({ commit }).source as GitSource));
    const project = join(root, "project");
    assert.equal(await readFile(join(project, "pkg", "index.txt"), "utf8"), "first\n");
    assert.equal(git(project, "rev-parse", "HEAD"), commit);
    assert.equal(git(project, "branch", "--show-current"), "opencraft/work");
    assert.equal(git(project, "remote", "get-url", "origin"), remote);
    // Objects are borrowed from the immutable generation, never copied or pruned.
    assert.equal(
      await readFile(join(project, ".git", "objects", "info", "alternates"), "utf8"),
      join(base, "objects") + "\n",
    );
    assert.equal(git(project, "config", "gc.auto"), "0");
    assert.deepEqual(JSON.parse(await readFile(join(project, ".git", "opencraft-source.json"), "utf8")), {
      version: 1,
      source: selection({ commit }).source,
      remote,
    });
    // No staging directory or publication lock remains after success.
    assert.deepEqual((await readdir(root)).sort(), ["project"]);

    // Restore preserves the user's work instead of resetting it.
    await writeFile(join(project, "pkg", "index.txt"), "edited\n");
    git(project, "commit", "-q", "-am", "local work");
    assert.deepEqual(await prepare(), { cwd: "/workspace/project/pkg" });
    assert.equal(await readFile(join(project, "pkg", "index.txt"), "utf8"), "edited\n");
    assert.notEqual(git(project, "rev-parse", "HEAD"), commit);

    // A copy made from another selection is never silently reused or replaced.
    await assert.rejects(prepare({ relativePath: "" }), /preparation failed/);
    await assert.rejects(prepare({ libraryId: "library-2" }), /preparation failed/);
    assert.equal(await readFile(join(project, "pkg", "index.txt"), "utf8"), "edited\n");

    // A generation whose manifest names another commit is refused before any copy is created.
    await rm(project, { recursive: true, force: true });
    await writeFile(join(base, "opencraft-generation.json"), JSON.stringify({ ...manifest, commit: "c".repeat(40) }));
    await assert.rejects(prepare(), /preparation failed/);
    await writeFile(join(base, "opencraft-generation.json"), JSON.stringify(manifest));

    // A selected path that is absent from the commit leaves no partial project behind.
    await assert.rejects(prepare({ relativePath: "missing" }), /preparation failed/);
    assert.deepEqual(await readdir(root), []);

    // Shallow generations cannot provide a complete offline history.
    await writeFile(join(base, "shallow"), commit + "\n");
    await assert.rejects(prepare(), /preparation failed/);
    await rm(join(base, "shallow"));

    // An existing user directory is preserved, never adopted or replaced.
    await mkdir(project);
    await writeFile(join(project, "notes.txt"), "mine\n");
    await assert.rejects(prepare(), /preparation failed/);
    assert.equal(await readFile(join(project, "notes.txt"), "utf8"), "mine\n");
    await rm(project, { recursive: true });

    // A symlinked project is refused even when it points at a valid copy.
    assert.deepEqual(await prepare(), { cwd: "/workspace/project/pkg" });
    const moved = join(directory, "moved");
    await rm(moved, { recursive: true, force: true });
    await rename(project, moved);
    await symlink(moved, project);
    assert.equal((await lstat(project)).isSymbolicLink(), true);
    await assert.rejects(prepare(), /preparation failed/);
    assert.equal((await lstat(project)).isSymbolicLink(), true);
  },
);
