import { Context, Service } from "@deepseek-ai/cordis";
import {
  ChatDocumentCompiler,
  ChatDocumentStreamingSession,
} from "@opencraft/chat-document";

declare module "@deepseek-ai/cordis" {
  interface Context {
    chatDocumentCompiler: ChatDocumentCompilerService;
  }
}

export interface ChatDocumentCompilerServiceConfig {
  readonly maximumSessions?: number;
}

interface SessionEntry {
  readonly session: ChatDocumentStreamingSession;
  lastUsed: number;
}

export class ChatDocumentCompilerService extends Service {
  private readonly compiler = new ChatDocumentCompiler();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly maximumSessions: number;
  private clock = 0;

  constructor(ctx: Context, config: ChatDocumentCompilerServiceConfig = {}) {
    super(ctx, "chatDocumentCompiler");
    this.maximumSessions = Math.max(16, config.maximumSessions ?? 256);
    ctx.effect(() => () => this.clear());
  }

  session(documentId: string): ChatDocumentStreamingSession {
    const existing = this.sessions.get(documentId);
    if (existing !== undefined) {
      existing.lastUsed = ++this.clock;
      return existing.session;
    }
    const session = new ChatDocumentStreamingSession(documentId, this.compiler);
    this.sessions.set(documentId, { session, lastUsed: ++this.clock });
    this.prune();
    return session;
  }

  release(documentId: string): void {
    const entry = this.sessions.get(documentId);
    if (entry !== undefined) entry.lastUsed = ++this.clock;
  }

  clear(documentId?: string): void {
    if (documentId === undefined) {
      this.sessions.clear();
      this.compiler.clearCaches();
    } else {
      this.sessions.delete(documentId);
    }
  }

  private prune(): void {
    while (this.sessions.size > this.maximumSessions) {
      let oldestId: string | null = null;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.sessions) {
        if (entry.lastUsed < oldestUse) {
          oldestId = id;
          oldestUse = entry.lastUsed;
        }
      }
      if (oldestId === null) return;
      this.sessions.delete(oldestId);
    }
  }
}
