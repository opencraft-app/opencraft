import type {
  BotChatWriteAuthority,
  BotChatWriteAuthoritySnapshot,
} from "@opencraft/plugin-bot-chat";

/** Single write lease shared by the host switch and the embedded Composer. */
export class EmbeddedChatWriteAuthority implements BotChatWriteAuthority {
  private snapshot: BotChatWriteAuthoritySnapshot = Object.freeze({ writable: false });
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): BotChatWriteAuthoritySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setWritable(writable: boolean): void {
    if (this.snapshot.writable === writable) return;
    this.snapshot = Object.freeze({ writable });
    for (const listener of this.listeners) listener();
  }
}
