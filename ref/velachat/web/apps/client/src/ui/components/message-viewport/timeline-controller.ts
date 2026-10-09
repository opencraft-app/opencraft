export interface TimelineState {
  conversationKey: string;
  following: boolean;
  messageIds: string[];
  scrollRequest: number;
  unseenCount: number;
}

export type TimelineEvent =
  | {
      conversationKey: string;
      messageIds: string[];
      type: "messages_changed";
    }
  | {distanceFromEnd: number; type: "viewport_changed"}
  | {type: "jump_to_latest"};

export const FOLLOW_LATEST_THRESHOLD = 96;

export function createTimelineState(
  conversationKey: string,
  messageIds: string[],
): TimelineState {
  return {
    conversationKey,
    following: true,
    messageIds,
    scrollRequest: messageIds.length > 0 ? 1 : 0,
    unseenCount: 0,
  };
}

export function reduceTimeline(
  state: TimelineState,
  event: TimelineEvent,
): TimelineState {
  if (event.type === "viewport_changed") {
    const following = event.distanceFromEnd <= FOLLOW_LATEST_THRESHOLD;
    if (following === state.following && (!following || state.unseenCount === 0)) {
      return state;
    }
    return {
      ...state,
      following,
      unseenCount: following ? 0 : state.unseenCount,
    };
  }

  if (event.type === "jump_to_latest") {
    return {
      ...state,
      following: true,
      scrollRequest: state.scrollRequest + 1,
      unseenCount: 0,
    };
  }

  if (event.conversationKey !== state.conversationKey) {
    return {
      ...createTimelineState(event.conversationKey, event.messageIds),
      scrollRequest: state.scrollRequest + (event.messageIds.length > 0 ? 1 : 0),
    };
  }

  if (sameIds(state.messageIds, event.messageIds)) return state;
  const appendedCount = countAppendedMessages(
    state.messageIds,
    event.messageIds,
  );
  return {
    ...state,
    messageIds: event.messageIds,
    scrollRequest:
      state.following && appendedCount > 0
        ? state.scrollRequest + 1
        : state.scrollRequest,
    unseenCount:
      state.following || appendedCount === 0
        ? state.unseenCount
        : state.unseenCount + appendedCount,
  };
}

export function countAppendedMessages(
  previousIds: string[],
  nextIds: string[],
): number {
  if (previousIds.length === 0) return nextIds.length;
  const previousLastId = previousIds[previousIds.length - 1]!;
  const previousLastIndex = nextIds.lastIndexOf(previousLastId);
  if (previousLastIndex < 0) return 0;
  const previous = new Set(previousIds);
  let appended = 0;
  for (const messageId of nextIds.slice(previousLastIndex + 1)) {
    if (!previous.has(messageId)) appended += 1;
  }
  return appended;
}

export function calculatePrependOffset(input: {
  afterContentHeight: number;
  beforeContentHeight: number;
  beforeOffset: number;
  firstMessageChanged: boolean;
}): number | null {
  if (
    !input.firstMessageChanged ||
    input.afterContentHeight <= input.beforeContentHeight
  ) {
    return null;
  }
  return (
    input.beforeOffset +
    input.afterContentHeight -
    input.beforeContentHeight
  );
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((messageId, index) => messageId === right[index])
  );
}
