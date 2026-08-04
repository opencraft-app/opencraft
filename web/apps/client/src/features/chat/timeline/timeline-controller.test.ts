import * as timelineController from "./timeline-controller";

describe("timeline controller", () => {
  it("does not count prepended history as unseen live messages", () => {
    let state = timelineController.createTimelineState("channel:one", [
      "m2",
      "m3",
    ]);
    state = timelineController.reduceTimeline(state, {
      distanceFromEnd: 500,
      type: "viewport_changed",
    });

    state = timelineController.reduceTimeline(state, {
      conversationKey: "channel:one",
      messageIds: ["m1", "m2", "m3"],
      type: "messages_changed",
    });

    expect(state.unseenCount).toBe(0);
    expect(state.following).toBe(false);
  });

  it("counts appended messages until the reader jumps to latest", () => {
    let state = timelineController.createTimelineState("channel:one", [
      "m1",
    ]);
    state = timelineController.reduceTimeline(state, {
      distanceFromEnd: 500,
      type: "viewport_changed",
    });
    state = timelineController.reduceTimeline(state, {
      conversationKey: "channel:one",
      messageIds: ["m1", "m2", "m3"],
      type: "messages_changed",
    });

    expect(state.unseenCount).toBe(2);
    state = timelineController.reduceTimeline(state, {
      type: "jump_to_latest",
    });
    expect(state.unseenCount).toBe(0);
    expect(state.following).toBe(true);
  });

  it("requests a follow scroll when messages append at the live edge", () => {
    const initial = timelineController.createTimelineState("channel:one", [
      "m1",
    ]);
    const state = timelineController.reduceTimeline(initial, {
      conversationKey: "channel:one",
      messageIds: ["m1", "m2"],
      type: "messages_changed",
    });

    expect(state.scrollRequest).toBe(initial.scrollRequest + 1);
    expect(state.unseenCount).toBe(0);
  });

  it("does not treat an in-place message status update as new", () => {
    const initial = timelineController.createTimelineState("channel:one", [
      "m1",
      "m2",
    ]);
    const state = timelineController.reduceTimeline(initial, {
      conversationKey: "channel:one",
      messageIds: ["m1", "m2"],
      type: "messages_changed",
    });

    expect(state).toBe(initial);
  });

  it("resets unseen state when the conversation generation changes", () => {
    let state = timelineController.createTimelineState("channel:one", [
      "m1",
    ]);
    state = timelineController.reduceTimeline(state, {
      distanceFromEnd: 500,
      type: "viewport_changed",
    });
    state = timelineController.reduceTimeline(state, {
      conversationKey: "channel:one",
      messageIds: ["m1", "m2"],
      type: "messages_changed",
    });

    state = timelineController.reduceTimeline(state, {
      conversationKey: "direct:agent-two",
      messageIds: ["dm1"],
      type: "messages_changed",
    });

    expect(state.conversationKey).toBe("direct:agent-two");
    expect(state.following).toBe(true);
    expect(state.unseenCount).toBe(0);
  });

  it("computes the Web offset needed to preserve a prepended anchor", () => {
    const calculatePrependOffset = (
      timelineController as Record<string, unknown>
    ).calculatePrependOffset as
      | ((input: {
          afterContentHeight: number;
          beforeContentHeight: number;
          beforeOffset: number;
          firstMessageChanged: boolean;
        }) => number | null)
      | undefined;

    expect(calculatePrependOffset).toEqual(expect.any(Function));
    expect(
      calculatePrependOffset?.({
        afterContentHeight: 1_400,
        beforeContentHeight: 1_000,
        beforeOffset: 160,
        firstMessageChanged: true,
      }),
    ).toBe(560);
    expect(
      calculatePrependOffset?.({
        afterContentHeight: 1_400,
        beforeContentHeight: 1_000,
        beforeOffset: 160,
        firstMessageChanged: false,
      }),
    ).toBeNull();
  });
});
