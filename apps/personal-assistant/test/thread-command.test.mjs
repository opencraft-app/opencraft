import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { provisionBotProfile } from "../src/adapters/local/bot-profile.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { createExecutionPorts } from "../src/runtime/execution-ports.mjs";
import { assistantTools } from "../src/adapters/work-tools/assistant-tools.mjs";
import { profileFor, root } from "./helpers.mjs";

test("hosted assistant CLI uses its live Bot socket without shell expansion or caller authority arguments", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "assistant-cli-threads-"));
  const binding = {
    serverId: "server",
    botId: "bot",
    assignmentId: "claim",
    owner: { kind: "human", id: "human" },
  };
  const profile = provisionBotProfile(directory, binding, {
      telemetry: { enabled: false },
    }),
    calls = [];
  const runner = await LocalRunner.open(profile, {
    platformChannelPort: {
      async authorize() {
        return { binding, epoch: "epoch", expiresAt: Date.now() + 15000 };
      },
      async request(b, method, params) {
        assert.deepEqual(b, binding);
        calls.push({ method, params });
        return {
          operationId: "op",
          state: "submitted",
          taskOutcome: "unknown",
        };
      },
    },
  });
  t.after(async () => {
    await runner.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const argv = [
    "thread",
    "--profile-dir",
    profile.path,
    "start",
    "--profile",
    "coding",
    "--prompt",
    "$(echo literal); keep this",
    "--idempotency-key",
    "stable",
  ];
  const result = await promisify(execFile)(
    process.execPath,
    ["bin/assistant.mjs", ...argv],
    { cwd: root },
  );
  assert.equal(JSON.parse(result.stdout).state, "submitted");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: "opencraft/personal-assistant/threads/command",
    params: {
      argv: [
        "thread",
        "start",
        "--profile",
        "coding",
        "--prompt",
        "$(echo literal); keep this",
        "--idempotency-key",
        "stable",
      ],
    },
  });
  const live=['thread','--profile-dir',profile.path,'tell','reference','--delivery','steer','--expected-turn','running-turn','--message','只追加这条原话','--idempotency-key','live-1'];
  await promisify(execFile)(process.execPath,['bin/assistant.mjs',...live],{cwd:root});
  assert.deepEqual(calls[1],{method:'opencraft/personal-assistant/threads/command',params:{argv:['thread','tell','reference','--delivery','steer','--expected-turn','running-turn','--message','只追加这条原话','--idempotency-key','live-1']}});
  await assert.rejects(
    runner.dispatch({
      op: "thread.command",
      params: { argv: ["thread", "profiles"], workId: "spoofed" },
    }),
    /Invalid/,
  );
});
test("model tool uses the Work captured platform capability and denies old or rebound scope", async (t) => {
  const profile = profileFor(t, { telemetry: { enabled: false } }),
    resource = { id: "platform.threads", binding: "owner-one" };
  const { app, uow } = createLocalDomain(profile, null, {
    platformThreads: resource,
  });
  t.after(() => uow.close());
  const id = app.works.submit("task", { text: "Create a task" }).workId,
    work = app.works.require(id).record;
  const snapshot = app.executions.snapshot(work),
    calls = [];
  const ports = createExecutionPorts(
    app,
    () => {},
    async (argv, workId) => {
      calls.push({ argv, workId });
      return { state: "submitted" };
    },
  ).toolsFor(work, snapshot);
  const tool = assistantTools({ ports, snapshot, onBoundaryError() {} }).find(
    (t) => t.name === "thread_command",
  );
  assert.ok(tool);
  assert.match(tool.description,/--delivery steer --expected-turn/);
  assert.match(
    (await tool.execute({ argv: ["thread", "profiles"] })).output[0].text,
    /submitted/,
  );
  assert.equal(calls[0].workId, id);
  app.scope.resources = [{ ...resource, binding: "other-owner" }];
  await assert.rejects(
    tool.execute({ argv: ["thread", "profiles"] }),
    /binding/,
  );
  assert.equal(calls.length, 1);
  const old = {
    ...snapshot,
    delegation: {
      ...snapshot.delegation,
      tools: snapshot.delegation.tools.filter((t) => t !== "thread_command"),
    },
  };
  assert.equal(
    assistantTools({ ports, snapshot: old, onBoundaryError() {} }).some(
      (t) => t.name === "thread_command",
    ),
    false,
  );
});


test("one resource catalog drives reception discovery and execution delegation without granting old turns new tools", async (t) => {
  const {profileFor} = await import('./helpers.mjs');
  const {createLocalDomain} = await import('../src/runtime/create-local-domain.mjs');
  const {receptionRoutingInstruction,threadRoutingInstruction} = await import('../src/adapters/models/reception-routing.mjs');
  const profile = profileFor(t);
  const {app,uow} = createLocalDomain(profile,null,{platformThreads:{id:'platform.threads',binding:'original'}});
  t.after(()=>uow.close());
  const accept=id=>{app.reception.accept(id,{text:'Create a real Thread and follow up'});return app.reception.turn(id);};
  const turn=accept('authorized'),context=app.reception.context(turn);
  assert.deepEqual(context.capabilities.resources,['platform.threads']);
  assert.deepEqual(context.capabilities.delegationTools,['thread_command']);
  assert.ok(app.scope.delegate('authorized').tools.includes('thread_command'));
  assert.ok(receptionRoutingInstruction.includes(threadRoutingInstruction));
  assert.ok(threadRoutingInstruction.includes('thread_command'));
  app.scope.resources=[];
  assert.deepEqual(app.reception.context(turn).capabilities.delegationTools,[]);
  const old=accept('without-grant');
  app.scope.resources=[{id:'platform.threads',binding:'replacement'}];
  assert.deepEqual(app.reception.context(old).capabilities.delegationTools,[]);
  assert.deepEqual(app.reception.context(turn).capabilities.delegationTools,[]);
  assert.deepEqual(app.reception.context(accept('new-grant')).capabilities.delegationTools,['thread_command']);
});
