import { createConversationReturnProbe } from "@opencraft/workbench-runtime/conversation-return-probe";

export interface ConversationLifecycleSnapshot {
  readonly visible: boolean;
  readonly online: boolean;
}

export interface ConversationLifecycleSource {
  getSnapshot(): ConversationLifecycleSnapshot;
  subscribe(listener: (snapshot: ConversationLifecycleSnapshot) => void): () => void;
}

export function bindConversationReturnLifecycle(input: {
  readonly source: ConversationLifecycleSource;
  readonly getRuntime: () => { getSnapshot(): { readonly phase: string }; requestRecovery?(): void };
  readonly getLease: () => { setRecoveryVisibility(visible: boolean): void; retryRestore(): Promise<void> } | null;
  readonly now?: () => number;
}): () => void {
  const probe = createConversationReturnProbe();
  const now = input.now ?? Date.now;
  let disposed = false;
  let previous = input.source.getSnapshot();
  let wasOffline = !previous.online;
  if (!previous.visible) probe.background(now());
  if (wasOffline) probe.offline();
  input.getLease()?.setRecoveryVisibility(previous.visible && previous.online);
  const recover = () => {
    if (disposed || !previous.visible || !previous.online) return;
    const runtime = input.getRuntime();
    if (runtime.getSnapshot().phase !== "ready") {
      runtime.requestRecovery?.();
      return;
    }
    void input
      .getLease()
      ?.retryRestore()
      .catch(() => undefined);
  };
  const stop = input.source.subscribe((snapshot) => {
    if (disposed) return;
    const changedVisibility = previous.visible !== snapshot.visible;
    previous = snapshot;
    input.getLease()?.setRecoveryVisibility(snapshot.visible && snapshot.online);
    if (!snapshot.online) {
      wasOffline = true;
      probe.offline();
    }
    if (changedVisibility && !snapshot.visible) probe.background(now());
    if (!snapshot.visible || !snapshot.online) return;
    const networkRecovery = wasOffline;
    const admitted = networkRecovery ? probe.online(now()) : changedVisibility && probe.foreground(now());
    wasOffline = false;
    if (networkRecovery && changedVisibility) probe.foreground(now());
    if (admitted) recover();
  });
  return () => {
    disposed = true;
    stop();
    input.getLease()?.setRecoveryVisibility(false);
  };
}
