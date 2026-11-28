import test from "node:test";
import assert from "node:assert/strict";
import type { PersonalAssistantStatus } from "@opencraft/appserver-protocol";
import {
  formatAssistantDisplayName,
  formatEnvironmentLabel,
  isHostAssistantRunnerUnavailable,
  normalizeAssistantActor,
  normalizeAssistantActorList,
  projectAvailableAssistantPresets,
  resolveAssistantTeamPlacement,
  upsertAssistantStatusList,
} from "../../plugins/im/src/assistant-actors";
import { getChannelRuntime } from "../../plugins/im/src/channel-runtime";
import type { ChannelRpc } from "../../plugins/im/src/channel-client";

function makeStatus(overrides: {
  botId: string;
  name?: string;
  isDefault?: boolean;
  presetId?: "personal-assistant" | null;
  cardinality?: "singleton-per-human" | "multi";
  paused?: boolean;
  state?: "claimed" | "revoked";
  phase?: PersonalAssistantStatus["runtime"]["phase"];
  createdAt?: number;
}): PersonalAssistantStatus {
  return {
    assistant: {
      name: overrides.name ?? "Assistant",
      duties: "Handle tasks",
      isDefault: overrides.isDefault ?? false,
      presetId: overrides.presetId,
      cardinality: overrides.cardinality,
      paused: overrides.paused ?? false,
      configRevision: 0,
      environment: { kind: "local" },
      binding: {
        serverId: "srv-1",
        botId: overrides.botId,
        assignmentId: `assign-${overrides.botId}`,
        owner: { kind: "human", id: "human://srv-1/alice" },
      },
      actorId: `session://srv-1/${overrides.botId}`,
      state: overrides.state ?? "claimed",
      createdAt: overrides.createdAt ?? 100,
      model: { providerId: "openai", modelId: "gpt-5" },
      modelRevision: 1,
    },
    channelId: `dm:${overrides.botId}`,
    runtime: { phase: overrides.phase ?? "running" },
  };
}

test("normalizeAssistantActorList orders singleton preset first and projectAvailableAssistantPresets hides hired singleton", () => {
  const custom = makeStatus({ botId: "bot-b", name: "Engineer", createdAt: 50 });
  const emptyPresets = projectAvailableAssistantPresets([custom]);
  assert.deepEqual(
    emptyPresets.map((p) => p.id),
    ["personal-assistant"],
  );

  const singleton = makeStatus({
    botId: "bot-a",
    name: "Personal assistant",
    isDefault: true,
    createdAt: 200,
  });
  const actors = normalizeAssistantActorList([custom, singleton]);
  assert.deepEqual(
    actors.map((a) => a.botId),
    ["bot-a", "bot-b"],
  );
  assert.equal(actors[0]!.presetId, "personal-assistant");
  assert.equal(actors[0]!.cardinality, "singleton-per-human");
  assert.equal(formatAssistantDisplayName(actors[0]!, "个人助理"), "个人助理");
  assert.equal(formatAssistantDisplayName(actors[1]!, "个人助理"), "Engineer");
  assert.equal(projectAvailableAssistantPresets([custom, singleton]).length, 0);
});

test("upsertAssistantStatusList updates existing actor in place and formats sandbox environment labels", () => {
  const initial = [
    makeStatus({ botId: "bot-1", name: "Personal assistant", isDefault: true, paused: false }),
    makeStatus({ botId: "bot-2", name: "Reviewer", paused: false }),
  ];
  const pausedPersonal = makeStatus({
    botId: "bot-1",
    name: "Chief of Staff",
    isDefault: true,
    paused: true,
    phase: "stopped",
  });
  const merged = upsertAssistantStatusList(initial, pausedPersonal);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.assistant?.name, "Chief of Staff");
  assert.equal(merged[0]!.assistant?.paused, true);
  assert.equal(
    formatEnvironmentLabel({ kind: "sandbox", backendId: "e2b-cloud", templateId: "python-312" }, "本机"),
    "E2B · python-312",
  );
});

test("getChannelRuntime shares a single bots/list read across assistants, assistant, and bots projections", async () => {
  const calls: string[] = [];
  const singleton = makeStatus({ botId: "bot-default", name: "Personal assistant", isDefault: true });
  const custom = makeStatus({ botId: "bot-custom", name: "Designer", isDefault: false });
  const activation = new AbortController();
  const rpc: ChannelRpc = {
    draftScope: "scope-1",
    async connect() {},
    async close() {},
    onChanged: () => () => {},
    onDisconnect: () => () => {},
    async request(method: string) {
      calls.push(method);
      if (method === "opencraft/channels/subscribe") return {} as never;
      if (method === "opencraft/channels/unsubscribe") return {} as never;
      if (method === "opencraft/channels/list") return { groups: [] } as never;
      if (method === "opencraft/personal-assistant/bots/list") {
        return { bots: [singleton, custom] } as never;
      }
      if (method === "opencraft/personal-assistant/get") {
        throw new Error("Unexpected legacy personal-assistant/get poll when bots/list is supported");
      }
      return null as never;
    },
  };

  const runtime = getChannelRuntime(
    (async () => new Response("{}", { status: 200 })) as typeof fetch,
    rpc,
    activation.signal,
  );
  try {
    await Promise.all([runtime.assistants.refresh(), runtime.assistant.refresh(), runtime.bots.refresh()]);
    assert.equal(runtime.assistants.get().value?.length, 2);
    assert.equal(runtime.assistant.get().value?.assistant?.binding.botId, "bot-default");
    assert.equal(runtime.bots.get().value?.length, 1);
    assert.equal(runtime.bots.get().value?.[0]?.assistant?.binding.botId, "bot-custom");
    assert.equal(calls.filter((m) => m === "opencraft/personal-assistant/get").length, 0);
    assert.equal(calls.filter((m) => m === "opencraft/personal-assistant/bots/list").length, 1);
  } finally {
    activation.abort();
  }
});

test("resolveAssistantTeamPlacement and isHostAssistantRunnerUnavailable model scope and host runner state cleanly", () => {
  const personal = normalizeAssistantActor(
    makeStatus({ botId: "bot-p", name: "Personal assistant", isDefault: true, phase: "unavailable" }),
  )!;
  const engineer = normalizeAssistantActor(
    makeStatus({ botId: "bot-e", name: "Engineer", isDefault: false, phase: "unavailable" }),
  )!;
  const reviewer = normalizeAssistantActor(
    makeStatus({ botId: "bot-r", name: "Reviewer", isDefault: false, phase: "running" }),
  )!;

  assert.equal(personal.collaborationScope, "personal-only");
  assert.equal(engineer.collaborationScope, "team-eligible");
  assert.deepEqual(resolveAssistantTeamPlacement(personal, []), { kind: "personal-only" });
  assert.deepEqual(resolveAssistantTeamPlacement(engineer, null), { kind: "private-local" });
  assert.deepEqual(resolveAssistantTeamPlacement(engineer, []), { kind: "unassigned" });
  assert.deepEqual(
    resolveAssistantTeamPlacement(engineer, [
      {
        id: "space-1",
        name: "Core Platform",
        role: "owner",
        openContact: true,
        members: [{ actorId: engineer.actorId, displayName: "Engineer", kind: "session", role: "member" }],
      },
    ]),
    { kind: "assigned", teamId: "space-1", teamName: "Core Platform", canManageTeam: true },
  );

  assert.equal(isHostAssistantRunnerUnavailable([personal, engineer]), true);
  assert.equal(isHostAssistantRunnerUnavailable([personal, reviewer]), false);
});
