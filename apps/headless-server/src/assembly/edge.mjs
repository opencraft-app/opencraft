/**
 * Edge assembly (gateway-split §4.1.1): the entry every request reaches. The
 * operator-selected runtime plugins (after instance authentication and
 * admission, before the listener), the Web server's options — the release
 * and browser storage isolation, health and storage outcomes across every
 * module, and every HTTP service and session factory the route table
 * dispatches to — and the listener, directly or behind the SSH ingress.
 *
 * The route table and the socket are runtime constructions: the composition
 * root supplies `createWebServer` (on Node the `node:http` gateway of
 * `serve-workbench-web.mjs`), the runtime plugin host, and the SSH ingress in
 * front of a private loopback listener. Release files are read by the root
 * before any resource exists and arrive as values. Creating it opens
 * nothing. The root calls each step at its original position in startup and
 * each named disposer at its original position in the shutdown order; a
 * disposer for something never opened resolves without effect.
 */
export function assembleEdge() {
  let runtimePlugins, serviceIngress, web;
  return {
    async startServiceIngress(start) {
      if (start) serviceIngress = await start();
    },
    /** Starts the runtime plugins when configured (`start` is undefined otherwise); resolves the host or undefined. */
    async startRuntimePlugins(start) {
      if (start) runtimePlugins = await start();
      return runtimePlugins;
    },
    /** Creates the Web server with the options of every module, in their original order. */
    async openWeb({
      createWebServer,
      // Release and browser storage isolation.
      webRoot,
      userPluginDirectory,
      productPluginAssets,
      workbenchAssetsPlugin,
      webRelease,
      isolateBrowserStorage,
      machineIdentity,
      // Health.
      observability,
      ownerWake,
      getExecutionHealth,
      hostReadiness,
      // Client sessions (client-session `openWebSessions`).
      sessions,
      agent,
      agentIdentity,
      mcpApps,
      imPlugins,
      connectorService,
      loopbackOnly,
      localAccess,
      appHostServer,
      sshServers,
      sshManagement,
      fileDownloads,
      turnPush,
      serverStorage,
      remoteBrowser,
      identity,
      loginAdmission,
      codexStorageOutcomes,
      desktop,
      desktopAccess,
      account,
      actorAccess,
      actorStore,
      instanceAccess,
      assetsService,
      actorCollaborationApi,
      serverInformationService,
      accountModelDefaultsService,
      threadReadReceiptsService,
      actorSshKeysService,
      humanAuth,
      accountApplication,
      hubController,
    }) {
      web = await createWebServer({
        root: webRoot,
        userPluginDirectory,
        productPluginAssets,
        workbenchAssetsPlugin,
        instanceId: isolateBrowserStorage ? machineIdentity.machineId : null,
        assetVersion: isolateBrowserStorage ? webRelease.buildId : null,
        observability,
        ownerWake,
        getExecutionHealth,
        getHostReadiness: () => hostReadiness(),
        ...sessions,
        appServerTarget: agent.websocketUrl,
        resolveAppServerTarget: agent.resolveWebsocketUrl,
        appServerIdentity: agentIdentity ?? null,
        mcpAppsService: mcpApps,
        getImService: () => imPlugins.current(),
        connectorService,
        loopbackOnly,
        localAccess,
        appHostServer,
        sshServerDescriptors: sshServers.map((binding) => binding.descriptor),
        sshManagement,
        fileDownloads,
        getPluginHealth: () => {
          const im = imPlugins.current();
          return {
            ...(im ? { "opencraft.im": im.states() } : {}),
            ...(turnPush ? { "opencraft.push": turnPush.health } : {}),
            ...(runtimePlugins ? { "opencraft.runtime-plugins": runtimePlugins.health() } : {}),
          };
        },
        getStorageOutcomes: () => {
          const im = imPlugins.current();
          return [
            {
              name: "server-core",
              status: serverStorage.outcome.status,
              appliedVersion: serverStorage.outcome.appliedVersion,
              movedAside: false,
              productVersion: serverStorage.contract.productVersion,
              contractHash: serverStorage.contract.hash,
            },
            ...(im
              ? [
                  {
                    name: "im-switchboard",
                    status: im.outcome.status,
                    appliedVersion: im.outcome.appliedVersion,
                    movedAside: im.outcome.movedAsidePaths.length > 0,
                  },
                ]
              : []),
            ...(im
              ? [
                  {
                    name: "im-posts",
                    status: im.postOutcome.status,
                    appliedVersion: im.postOutcome.appliedVersion,
                    movedAside: im.postOutcome.movedAsidePaths.length > 0,
                  },
                ]
              : []),
            ...(agent.storageOutcomes ?? []),
            ...(remoteBrowser?.storageOutcomes() ?? []),
            ...(connectorService?.outcomes() ?? []),
            ...(turnPush
              ? [
                  {
                    name: "web-push",
                    status: turnPush.store.outcome.status,
                    appliedVersion: turnPush.store.outcome.appliedVersion,
                    movedAside: turnPush.store.outcome.movedAsidePaths.length > 0,
                  },
                ]
              : []),
            {
              name: "mcp-apps",
              status: mcpApps.outcome.status,
              appliedVersion: mcpApps.outcome.appliedVersion,
              movedAside: mcpApps.outcome.movedAsidePaths.length > 0,
            },
            ...(agentIdentity
              ? [
                  {
                    name: "thread-identity",
                    hostId: "opencraft-server",
                    status: agentIdentity.store.outcome.status,
                    appliedVersion: agentIdentity.store.outcome.appliedVersion,
                    backupPath: agentIdentity.store.outcome.backupPath,
                    movedAside: agentIdentity.store.outcome.movedAsidePaths.length > 0,
                  },
                ]
              : []),
            ...(identity?.getStorageOutcomes?.() ?? []),
            ...(loginAdmission
              ? [
                  {
                    name: "login-admission",
                    status: loginAdmission.outcome.status,
                    appliedVersion: loginAdmission.outcome.appliedVersion,
                    movedAside: loginAdmission.outcome.movedAsidePaths.length > 0,
                  },
                ]
              : []),
            ...[...codexStorageOutcomes.values()].flat(),
            ...(sshManagement
              ? [
                  {
                    name: "ssh-connections",
                    status: sshManagement.store.outcome.status,
                    appliedVersion: sshManagement.store.outcome.appliedVersion,
                    backupPath: sshManagement.store.outcome.backupPath,
                    movedAside: sshManagement.store.outcome.movedAsidePaths.length > 0,
                  },
                ]
              : []),
          ];
        },
        desktopService: desktop ?? null,
        desktopAccess,
        modelPolicyService: account.createHttpService({ actorAccess, actorStore, instanceAccess }),
        assetsService,
        identityService: identity?.service ?? null,
        ...(serviceIngress ? { serviceIngress } : {}),
        ...(runtimePlugins ? { runtimePluginService: runtimePlugins } : {}),
        accessService: instanceAccess ?? null,
        actorService: actorAccess,
        allowSessionChannels: true,
        actorCollaborationService: actorCollaborationApi,
        turnPushService: turnPush,
        serverInformationService,
        accountModelDefaultsService,
        threadReadReceiptsService,
        actorSshKeysService,
        authService: humanAuth ?? null,
        accountService: accountApplication ?? null,
        hubService: hubController,
        remoteBrowserService: remoteBrowser,
        speechService: account.createSpeechService(),
      });
      return web;
    },
    /**
     * Opens the listener: on `host`:`port`, or, with `sshIngress`, on a
     * private loopback port behind the SSH/HTTP ingress, which then owns the
     * public address. Resolves the public address.
     */
    async listen({ host, port, sshIngress }) {
      if (sshIngress) {
        const privateAddress = await web.listen({ host: "127.0.0.1", port: 0 });
        return sshIngress(privateAddress.port);
      }
      return web.listen({ host, port });
    },
    /** Shutdown step 2: Web stops accepting, then calls `closeEntry` (step 3) in its carrier phase. */
    closeWeb: (update, closeEntry) => web?.close(update, closeEntry),
    /** Shutdown step 4, after the entry phase and before the personal SSH keys. */
    closeRuntimePlugins: () => runtimePlugins?.close(),
    closeServiceIngress: () => serviceIngress?.close?.(),
  };
}
