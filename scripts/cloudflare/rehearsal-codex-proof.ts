import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { APP_HOST_IDLE_PROBE_ID } from "@opencraft/app-host-protocol";
import {
  SHARED_INTERACTIONS_CHANGED,
  SHARED_INTERACTIONS_READ,
  SHARED_INTERACTIONS_RESPOND,
  WORKSPACE_PLACEMENT_EXTENSION,
  type SharedInteraction,
} from "@opencraft/appserver-protocol";
import type { Thread } from "@opencraft/appserver-protocol/generated/v2";
import {
  codexActorWorkspace,
  isCodexWorkspaceOwner,
} from "../../apps/headless-server/src/cloudflare/codex-workspace.ts";
import { connectCodex, frameQueue } from "../../tests/cloudflare/codex-apphost-client.ts";
import type { TestWebSocket, WorkerInstance } from "../../tests/cloudflare/worker-runtime.ts";
import { proveNativeTools } from "./rehearsal-codex-native-tools.ts";

const nonce = () => randomBytes(32).toString("base64url");
interface RestartProof {
  readonly credentialDigest: string;
  readonly crash?: (workspace: string) => Promise<void>;
  readonly proveClientHibernation?: boolean;
  readonly verifyBrowserAtRest?: (input: BrowserIdleProof) => Promise<void>;
}

export interface BrowserIdleProof {
  readonly origin: string;
  readonly cookies: ReadonlyMap<string, string>;
  readonly signal: AbortSignal;
  readonly workspace: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly verifyUnchanged: () => Promise<void>;
}

export async function waitForRoute(
  request: () => Promise<Response>,
  status: number,
  description: string,
  signal: AbortSignal,
) {
  const deadline = Date.now() + 70_000;
  for (;;) {
    signal.throwIfAborted();
    const response = await request();
    if (response.status === status) return response;
    await response.body?.cancel();
    // requests routed to an edge that has not seen the new deployment can
    // return 404 even after another request reached the Worker.
    assert.ok(response.status === 404 && Date.now() < deadline, `${description} returned HTTP ${response.status}`);
    await delay(1000, undefined, { signal });
  }
}

export async function proveCodex(
  instance: WorkerInstance,
  setupToken: string,
  checks: string[],
  signal: AbortSignal,
  model: string,
  external: boolean,
  bridge: boolean,
  nativeTools?: readonly string[],
  restartProof?: RestartProof,
) {
  const state = await waitForRoute(
    () => instance.fetch(instance.origin + "/__opencraft_account/status"),
    200,
    "Account setup readiness",
    signal,
  );
  assert.equal(
    ((await state.json()) as { setupAvailable: boolean }).setupAvailable,
    true,
    "Account setup proof unavailable",
  );
  const body = JSON.stringify({ proof: setupToken, mode: "web", username: "cloud-owner", password: "Oc1!" + nonce() });
  const setup = await waitForRoute(
    () =>
      instance.fetch(instance.origin + "/__opencraft_account/setup", {
        method: "POST",
        headers: { origin: instance.origin, "content-type": "application/json" },
        body,
      }),
    200,
    "Account setup",
    signal,
  );
  const cookies = new Map(
    setup.headers.getSetCookie().map((cookie) => {
      const pair = cookie.split(";", 1)[0]!;
      const delimiter = pair.indexOf("=");
      return [pair.slice(0, delimiter), pair.slice(delimiter + 1)];
    }),
  );
  await setup.body?.cancel();
  assert.ok(cookies.size, "Account setup did not return a session");

  const sockets: TestWebSocket[] = [];
  const seen = new Set<string>();
  try {
    const { rpc, event, initialized, socket } = await connectCodex(
      { patience: external ? 40 : 25 },
      instance,
      { cookies },
      sockets,
      "ready",
    );
    const challenge = external ? nonce() : null;
    const proofFile = ".opencraft-rehearsal-proof";
    socket.addEventListener("message", ({ data }) => {
      const envelope = JSON.parse(String(data));
      if (envelope.type !== "host/frame") return;
      const frame = JSON.parse(envelope.frame);
      if (typeof frame.method !== "string") return;
      if (
        frame.method === "item/agentMessage/delta" &&
        typeof frame.params?.delta === "string" &&
        frame.params.delta.startsWith("REHEARSAL_TOOL_MISSING ")
      )
        seen.add(frame.params.delta);
      const kind = frame.params?.item?.type ?? frame.params?.turn?.status;
      seen.add(kind ? `${frame.method}(${kind})` : frame.method);
    });
    const call = async (method: string, params: object = {}) => {
      signal.throwIfAborted();
      const result = await rpc(method, params);
      assert.equal(result.error, undefined, `${method}: ${JSON.stringify(result.error)}`);
      return result.result;
    };
    assert.deepEqual(await call("project/list"), { data: [], nextCursor: null });
    assert.deepEqual(await call("thread/list", { sortKey: "updated_at" }), {
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });
    checks.push("empty Project and Thread directories before the first native operation");
    const models = await call("model/list");
    assert.ok(
      models.data.some((entry: { model: string }) => entry.model === model),
      "Configured model is missing",
    );
    const placement = initialized.capabilities.extensions[WORKSPACE_PLACEMENT_EXTENSION];
    assert.equal(placement.fileScopeVersion, 1);
    const root = placement.projectDirectoryRoot;
    assert.match(root, /^(?:\/[a-zA-Z0-9_-]+)+$/u);
    const cwd = root + "/cloud-project-demo";
    const secondProjectRoot = root + "/cloud-project-extra";
    checks.push("account login, AppHost authorization and model catalog");

    const pty = {
      command: ["/bin/bash", "--noprofile", "--norc"],
      tty: true,
      streamStdoutStderr: true,
      outputBytesCap: null,
      timeoutMs: null,
      size: { cols: 80, rows: 24 },
    };
    const write = (scope: { processHandle: string }, text: string) =>
      call("process/writeStdin", { ...scope, deltaBase64: Buffer.from(text).toString("base64") });
    const outputContains = async (processHandle: string, expected: string) => {
      let output = "";
      while (!output.includes(expected)) {
        signal.throwIfAborted();
        const { params } = await event("process/outputDelta", (params) => params.processHandle === processHandle);
        output += Buffer.from(params.deltaBase64, "base64").toString("utf8");
        assert.ok(output.length < 16_384, "PTY receipt not found in preview output");
      }
      return output;
    };
    const seed = { processHandle: "project-root" };
    await call("process/spawn", { ...pty, ...seed });
    const proofSeed = challenge ? ` && printf '%s\\n' '${challenge}' > '${cwd}/${proofFile}'` : "";
    await write(
      seed,
      `mkdir -p '${cwd}'${restartProof ? ` '${secondProjectRoot}'` : ""}${proofSeed} && printf 'OC-PROJECT:%s\\n' seeded\n`,
    );
    await outputContains(seed.processHandle, "OC-PROJECT:seeded");
    await call("process/kill", seed);
    const directory = await call("fs/readDirectory", { path: root });
    assert.ok(directory.entries.some(({ fileName }: { fileName: string }) => fileName === "cloud-project-demo"));
    const request = { name: "Cloud project demo", roots: [{ path: cwd }], idempotencyKey: "cloud-project-demo" };
    const { project } = await call("project/create", request);
    assert.equal((await call("project/create", request)).project.id, project.id);
    assert.ok((await call("project/list")).data.some(({ id }: { id: string }) => id === project.id));
    if (restartProof)
      await call("project/create", {
        name: "Second cloud project",
        roots: [{ path: secondProjectRoot }],
        idempotencyKey: "cloud-project-extra",
      });
    const assignment = { cwd, projectId: project.id, runtimeWorkspaceRoots: [cwd], historyMode: "paginated" };
    if (nativeTools?.length) {
      await proveNativeTools({ call, event, assignment, cwd, model, checks, selected: nativeTools });
      return;
    }
    const { thread } = await call("thread/start", { ...assignment, model });
    assert.equal(thread.id.startsWith("bridge:codex:"), bridge, "Unexpected Codex execution route");
    assert.equal(thread.projectId, project.id);
    assert.equal(thread.cwd, cwd);
    checks.push("native Project catalog, idempotent creation and Thread placement");

    let turnId: string;
    const challengeInput = {
      threadId: thread.id,
      clientUserMessageId: "external-responses-hands",
      input: [
        {
          type: "text",
          text: `Use the shell tool to run \`cat ${proofFile}\` in the current project. Then write a 100-word report that includes the exact file content. Run the read-only command and use its actual output.`,
        },
      ],
    };
    if (challenge) {
      const { turn } = await call("turn/start", challengeInput);
      turnId = turn.id;
      // First observe terminal failure, even when the model never sent a tool
      // call. The queue retains the earlier shell and text frames.
      const completed = await event("turn/completed", (params) => params.turn.id === turnId);
      assert.equal(
        completed.params.turn.status,
        "completed",
        completed.params.turn.error?.message ?? "Model Turn failed",
      );
      const shell = await event(
        "item/completed",
        (params) =>
          params.turnId === turnId &&
          params.item.type === "commandExecution" &&
          params.item.source !== "userShell" &&
          params.item.cwd === cwd &&
          params.item.exitCode === 0 &&
          params.item.aggregatedOutput?.includes(challenge),
      );
      const deltas = [];
      // Arrival times are recorded before frames enter the test queue.
      assert.ok(shell.receivedAt < completed.receivedAt, "Hands completed after the Turn");
      for (let index = 0; index < 2; index++)
        deltas.push(
          await event(
            "item/agentMessage/delta",
            (params) => params.turnId === turnId && typeof params.delta === "string" && params.delta.length > 0,
          ),
        );
      assert.ok(
        deltas.every((delta) => delta.receivedAt < completed.receivedAt),
        "Model text arrived after Turn completion",
      );
      checks.push("external Responses text deltas and a native Linux command read the hidden file challenge");
    } else {
      const { turn } = await call("turn/start", {
        threadId: thread.id,
        clientUserMessageId: "cloud-hands",
        input: [{ type: "text", text: "Run the cloud Hands smoke check." }],
      });
      const inTurn = (params: { turnId: string }) => params.turnId === turn.id;
      const reason = await event("item/reasoning/summaryTextDelta", inTurn);
      assert.equal(reason.params.delta, "I will verify the Linux workspace.");
      const plan = await event("turn/plan/updated", inTurn);
      assert.deepEqual(plan.params.plan, [{ step: "Verify the Linux workspace", status: "inProgress" }]);
      const changing = await event("item/started", (params) => inTurn(params) && params.item.type === "fileChange");
      const pendingChange = await event(
        SHARED_INTERACTIONS_CHANGED,
        (params) =>
          params.threadId === thread.id &&
          params.requests?.some(
            (request: SharedInteraction) => request.params.turnId === turn.id && request.state === "pending",
          ),
      );
      const pending = await call(SHARED_INTERACTIONS_READ, { threadId: thread.id });
      assert.deepEqual(pendingChange.params, pending);
      const approval = pending.requests.find(
        (request: SharedInteraction) =>
          request.method === "item/fileChange/requestApproval" &&
          request.params.turnId === turn.id &&
          request.params.itemId === changing.params.item.id,
      );
      assert.ok(pending.canRespond && approval?.state === "pending", "Expected the native file-change approval");
      // The original mutation lane is holding the approval while Workbench can
      // issue multiple generations of catalog and history reads.
      const readsStarted = performance.now();
      for (let batch = 0; batch < 10; batch++) {
        const rows = await Promise.all([
          call("thread/list", { limit: 10 }),
          call("thread/list", { limit: 10, archived: true }),
          call("thread/read", { threadId: thread.id, includeTurns: true }),
          call("thread/read", { threadId: thread.id, includeTurns: false }),
        ]);
        assert.ok(rows[0].data.some(({ id }: { id: string }) => id === thread.id));
        assert.ok(rows[2].thread.turns.some(({ id }: { id: string }) => id === turn.id));
        assert.equal(rows[3].thread.id, thread.id);
      }
      checks.push(
        `40 independent catalog and history reads during one approval in ${Math.round(performance.now() - readsStarted)}ms`,
      );
      const answer = await call(SHARED_INTERACTIONS_RESPOND, {
        threadId: thread.id,
        interactionId: approval.id,
        submissionId: "approve-rehearsal-patch",
        result: { decision: "accept" },
      });
      assert.ok(answer.disposition === "submitted" || answer.disposition === "resolved");
      const patch = await event("item/completed", (params) => inTurn(params) && params.item.type === "fileChange");
      assert.equal(patch.params.item.status, "completed");
      assert.ok(
        patch.params.item.changes.some(
          ({ path, diff }: { path: string; diff: string }) =>
            path.endsWith("cloud-hands-proof.txt") && diff.includes("workspace-proof"),
        ),
      );
      const usage = await event("thread/tokenUsage/updated", inTurn);
      assert.ok(usage.params.tokenUsage.total.totalTokens > 0);
      checks.push("native reasoning summary, plan, applied file change and live token usage");
      const delta = () => event("item/agentMessage/delta", (params) => params.turnId === turn.id);
      const first = await delta();
      assert.equal(first.params.delta, "CLOUD_HANDS_");
      const second = await delta();
      assert.equal(second.params.delta, "VERIFIED");
      assert.ok(second.receivedAt - first.receivedAt >= 100, "Response deltas arrived together");
      const cleared = await event(
        SHARED_INTERACTIONS_CHANGED,
        (params) => params.threadId === thread.id && params.requests?.length === 0,
      );
      assert.equal(cleared.params.epoch, pending.epoch);
      assert.ok(cleared.params.revision > pending.revision);
      const completed = await event("turn/completed", (params) => params.turn.id === turn.id);
      assert.ok(cleared.receivedAt <= completed.receivedAt, "Native approval settled after the terminal Turn event");
      assert.equal(completed.params.turn.status, "completed");
      checks.push("revisioned native approval snapshots, Linux cgroup, non-root UID and at least 65,536 FDs");
      assert.ok(completed.receivedAt >= second.receivedAt, "Turn completed before the final delta");
      turnId = turn.id;
    }
    const history = await call("thread/read", { threadId: thread.id, includeTurns: true });
    const nativeThread: Thread = history.thread;
    assert.equal(nativeThread.projectId, project.id);
    const finished = nativeThread.turns.find((turn) => turn.id === turnId);
    assert.equal(finished?.status, "completed");
    if (challenge)
      assert.ok(
        finished.items.some((item) => item.type === "agentMessage" && item.text.includes(challenge)),
        "Native final answer omitted the hidden file challenge",
      );
    checks.push("native Turn completion and restored history");

    const terminal = { processHandle: "project-terminal", threadId: thread.id, projectId: project.id };
    await call("process/spawn", { ...pty, ...terminal, cwd });
    // Repeated separate writes catch a regression that nested each write inside the output WebSocket.
    for (let i = 0; i < 18; i++) await write(terminal, "true\n");
    await write(terminal, "printf 'OC-PWD:%s\\n' \"$(pwd)\"\n");
    await outputContains(terminal.processHandle, "OC-PWD:" + cwd);
    if (restartProof)
      await write(terminal, `printf 'OC-MACHINE:%s:END\\n' "$(cat /var/lib/opencraft-workspace/data/machine-id)"\n`);
    const machineOutput = restartProof ? await outputContains(terminal.processHandle, ":END\r\n") : undefined;
    await call("process/kill", terminal);
    checks.push("Project-scoped Linux PTY, including 19 independent input writes");
    if (restartProof) {
      assert.ok(challenge);
      assert.match(restartProof.credentialDigest, /^[0-9a-f]{64}$/u);
      const machine = /OC-MACHINE:([0-9a-f-]{36}):END/u.exec(machineOutput!)?.[1];
      assert.ok(machine, "Linux Hands did not expose its persisted machine identity");
      const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const actor = await instance.fetch(`${instance.origin}/__opencraft_actors/me`, { headers: { cookie } });
      assert.equal(actor.status, 200, "Current actor unavailable");
      const actorId = ((await actor.json()) as { actor?: { id?: unknown } }).actor?.id;
      assert.ok(isCodexWorkspaceOwner(actorId));
      const workspace = await codexActorWorkspace(machine, actorId);

      const inspect = { ...terminal, processHandle: "check-provider-confinement" };
      await call("process/spawn", {
        ...pty,
        ...inspect,
        command: ["/usr/bin/python3", "-c", CREDENTIAL_INSPECTION, restartProof.credentialDigest],
        cwd,
      });
      const exited = await event("process/exited", (params) => params.processHandle === inspect.processHandle);
      assert.equal(exited.params.exitCode, 0, "Provider credential inspection failed");
      await outputContains(inspect.processHandle, "OC-PROVIDER-CREDENTIAL-ABSENT");
      checks.push(
        "the disposable provider credential is absent from readable Brain and Hands workspace files and process environments",
      );

      await proveSnapshotRestart(
        instance,
        cookies,
        sockets,
        signal,
        workspace,
        nativeThread,
        turnId,
        challengeInput,
        challenge,
        checks,
        restartProof,
      );
      return;
    }
    if (nativeTools) await proveNativeTools({ call, event, assignment, cwd, model, checks, selected: nativeTools });
  } catch (error) {
    checks.push(`AppHost notifications before failure: ${[...seen].join(", ") || "none"}`);
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
  }
}

// Scan for the disposable provider token by SHA-256 fingerprint. The actual
// token never enters the container via the verification command or its output.
const CREDENTIAL_INSPECTION = `
from hashlib import sha256
from pathlib import Path
import os, re, stat, sys

def check(content):
    for candidate in re.findall(rb'(?<![a-zA-Z0-9_-])[a-zA-Z0-9_-]{43}(?![a-zA-Z0-9_-])', content):
        if sha256(candidate).hexdigest() == sys.argv[1]:
            raise SystemExit('Provider credential found in container')

root = Path('/var/lib/opencraft-workspace')
assert root.is_dir() and (root / 'data' / 'machine-id').is_file()
check(b'\\0'.join(os.environb.values()))
for environ in Path('/proc').glob('[0-9]*/environ'):
    try:
        check(environ.read_bytes())
    except (PermissionError, ProcessLookupError, FileNotFoundError):
        pass
for path in root.rglob('*'):
    try:
        if stat.S_ISREG(path.lstat().st_mode):
            check(path.read_bytes())
    except FileNotFoundError:
        pass
print('OC-PROVIDER-CREDENTIAL-ABSENT')
`;

async function proveSnapshotRestart(
  instance: WorkerInstance,
  cookies: ReadonlyMap<string, string>,
  sockets: TestWebSocket[],
  signal: AbortSignal,
  workspace: string,
  original: Thread,
  turnId: string,
  input: object,
  challenge: string,
  checks: string[],
  { crash, proveClientHibernation, verifyBrowserAtRest }: RestartProof,
) {
  const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  const base = `${instance.origin}/__opencraft_workspaces/${workspace}`;
  const request = (operation: "status" | "sleep") =>
    instance.fetch(`${base}/${operation}`, {
      method: operation === "sleep" ? "POST" : "GET",
      headers: { cookie, origin: instance.origin },
    });
  const environment = async () => {
    const response = await request("status");
    assert.equal(response.status, 200, "Workspace status unavailable");
    return ((await response.json()) as { environment: { running: boolean; epoch: number; incarnation?: string } })
      .environment;
  };
  const before = await environment();
  assert.ok(before.running && before.incarnation && before.epoch > 0);
  const sleep = async () => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const response = await request("sleep");
      await response.body?.cancel();
      if (response.ok) break;
      assert.ok(
        response.status === 409 && Date.now() < deadline,
        `Workspace snapshot sleep returned HTTP ${response.status}`,
      );
      await delay(500, undefined, { signal });
    }
    assert.equal((await environment()).running, false, "Workspace did not stop after snapshot");
  };
  await sleep();
  const connect = (clientId: string) =>
    connectCodex({ patience: 40 }, instance, { cookies }, sockets, "ready", clientId);
  const { rpc, event, socket } = await connect("codex-after-snapshot");
  const list = { limit: 1, sortKey: "updated_at", sortDirection: "desc" };
  const read = async (rpc: Awaited<ReturnType<typeof connect>>["rpc"]) => {
    const result = await rpc("thread/read", { threadId: original.id, includeTurns: true });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    return result.result.thread as Thread;
  };
  const verifyUnchanged = async () => {
    const state = await environment();
    assert.equal(state.running, false, "A read woke Linux");
    assert.equal(state.epoch, before.epoch, "A read started a new incarnation");
  };
  const assertCold = async () => {
    const threads = await rpc("thread/list", list);
    assert.equal(threads.error, undefined, JSON.stringify(threads.error));
    assert.equal(threads.result.data[0]?.id, original.id);
    assert.equal(threads.result.data[0]?.latestTurnCompletion?.id, turnId);
    const projects = await rpc("project/list", { limit: 1 });
    assert.equal(projects.error, undefined, JSON.stringify(projects.error));
    assert.ok(
      projects.result.data.length === 1 && projects.result.nextCursor,
      "Project directory lost its committed rows",
    );
    const next = await rpc("project/list", { limit: 1, cursor: projects.result.nextCursor });
    assert.equal(next.error, undefined, JSON.stringify(next.error));
    assert.equal(next.result.nextCursor, null);
    assert.ok(next.result.data[0]?.id && next.result.data[0].id !== projects.result.data[0].id);
    assert.deepEqual((await rpc("process/list", {})).result, { processes: [] });
    const history = await read(rpc);
    assert.deepEqual(
      history.turns.map((turn) => turn.id),
      [turnId],
    );
    assert.ok(history.turns[0]?.items.some((item) => item.type === "agentMessage" && item.text.includes(challenge)));
    const miss = await rpc("thread/turns/list", { threadId: original.id, cursor: "unrecorded" });
    assert.equal(miss.error?.code, -32073);
    await verifyUnchanged();
  };
  await assertCold();
  checks.push("history hits and misses, Thread and Project directories, and terminal inventory left Linux stopped");
  if (proveClientHibernation) {
    const receive = frameQueue({ patience: 40 }, socket);
    const instanceId = async () => {
      socket.send("__opencraft_rehearsal_client_instance");
      return (await receive((frame) => frame.type === "rehearsal/client-instance")).result;
    };
    const beforeIdle = await instanceId();
    const ping = JSON.stringify({ type: "connection/probe", requestId: APP_HOST_IDLE_PROBE_ID });
    for (let i = 0; i < 5; i++) {
      await delay(4_000, undefined, { signal });
      socket.send(ping);
      assert.equal((await receive((frame) => frame.requestId === APP_HOST_IDLE_PROBE_ID)).ok, true);
    }
    assert.notEqual(await instanceId(), beforeIdle, "The Client DO stayed in memory during browser-style probes");
    await assertCold();
    checks.push(
      "the Client DO hibernated while answering periodic probes, then admitted fresh RPCs on the original AppHost WebSocket",
    );
  }
  if (verifyBrowserAtRest) {
    await verifyBrowserAtRest({
      origin: instance.origin,
      workspace,
      threadId: original.id,
      turnId,
      cookies,
      signal,
      verifyUnchanged,
    });
    checks.push(
      "real Chromium refreshed the authenticated Workbench home and read both directories without waking Linux",
    );
  }
  const terminal = { processHandle: "cold-pty", threadId: original.id, projectId: original.projectId };
  const opened = await rpc("process/spawn", {
    ...terminal,
    cwd: original.cwd,
    command: ["/bin/bash", "--noprofile", "--norc"],
    tty: true,
    streamStdoutStderr: true,
    outputBytesCap: null,
    timeoutMs: null,
    size: { cols: 80, rows: 24 },
  });
  assert.equal(opened.error, undefined, JSON.stringify(opened.error));
  const ptyWake = await environment();
  assert.ok(
    ptyWake.running && ptyWake.epoch === before.epoch + 1,
    "Opening the terminal did not wake exactly one Linux incarnation",
  );
  const wrote = await rpc("process/writeStdin", {
    ...terminal,
    deltaBase64: Buffer.from("printf 'OC-COLD-OS:%s\\n' \"$(uname -s)\"\n").toString("base64"),
  });
  assert.equal(wrote.error, undefined, JSON.stringify(wrote.error));
  let output = "";
  while (!output.includes("OC-COLD-OS:Linux")) {
    const { params } = await event("process/outputDelta", (value) => value.processHandle === terminal.processHandle);
    output += Buffer.from(params.deltaBase64, "base64").toString("utf8");
    assert.ok(output.length < 16_384, "Cold terminal did not return Linux output");
  }
  const killed = await rpc("process/kill", terminal);
  assert.equal(killed.error, undefined, JSON.stringify(killed.error));
  await event("process/exited", (value) => value.processHandle === terminal.processHandle);
  checks.push("explicitly opening a PTY started exactly one new Linux incarnation and returned real command output");
  const restored = await read(rpc);
  assert.equal(restored.id, original.id);
  assert.equal(restored.cwd, original.cwd);
  assert.deepEqual(
    restored.turns.map((turn) => turn.id),
    [turnId],
  );
  assert.ok(restored.turns[0]?.items.some((item) => item.type === "agentMessage" && item.text.includes(challenge)));
  const after = await environment();
  assert.ok(after.running && after.incarnation && after.incarnation !== before.incarnation);
  assert.equal(after.epoch, before.epoch + 1, "The terminal did not restore a new workspace incarnation");
  checks.push(
    "the real container stopped, restarted from its snapshot, and recovered the original Bridge Thread and full answer",
  );

  const duplicate = await rpc("turn/start", input);
  assert.equal(
    duplicate.error?.data?.resultUnknown,
    true,
    "The previously submitted input was not fenced after restart",
  );
  assert.deepEqual(
    (await read(rpc)).turns.map((turn) => turn.id),
    [turnId],
    "A repeated submission mutated restored history",
  );
  const next = await rpc("turn/start", {
    threadId: original.id,
    clientUserMessageId: "after-snapshot",
    input: [{ type: "text", text: "Give a short text-only summary of the file you read in the preceding turn." }],
  });
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  const resumedId = next.result.turn.id;
  const completed = await event("turn/completed", (params) => params.turn.id === resumedId);
  assert.equal(completed.params.turn.status, "completed", completed.params.turn.error?.message);
  assert.deepEqual(
    (await read(rpc)).turns.map((turn) => turn.id),
    [turnId, resumedId],
  );
  checks.push(
    "the original input could not be submitted twice, and GPT-OSS 20B completed a new Turn in the same Thread",
  );
  if (!crash) {
    await sleep();
    const coldTurn = await connect("codex-cold-turn-rehearsal");
    assert.equal((await environment()).epoch, after.epoch, "Connecting to AppHost woke Linux");
    const answer = await coldTurn.rpc("turn/start", {
      threadId: original.id,
      clientUserMessageId: "cold-turn-wake",
      input: [{ type: "text", text: "Reply with a short text-only acknowledgment." }],
    });
    assert.equal(answer.error, undefined, JSON.stringify(answer.error));
    const id = answer.result.turn.id;
    const completed = await coldTurn.event("turn/completed", (params) => params.turn.id === id);
    assert.equal(completed.params.turn.status, "completed", completed.params.turn.error?.message);
    const turnWake = await environment();
    assert.ok(
      turnWake.running && turnWake.epoch === after.epoch + 1,
      "Sending the Turn did not wake exactly one Linux incarnation",
    );
    checks.push(
      "sending a real Codex Turn from sleep started exactly one Linux incarnation and GPT-OSS 20B completed the reply",
    );
    return;
  }

  const interruptedInput = {
    threadId: original.id,
    clientUserMessageId: "rehearsal-container-loss",
    input: [
      {
        type: "text",
        text: "OC_NATIVE_PROOF exec_command\nUse the shell tool to run `sleep 60` in the current project. Wait for the command before replying.",
      },
    ],
  };
  const active = await rpc("turn/start", interruptedInput);
  assert.equal(active.error, undefined, JSON.stringify(active.error));
  const activeId = active.result.turn.id;
  await event(
    "item/started",
    (params) =>
      params.turnId === activeId &&
      params.item?.type === "commandExecution" &&
      params.item.command?.includes("sleep 60"),
  );
  await crash(workspace);
  assert.equal((await environment()).running, false, "The active container is still running after the stop");
  try {
    socket.close(1000);
  } catch {
    /* The source may already be offline. */
  }
  checks.push("the disposable container stopped abruptly while the native Hands command was active");

  const recovered = await connect("codex-after-container-loss");
  const retried = await recovered.rpc("turn/start", interruptedInput);
  assert.equal(retried.error?.data?.resultUnknown, true, "A lost execution's input was forwarded again");
  const checkpoint = await read(recovered.rpc);
  assert.deepEqual(
    checkpoint.turns.map((turn) => turn.id),
    [turnId],
    "Recovery must use the last committed snapshot",
  );
  const rebooted = await environment();
  assert.ok(rebooted.running && rebooted.incarnation && rebooted.incarnation !== after.incarnation);
  assert.equal(rebooted.epoch, after.epoch + 1);
  const replacement = await recovered.rpc("turn/start", {
    threadId: original.id,
    clientUserMessageId: "after-container-loss",
    input: [{ type: "text", text: "Give a short text-only summary of the original file you read." }],
  });
  assert.equal(replacement.error, undefined, JSON.stringify(replacement.error));
  const replacementId = replacement.result.turn.id;
  const finished = await recovered.event("turn/completed", (params) => params.turn.id === replacementId);
  assert.equal(finished.params.turn.status, "completed", finished.params.turn.error?.message);
  assert.deepEqual(
    (await read(recovered.rpc)).turns.map((turn) => turn.id),
    [turnId, replacementId],
  );
  checks.push(
    "after the crash, a new incarnation restored the checkpoint, refused the lost input, and completed a new Turn",
  );
}
