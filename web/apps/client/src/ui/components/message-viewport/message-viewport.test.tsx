import {act, render} from "@testing-library/react-native";
import {FlatList, Platform, StyleSheet as RNStyleSheet, Text} from "react-native";

import {velaTheme} from "../../tokens";
import {MessageViewport} from "./message-viewport";

const originalPlatformOS = Platform.OS;
const originalRequestAnimationFrame = global.requestAnimationFrame;

describe("MessageViewport", () => {
  beforeEach(() => {
    global.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("reserves the floating composer inset inside the scroll content", async () => {
    const screen = await render(
      <MessageViewport
        bottomInset={132}
        conversationKey="channel:general"
        data={["m1"]}
        keyExtractor={(item) => item}
        renderItem={({item}) => <Text>{item}</Text>}
      />,
    );

    expect(
      RNStyleSheet.flatten(
        screen.getByTestId("message-viewport").props.contentContainerStyle,
      ),
    ).toMatchObject({paddingBottom: 132});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: originalPlatformOS,
    });
    global.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it("reapplies the initial latest-message scroll after content is measured", async () => {
    const scrollToEnd = jest
      .spyOn(FlatList.prototype, "scrollToEnd")
      .mockImplementation(() => undefined);
    const screen = await render(
      <MessageViewport
        conversationKey="channel:general"
        data={["m1", "m2", "m3"]}
        keyExtractor={(item) => item}
        renderItem={({item}) => <Text>{item}</Text>}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    scrollToEnd.mockClear();

    await act(async () => {
      screen
        .getByTestId("message-viewport")
        .props.onContentSizeChange(320, 339);
      await Promise.resolve();
    });

    expect(scrollToEnd).toHaveBeenCalledWith({animated: false});
    scrollToEnd.mockRestore();
  });

  it("retries the latest-message scroll after an asynchronous first batch paints", async () => {
    let afterPaint: FrameRequestCallback | undefined;
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: "web",
    });
    global.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      afterPaint = callback;
      return 1;
    });
    const scrollToEnd = jest
      .spyOn(FlatList.prototype, "scrollToEnd")
      .mockImplementation(() => undefined);
    const scrollToOffset = jest
      .spyOn(FlatList.prototype, "scrollToOffset")
      .mockImplementation(() => undefined);
    const renderViewport = (data: string[]) => (
      <MessageViewport
        conversationKey="channel:general"
        data={data}
        keyExtractor={(item) => item}
        renderItem={({item}) => <Text>{item}</Text>}
      />
    );
    const screen = await render(renderViewport([]));

    scrollToEnd.mockClear();
    await act(async () => {
      screen.rerender(renderViewport(["m1", "m2", "m3"]));
      await Promise.resolve();
      screen.getByTestId("message-viewport").props.onLayout({
        nativeEvent: {layout: {height: 294}},
      });
      screen
        .getByTestId("message-viewport")
        .props.onContentSizeChange(320, 339);
    });
    scrollToEnd.mockClear();
    scrollToOffset.mockClear();

    await act(async () => {
      afterPaint?.(0);
      await Promise.resolve();
    });

    expect(scrollToOffset).toHaveBeenCalledWith({
      animated: false,
      offset: 45,
    });
  });

  it("cancels a pending post-paint retry when the viewport unmounts", async () => {
    jest.useFakeTimers();
    Object.defineProperty(global, "requestAnimationFrame", {
      configurable: true,
      value: undefined,
    });
    const clearTimeoutSpy = jest.spyOn(global, "clearTimeout");
    const renderViewport = (data: string[]) => (
      <MessageViewport
        conversationKey="channel:general"
        data={data}
        keyExtractor={(item) => item}
        renderItem={({item}) => <Text>{item}</Text>}
      />
    );
    const screen = await render(renderViewport([]));

    await act(async () => {
      screen.rerender(renderViewport(["m1"]));
      await Promise.resolve();
    });
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await act(async () => screen.unmount());

    expect(clearTimeoutSpy).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("renders unseen messages as a compact HeroUI floating control", async () => {
    const renderViewport = (data: string[]) => (
      <MessageViewport
        bottomInset={132}
        conversationKey="channel:general"
        data={data}
        keyExtractor={(item) => item}
        renderItem={({item}) => <Text>{item}</Text>}
      />
    );
    const screen = await render(renderViewport(["m1"]));

    await act(async () => {
      screen.getByTestId("message-viewport").props.onScroll({
        nativeEvent: {
          contentOffset: {y: 0},
          contentSize: {height: 500},
          layoutMeasurement: {height: 200},
        },
      });
      screen.rerender(renderViewport(["m1", "m2"]));
      await Promise.resolve();
    });

    expect(
      screen.getByRole("button", {name: "查看 1 条新消息"}),
    ).toHaveStyle({
      backgroundColor: "#FFFFFF",
      borderRadius: 9999,
      height: velaTheme.recipes.iconControl.floatingSize,
      width: velaTheme.recipes.iconControl.floatingSize,
    });
    expect(screen.getByTestId("new-messages-badge")).toHaveStyle({
      backgroundColor: "#006FEE",
      borderRadius: 9999,
    });
    expect(screen.getByText("1")).toHaveStyle({color: "#FFFFFF"});
    expect(screen.getByTestId("new-messages-button")).toHaveStyle({
      bottom: 132 + velaTheme.spacing.lg,
    });
  });

  it("scrolls a requested search result into the middle of the viewport", async () => {
    const scrollToIndex = jest
      .spyOn(FlatList.prototype, "scrollToIndex")
      .mockImplementation(() => undefined);

    await render(
      <MessageViewport
        conversationKey="channel:general"
        data={["m1", "m2", "m3"]}
        focusRequest={{key: "m2", revision: 1}}
        keyExtractor={(item) => item}
        renderItem={({item}) => <Text>{item}</Text>}
      />,
    );

    expect(scrollToIndex).toHaveBeenCalledWith({
      animated: true,
      index: 1,
      viewPosition: 0.45,
    });
  });

  it("estimates the target offset and retries when the focused row is not measured", async () => {
    let afterPaint: FrameRequestCallback | undefined;
    global.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      afterPaint = callback;
      return 1;
    });
    const scrollToIndex = jest
      .spyOn(FlatList.prototype, "scrollToIndex")
      .mockImplementation(() => undefined);
    const scrollToOffset = jest
      .spyOn(FlatList.prototype, "scrollToOffset")
      .mockImplementation(() => undefined);
    const screen = await render(
      <MessageViewport
        conversationKey="channel:general"
        data={["m1", "m2", "m3"]}
        focusRequest={{key: "m3", revision: 1}}
        keyExtractor={(item) => item}
        renderItem={({item}) => <Text>{item}</Text>}
      />,
    );
    scrollToIndex.mockClear();

    await act(async () => {
      screen.getByTestId("message-viewport").props.onScrollToIndexFailed({
        averageItemLength: 72,
        highestMeasuredFrameIndex: 0,
        index: 2,
      });
      await Promise.resolve();
    });

    expect(scrollToOffset).toHaveBeenCalledWith({
      animated: false,
      offset: 144,
    });
    await act(async () => {
      afterPaint?.(0);
      await Promise.resolve();
    });
    expect(scrollToIndex).toHaveBeenCalledWith({
      animated: true,
      index: 2,
      viewPosition: 0.45,
    });
  });
});
