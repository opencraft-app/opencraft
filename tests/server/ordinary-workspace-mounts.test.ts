import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxCommand, SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";
import {
  e2bMountProbe,
  validateE2BMountReceipt,
  verifyE2BWorkspaceMounts,
} from "../../packages/sandbox-e2b/src/workspace-mounts.js";

const unavailable = /ordinary_workspace_mounts_unavailable/;
const privateVolumeId = "a1b2c3d4-2222-4333-8444-555555555555";
const libraryVolumeId = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const nfs = (mount: string, name: string, extra: Partial<Record<"root" | "fs" | "source", string>> = {}) => ({
  mount,
  root: "/",
  fs: "nfs4",
  source: "10.0.0.2:/" + name,
  ...extra,
});
const privateReceipt = () => ({
  mounts: [nfs("/workspace", "private-volume")],
  workspace: "/workspace",
  library: null,
  directory: false,
});
const libraryReceipt = () => ({
  mounts: [nfs("/workspace", "private-volume"), nfs("/shared", "library-volume", { fs: "nfs" })],
  workspace: "/workspace",
  library: "/shared/docs/guides",
  directory: true,
});

test("mount receipts accept exactly the verified private and library NFS volumes", () => {
  assert.deepEqual(validateE2BMountReceipt(privateReceipt(), { privateName: "private-volume" }), {
    cwd: "/workspace",
  });
  assert.deepEqual(
    validateE2BMountReceipt(libraryReceipt(), {
      privateName: "private-volume",
      sharedName: "library-volume",
      relativePath: "docs/guides",
    }),
    { cwd: "/workspace", libraryPath: "/shared/docs/guides" },
  );
  assert.deepEqual(
    validateE2BMountReceipt(
      { ...libraryReceipt(), library: "/shared" },
      { privateName: "private-volume", sharedName: "library-volume", relativePath: "" },
    ),
    { cwd: "/workspace", libraryPath: "/shared" },
  );
});

test("mount receipts reject malformed expectations and every unverified filesystem shape", () => {
  for (const expected of [
    { privateName: "" },
    { privateName: "-private" },
    { privateName: "private/volume" },
    { privateName: "x".repeat(161) },
    { privateName: "private-volume", sharedName: "library volume" },
    { privateName: "private-volume", sharedName: "library-volume", relativePath: "../escape" },
    { privateName: "private-volume", sharedName: "library-volume", relativePath: "/absolute" },
  ])
    assert.throws(
      () => validateE2BMountReceipt(libraryReceipt(), expected),
      unavailable,
      JSON.stringify(expected),
    );

  const expected = { privateName: "private-volume", sharedName: "library-volume", relativePath: "docs/guides" };
  const rejected: [string, unknown][] = [
    ["null", null],
    ["text", "receipt"],
    ["no mounts", { ...libraryReceipt(), mounts: undefined }],
    [
      "too many mounts",
      { ...libraryReceipt(), mounts: Array.from({ length: 257 }, () => nfs("/workspace", "private-volume")) },
    ],
    ["resolved workspace", { ...libraryReceipt(), workspace: "/mnt/workspace" }],
    ["private missing", { ...libraryReceipt(), mounts: [nfs("/shared", "library-volume")] }],
    ["library missing", { ...libraryReceipt(), mounts: [nfs("/workspace", "private-volume")] }],
    [
      "stacked private",
      { ...libraryReceipt(), mounts: [...libraryReceipt().mounts, nfs("/workspace", "private-volume")] },
    ],
    [
      "private subtree",
      {
        ...libraryReceipt(),
        mounts: [nfs("/workspace", "private-volume", { root: "/sub" }), libraryReceipt().mounts[1]],
      },
    ],
    [
      "local filesystem",
      {
        ...libraryReceipt(),
        mounts: [nfs("/workspace", "private-volume", { fs: "ext4" }), libraryReceipt().mounts[1]],
      },
    ],
    [
      "other private volume",
      { ...libraryReceipt(), mounts: [nfs("/workspace", "other-volume"), libraryReceipt().mounts[1]] },
    ],
    // A suffix match without the export separator names another volume.
    [
      "volume suffix",
      { ...libraryReceipt(), mounts: [nfs("/workspace", "xprivate-volume"), libraryReceipt().mounts[1]] },
    ],
    [
      "long source",
      {
        ...libraryReceipt(),
        mounts: [
          nfs("/workspace", "private-volume", { source: "h".repeat(1024) + ":/private-volume" }),
          libraryReceipt().mounts[1],
        ],
      },
    ],
    [
      "nested private mount",
      {
        ...libraryReceipt(),
        mounts: [...libraryReceipt().mounts, { mount: "/workspace/cache", root: "/", fs: "tmpfs", source: "tmpfs" }],
      },
    ],
    [
      "nested library mount",
      {
        ...libraryReceipt(),
        mounts: [...libraryReceipt().mounts, { mount: "/shared/docs", root: "/", fs: "tmpfs", source: "tmpfs" }],
      },
    ],
    ["null entry", { ...libraryReceipt(), mounts: [...libraryReceipt().mounts, null] }],
    ["unnamed entry", { ...libraryReceipt(), mounts: [...libraryReceipt().mounts, { root: "/" }] }],
    ["other library path", { ...libraryReceipt(), library: "/shared/docs" }],
    // realpath resolution away from the selected path means a symlink was followed.
    ["resolved library", { ...libraryReceipt(), library: "/workspace/docs/guides" }],
    ["library is not a directory", { ...libraryReceipt(), directory: false }],
    ["truthy directory", { ...libraryReceipt(), directory: 1 }],
  ];
  for (const [name, receipt] of rejected)
    assert.throws(() => validateE2BMountReceipt(receipt, expected), unavailable, name);
  // Without a library binding, only the private volume is evidence; no library is reported.
  assert.throws(
    () =>
      validateE2BMountReceipt(
        { ...privateReceipt(), mounts: [...privateReceipt().mounts, nfs("/workspace/x", "y")] },
        { privateName: "private-volume" },
      ),
    unavailable,
  );
});

const python = spawnSync("python3", ["--version"]).status === 0;

test(
  "the mount probe reports only workspace and library mounts with decoded fields",
  { skip: !python && "python3 is required" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "ordinary-mount-probe-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const mountinfo = join(directory, "mountinfo");
    await writeFile(
      mountinfo,
      [
        "36 25 0:32 / /workspace rw,relatime shared:1 - nfs4 10.0.0.2:/private-volume rw,vers=4.1",
        "37 36 0:33 / /workspace/cache rw - tmpfs tmpfs rw",
        "38 25 0:34 /exports/a\\040b /shared rw master:2 - nfs 10.0.0.2:/library\\040volume rw",
        "39 25 0:35 / /home rw - ext4 /dev/sda1 rw",
        "40 25 0:36 / /workspace2 rw - ext4 /dev/sda2 rw",
        "41 25 0:37 / /sharedx rw - ext4 /dev/sda3 rw",
        "",
      ].join("\n"),
    );
    const marker = "'/proc/self/mountinfo'";
    assert.equal(e2bMountProbe.split(marker).length, 2);
    const run = (selected: string) => {
      const result = spawnSync(
        "python3",
        ["-c", e2bMountProbe.replace(marker, JSON.stringify(mountinfo)), selected],
        {
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const report = run("");
    assert.deepEqual(report.mounts, [
      { mount: "/workspace", root: "/", fs: "nfs4", source: "10.0.0.2:/private-volume" },
      { mount: "/workspace/cache", root: "/", fs: "tmpfs", source: "tmpfs" },
      { mount: "/shared", root: "/exports/a b", fs: "nfs", source: "10.0.0.2:/library volume" },
    ]);
    assert.equal(report.library, null);
    assert.equal(report.directory, false);
    // The selected library is resolved, so a symlink cannot masquerade as the selected path.
    const selected = run(directory);
    assert.equal(selected.library, directory);
    assert.equal(selected.directory, true);
    assert.equal(run(mountinfo).directory, false);
  },
);

type Fetch = typeof fetch;
const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), init);
const metadata = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  workspaceID: "ws-alpha",
  privateVolumeID: privateVolumeId,
  privateVolumeName: "private-volume",
  sharedVolumeID: libraryVolumeId,
  members: [{ sandboxID: "instance-1" }],
  ...extra,
});

function probeSandbox(
  reply: {
    receipt?: unknown;
    stdout?: string;
    code?: number | null;
    kind?: "process" | "terminal";
    hang?: boolean;
    terminateFails?: boolean;
  } = {},
) {
  const calls = { spawned: [] as SandboxCommand[], terminated: 0 };
  const sandbox: Pick<SandboxEnvironment, "spawn"> = {
    async spawn(command, onOutput) {
      calls.spawned.push(command);
      let finish!: (code: number | null) => void;
      const exited = new Promise<{ code: number | null }>((resolve) => {
        finish = (code) => resolve({ code });
      });
      const common = {
        id: "probe",
        exited,
        async writeStdin() {},
        async terminate() {
          calls.terminated += 1;
          if (reply.terminateFails) throw Error("terminate failed");
          finish(null);
        },
      };
      if (reply.kind === "terminal") return { ...common, kind: "terminal", async resize() {} } as SandboxProcess;
      return {
        ...common,
        kind: "process",
        async closeStdin() {
          if (reply.hang) return;
          const stdout = reply.stdout ?? JSON.stringify(reply.receipt ?? privateReceipt());
          for (let offset = 0; offset < stdout.length; offset += 1000)
            onOutput?.({ stream: "stdout", data: new TextEncoder().encode(stdout.slice(offset, offset + 1000)) });
          onOutput?.({ stream: "stderr", data: new TextEncoder().encode("x".repeat(70000)) });
          finish(reply.code === undefined ? 0 : reply.code);
        },
      } as SandboxProcess;
    },
  };
  return { sandbox, calls };
}

function verifyInput(
  overrides: Partial<Parameters<typeof verifyE2BWorkspaceMounts>[0]> = {},
  responses: Record<string, () => Response> = {},
) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const events: string[] = [];
  let cleanupUnconfirmed = 0;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    events.push("fetch " + new URL(String(url)).pathname);
    const path = new URL(String(url)).pathname;
    const respond =
      responses[path] ??
      (path === "/workspaces/ws-alpha"
        ? () => json(metadata())
        : path === "/volumes/" + libraryVolumeId
          ? () => json({ volumeID: libraryVolumeId, name: "library-volume" })
          : () => new Response(null, { status: 404 }));
    return respond();
  }) as Fetch;
  const { sandbox, calls } = probeSandbox();
  const input: Parameters<typeof verifyE2BWorkspaceMounts>[0] = {
    sandbox,
    workspaceId: "ws-alpha",
    instanceId: "instance-1",
    privateVolumeId,
    apiUrl: "https://volumes.example.test/",
    readApiKey: async () => {
      events.push("key");
      return "read-key";
    },
    authorize: async () => {
      events.push("authorize");
    },
    onCleanupUnconfirmed: () => {
      cleanupUnconfirmed += 1;
    },
    request,
    ...overrides,
  };
  return { input, requests, events, calls, cleanupUnconfirmed: () => cleanupUnconfirmed };
}

test("verification rejects malformed identities and endpoints before reading any credential", async () => {
  for (const overrides of [
    { workspaceId: "alpha" },
    { workspaceId: "ws-" },
    { workspaceId: "ws-a/b" },
    { instanceId: "" },
    { privateVolumeId: "a1b2c3d4-2222-4333-8444-55555555555" },
    { privateVolumeId: privateVolumeId.toUpperCase() },
    { library: { volumeId: "library", relativePath: "docs" } },
    { library: { volumeId: libraryVolumeId, relativePath: "../docs" } },
    { apiUrl: "http://volumes.example.test/" },
    { apiUrl: "https://user:secret@volumes.example.test/" },
    { apiUrl: "https://volumes.example.test/api/" },
    { apiUrl: "https://volumes.example.test/?region=1" },
    { apiUrl: "https://volumes.example.test/#x" },
  ] satisfies Partial<Parameters<typeof verifyE2BWorkspaceMounts>[0]>[]) {
    const { input, events } = verifyInput(overrides);
    await assert.rejects(verifyE2BWorkspaceMounts(input), unavailable, JSON.stringify(overrides));
    assert.deepEqual(events, [], JSON.stringify(overrides));
  }
  const { input, events } = verifyInput({ apiUrl: "not a url" });
  await assert.rejects(verifyE2BWorkspaceMounts(input));
  assert.deepEqual(events, []);
});

test("verification reads metadata with the current key, then probes the private volume", async () => {
  const { input, requests, events, calls } = verifyInput();
  const { sandbox } = probeSandbox({ receipt: privateReceipt() });
  input.sandbox = {
    spawn: async (command, onOutput) => {
      events.push("spawn");
      calls.spawned.push(command);
      return sandbox.spawn(command, onOutput);
    },
  };
  assert.deepEqual(await verifyE2BWorkspaceMounts(input), { cwd: "/workspace" });
  assert.deepEqual(events, [
    "authorize",
    "key",
    "authorize",
    "fetch /workspaces/ws-alpha",
    "authorize",
    "authorize",
    "spawn",
    "authorize",
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://volumes.example.test/workspaces/ws-alpha");
  assert.deepEqual(requests[0]!.init?.headers, { "X-API-Key": "read-key" });
  assert.equal(requests[0]!.init?.redirect, "error");
  assert.ok(requests[0]!.init?.signal instanceof AbortSignal);
  const [command] = calls.spawned;
  assert.deepEqual(command!.command, ["/usr/bin/python3", "-c", e2bMountProbe, ""]);
  assert.equal(command!.cwd, "/workspace");
  assert.deepEqual(command!.env, { PATH: "/usr/bin:/bin" });
});

test("verification binds the library volume by identity and probes the selected path", async () => {
  const { input, requests, calls } = verifyInput({
    library: { volumeId: libraryVolumeId, relativePath: "docs/guides" },
  });
  const { sandbox } = probeSandbox({ receipt: libraryReceipt() });
  input.sandbox = {
    spawn: async (command, onOutput) => {
      calls.spawned.push(command);
      return sandbox.spawn(command, onOutput);
    },
  };
  assert.deepEqual(await verifyE2BWorkspaceMounts(input), {
    cwd: "/workspace",
    libraryPath: "/shared/docs/guides",
  });
  assert.deepEqual(
    requests.map((r) => r.url),
    ["https://volumes.example.test/workspaces/ws-alpha", "https://volumes.example.test/volumes/" + libraryVolumeId],
  );
  assert.equal(calls.spawned[0]!.command[3], "/shared/docs/guides");
});

test("verification rejects metadata that does not bind this allocation, without probing", async () => {
  const library = { volumeId: libraryVolumeId, relativePath: "docs/guides" };
  const cases: [
    string,
    Record<string, () => Response>,
    Partial<Parameters<typeof verifyE2BWorkspaceMounts>[0]>?,
  ][] = [
    ["schema", { "/workspaces/ws-alpha": () => json(metadata({ schemaVersion: 1 })) }],
    ["workspace", { "/workspaces/ws-alpha": () => json(metadata({ workspaceID: "ws-beta" })) }],
    ["private volume", { "/workspaces/ws-alpha": () => json(metadata({ privateVolumeID: libraryVolumeId })) }],
    ["volume name", { "/workspaces/ws-alpha": () => json(metadata({ privateVolumeName: "../x" })) }],
    ["no members", { "/workspaces/ws-alpha": () => json(metadata({ members: [] })) }],
    [
      "shared",
      {
        "/workspaces/ws-alpha": () =>
          json(metadata({ members: [{ sandboxID: "instance-1" }, { sandboxID: "instance-2" }] })),
      },
    ],
    ["member", { "/workspaces/ws-alpha": () => json(metadata({ members: [{ sandboxID: "instance-2" }] })) }],
    ["null member", { "/workspaces/ws-alpha": () => json(metadata({ members: [null] })) }],
    ["array", { "/workspaces/ws-alpha": () => json([metadata()]) }],
    ["null", { "/workspaces/ws-alpha": () => json(null) }],
    ["status", { "/workspaces/ws-alpha": () => json(metadata(), { status: 503 }) }],
    ["no body", { "/workspaces/ws-alpha": () => new Response(null, { status: 200 }) }],
    ["oversized", { "/workspaces/ws-alpha": () => json(metadata({ pad: "x".repeat(70000) })) }],
    [
      "library binding",
      { "/workspaces/ws-alpha": () => json(metadata({ sharedVolumeID: privateVolumeId })) },
      { library },
    ],
    [
      "library volume",
      { ["/volumes/" + libraryVolumeId]: () => json({ volumeID: privateVolumeId, name: "library-volume" }) },
      { library },
    ],
    [
      "library name",
      { ["/volumes/" + libraryVolumeId]: () => json({ volumeID: libraryVolumeId, name: "" }) },
      { library },
    ],
    ["library missing", { ["/volumes/" + libraryVolumeId]: () => new Response("{}", { status: 404 }) }, { library }],
  ];
  for (const [name, responses, overrides] of cases) {
    const { input, calls } = verifyInput(overrides, responses);
    await assert.rejects(verifyE2BWorkspaceMounts(input), unavailable, name);
    assert.equal(calls.spawned.length, 0, name);
  }
});

test("verification stops when authority is revoked between steps", async () => {
  for (let failAt = 1; failAt <= 5; failAt += 1) {
    let calls = 0;
    const { input, calls: probe } = verifyInput({
      authorize: async () => {
        if (++calls === failAt) throw Error("revoked");
      },
    });
    await assert.rejects(verifyE2BWorkspaceMounts(input), failAt <= 3 ? /revoked/ : unavailable, String(failAt));
    // Spawning requires the fourth authorization.
    assert.equal(probe.spawned.length > 0, failAt > 4, String(failAt));
  }
});

test("verification rejects unusable probes and releases the probe process", async () => {
  const cases: [string, Parameters<typeof probeSandbox>[0]][] = [
    ["exit", { code: 2 }],
    ["signal", { code: null }],
    ["terminal", { kind: "terminal" }],
    ["oversized", { stdout: JSON.stringify({ ...privateReceipt(), pad: "x".repeat(70000) }) }],
    ["invalid json", { stdout: "{" }],
    ["unverified mount", { receipt: { ...privateReceipt(), mounts: [nfs("/workspace", "other-volume")] } }],
  ];
  for (const [name, reply] of cases) {
    const { input } = verifyInput();
    const probe = probeSandbox(reply);
    input.sandbox = probe.sandbox;
    await assert.rejects(verifyE2BWorkspaceMounts(input), unavailable, name);
    assert.equal(probe.calls.terminated, 1, name);
  }
  const { input, cleanupUnconfirmed } = verifyInput();
  input.sandbox = probeSandbox({ code: 1, terminateFails: true }).sandbox;
  await assert.rejects(verifyE2BWorkspaceMounts(input), unavailable);
  assert.equal(cleanupUnconfirmed(), 1, "an unconfirmed cleanup is reported to the allocation owner");
});

test("verification expires a probe that does not finish and terminates it", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { input } = verifyInput();
  const probe = probeSandbox({ hang: true });
  let spawned!: () => void;
  const started = new Promise<void>((resolve) => (spawned = resolve));
  input.sandbox = {
    async spawn(command, onOutput) {
      const child = await probe.sandbox.spawn(command, onOutput);
      spawned();
      return child;
    },
  };
  const verification = verifyE2BWorkspaceMounts(input);
  await started;
  mock.timers.tick(20000);
  await assert.rejects(verification, unavailable);
  assert.ok(probe.calls.terminated >= 1);
});
