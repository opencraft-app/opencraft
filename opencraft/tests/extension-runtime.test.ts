import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionManifestError,
  parseExtensionManifestV1,
  type ExtensionDisposable,
  type ExtensionManifestV1,
} from "@opencraft/extension-contract";
import {
  ExtensionActivationStaleError,
  ExtensionSupervisor,
  type InternalContributionAdapter,
  type TrustedExtensionApiV1,
  type TrustedExtensionDefinition,
} from "@opencraft/extension-runtime";

const lightPalette = {
  accent: "#3478f6",
  contrast: 46,
  ink: "#202124",
  surface: "#fbfaf7",
  semanticColors: {
    diffAdded: "#18864b",
    diffRemoved: "#c13a35",
    skill: "#8457c5",
  },
} as const;

const darkPalette = {
  accent: "#6ea8ff",
  contrast: 58,
  ink: "#f2f1ed",
  surface: "#1b1b1a",
  semanticColors: {
    diffAdded: "#55bd82",
    diffRemoved: "#f06b65",
    skill: "#b693ef",
  },
} as const;

function manifest(id: string): ExtensionManifestV1 {
  return {
    manifestVersion: 1,
    id,
    name: id,
    version: "1.0.0",
    apiVersion: 1,
    trust: "trusted",
    platforms: ["web"],
    activationEvents: ["onStartupFinished"],
  };
}

function definition(
  id: string,
  activate: TrustedExtensionDefinition["activate"],
): TrustedExtensionDefinition {
  return { manifest: manifest(id), activate };
}

test("manifest V1 rejects ambiguous identity and unsupported trust", () => {
  assert.equal(parseExtensionManifestV1(manifest("vela.example")).id, "vela.example");
  assert.throws(
    () => parseExtensionManifestV1({ ...manifest("vela.example"), id: "Example" }),
    ExtensionManifestError,
  );
  assert.throws(
    () => parseExtensionManifestV1({ ...manifest("vela.example"), trust: "sandboxed" }),
    /trust=trusted/u,
  );
});

test("manifest V1 normalizes explicit extension dependencies", () => {
  const parsed = parseExtensionManifestV1({
    ...manifest("vela.consumer"),
    dependencies: ["vela.provider"],
  });
  assert.deepEqual(parsed.dependencies, ["vela.provider"]);
  assert.throws(
    () => parseExtensionManifestV1({ ...manifest("vela.consumer"), dependencies: ["vela.consumer"] }),
    /cannot depend on itself/u,
  );
});

test("supervisor enforces dependency activation and reverse disposal order", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const provider = definition("vela.provider", () => undefined);
  const consumer: TrustedExtensionDefinition = {
    manifest: { ...manifest("vela.consumer"), dependencies: ["vela.provider"] },
    activate: () => undefined,
  };
  await assert.rejects(supervisor.activate(consumer), /requires active dependencies: vela.provider/u);
  await supervisor.activate(provider);
  await supervisor.activate(consumer);
  await assert.rejects(supervisor.deactivate("vela.provider"), /required by active extensions: vela.consumer/u);
  assert.equal(await supervisor.deactivate("vela.consumer"), true);
  assert.equal(await supervisor.deactivate("vela.provider"), true);
  await supervisor.dispose();
});

test("one activation atomically publishes declarations and presentation surfaces", async () => {
  const disposalOrder: string[] = [];
  let apiAfterActivation: TrustedExtensionApiV1 | undefined;
  let removeView: ExtensionDisposable | undefined;
  const supervisor = new ExtensionSupervisor({
    platform: "web",
    createActivationId: () => "activation-1",
  });
  const identity = await supervisor.activate(definition("vela.example", (api) => {
    apiAfterActivation = api;
    api.commands.register(
      { id: "vela.example.echo", title: "Echo" },
      async (value) => value,
    );
    api.settings.registerSchema({
      id: "vela.example.preferences",
      title: "Example",
      schemaVersion: 1,
      fields: [{ key: "enabled", type: "boolean", title: "Enabled", defaultValue: true }],
    });
    removeView = api.views.register({
      id: "vela.example.settings-view",
      title: "Example settings",
      viewType: "vela.example.settings",
    });
    api.settings.registerPage({
      id: "vela.example.settings-page",
      title: "Example",
      viewId: "vela.example.settings-view",
      layout: "master-detail",
      management: { familyId: "vela.example.manage", scope: "agent" },
    });
    api.navigation.register({
      id: "vela.example.navigation",
      title: "Example",
      surface: "sidebar-primary",
      target: { kind: "settings", pageId: "vela.example.settings-page" },
    });
    api.sidebar.registerCatalog({
      id: "vela.example.catalog",
      title: "Example catalog",
      viewId: "vela.example.settings-view",
    });
    api.workbench.registerSurface({
      id: "vela.example.empty",
      viewId: "vela.example.settings-view",
      surface: "empty-workbench",
    });
    api.workbench.registerSurface({
      id: "vela.example.authentication-required",
      viewId: "vela.example.settings-view",
      surface: "host-connection-intervention",
      providerId: "vela.example",
      intervention: "authentication-required",
    });
    api.themes.register({
      id: "vela.example.paper",
      label: "Paper",
      palettes: { light: lightPalette, dark: darkPalette },
    });
    api.bots.register({
      id: "vela.example.bot",
      name: "Example Bot",
      avatar: { kind: "monogram", text: "E", background: "#3478f6" },
      action: { kind: "command", commandId: "vela.example.echo" },
      defaultPinned: true,
    });
    api.subscriptions.add(() => { disposalOrder.push("subscription"); });
    return () => { disposalOrder.push("activation"); };
  }));

  assert.deepEqual(identity, {
    extensionId: "vela.example",
    activationId: "activation-1",
    generation: 1,
  });
  const snapshot = supervisor.contributions.getSnapshot();
  assert.equal(snapshot.commands.length, 1);
  assert.equal(snapshot.settingsSchemas.length, 1);
  assert.equal(snapshot.views.length, 1);
  assert.equal(snapshot.settingsPages.length, 1);
  assert.deepEqual(snapshot.settingsPages[0]?.contribution.management, {
    familyId: "vela.example.manage",
    scope: "agent",
  });
  assert.equal(snapshot.settingsPages[0]?.contribution.layout, "master-detail");
  assert.equal(Object.isFrozen(snapshot.settingsPages[0]?.contribution.management), true);
  assert.equal(snapshot.navigation.length, 1);
  assert.equal(snapshot.sidebarCatalogs.length, 1);
  assert.equal(snapshot.workbenchSurfaces.length, 2);
  assert.equal(snapshot.themes.length, 1);
  assert.equal(snapshot.bots.length, 1);
  assert.equal(snapshot.themes[0]?.contribution.palettes.light.surface, "#fbfaf7");
  assert.equal(snapshot.commands[0]?.owner.activationId, "activation-1");
  assert.equal(await supervisor.contributions.executeCommand("vela.example.echo", "hello"), "hello");

  await removeView?.();
  assert.equal(supervisor.contributions.getSnapshot().views.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().navigation.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().sidebarCatalogs.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().workbenchSurfaces.length, 0);
  assert.equal(await supervisor.deactivate("vela.example"), true);
  assert.deepEqual(disposalOrder, ["activation", "subscription"]);
  assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().themes.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().bots.length, 0);
  assert.throws(
    () => apiAfterActivation!.settings.registerSchema({
      id: "vela.example.late",
      title: "Late",
      schemaVersion: 1,
      fields: [],
    }),
    ExtensionActivationStaleError,
  );
  await supervisor.dispose();
});

test("trusted JavaScript can request a Host-owned announcement and await a data result", async () => {
  let api!: TrustedExtensionApiV1;
  const supervisor = new ExtensionSupervisor({
    platform: "web",
    createActivationId: () => "activation-announcement",
  });
  await supervisor.activate(definition("vela.announcer", (activationApi) => {
    api = activationApi;
  }));

  const result = api.window.showAnnouncement({
    id: "vela.announcer.release",
    title: "What’s new",
    body: "A renderer-neutral announcement.",
    primaryAction: { id: "continue", label: "Continue" },
  });
  const presented = supervisor.announcements.getSnapshot().announcements[0];
  assert.equal(presented?.contribution.title, "What’s new");
  assert.equal(supervisor.announcements.choose(presented!.key, "continue"), true);
  assert.deepEqual(await result, { kind: "action", actionId: "continue" });
  assert.equal(supervisor.announcements.getSnapshot().announcements.length, 0);

  assert.throws(
    () => api.window.showAnnouncement({ id: "other.release", title: "Invalid" }),
    /must be namespaced by extension vela\.announcer/u,
  );
  assert.throws(
    () => api.window.showAnnouncement(null as never),
    /contribution must be an object/u,
  );
  assert.throws(
    () => api.window.showAnnouncement({
      id: "vela.announcer.invalid-media",
      title: "Invalid",
      media: { kind: "html", url: "/unsafe" },
    } as never),
    /invalid media kind/u,
  );
  const inlineResult = api.window.showAnnouncement({
    id: "vela.announcer.inline-image",
    title: "Inline image",
    media: {
      kind: "image-url",
      url: "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
      alt: "Inline release artwork",
    },
  });
  const inlineAnnouncement = supervisor.announcements.getSnapshot().announcements[0];
  assert.equal(inlineAnnouncement?.contribution.media?.url.startsWith("data:image/svg+xml"), true);
  assert.equal(supervisor.announcements.dismiss(inlineAnnouncement!.key, "programmatic"), true);
  assert.deepEqual(await inlineResult, { kind: "dismissed", reason: "programmatic" });
  assert.throws(
    () => api.window.showAnnouncement({
      id: "vela.announcer.non-image-data",
      title: "Unsafe inline content",
      media: { kind: "image-url", url: "data:text/html,<script>alert(1)</script>", alt: "Invalid" },
    }),
    /media URL must be HTTP\(S\), blob, image data, or root-relative/u,
  );
  assert.throws(
    () => api.window.showAnnouncement({
      id: "vela.announcer.invalid-dismiss",
      title: "Invalid",
      dismissOnOutsidePress: "yes",
    } as never),
    /dismissOnOutsidePress must be a boolean/u,
  );
  await supervisor.dispose();
});

test("extension retirement dismisses pending announcement work before draining callers", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await supervisor.activate(definition("vela.retiring", (activationApi) => {
    activationApi.commands.register(
      { id: "vela.retiring.show", title: "Show announcement" },
      () => activationApi.window.showAnnouncement({
        id: "vela.retiring.notice",
        title: "Pending notice",
      }),
    );
  }));
  const result = supervisor.contributions.executeCommand("vela.retiring.show");
  for (let index = 0; index < 10 && supervisor.announcements.getSnapshot().announcements.length === 0; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const retirement = supervisor.deactivate("vela.retiring");
  assert.deepEqual(await result, { kind: "dismissed", reason: "owner-disposed" });
  await retirement;
  assert.equal(supervisor.announcements.getSnapshot().announcements.length, 0);
  await supervisor.dispose();
});

test("invalid theme palette aborts the complete activation batch", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await assert.rejects(
    supervisor.activate(definition("vela.bad-theme", (api) => {
      api.commands.register(
        { id: "vela.bad-theme.command", title: "Must roll back" },
        () => undefined,
      );
      api.themes.register({
        id: "vela.bad-theme.palette",
        label: "Bad",
        palettes: {
          light: { ...lightPalette, surface: "white" },
          dark: darkPalette,
        },
      });
    })),
    /must be a #RRGGBB color/u,
  );
  const snapshot = supervisor.contributions.getSnapshot();
  assert.equal(snapshot.commands.length, 0);
  assert.equal(snapshot.themes.length, 0);
  await supervisor.dispose();
});

test("presentation contributions cannot outlive or invent their semantic target", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await assert.rejects(
    supervisor.activate(definition("vela.dangling", (api) => {
      api.navigation.register({
        id: "vela.dangling.open",
        title: "Dangling",
        surface: "sidebar-primary",
        target: { kind: "view", viewId: "vela.dangling.missing-view" },
      });
    })),
    /targets an unregistered contribution/u,
  );
  assert.equal(supervisor.contributions.getSnapshot().navigation.length, 0);
  await supervisor.dispose();
});

test("a semantic View role has exactly one transactional owner", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await supervisor.activate(definition("vela.bot-owner", (api) => {
    api.views.register({
      id: "vela.bot-owner.view",
      title: "Bot owner",
      viewType: "vela.bot-owner.surface",
      role: "bot-conversation",
    });
  }));
  await assert.rejects(
    supervisor.activate(definition("vela.bot-contender", (api) => {
      api.views.register({
        id: "vela.bot-contender.view",
        title: "Bot contender",
        viewType: "vela.bot-contender.surface",
        role: "bot-conversation",
      });
    })),
    /View role bot-conversation is already owned by vela\.bot-owner\.view/u,
  );
  assert.deepEqual(
    supervisor.contributions.getSnapshot().views.map(({ contribution }) => contribution.id),
    ["vela.bot-owner.view"],
  );
  await supervisor.dispose();
});

test("activation failure leaves no partially published contribution", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await assert.rejects(
    supervisor.activate(definition("vela.failure", (api) => {
      api.commands.register({ id: "vela.failure.command", title: "Command" }, () => undefined);
      api.settings.registerSchema({
        id: "vela.failure.settings",
        title: "Settings",
        schemaVersion: 1,
        fields: [],
      });
      throw new Error("activation exploded");
    })),
    /activation exploded/u,
  );
  assert.deepEqual(supervisor.contributions.getSnapshot().commands, []);
  assert.deepEqual(supervisor.contributions.getSnapshot().settingsSchemas, []);
  assert.equal(supervisor.getSnapshot().extensions[0]?.status, "failed");
  await supervisor.dispose();
});

test("internal commit failure rolls back prior internal resources before public publication", async () => {
  const events: string[] = [];
  const adapters: Record<string, InternalContributionAdapter> = {
    first: {
      prepare: () => ({
        commit: () => {
          events.push("first:commit");
          return () => { events.push("first:dispose"); };
        },
      }),
    },
    second: {
      prepare: () => ({
        commit: () => {
          events.push("second:commit");
          throw new Error("second failed");
        },
      }),
    },
  };
  const supervisor = new ExtensionSupervisor({ platform: "web", internalContributions: adapters });
  await assert.rejects(
    supervisor.activate(definition("vela.rollback", (api) => {
      api.commands.register({ id: "vela.rollback.command", title: "Command" }, () => undefined);
      api.internal.register("first", {});
      api.internal.register("second", {});
    })),
    /second failed/u,
  );
  assert.deepEqual(events, ["first:commit", "second:commit", "first:dispose"]);
  assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
  await supervisor.dispose();
});

test("deactivation invalidates old generation before awaiting leased internal resource", async () => {
  let releaseLease!: () => void;
  const lease = new Promise<void>((resolve) => { releaseLease = resolve; });
  let capturedApi!: TrustedExtensionApiV1;
  const adapter: InternalContributionAdapter = {
    prepare: () => ({ commit: () => async () => lease }),
  };
  let activationNumber = 0;
  const supervisor = new ExtensionSupervisor({
    platform: "web",
    internalContributions: { leased: adapter },
    createActivationId: () => `activation-${++activationNumber}`,
  });
  const extension = definition("vela.leased", (api) => {
    capturedApi = api;
    api.internal.register("leased", {});
  });
  const first = await supervisor.activate(extension);
  let retired = false;
  const retirement = supervisor.deactivate("vela.leased").then(() => { retired = true; });
  await Promise.resolve();
  assert.equal(retired, false);
  assert.throws(
    () => capturedApi.views.register({
      id: "vela.leased.late",
      title: "Late",
      viewType: "late",
    }),
    ExtensionActivationStaleError,
  );
  releaseLease();
  await retirement;
  const second = await supervisor.activate(extension);
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.notEqual(first.activationId, second.activationId);
  releaseLease();
  await supervisor.dispose();
});

test("command invocation owns a lease across extension deactivation", async () => {
  let finish!: () => void;
  const commandWork = new Promise<void>((resolve) => { finish = resolve; });
  const events: string[] = [];
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await supervisor.activate(definition("vela.command-lease", (api) => {
    api.commands.register(
      { id: "vela.command-lease.run", title: "Run" },
      async () => {
        events.push("command:start");
        await commandWork;
        events.push("command:end");
      },
    );
    return () => { events.push("activation:dispose"); };
  }));
  const command = supervisor.contributions.executeCommand("vela.command-lease.run");
  await Promise.resolve();
  let retired = false;
  const retirement = supervisor.deactivate("vela.command-lease").then(() => { retired = true; });
  for (let index = 0; index < 10 && supervisor.contributions.getSnapshot().commands.length > 0; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
  assert.equal(retired, false);
  assert.deepEqual(events, ["command:start"]);
  finish();
  await command;
  await retirement;
  assert.deepEqual(events, ["command:start", "command:end", "activation:dispose"]);
  await supervisor.dispose();
});

test("platform targeting is checked before extension code runs", async () => {
  let ran = false;
  const supervisor = new ExtensionSupervisor({ platform: "expo" });
  await assert.rejects(
    supervisor.activate(definition("vela.web-only", () => { ran = true; })),
    /does not target expo/u,
  );
  assert.equal(ran, false);
  await supervisor.dispose();
});
