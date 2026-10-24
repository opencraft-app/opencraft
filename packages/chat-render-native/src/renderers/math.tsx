import { nativeTypographyStyle } from "@opencraft/design-system/typography";
import { Platform } from "react-native";
import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { nativeThemes } from "@opencraft/design-system/tokens.native";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";

import { StyleSheet } from "../styles";
import { useNativeHorizontalOverflowTouchOwner } from "../horizontal-scroll-owner";
import { parseEmbeddedRenderMessage } from "./embedded-rich-render-message";
import { allowEmbeddedDocumentNavigation } from "./embedded-rich-runtime-policy";

const MathRuntimeContext = createContext<(() => Promise<string>) | null>(null);

export function NativeChatMathProvider({ loadHtml, children }: {
  readonly loadHtml: () => Promise<string>;
  readonly children: ReactNode;
}) {
  return <MathRuntimeContext.Provider value={loadHtml}>{children}</MathRuntimeContext.Provider>;
}

export function NativeMathFallback({ node }: ChatNodeRendererProps) {
  const horizontalScrollOwner = useNativeHorizontalOverflowTouchOwner(node.kind === "math" ? node.source : "");
  if (node.kind !== "math") return null;
  const source = node.display ? `$$${node.source}$$` : `$${node.source}$`;
  if (!node.display) return <Text style={styles.inline}>{source}</Text>;
  return <ScrollView horizontal nestedScrollEnabled scrollEnabled={horizontalScrollOwner.scrollEnabled}
    onLayout={event => horizontalScrollOwner.setViewportWidth(event.nativeEvent.layout.width)}
    onContentSizeChange={width => horizontalScrollOwner.setContentWidth(width)}
    onTouchStart={horizontalScrollOwner.beginTouch} onTouchEnd={horizontalScrollOwner.endTouch} onTouchCancel={horizontalScrollOwner.endTouch}
    style={styles.display}><Text selectable style={styles.inline}>{source}</Text></ScrollView>;
}

function DisplayMath({ props, loadHtml }: {
  readonly props: ChatNodeRendererProps;
  readonly loadHtml: () => Promise<string>;
}) {
  const source = props.node.kind === "math" ? props.node.source : "";
  const theme = props.context.theme === "dark" ? "dark" : "light";
  const key = `${theme}\u0000${source}`;
  const [html, setHtml] = useState<string | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{ key: string; height: number } | null>(null);
  const webView = useRef<WebView>(null);
  const revision = useRef(0);
  const expected = useRef<{ key: string; revision: number } | null>(null);
  const currentKey = useRef(key);
  currentKey.current = key;
  const webSource = useMemo(() => html === null ? null : ({ html }), [html]);
  const horizontalScrollOwner = useNativeHorizontalOverflowTouchOwner(key);

  useEffect(() => {
    let active = true;
    void loadHtml().then(value => { if (active) setHtml(value); }, () => { if (active) setFailedKey(key); });
    return () => { active = false; };
  }, [key, loadHtml]);

  useEffect(() => {
    if (!bridgeReady) return;
    const next = ++revision.current;
    expected.current = { key, revision: next };
    const payload = JSON.stringify({ type: "render", revision: next, source, theme });
    webView.current?.injectJavaScript(`globalThis.__OPENCRAFT_MATH_RENDER__?.(${payload}); true;`);
  }, [bridgeReady, key, source, theme]);

  const visible = rendered?.key === key ? rendered : null;
  useEffect(() => {
    if (visible !== null || failedKey === key || html === null) return;
    const timer = setTimeout(() => setFailedKey(key), 15_000);
    return () => clearTimeout(timer);
  }, [failedKey, html, key, visible]);

  const receive = (event: WebViewMessageEvent) => {
    const message = parseEmbeddedRenderMessage(event.nativeEvent.data);
    if (message?.type === "ready") { setBridgeReady(true); return; }
    if (!message || !expected.current || expected.current.key !== currentKey.current
      || message.revision !== expected.current.revision) return;
    if (message.type === "failed") setFailedKey(key);
    else {
      horizontalScrollOwner.setContentWidth(message.width);
      setRendered({ key, height: Math.max(48, Math.min(360, Math.ceil(message.height))) });
      props.context.requestMeasurement?.({ geometryChanged: true, reason: "math-typeset" });
    }
  };

  if (failedKey === key) return <NativeMathFallback {...props} />;
  return <View style={styles.mathSurface} onLayout={event => horizontalScrollOwner.setViewportWidth(event.nativeEvent.layout.width)}
    onTouchStart={horizontalScrollOwner.beginTouch} onTouchEnd={horizontalScrollOwner.endTouch} onTouchCancel={horizontalScrollOwner.endTouch}>
    {visible === null ? <View style={styles.placeholder}><ActivityIndicator color={nativeThemes.light.color.text.secondary} /></View> : null}
    {webSource !== null ? <WebView
      ref={webView}
      source={webSource}
      originWhitelist={["*"]}
      onMessage={receive}
      onShouldStartLoadWithRequest={request => allowEmbeddedDocumentNavigation(request.url, bridgeReady)}
      onTouchStart={horizontalScrollOwner.beginTouch}
      onTouchEnd={horizontalScrollOwner.endTouch}
      onTouchCancel={horizontalScrollOwner.endTouch}
      onError={() => setFailedKey(key)}
      onContentProcessDidTerminate={() => setFailedKey(key)}
      scrollEnabled={horizontalScrollOwner.scrollEnabled}
      bounces={false}
      javaScriptEnabled
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      accessibilityLabel={source}
      style={visible === null ? styles.hiddenRuntime : [styles.visibleRuntime, { height: visible.height }]}
    /> : null}
  </View>;
}

/** Inline math stays inside native Text; display math uses a packaged typesetter. */
export function NativeMathRenderer(props: ChatNodeRendererProps) {
  const loadHtml = useContext(MathRuntimeContext);
  if (props.node.kind !== "math" || !props.node.display || props.node.source.length > 8_000 || loadHtml === null) return <NativeMathFallback {...props} />;
  return <DisplayMath key={`${props.context.theme}\u0000${props.node.source}`} props={props} loadHtml={loadHtml} />;
}

const styles = StyleSheet.create(theme => ({
  inline: { color: theme.color.text.secondary, ...nativeTypographyStyle("inlineCode", Platform.OS) },
  display: { marginVertical: 9, maxWidth: "100%" },
  mathSurface: { minWidth: 0, maxWidth: "100%", marginVertical: 9 },
  placeholder: { height: 48, backgroundColor: theme.color.surface.subtle, borderRadius: theme.radii.md, justifyContent: "center", alignItems: "center" },
  hiddenRuntime: { position: "absolute", left: 0, right: 0, top: 0, height: 48, opacity: 0 },
  visibleRuntime: { minHeight: 48, backgroundColor: "transparent" },
}));
