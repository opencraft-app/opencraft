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

test("retirement revokes a pending factory and releases its late resource once", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let api!: TrustedExtensionApiV1, cleanup = 0, lateCleanup = 0, lateAccepted = false;
  const activation = supervisor.activate(definition("opencraft.retiring", async value => {
    api = value;
    api.subscriptions.add(() => { cleanup++; });
    enter(); await held;
    try { api.commands.register({ id: "opencraft.retiring.late", title: "Late" }, () => "wrong"); lateAccepted = true; } catch { /* Retired API must reject. */ }
    return () => { lateCleanup++; };
  }));
  const result = Promise.allSettled([activation]);
  await entered;
  const retiring = supervisor.dispose();
  const aborted = api.signal.aborted;
  release();
  const [outcome] = await result; await retiring;
  assert.equal(aborted, true, "retirement must revoke a factory before it resumes");
  assert.equal(outcome.status, "rejected");
  assert.equal(lateAccepted, false);
  assert.equal(cleanup, 1);
  assert.equal(lateCleanup, 1);
  assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
  assert.equal(supervisor.getSnapshot().extensions.some(row => row.status === "active" || row.status === "activating"), false);
});

test("retirement closes admission immediately and every disposer waits for cleanup", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let cleanups = 0, lateStarts = 0, secondFinished = false;
  await supervisor.activate(definition("opencraft.owned", () => async () => {
    cleanups++; enter(); await held;
  }));
  const first = supervisor.dispose();
  await entered;
  const candidate = supervisor.activate(definition("opencraft.too-late", () => { lateStarts++; }));
  const [outcome] = await Promise.allSettled([candidate]);
  const second = supervisor.dispose().then(() => { secondFinished = true; });
  await Promise.resolve(); await Promise.resolve();
  const premature = secondFinished;
  release();
  await Promise.all([first, second]);
  assert.equal(premature, false, "a concurrent dispose must not finish ahead of owned cleanup");
  assert.equal(outcome.status, "rejected");
  assert.equal(lateStarts, 0);
  assert.equal(cleanups, 1);
});

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

test("retirement owns a pending internal commit before unwinding consumers and providers", async () => {
  const committing = barrier(), commit = barrier(), cleaning = barrier(), cleanup = barrier();
  const events: string[] = [];
  const supervisor = new ExtensionSupervisor({ platform: "web", internalContributions: {
    delayed: { prepare: () => ({ commit: async () => {
      committing.release(); await commit.wait;
      return async () => { events.push("pending:cleanup"); cleaning.release(); await cleanup.wait; };
    } }) },
  } });
  await supervisor.activate(definition("opencraft.provider", api => {
    api.commands.register({ id: "opencraft.provider.read", title: "Read" }, () => "available");
    return () => { events.push("provider:cleanup"); };
  }));
  await supervisor.activate({ manifest: { ...manifest("opencraft.consumer"), dependencies: ["opencraft.provider"] },
    activate: () => () => { events.push("consumer:cleanup"); } });
  const pending = supervisor.activate({ manifest: { ...manifest("opencraft.pending"), dependencies: ["opencraft.provider"] },
    activate: api => {
      api.commands.register({ id: "opencraft.pending.run", title: "Pending" }, () => "wrong");
      api.internal.register("delayed", {});
    } });
  const outcome = Promise.allSettled([pending]);
  await committing.wait;
  let queuedStarts = 0;
  const queued = Promise.allSettled([supervisor.activate(definition("opencraft.pending", () => { queuedStarts++; }))]);
  const retiring = supervisor.dispose();
  commit.release();
  await cleaning.wait;
  const providerResult = await supervisor.contributions.executeCommand("opencraft.provider.read");
  const visible = supervisor.contributions.getSnapshot().commands.map(row => row.contribution.id);
  cleanup.release();
  const [result] = await outcome;
  const [queuedResult] = await queued;
  await retiring;
  assert.equal(providerResult, "available", "pending rollback borrows a still-live provider");
  assert.deepEqual(visible, ["opencraft.provider.read"]);
  assert.equal(result.status, "rejected");
  assert.equal(queuedResult.status, "rejected");
  assert.equal(queuedStarts, 0);
  assert.deepEqual(events, ["pending:cleanup", "consumer:cleanup", "provider:cleanup"]);
});

test("every retirement caller receives a pending factory rollback failure", async () => {
  const entered = barrier(), factory = barrier();
  const failure = new Error("pending cleanup failed");
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const activating = Promise.allSettled([supervisor.activate(definition("opencraft.pending-failure", async () => {
    entered.release(); await factory.wait;
    return () => { throw failure; };
  }))]);
  await entered.wait;
  const disposals = Promise.allSettled([supervisor.dispose(), supervisor.dispose()]);
  factory.release();
  const [activation] = await activating;
  const results = await disposals;
  assert.equal(activation.status, "rejected");
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof AggregateError);
      assert.ok(result.reason.errors.includes(failure));
    }
  }
  assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
});

test("retirement also drains and reports cleanup already started by deactivation", async () => {
  const entered = barrier(), cleanup = barrier();
  const failure = new Error("deactivation cleanup failed");
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await supervisor.activate(definition("opencraft.deactivating", () => async () => {
    entered.release(); await cleanup.wait; throw failure;
  }));
  const deactivating = Promise.allSettled([supervisor.deactivate("opencraft.deactivating")]);
  await entered.wait;
  const retiring = Promise.allSettled([supervisor.dispose()]);
  cleanup.release();
  const [deactivation] = await deactivating;
  const [disposal] = await retiring;
  assert.equal(deactivation.status, "rejected");
  assert.equal(disposal.status, "rejected");
  if (disposal.status === "rejected") assert.ok(disposal.reason.errors.includes(failure));
});

test("late or newly requested optional modules cannot mutate a retired supervisor", async () => {
  for (const fails of [false, true]) {
    const entered = barrier(), loading = barrier();
    const supervisor = new ExtensionSupervisor({ platform: "web" });
    let starts = 0, loads = 0;
    const extension = definition("opencraft.optional", () => { starts++; });
    const pending = supervisor.loadOptional("opencraft.optional", async () => {
      entered.release(); await loading.wait;
      if (fails) throw new Error("late module failure");
      return extension;
    });
    await entered.wait;
    await supervisor.dispose();
    const retired = supervisor.getSnapshot();
    loading.release();
    assert.equal(await pending, false);
    assert.equal(await supervisor.loadOptional("opencraft.optional", () => { loads++; return extension; }), false);
    assert.equal(await supervisor.activateOptional(extension), false);
    assert.equal(starts, 0);
    assert.equal(loads, 0);
    assert.equal(supervisor.getSnapshot(), retired, "late optional failure cannot republish retired diagnostics");
  }
});

test("retirement from an activating observer prevents the factory from starting", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let starts = 0, retiring: Promise<void> | undefined;
  supervisor.subscribe(() => {
    if (supervisor.getSnapshot().extensions.some(row => row.status === "activating")) retiring = supervisor.dispose();
  });
  await assert.rejects(supervisor.activate(definition("opencraft.reentrant", () => { starts++; })));
  await retiring;
  assert.equal(starts, 0);
  assert.deepEqual(supervisor.getSnapshot().extensions, []);
});

test("manifest V1 rejects ambiguous identity and unsupported trust", () => {
  assert.equal(parseExtensionManifestV1(manifest("opencraft.example")).id, "opencraft.example");
  assert.throws(
    () => parseExtensionManifestV1({ ...manifest("opencraft.example"), id: "Example" }),
    ExtensionManifestError,
  );
  assert.throws(
    () => parseExtensionManifestV1({ ...manifest("opencraft.example"), trust: "sandboxed" }),
    /trust=trusted/u,
  );
});

test("manifest V1 normalizes explicit extension dependencies", () => {
  const parsed = parseExtensionManifestV1({
    ...manifest("opencraft.consumer"),
    dependencies: ["opencraft.provider"],
  });
  assert.deepEqual(parsed.dependencies, ["opencraft.provider"]);
  assert.throws(
    () => parseExtensionManifestV1({ ...manifest("opencraft.consumer"), dependencies: ["opencraft.consumer"] }),
    /cannot depend on itself/u,
  );
});

test("supervisor enforces dependency activation and reverse disposal order", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const provider = definition("opencraft.provider", () => undefined);
  const consumer: TrustedExtensionDefinition = {
    manifest: { ...manifest("opencraft.consumer"), dependencies: ["opencraft.provider"] },
    activate: () => undefined,
  };
  await assert.rejects(supervisor.activate(consumer), /requires active dependencies: opencraft.provider/u);
  await supervisor.activate(provider);
  await supervisor.activate(consumer);
  await assert.rejects(supervisor.deactivate("opencraft.provider"), /required by active extensions: opencraft.consumer/u);
  assert.equal(await supervisor.deactivate("opencraft.consumer"), true);
  assert.equal(await supervisor.deactivate("opencraft.provider"), true);
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
  const identity = await supervisor.activate(definition("opencraft.example", (api) => {
    apiAfterActivation = api;
    api.commands.register(
      { id: "opencraft.example.echo", title: "Echo" },
      async (value) => value,
    );
    api.settings.registerSchema({
      id: "opencraft.example.preferences",
      title: "Example",
      schemaVersion: 1,
      fields: [{ key: "enabled", type: "boolean", title: "Enabled", defaultValue: true }],
    });
    removeView = api.views.register({
      id: "opencraft.example.settings-view",
      title: "Example settings",
      viewType: "opencraft.example.settings",
      audience: "internal",
    });
    api.settings.registerPage({
      id: "opencraft.example.settings-page",
      title: "Example",
      viewId: "opencraft.example.settings-view",
      layout: "master-detail",
      management: { familyId: "opencraft.example.manage", scope: "agent" },
    });
    api.navigation.register({
      id: "opencraft.example.navigation",
      title: "Example",
      surface: "sidebar-primary",
      target: { kind: "settings", pageId: "opencraft.example.settings-page" },
      audience: "internal",
    });
    api.sidebar.registerCatalog({
      id: "opencraft.example.catalog",
      title: "Example catalog",
      viewId: "opencraft.example.settings-view",
    });
    api.workbench.registerSurface({
      id: "opencraft.example.empty",
      viewId: "opencraft.example.settings-view",
      surface: "empty-workbench",
    });
    api.workbench.registerSurface({
      id: "opencraft.example.authentication-required",
      viewId: "opencraft.example.settings-view",
      surface: "host-connection-intervention",
      providerId: "opencraft.example",
      intervention: "authentication-required",
    });
    api.themes.register({
      id: "opencraft.example.paper",
      label: "Paper",
      palettes: { light: lightPalette, dark: darkPalette },
    });
    api.bots.register({
      id: "opencraft.example.bot",
      name: "Example Bot",
      avatar: { kind: "monogram", text: "E", background: "#3478f6" },
      action: { kind: "command", commandId: "opencraft.example.echo" },
      defaultPinned: true,
    });
    api.subscriptions.add(() => { disposalOrder.push("subscription"); });
    return () => { disposalOrder.push("activation"); };
  }));

  assert.deepEqual(identity, {
    extensionId: "opencraft.example",
    activationId: "activation-1",
    generation: 1,
  });
  const snapshot = supervisor.contributions.getSnapshot();
  assert.equal(snapshot.commands.length, 1);
  assert.equal(snapshot.settingsSchemas.length, 1);
  assert.equal(snapshot.views.length, 1);
  assert.equal(snapshot.views[0]?.contribution.audience, "internal");
  assert.equal(snapshot.settingsPages.length, 1);
  assert.deepEqual(snapshot.settingsPages[0]?.contribution.management, {
    familyId: "opencraft.example.manage",
    scope: "agent",
  });
  assert.equal(snapshot.settingsPages[0]?.contribution.layout, "master-detail");
  assert.equal(Object.isFrozen(snapshot.settingsPages[0]?.contribution.management), true);
  assert.equal(snapshot.navigation.length, 1);
  assert.equal(snapshot.navigation[0]?.contribution.audience, "internal");
  assert.equal(snapshot.sidebarCatalogs.length, 1);
  assert.equal(snapshot.workbenchSurfaces.length, 2);
  assert.equal(snapshot.themes.length, 1);
  assert.equal(snapshot.bots.length, 1);
  assert.equal(snapshot.themes[0]?.contribution.palettes.light.surface, "#fbfaf7");
  assert.equal(snapshot.commands[0]?.owner.activationId, "activation-1");
  assert.equal(await supervisor.contributions.executeCommand("opencraft.example.echo", "hello"), "hello");

  await removeView?.();
  assert.equal(supervisor.contributions.getSnapshot().views.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().navigation.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().sidebarCatalogs.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().workbenchSurfaces.length, 0);
  assert.equal(await supervisor.deactivate("opencraft.example"), true);
  assert.deepEqual(disposalOrder, ["activation", "subscription"]);
  assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().themes.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().bots.length, 0);
  assert.throws(
    () => apiAfterActivation!.settings.registerSchema({
      id: "opencraft.example.late",
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
  await supervisor.activate(definition("opencraft.announcer", (activationApi) => {
    api = activationApi;
  }));

  const result = api.window.showAnnouncement({
    id: "opencraft.announcer.release",
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
    /must be namespaced by extension opencraft\.announcer/u,
  );
  assert.throws(
    () => api.window.showAnnouncement(null as never),
    /contribution must be an object/u,
  );
  assert.throws(
    () => api.window.showAnnouncement({
      id: "opencraft.announcer.invalid-media",
      title: "Invalid",
      media: { kind: "html", url: "/unsafe" },
    } as never),
    /invalid media kind/u,
  );
  const inlineResult = api.window.showAnnouncement({
    id: "opencraft.announcer.inline-image",
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
      id: "opencraft.announcer.non-image-data",
      title: "Unsafe inline content",
      media: { kind: "image-url", url: "data:text/html,<script>alert(1)</script>", alt: "Invalid" },
    }),
    /media URL must be HTTP\(S\), blob, image data, or root-relative/u,
  );
  assert.throws(
    () => api.window.showAnnouncement({
      id: "opencraft.announcer.invalid-dismiss",
      title: "Invalid",
      dismissOnOutsidePress: "yes",
    } as never),
    /dismissOnOutsidePress must be a boolean/u,
  );
  await supervisor.dispose();
});

test("extension retirement dismisses pending announcement work before draining callers", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await supervisor.activate(definition("opencraft.retiring", (activationApi) => {
    activationApi.commands.register(
      { id: "opencraft.retiring.show", title: "Show announcement" },
      () => activationApi.window.showAnnouncement({
        id: "opencraft.retiring.notice",
        title: "Pending notice",
      }),
    );
  }));
  const result = supervisor.contributions.executeCommand("opencraft.retiring.show");
  for (let index = 0; index < 10 && supervisor.announcements.getSnapshot().announcements.length === 0; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const retirement = supervisor.deactivate("opencraft.retiring");
  assert.deepEqual(await result, { kind: "dismissed", reason: "owner-disposed" });
  await retirement;
  assert.equal(supervisor.announcements.getSnapshot().announcements.length, 0);
  await supervisor.dispose();
});

test("invalid theme palette aborts the complete activation batch", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await assert.rejects(
    supervisor.activate(definition("opencraft.bad-theme", (api) => {
      api.commands.register(
        { id: "opencraft.bad-theme.command", title: "Must roll back" },
        () => undefined,
      );
      api.themes.register({
        id: "opencraft.bad-theme.palette",
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
    supervisor.activate(definition("opencraft.dangling", (api) => {
      api.navigation.register({
        id: "opencraft.dangling.open",
        title: "Dangling",
        surface: "sidebar-primary",
        target: { kind: "view", viewId: "opencraft.dangling.missing-view" },
      });
    })),
    /targets an unregistered contribution/u,
  );
  assert.equal(supervisor.contributions.getSnapshot().navigation.length, 0);
  await supervisor.dispose();
});

for (const role of ["bot-conversation", "connector-management"] as const) test(`the ${role} View role has exactly one transactional owner`, async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await supervisor.activate(definition("opencraft.bot-owner", (api) => {
    api.views.register({
      id: "opencraft.bot-owner.view",
      title: "Bot owner",
      viewType: "opencraft.bot-owner.surface",
      role,
    });
  }));
  await assert.rejects(
    supervisor.activate(definition("opencraft.bot-contender", (api) => {
      api.views.register({
        id: "opencraft.bot-contender.view",
        title: "Bot contender",
        viewType: "opencraft.bot-contender.surface",
        role,
      });
    })),
    new RegExp(`View role ${role} is already owned by opencraft\\.bot-owner\\.view`, "u"),
  );
  assert.deepEqual(
    supervisor.contributions.getSnapshot().views.map(({ contribution }) => contribution.id),
    ["opencraft.bot-owner.view"],
  );
  await supervisor.deactivate("opencraft.bot-owner");
  await supervisor.activate(definition("opencraft.replacement", (api) => {
    api.views.register({ id: "opencraft.replacement.view", title: "Replacement", viewType: "opencraft.replacement.surface", role });
  }));
  assert.equal(supervisor.contributions.getSnapshot().views[0]?.contribution.role, role);
  await supervisor.dispose();
});

test("activation failure leaves no partially published contribution", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await assert.rejects(
    supervisor.activate(definition("opencraft.failure", (api) => {
      api.commands.register({ id: "opencraft.failure.command", title: "Command" }, () => undefined);
      api.settings.registerSchema({
        id: "opencraft.failure.settings",
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
    supervisor.activate(definition("opencraft.rollback", (api) => {
      api.commands.register({ id: "opencraft.rollback.command", title: "Command" }, () => undefined);
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
  const extension = definition("opencraft.leased", (api) => {
    capturedApi = api;
    api.internal.register("leased", {});
  });
  const first = await supervisor.activate(extension);
  let retired = false;
  const retirement = supervisor.deactivate("opencraft.leased").then(() => { retired = true; });
  await Promise.resolve();
  assert.equal(retired, false);
  assert.throws(
    () => capturedApi.views.register({
      id: "opencraft.leased.late",
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
  await supervisor.activate(definition("opencraft.command-lease", (api) => {
    api.commands.register(
      { id: "opencraft.command-lease.run", title: "Run" },
      async () => {
        events.push("command:start");
        await commandWork;
        events.push("command:end");
      },
    );
    return () => { events.push("activation:dispose"); };
  }));
  const command = supervisor.contributions.executeCommand("opencraft.command-lease.run");
  await Promise.resolve();
  let retired = false;
  const retirement = supervisor.deactivate("opencraft.command-lease").then(() => { retired = true; });
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
    supervisor.activate(definition("opencraft.web-only", () => { ran = true; })),
    /does not target expo/u,
  );
  assert.equal(ran, false);
  await supervisor.dispose();
});

test("settings pages preserve a fixed Host owner and reject an empty owner atomically", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const register = (targetHostId: string) => definition("opencraft.host-settings", api => {
    api.views.register({ id: "opencraft.host-settings.view", title: "Host settings", viewType: "host-settings" });
    api.settings.registerPage({ id: "opencraft.host-settings.page", title: "Settings", viewId: "opencraft.host-settings.view", targetHostId });
  });
  await assert.rejects(supervisor.activate(register(" ")), /target Host/u);
  assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 0);
  assert.equal(supervisor.contributions.getSnapshot().views.length, 0);
  await supervisor.activate(register("fixture-host"));
  assert.equal(supervisor.contributions.getSnapshot().settingsPages[0]?.contribution.targetHostId, "fixture-host");
  await supervisor.dispose();
});


test("navigation and settings copy is validated and frozen with its activation", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const title = { id: "example.title", defaultMessage: "Complete title" };
  const short = { id: "example.short", defaultMessage: "Compact" };
  const badge = { id: "example.badge", defaultMessage: "Preview" };
  await supervisor.activate(definition("example.copy", api => {
    api.views.register({ id: "example.copy.view", title: "View", viewType: "example.copy.surface" });
    api.navigation.register({ id: "example.copy.nav", title: "Fallback", titleMessage: title, shortTitleMessage: short, badgeMessage: badge,
      surface: "sidebar-primary", target: { kind: "view", viewId: "example.copy.view" } });
    api.settings.registerPage({ id: "example.copy.page", title: "Fallback", titleMessage: title, shortTitleMessage: short, viewId: "example.copy.view" });
  }));
  title.defaultMessage = short.defaultMessage = badge.defaultMessage = "Late mutation";
  const snapshot = supervisor.contributions.getSnapshot();
  assert.equal(snapshot.navigation[0]?.contribution.titleMessage?.defaultMessage, "Complete title");
  assert.equal(snapshot.navigation[0]?.contribution.shortTitleMessage?.defaultMessage, "Compact");
  assert.equal(snapshot.navigation[0]?.contribution.badgeMessage?.defaultMessage, "Preview");
  assert.equal(snapshot.settingsPages[0]?.contribution.shortTitleMessage?.defaultMessage, "Compact");
  assert.ok(Object.isFrozen(snapshot.navigation[0]?.contribution.badgeMessage));
  assert.ok(Object.isFrozen(snapshot.settingsPages[0]?.contribution.shortTitleMessage));
  await supervisor.deactivate("example.copy");
  assert.deepEqual(supervisor.contributions.getSnapshot().navigation, []);
  await supervisor.dispose();
});

for (const field of ["titleMessage", "shortTitleMessage", "badgeMessage"] as const) test(`invalid navigation ${field} rolls back the whole contribution transaction`, async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await assert.rejects(supervisor.activate(definition("example.invalid-copy", api => {
    api.views.register({ id: "example.invalid-copy.view", title: "View", viewType: "example.invalid-copy.surface" });
    api.navigation.register({ id: "example.invalid-copy.nav", title: "Fallback", [field]: { id: "example.invalid-copy.message", defaultMessage: " " },
      surface: "sidebar-primary", target: { kind: "view", viewId: "example.invalid-copy.view" } });
  })), /navigation message fallback/u);
  assert.deepEqual(supervisor.contributions.getSnapshot().views, []);
  assert.deepEqual(supervisor.contributions.getSnapshot().navigation, []);
  await supervisor.dispose();
});

test("invalid compact settings copy rejects publication", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  await assert.rejects(supervisor.activate(definition("example.invalid-page-copy", api => {
    api.views.register({ id: "example.invalid-page-copy.view", title: "View", viewType: "example.invalid-page-copy.surface" });
    api.settings.registerPage({ id: "example.invalid-page-copy.page", title: "Fallback", viewId: "example.invalid-page-copy.view",
      shortTitleMessage: { id: "", defaultMessage: "Compact" } });
  })), /settings message ID/u);
  assert.deepEqual(supervisor.contributions.getSnapshot().views, []);
  await supervisor.dispose();
});
