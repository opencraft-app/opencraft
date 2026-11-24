import type { SshManagement } from "@opencraft/opencraft-daemon/ssh-management";
import type { LocalDesktopService } from "@opencraft/local-agent-host/desktop";

/** The App Host operations node-local services call; the composition root passes the constructed server. */
export interface NodeLocalAppHost {
  resetHost(hostId: string): unknown;
  hostState(hostId: string): unknown;
  ensureHostConnected(hostId: string, assertAdmission?: unknown): unknown;
}

/** The observation ingress the Web server mounts and reports a planned restart through. */
export interface NodeLocalObservability {
  handle(request: unknown, response: unknown): Promise<boolean>;
  close(): void;
}

export interface NodeLocalAssembly {
  /** Opens the verified local desktop when `enabled` is `true`; otherwise resolves `undefined`. */
  startDesktop(options: {
    enabled: boolean | undefined;
    control: boolean | undefined;
    access: "loopback" | "trusted-internal";
  }): Promise<LocalDesktopService | undefined>;
  /** Opens saved SSH connections when `enabled`; otherwise resolves `undefined`. */
  openSshManagement(options: {
    enabled: boolean | undefined;
    publicAccess: boolean | undefined;
    accessFile: string | undefined;
    requireAccessKey: boolean | undefined;
    appHost: NodeLocalAppHost;
    sshServers: ReadonlyArray<{ descriptor: unknown }>;
  }): Promise<SshManagement | undefined>;
  /** The observation ingress, or `null`/`undefined` when unconfigured or unusable (reported on stderr). */
  startObservability(options: {
    configFile: string | undefined;
    access: unknown;
    actors: unknown;
    executionHealth: unknown;
  }): Promise<NodeLocalObservability | null | undefined>;
  /** Opens the SSH/HTTP ingress in front of the Web server's private listener; resolves to its address. */
  listenSshIngress(options: {
    configuration: object;
    httpPort: number;
    appHost: NodeLocalAppHost;
    identitySshAccess: unknown;
    personalSshKeys: unknown;
    codexExecutable: string;
    host: string;
    port: number;
  }): Promise<{ port: number }>;
  /** Connects the outbound relay to the listener's port when configured. */
  connectRelay(configuration: { options: { targetPort?: number } } | null | undefined, listenPort: number): void;
  /** Starts the availability notification socket; a startup failure is reported and leaves it absent. */
  startAvailabilityNotification(options: {
    configFile: string | undefined;
    getImService: () => unknown;
  }): Promise<void>;
  /** Shutdown step 3 (entry phase): each resolves without effect when its service never started. */
  closeRelay(): unknown;
  closeSshIngress(): unknown;
  closeSshNativeRpc(): unknown;
  closeDesktop(): unknown;
  closeAvailabilityNotification(): unknown;
  /** Shutdown step 6, after the runtime plugins and personal SSH keys. */
  closeObservability(): unknown;
  /** Shutdown step 11, among the serial writers after the MCP apps store. */
  closeSshManagement(): unknown;
}

export function assembleNodeLocal(options: { dataDirectory: string }): NodeLocalAssembly;
