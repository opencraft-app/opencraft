/**
 * Presentation independent policy for revalidating a visible conversation.
 * Platform adapters report foreground and connectivity changes. The Host
 * runtime remains the only authority for the resulting history.
 */
export interface ConversationReturnProbe {
  background(now: number): void;
  foreground(now: number): boolean;
  offline(): void;
  online(now: number): boolean;
}

export function createConversationReturnProbe(input: {
  readonly minimumBackgroundMs?: number;
  readonly minimumProbeIntervalMs?: number;
} = {}): ConversationReturnProbe {
  const minimumBackgroundMs = input.minimumBackgroundMs ?? 15_000;
  const minimumProbeIntervalMs = input.minimumProbeIntervalMs ?? 5_000;
  let backgroundAt: number | null = null;
  let disconnected = false;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  const admit = (now: number) => {
    if (now - lastProbeAt < minimumProbeIntervalMs) return false;
    lastProbeAt = now;
    return true;
  };
  return {
    background(now) { backgroundAt = now; },
    foreground(now) {
      const duration = backgroundAt === null ? 0 : Math.max(0, now - backgroundAt);
      backgroundAt = null;
      if (disconnected || duration < minimumBackgroundMs) return false;
      return admit(now);
    },
    offline() { disconnected = true; },
    online(now) {
      if (!disconnected) return false;
      disconnected = false;
      return admit(now);
    },
  };
}
