import { ChatDocumentCompiler, type ChatDocumentCompilerOptions } from "../compiler";
import type {
  ChatDocumentCompileCandidate,
  ChatDocumentSnapshot,
  ChatDocumentNode,
} from "../model";
import { reconcileChatDocumentIdentity } from "./identity";
import type { ChatDocumentDialect } from "../preprocess";

export class ChatDocumentStreamingSession {
  private committed: ChatDocumentSnapshot | null = null;
  private nextIdentity = 0;
  private committedParsedNodes: readonly ChatDocumentNode[] = [];
  private committedDialect: ChatDocumentDialect | null = null;

  constructor(
    readonly documentId: string,
    private readonly compiler: ChatDocumentCompiler = new ChatDocumentCompiler(),
  ) {
    if (documentId.length === 0) throw new RangeError("Chat document id must not be empty");
  }

  getSnapshot(): ChatDocumentSnapshot | null {
    return this.committed;
  }

  compile(source: string, options: ChatDocumentCompilerOptions = {}): ChatDocumentCompileCandidate {
    const base = this.committed;
    const dialect = options.dialect ?? "assistant";
    // Returning to a completed document reuses its committed identities and
    // settled segments. Render context (Host, theme, policy) is resolved by the
    // View on every mount; this snapshot contains syntax and identity only.
    if (base !== null && !base.streaming && options.streaming !== true
      && base.source === source && this.committedDialect === dialect) {
      return { snapshot: base, commit: () => {} };
    }
    const parsed = this.compiler.compile(source, options);
    const reconciled = reconcileChatDocumentIdentity(
      this.documentId,
      parsed.nodes,
      base,
      this.nextIdentity,
      options.streaming === true,
      this.committedParsedNodes,
    );
    const snapshot: ChatDocumentSnapshot = {
      documentId: this.documentId,
      revision: (base?.revision ?? 0) + 1,
      source,
      streaming: options.streaming === true,
      nodes: reconciled.nodes,
    };
    let didCommit = false;
    return {
      snapshot,
      commit: () => {
        if (didCommit) return;
        didCommit = true;
        // An abandoned concurrent render cannot overwrite a newer snapshot.
        if (this.committed !== base) return;
        this.committed = snapshot;
        this.committedParsedNodes = parsed.nodes;
        this.committedDialect = dialect;
        this.nextIdentity = reconciled.nextIdentity;
      },
    };
  }
}
