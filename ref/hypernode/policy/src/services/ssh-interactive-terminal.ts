import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  HostInteractiveTerminalPort,
  HostSessionContext,
  HostTerminalAttachment,
  HostUserRecord,
  TerminalDrainResult,
} from "../types/host-policy.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  ThreadWriteLeaseConnection,
} from "../types/thread-lifecycle.ts";
import type {
  HostWorkspacesPort,
} from "../types/workspace.ts";

type TerminalBackend = "workspace-v2" | "host-terminal";

interface InteractiveTerminalSession {
  readonly id: string;
  readonly sessionId: string;
  readonly user: HostUserRecord;
  cwd: string;
  readonly shell: string;
  readonly leaseThreadId: string;
  readonly leaseConnection: ThreadWriteLeaseConnection;
  readonly backend: TerminalBackend;
  exited: boolean;
}

interface TerminalReadResult {
  sessions: Array<{
    sessionId: string;
    username: string;
    cwd: string;
    shell: string;
  }>;
}

function terminalId(sessionId: string): string {
  return `terminal-${sessionId}`;
}

function requireWorkspaceHost(): HostWorkspacesPort {
  const host = globalThis.hostWorkspaces;
  if (host === undefined) throw new Error("Workspace v2 host is unavailable");
  return host;
}

type Dependencies =
  | "appServer"
  | "threadWriteLease"
  | "userDirectory"
  | "workspaceFilesystem"
  | "workspaceView";

export class SshInteractiveTerminalService extends Service implements HostInteractiveTerminalPort {
  static inject = [
    "appServer",
    "threadWriteLease",
    "userDirectory",
    "workspaceFilesystem",
    "workspaceView",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  private readonly sessions = new Map<string, InteractiveTerminalSession>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "sshInteractiveTerminal");
    ctx.effect(() => ctx.appServer.register("hypernode/terminal/read", (): TerminalReadResult => ({
      sessions: [...this.sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        username: session.user.username,
        cwd: session.cwd,
        shell: session.shell,
      })),
    })));
  }

  open({ connectionId, sessionId, cols = 80, rows = 24 }: HostSessionContext): InteractiveTerminalSession {
    const user = this.ctx.userDirectory.identityForConnection(connectionId);
    if (user?.username === undefined || user.username.length === 0) {
      throw new Error("terminal requires an authenticated SSH identity");
    }
    const key = String(sessionId);
    const id = terminalId(key);
    const leaseThreadId = `terminal:${key}`;
    const leaseConnection: ThreadWriteLeaseConnection = {
      connectionId,
      identity: { id: user.id, username: user.username },
    };
    let attached: HostTerminalAttachment;
    if (this.ctx.workspaceFilesystem.enabled) {
      this.ctx.workspaceView.bindLeaseAlias(leaseThreadId, "main");
      const lease = this.ctx.threadWriteLease.acquire(leaseThreadId, leaseConnection, "running");
      if (!lease.acquired) {
        this.ctx.workspaceView.unbindLeaseAlias(leaseThreadId);
        throw this.ctx.threadWriteLease.errorFor(lease.lease);
      }
      try {
        const workspace = this.ctx.workspaceFilesystem.attachmentFor("main");
        if (workspace === null || workspace.capabilityId === null) {
          throw new Error("Workspace v2 root attachment is unavailable");
        }
        attached = requireWorkspaceHost().openTerminal(id, workspace.capabilityId, cols, rows);
      } catch (error) {
        this.ctx.threadWriteLease.release(leaseThreadId, leaseConnection);
        this.ctx.workspaceView.unbindLeaseAlias(leaseThreadId);
        throw error;
      }
    } else {
      attached = globalThis.hostTerminal.spawnForUser(
        id,
        user.username,
        ".",
        user.linuxUid,
        user.linuxGid,
        cols,
        rows,
      );
    }
    const session: InteractiveTerminalSession = {
      id,
      sessionId: key,
      user,
      cwd: attached.cwd,
      shell: attached.shell,
      leaseThreadId,
      leaseConnection,
      backend: this.ctx.workspaceFilesystem.v2 ? "workspace-v2" : "host-terminal",
      exited: false,
    };
    this.sessions.set(key, session);
    return session;
  }

  write(sessionId: string, dataBytes: Uint8Array): TerminalDrainResult {
    const session = this.require(sessionId);
    if (session.backend === "workspace-v2") {
      requireWorkspaceHost().writeTerminal(session.id, dataBytes);
    } else {
      globalThis.hostTerminal.write(session.id, dataBytes);
    }
    return this.drain(session);
  }

  resize(sessionId: string, cols = 80, rows = 24): Record<string, never> {
    const session = this.require(sessionId);
    if (session.backend === "workspace-v2") {
      requireWorkspaceHost().resizeTerminal(session.id, cols || 80, rows || 24);
    } else {
      globalThis.hostTerminal.resize(session.id, cols || 80, rows || 24);
    }
    return {};
  }

  poll(sessionId: string): TerminalDrainResult {
    return this.drain(this.require(sessionId));
  }

  close(sessionId: string): void {
    const key = String(sessionId);
    const session = this.sessions.get(key);
    if (session === undefined) return;
    this.sessions.delete(key);
    if (session.backend === "workspace-v2") {
      requireWorkspaceHost().closeTerminal(session.id);
    } else {
      globalThis.hostTerminal.kill(session.id);
    }
    if (this.ctx.workspaceFilesystem.enabled) {
      this.ctx.threadWriteLease.release(session.leaseThreadId, session.leaseConnection);
      this.ctx.workspaceView.unbindLeaseAlias(session.leaseThreadId);
    }
  }

  private require(sessionId: string): InteractiveTerminalSession {
    const session = this.sessions.get(String(sessionId));
    if (session === undefined) throw new Error(`unknown terminal session ${sessionId}`);
    return session;
  }

  private drain(session: InteractiveTerminalSession): TerminalDrainResult {
    const result = session.backend === "workspace-v2"
      ? requireWorkspaceHost().drainTerminal(session.id)
      : globalThis.hostTerminal.drain(session.id);
    if (result.cwd !== undefined) session.cwd = result.cwd;
    if (result.exited === true) session.exited = true;
    return result;
  }
}
