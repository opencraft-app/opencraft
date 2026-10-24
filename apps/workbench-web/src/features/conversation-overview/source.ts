import type { AppServerProtocolResourcePort } from "@opencraft/workbench-runtime";
import { recentTurnPreviews, type RecentTurnPreview } from "./model";

export interface ConversationOverviewSource {
  readonly key: string;
  readonly hostId: string;
  readonly available: boolean;
  readonly supported: boolean;
  read(threadId: string, signal: AbortSignal): Promise<readonly RecentTurnPreview[]>;
}

/** Two read lanes per admitted Host. Aborted queued work never reaches the protocol. */
export function createPreviewReadLimiter() {
  const lanes: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
  let next = 0;
  return <T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> => {
    const lane = next++ % lanes.length;
    const result = lanes[lane]!.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const value = await read();
      signal.throwIfAborted();
      return value;
    });
    lanes[lane] = result;
    return result;
  };
}

export function createConversationOverviewSource(input: {
  readonly key: string;
  readonly hostId: string;
  readonly available: boolean;
  readonly supported: boolean;
  readonly assertCurrent: () => void;
  readonly protocol: AppServerProtocolResourcePort;
}): ConversationOverviewSource {
  const limit = createPreviewReadLimiter();
  return {
    key: input.key, hostId: input.hostId, available: input.available, supported: input.supported,
    read: (threadId, signal) => limit(signal, async () => {
      input.assertCurrent();
      if (!input.available || !input.supported) throw new Error("Conversation preview is unavailable");
      const page = await input.protocol.request("thread/turns/list", {
        threadId, cursor: null, sortDirection: "desc", limit: 2, itemsView: "summary",
      });
      input.assertCurrent();
      return recentTurnPreviews(page.data);
    }),
  };
}
