import type { DurableStorageNative, PolicyStorePort } from "./storage.js";
import type { HostWorkspacesPort } from "./workspace.js";
import type { HostPolicy, HostTerminalRuntimePort } from "./host-policy.ts";
import type { HostTelemetryPort } from "../runtime/telemetry.ts";
import type { ByteInput } from "../runtime/bytes.ts";
import type { VfsDirectoryEntry, VfsMetadata } from "./vfs.ts";
import type { TcpOutboundDriver } from "./network.ts";
import type { RuntimePluginGlobalApi } from "./hot-upgrade.ts";

interface HypernodeBootDiagnostic {
  name: string;
  state: number;
  missing: string[];
}

interface HypernodeBootResult {
  ready: true;
  fibers: number;
}

declare global {
  var durableStorage: DurableStorageNative | undefined;
  var policyStore: PolicyStorePort;
  var hostProcess: HostProcessPort;
  var hostFilesystem: HostFilesystemPort;
  var hostTcpOutboundDriver: TcpOutboundDriver;
  var hostWorkspaces: HostWorkspacesPort | undefined;
  var hostTerminal: HostTerminalRuntimePort;
  var crypto: Crypto;
  var console: Console;
  var hostEvents: HostEvents | undefined;
  var hostWebCrypto: HostWebCryptoPort | undefined;
  var hostTelemetry: HostTelemetryPort | undefined;
  var hostNetwork: {
    request(options: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    }): { status: number; body: string; headers?: Record<string, string> };
    openWebSocket(id: string, url: string, headers: Record<string, string>): void;
    sendWebSocket(id: string, text: string): void;
    drainWebSocket(id: string): {
      messages: string[];
      closed: boolean;
      error?: string | null;
    };
    closeWebSocket(id: string): void;
  };
  var hypernodeConfig: {
    authenticationMode?: string;
    usersRoot?: string;
    remoteControlBaseUrl?: string;
    workspaceV2Enabled?: boolean;
  };
  var hostIdentity: HostIdentityPort;
  var hostModelGateway: HostModelGatewayPort | undefined;
  var hypernodeBootDiagnostics: (() => HypernodeBootDiagnostic[]) | undefined;
  var hypernodeBootPromise: Promise<HypernodeBootResult> | undefined;
  var hypernodeRuntimePlugins: RuntimePluginGlobalApi | undefined;
  var hypernodeHotUpgrade: RuntimePluginGlobalApi | undefined;
  var policy: HostPolicy;
  var secrets: SecretsPort;

  interface SecretsPort {
    verifyPassword(candidate: string): boolean;
  }

  interface HostEvents {
    monotonicNowMs?(): number;
    notify?(): void;
    wakeAfter?(delayMs: number): void;
  }

  interface HostProcessPort {
    spawnCodexAppServer(processId: string, cwd: string): void;
    spawnCodexAppServerForUser(
      processId: string,
      cwd: string,
      username: string,
      linuxUid: number | null | undefined,
      linuxGid: number | null | undefined,
      installationId: string | null | undefined,
      providerId: string,
    ): void;
    spawnDshEngineWorkerForUser(
      processId: string,
      cwd: string,
      username: string,
      linuxUid: number | null | undefined,
      linuxGid: number | null | undefined,
      installationId: string | null | undefined,
      providerId: string,
    ): void;
    write(processId: string, input: string): void;
    drain(processId: string): import("./engine.ts").DshRuntimeDrainResult;
    terminate(processId: string, timeoutMs: number): void;
    kill(processId: string): void;
  }

  interface HostFilesystemMetadata extends VfsMetadata {
    fileName: string;
    size: number;
  }

  interface HostFilesystemPort {
    root(): string;
    metadata(path: string): HostFilesystemMetadata;
    readDirectory(path: string): VfsDirectoryEntry[];
    readFile(path: string): Uint8Array;
    writeFile(path: string, bytes: ByteInput): void;
    createDirectory(path: string, recursive: boolean): void;
    remove(path: string, recursive: boolean, force: boolean): void;
    metadataForUser(username: string, path: string): HostFilesystemMetadata;
    readDirectoryForUser(username: string, path: string): VfsDirectoryEntry[];
    readFileForUser(username: string, path: string): Uint8Array;
    writeFileForUser(
      username: string,
      path: string,
      bytes: ByteInput,
      linuxUid: number | null | undefined,
      linuxGid: number | null | undefined,
    ): void;
    createDirectoryForUser(
      username: string,
      path: string,
      recursive: boolean,
      linuxUid: number | null | undefined,
      linuxGid: number | null | undefined,
    ): void;
    removeForUser(username: string, path: string, recursive: boolean, force: boolean): void;
  }

  interface HostWebCryptoPort {
    submitDigest(algorithm: string, input: Uint8Array): string;
    drain(): HostWebCryptoResult[];
  }

  interface HostWebCryptoResult {
    id: string;
    bytes?: number[];
    error?: string;
  }

  interface Console {
    error(...values: unknown[]): void;
    info(...values: unknown[]): void;
    warn(...values: unknown[]): void;
  }

  interface Crypto {
    randomBytes(size: number): string;
    randomUUID?(): string;
    sha256(value: string): string;
  }

  interface HostIdentityPort {
    readCodexAuth(username: string): Uint8Array;
    readCodexInstallationId(username: string): string;
    readActiveCodexShare(username: string): string;
    findUserRollout(userHome: string, threadId: string): string;
    readUserRollout(path: string): Uint8Array;
    saveCodexAuthProfile(username: string, profileId: string): string;
    ensureCodexAuthProfileInstallation(
      username: string,
      profileId: string,
      installationId: string,
    ): void;
    activateCodexAuthProfile(username: string, profileId: string): string;
    activateSharedCodexAuthProfile(
      ownerUsername: string,
      profileId: string,
      consumerUsername: string,
      shareId: string,
    ): string;
    syncSharedCodexAuthProfile(
      consumerUsername: string,
      ownerUsername: string,
      profileId: string,
    ): void;
    clearActiveCodexAuth(username: string): void;
    beginCodexAuthLogin(
      username: string,
      stagingId: string,
      installationId: string,
    ): string;
    commitCodexAuthLogin(username: string, stagingId: string): void;
    rollbackCodexAuthLogin(username: string, stagingId: string): string;
    removeCodexAuthProfile(username: string, profileId: string): void;
  }

  interface HostModelGatewayPort {
    available?: boolean;
    credentialLoaded?(username: string, providerId: string): boolean;
  }
}

export {};
