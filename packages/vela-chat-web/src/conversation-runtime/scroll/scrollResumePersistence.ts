import { isBottomAnchorMeasurementNearBottom } from "./bottomAnchorDriver";
import type { BottomAnchorMeasurementState } from "./bottomAnchorDriver";
import type { ConversationScrollResumeState } from "./routeResume";

export interface ConversationScrollResumeWriter<FrameHandle = number> {
  cancel: () => void;
  flush: () => void;
  schedule: (state: ConversationScrollResumeState) => void;
}

export interface ConversationScrollResumeWriterOptions<FrameHandle = number> {
  cancelFrame: (handle: FrameHandle) => void;
  scheduleFrame: (callback: () => void) => FrameHandle;
  write: (state: ConversationScrollResumeState) => void;
}

export function shouldPersistConversationScrollResumeSnapshot({
  hasPendingResumeState,
  isHistoryReady,
  routeKey,
}: {
  hasPendingResumeState: boolean;
  isHistoryReady: boolean;
  routeKey: string | null;
}): boolean {
  return Boolean(routeKey && isHistoryReady && !hasPendingResumeState);
}

export function deriveConversationScrollLeaveSnapshot({
  hasPendingResumeState,
  isHistoryReady,
  measurement,
  routeKey,
}: {
  hasPendingResumeState: boolean;
  isHistoryReady: boolean;
  measurement: Pick<
    BottomAnchorMeasurementState,
    "bottomInsetPx" | "contentHeight" | "scrollTop" | "viewportHeight"
  > | null;
  routeKey: string | null;
}): ConversationScrollResumeState | null {
  if (
    !shouldPersistConversationScrollResumeSnapshot({
      hasPendingResumeState,
      isHistoryReady,
      routeKey,
    }) ||
    !routeKey ||
    !measurement
  ) {
    return null;
  }

  const { bottomInsetPx, contentHeight, scrollTop, viewportHeight } = measurement;
  if (
    ![bottomInsetPx, contentHeight, scrollTop, viewportHeight].every(
      Number.isFinite,
    )
  ) {
    return null;
  }
  if (contentHeight <= 0 || viewportHeight <= 0) return null;

  const maxScrollTop = Math.max(
    0,
    contentHeight + Math.max(0, bottomInsetPx) - viewportHeight,
  );
  return {
    routeKey,
    scrollTop: Math.min(Math.max(0, scrollTop), maxScrollTop),
    followOutput: isBottomAnchorMeasurementNearBottom(measurement),
  };
}

export function createConversationScrollResumeWriter<FrameHandle = number>({
  cancelFrame,
  scheduleFrame,
  write,
}: ConversationScrollResumeWriterOptions<FrameHandle>): ConversationScrollResumeWriter<FrameHandle> {
  let frameHandle: FrameHandle | null = null;
  let latestState: ConversationScrollResumeState | null = null;

  const cancelFrameIfNeeded = () => {
    if (frameHandle === null) return;
    cancelFrame(frameHandle);
    frameHandle = null;
  };

  const writeLatest = () => {
    const state = latestState;
    latestState = null;
    if (state) write(state);
  };

  return {
    cancel() {
      latestState = null;
      cancelFrameIfNeeded();
    },
    flush() {
      cancelFrameIfNeeded();
      writeLatest();
    },
    schedule(state) {
      latestState = state;
      if (frameHandle !== null) return;
      frameHandle = scheduleFrame(() => {
        frameHandle = null;
        writeLatest();
      });
    },
  };
}
