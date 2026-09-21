import { ChatDocumentCompiler, type ChatDocumentCompilerOptions } from "../compiler";
import type {
  ChatDocumentCompileCandidate,
  ChatDocumentSnapshot,
} from "../model";
import { reconcileChatDocumentIdentity } from "./identity";

export class ChatDocumentStreamingSession {
  private committed: ChatDocumentSnapshot | null = null;
  private nextIdentity = 0;

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
    const parsed = this.compiler.compile(source, options);
    const reconciled = reconcileChatDocumentIdentity(
      this.documentId,
      parsed.nodes,
      base,
      this.nextIdentity,
      options.streaming === true,
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
        this.nextIdentity = reconciled.nextIdentity;
      },
    };
  }
}
