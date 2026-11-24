import { createHash } from "node:crypto";
import { join } from "node:path";
import { LocalDesktopService } from "@opencraft/local-agent-host/desktop";
import { createNativeObserver, localDesktopMachineIdentity } from "@opencraft/local-agent-host/desktop-native";
import { createNativeDesktopControl } from "@opencraft/local-agent-host/desktop/native-control";
import { SshManagement } from "@opencraft/opencraft-daemon/ssh-management";
import { createSshHttpIngress } from "@opencraft/ssh-http-ingress/server";
import { connectRelay } from "@opencraft/plugin-relay-connect/server";
import { composeSshAccess } from "../actor-ssh-keys.ts";
import { createObservabilityIngress } from "../observability-ingress.mjs";
import { startAvailabilityNotification } from "../availability-notification.mjs";
import { createSshNativeRpcGateway } from "../ssh-native-rpc-gateway.mjs";
import { createSshCodexControl } from "../ssh-codex-control.mjs";

/**
 * Node-local assembly: services that exist only where the Gateway runs on a
 * machine it can reach directly (gateway-split §4.2) — the local desktop, SSH
 * management, the SSH/HTTP ingress, the outbound relay, the observation ingress
 * and the availability notification socket.
 *
 * Creating it opens nothing. The composition root calls each `start`/`open`
 * step at its original position in startup, and each named disposer at its
 * original position in the shutdown order; a disposer for a step that never
 * ran resolves without effect.
 */
export function assembleNodeLocal({ dataDirectory }) {
  let desktop, sshManagement, observability, sshNativeRpc, ingress, relay, availabilityNotification;
  return {
    /** The verified local desktop; `undefined` unless enabled. */
    async startDesktop({ enabled, control: controlEnabled, access }) {
      if (enabled !== true) return undefined;
      const observer = createNativeObserver();
      const incarnation = await observer.inspect(AbortSignal.timeout(5_000));
      const control = controlEnabled ? createNativeDesktopControl() : undefined;
      if (control && (await control.inspect(AbortSignal.timeout(5_000))) !== incarnation)
        throw new Error("Desktop control incarnation mismatch");
      const environmentId = await localDesktopMachineIdentity();
      const principalId = `local-owner:${process.getuid()}`;
      const serverId = `local-codex:${createHash("sha256")
        .update(JSON.stringify([dataDirectory, principalId]))
        .digest("hex")}`;
      desktop = new LocalDesktopService({
        serverId,
        environmentId,
        principalId,
        observer,
        control,
        transport: access === "trusted-internal" ? "same-origin-trusted-internal" : "same-origin-loopback",
      });
      return desktop;
    },
    /**
     * Saved SSH connections; `undefined` unless `enabled`. Local anonymous
     * features remain usable. Public remote access is enabled only with
     * explicit operator opt-in; all remote sockets require a session.
     */
    async openSshManagement({ enabled, publicAccess, accessFile, requireAccessKey, appHost, sshServers }) {
      sshManagement = enabled
        ? await SshManagement.open({
            directory: join(dataDirectory, "ssh"),
            publicAccess,
            accessFile,
            accessMode: requireAccessKey || accessFile ? "access-key" : "shared",
            resetConnection: (id) => appHost.resetHost(id),
            connectionState: (id) => appHost.hostState(id),
            connectConnection: (id, assertAdmission) => appHost.ensureHostConnected(id, assertAdmission),
            legacyServers: sshServers.map((binding) => binding.descriptor),
          })
        : undefined;
      return sshManagement;
    },
    /** The observation ingress; an unusable configuration leaves it absent and the workbench continues. */
    async startObservability({ configFile, access, actors, executionHealth }) {
      try {
        observability = await createObservabilityIngress(configFile, { access, actors, executionHealth });
      } catch {
        process.stderr.write(
          "Observability configuration unavailable; workbench continues without observation ingress.\n",
        );
      }
      return observability;
    },
    /**
     * Opens the SSH/HTTP ingress in front of the Web server's private loopback
     * listener and resolves to the public address.
     */
    async listenSshIngress({
      configuration,
      httpPort,
      appHost,
      identitySshAccess,
      personalSshKeys,
      codexExecutable,
      host,
      port,
    }) {
      sshNativeRpc = await createSshNativeRpcGateway(appHost);
      const sshAccess = composeSshAccess(identitySshAccess, personalSshKeys);
      ingress = createSshHttpIngress({
        ...configuration,
        httpPort,
        // An identity composition's own keys first, then each person's registered keys.
        ...(sshAccess
          ? {
              resolveAuthorizedKeys: (username, key) => sshAccess.publicKeys(username, key),
              authorizeSession: (username, key) => sshAccess.authorize(username, key),
              createNativeSession: (authorization) => createSshNativeRpcGateway(appHost, authorization),
            }
          : {}),
        codexPort: sshNativeRpc.port,
        codexControl: createSshCodexControl(appHost, codexExecutable),
      });
      return ingress.listen({ host, port });
    },
    /** The outbound relay to the listener's port, when configured. */
    connectRelay(configuration, listenPort) {
      if (configuration)
        relay = connectRelay({ ...configuration.options, targetPort: configuration.options.targetPort ?? listenPort });
    },
    /** The availability notification socket; a startup failure is reported and leaves it absent. */
    async startAvailabilityNotification({ configFile, getImService }) {
      try {
        availabilityNotification = await startAvailabilityNotification(configFile, getImService);
      } catch {
        console.warn("[availability-notification] startup-unavailable");
      }
    },
    // Shutdown step 3 (entry phase, in parallel with the other entry owners).
    closeRelay: () => relay?.close(),
    closeSshIngress: () => ingress?.close(),
    closeSshNativeRpc: () => sshNativeRpc?.close(),
    closeDesktop: () => desktop?.close(),
    closeAvailabilityNotification: () => availabilityNotification?.close(),
    // Shutdown step 6, after the runtime plugins and personal SSH keys.
    closeObservability: () => observability?.close(),
    // Shutdown step 11, among the serial writers.
    closeSshManagement: () => sshManagement?.close(),
  };
}
