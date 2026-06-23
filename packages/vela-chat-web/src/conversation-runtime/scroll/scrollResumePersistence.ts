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
  scrollAnchor,
}: {
  hasPendingResumeState: boolean;
  isHistoryReady: boolean;
  measurement: Pick<
    BottomAnchorMeasurementState,
    "bottomInsetPx" | "contentHeight" | "scrollTop" | "viewportHeight"
  > | null;
  routeKey: string | null;
  scrollAnchor?: ConversationScrollResumeState["anchor"] | null;
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
  const followOutput = isBottomAnchorMeasurementNearBottom(measurement);
  return {
    routeKey,
    scrollTop: Math.min(Math.max(0, scrollTop), maxScrollTop),
    followOutput,
    ...(!followOutput && scrollAnchor ? { anchor: scrollAnchor } : {}),
  };
}

export function shouldWriteConversationScrollLeaveSnapshot({
  existingState,
  nextState,
}: {
  existingState: ConversationScrollResumeState | null;
  nextState: ConversationScrollResumeState | null;
}): boolean {
  if (!nextState) return false;

  if (
    existingState &&
    existingState.routeKey === nextState.routeKey &&
    !existingState.followOutput &&
    nextState.followOutput
  ) {
    return false;
  }

  return true;
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
