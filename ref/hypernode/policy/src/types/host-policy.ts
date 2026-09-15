import type { AppServerIdentity } from "./appserver.ts";
import type { VirtualWebSocketConnection } from "../runtime/virtual-websocket.ts";
import type { CodexAccountRecord } from "./account-config.ts";

export type HostByteOutput = Uint8Array | number[];

export interface HostDecision {
  allow: boolean;
  stdout?: string;
  stdoutBytes?: HostByteOutput;
  stderr?: string;
  exitCode?: number;
  sensitive?: boolean;
  closeAfterWrite?: boolean;
  stream?: string;
  done?: boolean;
}

export interface HostConnectionContext {
  connectionId: string;
  remoteAddr?: string;
  dataBytes?: ArrayLike<number>;
  headers?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export interface HostAuthenticationContext extends HostConnectionContext {
  username: string;
  password: string;
  fingerprint?: string;
}

export interface HostSessionContext extends HostConnectionContext {
  sessionId: string;
  request?: string;
  command?: string;
  cols?: number;
  rows?: number;
}

export interface HostPolicy {
  onTCPOpen(context: HostConnectionContext): HostDecision;
  onTCPData(context: HostConnectionContext): HostDecision;
  onTCPPoll(context: HostConnectionContext): HostDecision;
  onTCPClose(context: HostConnectionContext): HostDecision;
  onTick(): void;
  authenticateNone(context: HostAuthenticationContext): HostDecision;
  authenticatePublicKey(context: HostAuthenticationContext): HostDecision;
  authenticate(context: HostAuthenticationContext): HostDecision;
  onRequest(context: HostSessionContext): HostDecision;
  onStreamData(context: HostSessionContext): HostDecision;
  onStreamPoll(context: HostSessionContext): HostDecision;
  onStreamClose(context: HostSessionContext): HostDecision;
  onExec(context: HostSessionContext): HostDecision;
}

export interface HostUserDirectoryPort {
  allowNoneAuth(context: HostAuthenticationContext): boolean;
  authenticatePublicKey(context: HostAuthenticationContext): boolean;
  identityForConnection(connectionId: string): HostUserRecord | null;
  identityForDirectWebSocket(context: HostConnectionContext & { username: string }):
    AppServerIdentity | null;
  find(id: string): HostUserRecord | null;
  list(): HostUserRecord[];
  setCodexAccount(
    userId: string,
    account?: CodexAccountRecord | null,
    metadata?: Record<string, unknown>,
  ): void;
  setCodexBindingState(userId: string, state: string): void;
  setInstallationId(userId: string, installationId: string): void;
  deliverAgentMessage(
    connection: import("./appserver.ts").AppServerConnection,
    threadId: string,
    message: {
      deliveryText: string;
      persistedText?: string;
      sensitive?: boolean;
    },
  ): void;
}

export interface HostUserRecord extends AppServerIdentity {
  id: string;
  username: string;
  role?: string;
  homePath?: string | null;
  codexHome?: string | null;
  linuxUid?: number | null;
  linuxGid?: number | null;
  installationId?: string | null;
  codexBindingState?: "bound" | "unbound" | null;
  codexAuthMode?: string | null;
  codexAccountEmail?: string | null;
  codexPlanType?: string | null;
  codexCredentialRef?: string | null;
  codexBoundAtMs?: number | null;
  codexLastVerifiedAtMs?: number | null;
}

export interface TerminalDrainResult {
  outputBytes?: HostByteOutput;
  error?: string;
  exitCode?: number;
  exited?: boolean;
  cwd?: string;
}

export interface HostTerminalAttachment {
  cwd: string;
  shell: string;
}

export interface HostTerminalRuntimePort {
  spawnForUser(
    terminalId: string,
    username: string,
    cwd: string,
    linuxUid: number | null | undefined,
    linuxGid: number | null | undefined,
    cols: number,
    rows: number,
  ): HostTerminalAttachment;
  write(terminalId: string, bytes: Uint8Array): void;
  resize(terminalId: string, cols: number, rows: number): void;
  drain(terminalId: string): TerminalDrainResult;
  kill(terminalId: string): void;
}

export interface HostInteractiveTerminalPort {
  open(context: HostSessionContext): unknown;
  resize(sessionId: string, cols?: number, rows?: number): unknown;
  write(sessionId: string, bytes: Uint8Array): TerminalDrainResult;
  poll(sessionId: string): TerminalDrainResult;
  close(sessionId: string): void;
}

export interface HostIngressPort {
  open(context: HostConnectionContext): HostDecision;
  data(context: HostConnectionContext): HostDecision;
  poll(context: HostConnectionContext): HostDecision;
  close(context: HostConnectionContext): HostDecision;
}

export interface HostTickPort {
  tick(): void;
}

export interface DeviceIdentityPort {
  installationId: string;
  read(userId?: string | null): DeviceIdentityReadResult;
  isBound(userId: string): boolean;
  setBindingState(userId: string, state: "bound" | "unbound"): void;
}

export interface DeviceIdentityReadResult {
  installationId: string;
  synthetic: true;
  persistedAt: string;
  userId: string | null;
  username: string | null;
  bindingState: "bound" | "unbound";
  loginMethods: ["chatgptDeviceCode"];
}

export interface TerminalHostStream {
  kind: "terminal";
  chunks: number;
}

export interface AppServerHostStream {
  kind: "appserver";
  chunks: number;
  connection: VirtualWebSocketConnection;
}

export type HostStream = TerminalHostStream | AppServerHostStream;
