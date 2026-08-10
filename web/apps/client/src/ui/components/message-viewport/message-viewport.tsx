import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type ReactElement,
} from "react";
import {
  FlatList,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import ArrowDown from "lucide-react-native/icons/arrow-down";

import { velaTheme } from "../../tokens";

import {
  calculatePrependOffset,
  createTimelineState,
  reduceTimeline,
} from "./timeline-controller";

const INITIAL_RENDER_COUNT = 24;
const MAX_RENDER_BATCH = 16;
const RENDER_WINDOW_SIZE = 9;

interface PendingPrependAnchor {
  beforeContentHeight: number;
  beforeOffset: number;
  conversationKey: string;
  firstMessageId: string | undefined;
}

export interface MessageViewportProps<Item> {
  bottomInset?: number;
  conversationKey: string;
  contentContainerStyle?: StyleProp<ViewStyle>;
  data: Item[];
  empty?: ReactElement | null;
  focusRequest?: { key: string; revision: number } | null;
  header?(onLoadOlder: () => void): ReactElement | null;
  keyExtractor(item: Item): string;
  loadingOlder?: boolean;
  onLoadOlder?(): void | Promise<void>;
  renderItem: ListRenderItem<Item>;
  style?: StyleProp<ViewStyle>;
}

export function MessageViewport<Item>({
  bottomInset = 0,
  conversationKey,
  contentContainerStyle,
  data,
  empty,
  focusRequest = null,
  header,
  keyExtractor,
  loadingOlder = false,
  onLoadOlder,
  renderItem,
  style,
}: MessageViewportProps<Item>) {
  const listRef = useRef<FlatList<Item> | null>(null);
  const dataRef = useRef(data);
  const focusRequestRef = useRef(focusRequest);
  const keyExtractorRef = useRef(keyExtractor);
  const pendingFocusRetryRef = useRef<(() => void) | null>(null);
  dataRef.current = data;
  focusRequestRef.current = focusRequest;
  keyExtractorRef.current = keyExtractor;
  const loadingOlderRef = useRef(false);
  const contentHeightRef = useRef(0);
  const offsetRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const pendingPrependAnchorRef = useRef<PendingPrependAnchor | null>(null);
  const messageIds = data.map(keyExtractor);
  const firstMessageId = messageIds[0];
  const currentFirstMessageIdRef = useRef(firstMessageId);
  currentFirstMessageIdRef.current = firstMessageId;
  const [timeline, dispatch] = useReducer(
    reduceTimeline,
    createTimelineState(conversationKey, messageIds),
  );
  const scrollToLatest = useCallback((animated: boolean) => {
    if (
      Platform.OS === "web" &&
      contentHeightRef.current > 0 &&
      viewportHeightRef.current > 0
    ) {
      const offset = Math.max(
        0,
        contentHeightRef.current - viewportHeightRef.current,
      );
      listRef.current?.scrollToOffset({ animated, offset });
      offsetRef.current = offset;
      return;
    }
    listRef.current?.scrollToEnd({ animated });
  }, []);

  useEffect(() => {
    dispatch({
      conversationKey,
      messageIds,
      type: "messages_changed",
    });
  }, [conversationKey, data]);

  useEffect(() => {
    const anchor = pendingPrependAnchorRef.current;
    if (anchor && anchor.conversationKey !== conversationKey) {
      pendingPrependAnchorRef.current = null;
    }
  }, [conversationKey]);

  useEffect(() => {
    if (timeline.scrollRequest === 0) return;
    const animated = timeline.scrollRequest > 1;
    let cancelled = false;
    scrollToLatest(animated);
    const cancelAfterPaint = requestAfterPaint(() => {
      if (!cancelled) scrollToLatest(animated);
    });
    return () => {
      cancelled = true;
      cancelAfterPaint();
    };
  }, [conversationKey, scrollToLatest, timeline.scrollRequest]);

  useEffect(() => {
    if (!focusRequest) return;
    const index = dataRef.current.findIndex(
      (item) => keyExtractorRef.current(item) === focusRequest.key,
    );
    if (index < 0) return;
    dispatch({
      distanceFromEnd: Number.POSITIVE_INFINITY,
      type: "viewport_changed",
    });
    const scroll = () =>
      listRef.current?.scrollToIndex({
        animated: true,
        index,
        viewPosition: 0.45,
      });
    scroll();
    pendingFocusRetryRef.current?.();
    const cancelRetry = requestAfterPaint(scroll);
    pendingFocusRetryRef.current = cancelRetry;
    return () => {
      cancelRetry();
      if (pendingFocusRetryRef.current === cancelRetry) {
        pendingFocusRetryRef.current = null;
      }
    };
  }, [conversationKey, focusRequest?.key, focusRequest?.revision]);

  useEffect(
    () => () => {
      pendingFocusRetryRef.current?.();
      pendingFocusRetryRef.current = null;
    },
    [],
  );

  const handleLoadOlder = useCallback(() => {
    if (loadingOlder || loadingOlderRef.current || !onLoadOlder) return;
    loadingOlderRef.current = true;
    if (Platform.OS === "web") {
      pendingPrependAnchorRef.current = {
        beforeContentHeight: contentHeightRef.current,
        beforeOffset: offsetRef.current,
        conversationKey,
        firstMessageId: currentFirstMessageIdRef.current,
      };
    }
    try {
      void Promise.resolve(onLoadOlder())
        .catch(() => undefined)
        .finally(() => {
          loadingOlderRef.current = false;
          const anchor = pendingPrependAnchorRef.current;
          if (!anchor) return;
          requestAfterPaint(() => {
            if (
              pendingPrependAnchorRef.current === anchor &&
              currentFirstMessageIdRef.current === anchor.firstMessageId &&
              contentHeightRef.current === anchor.beforeContentHeight
            ) {
              pendingPrependAnchorRef.current = null;
            }
          });
        });
    } catch {
      loadingOlderRef.current = false;
      pendingPrependAnchorRef.current = null;
    }
  }, [conversationKey, loadingOlder, onLoadOlder]);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent;
      offsetRef.current = contentOffset.y;
      contentHeightRef.current = contentSize.height;
      dispatch({
        distanceFromEnd: Math.max(
          0,
          contentSize.height - (contentOffset.y + layoutMeasurement.height),
        ),
        type: "viewport_changed",
      });
    },
    [],
  );
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    viewportHeightRef.current = event.nativeEvent.layout.height;
  }, []);
  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeightRef.current = height;
      if (Platform.OS === "web") {
        const anchor = pendingPrependAnchorRef.current;
        if (anchor?.conversationKey === conversationKey) {
          const offset = calculatePrependOffset({
            afterContentHeight: height,
            beforeContentHeight: anchor.beforeContentHeight,
            beforeOffset: anchor.beforeOffset,
            firstMessageChanged: firstMessageId !== anchor.firstMessageId,
          });
          if (offset !== null) {
            listRef.current?.scrollToOffset({ animated: false, offset });
            offsetRef.current = offset;
            pendingPrependAnchorRef.current = null;
            return;
          }
        }
      }
      if (timeline.following && timeline.scrollRequest > 0) {
        scrollToLatest(timeline.scrollRequest > 1);
      }
    },
    [
      conversationKey,
      firstMessageId,
      scrollToLatest,
      timeline.following,
      timeline.scrollRequest,
    ],
  );
  const handleScrollToIndexFailed = useCallback(
    (info: { averageItemLength: number; index: number }) => {
      const request = focusRequestRef.current;
      if (!request) return;
      const targetIndex = dataRef.current.findIndex(
        (item) => keyExtractorRef.current(item) === request.key,
      );
      if (targetIndex < 0) return;
      listRef.current?.scrollToOffset({
        animated: false,
        offset: Math.max(0, info.averageItemLength * targetIndex),
      });
      pendingFocusRetryRef.current?.();
      const cancelRetry = requestAfterPaint(() => {
        listRef.current?.scrollToIndex({
          animated: true,
          index: targetIndex,
          viewPosition: 0.45,
        });
      });
      pendingFocusRetryRef.current = cancelRetry;
    },
    [],
  );

  return (
    <View style={[styles.container, style]}>
      <FlatList
        contentContainerStyle={[
          contentContainerStyle,
          bottomInset > 0 ? {paddingBottom: bottomInset} : undefined,
        ]}
        data={data}
        initialNumToRender={INITIAL_RENDER_COUNT}
        keyExtractor={keyExtractor}
        ListEmptyComponent={empty}
        ListHeaderComponent={header?.(handleLoadOlder)}
        maintainVisibleContentPosition={
          Platform.OS === "web" ? undefined : { minIndexForVisible: 0 }
        }
        maxToRenderPerBatch={MAX_RENDER_BATCH}
        onContentSizeChange={handleContentSizeChange}
        onLayout={handleLayout}
        onScroll={handleScroll}
        onScrollToIndexFailed={handleScrollToIndexFailed}
        ref={listRef}
        renderItem={renderItem}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        style={styles.list}
        testID="message-viewport"
        windowSize={RENDER_WINDOW_SIZE}
      />
      {timeline.unseenCount > 0 ? (
        <Pressable
          accessibilityLabel={`查看 ${timeline.unseenCount} 条新消息`}
          accessibilityRole="button"
          onPress={() => dispatch({ type: "jump_to_latest" })}
          style={({ pressed }) => [
            styles.newMessages,
            bottomInset > 0
              ? {bottom: bottomInset + velaTheme.spacing.lg}
              : undefined,
            pressed && styles.newMessagesPressed,
          ]}
          testID="new-messages-button"
        >
          <ArrowDown
            color={velaTheme.semantic.color.iconAccent}
            size={velaTheme.semantic.icon.size.large}
            strokeWidth={velaTheme.semantic.icon.stroke.strong}
          />
          <View
            pointerEvents="none"
            style={styles.newMessagesBadge}
            testID="new-messages-badge"
          >
            <Text style={styles.newMessagesBadgeText}>
              {timeline.unseenCount > 99 ? "99+" : timeline.unseenCount}
            </Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  list: {
    flex: 1,
  },
  newMessages: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.overlaySurface,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.circle,
    borderWidth: theme.semantic.stroke.hairline,
    bottom: theme.spacing.lg,
    height: theme.recipes.iconControl.floatingSize,
    justifyContent: "center",
    position: "absolute",
    right: theme.spacing.lg,
    elevation: theme.semantic.elevation.overlay,
    shadowColor: theme.shadows.overlay.color,
    shadowOffset: { height: theme.shadows.overlay.offsetY, width: 0 },
    shadowOpacity: theme.shadows.overlay.opacity,
    shadowRadius: theme.shadows.overlay.radius,
    width: theme.recipes.iconControl.floatingSize,
    ...theme.semantic.motion.transition.control,
  },
  newMessagesPressed: {
    backgroundColor: theme.semantic.color.actionTonalSurface,
    transform: [{ scale: theme.semantic.interaction.pressedScale }],
    ...theme.semantic.motion.transition.control,
  },
  newMessagesBadge: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.notificationBadgeSurface,
    borderColor: theme.semantic.color.sectionSurface,
    borderRadius: theme.semantic.radius.circle,
    borderWidth: theme.semantic.stroke.statusRing,
    height: theme.recipes.status.notificationBadgeSize,
    justifyContent: "center",
    minWidth: theme.recipes.status.notificationBadgeSize,
    paddingHorizontal: theme.spacing.xs,
    position: "absolute",
    right: theme.recipes.status.notificationBadgeOffset,
    top: theme.recipes.status.notificationBadgeOffset,
  },
  newMessagesBadgeText: {
    color: theme.semantic.color.notificationBadgeText,
    ...theme.semantic.typography.captionEmphasis,
  },
}));

function requestAfterPaint(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const requestId = requestAnimationFrame(() => callback());
    return () => {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(requestId);
      }
    };
  }
  const timeoutId = setTimeout(callback, 0);
  return () => clearTimeout(timeoutId);
}
