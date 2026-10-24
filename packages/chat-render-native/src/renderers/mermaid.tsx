import { nativeTypographyStyle } from "@opencraft/design-system/typography";
import { Platform } from "react-native";
import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { CodeIcon as Code2, BranchIcon as Workflow, CloseIcon as X } from "@opencraft/design-system-native/action-icons";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Modal, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { nativeThemes } from "@opencraft/design-system/tokens.native";

import { StyleSheet } from "../styles";
import { useNativeChatCopy } from "../presentation-language";
import { NativeCodeRenderer } from "./code";
import { nativeMermaidPreviewHeight, parseMermaidRuntimeMessage } from "./mermaid-runtime-model";
import { allowEmbeddedDocumentNavigation } from "./embedded-rich-runtime-policy";

const MermaidRuntimeContext = createContext<(() => Promise<string>) | null>(null);

export function NativeChatMermaidProvider({ loadHtml, children }: {
  readonly loadHtml: () => Promise<string>;
  readonly children: ReactNode;
}) {
  return <MermaidRuntimeContext.Provider value={loadHtml}>{children}</MermaidRuntimeContext.Provider>;
}

function MermaidWebView({ html, source, theme, interactive, onRendered, onFailed }: {
  readonly html: string;
  readonly source: string;
  readonly theme: "light" | "dark";
  readonly interactive: boolean;
  readonly onRendered: (width: number, height: number) => void;
  readonly onFailed: () => void;
}) {
  const webView = useRef<WebView<object>>(null);
  const revision = useRef(0);
  const expected = useRef<{ key: string; revision: number } | null>(null);
  const key = `${theme}\u0000${source}\u0000${interactive}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [bridgeReady, setBridgeReady] = useState(false);
  const webSource = useMemo(() => ({ html }), [html]);

  useEffect(() => {
    if (!bridgeReady) return;
    const next = ++revision.current;
    expected.current = { key, revision: next };
    const payload = JSON.stringify({ type: "render", revision: next, source, theme, interactive });
    webView.current?.injectJavaScript(`globalThis.__OPENCRAFT_MERMAID_RENDER__?.(${payload}); true;`);
  }, [bridgeReady, interactive, key, source, theme]);

  const receive = (event: WebViewMessageEvent) => {
    const message = parseMermaidRuntimeMessage(event.nativeEvent.data);
    if (message?.type === "ready") { setBridgeReady(true); return; }
    if (!message || !expected.current || expected.current.key !== currentKey.current
      || message.revision !== expected.current.revision) return;
    if (message.type === "failed") onFailed();
    else onRendered(message.width, message.height);
  };

  return <WebView<object>
    ref={webView}
    source={webSource}
    originWhitelist={["*"]}
    onMessage={receive}
    onShouldStartLoadWithRequest={request => allowEmbeddedDocumentNavigation(request.url, bridgeReady)}
    onError={onFailed}
    onContentProcessDidTerminate={onFailed}
    scrollEnabled={interactive}
    bounces={false}
    javaScriptEnabled
    setSupportMultipleWindows={false}
    allowsLinkPreview={false}
    style={styles.webView}
  />;
}

function MermaidViewer({ html, source, theme, close }: {
  readonly html: string;
  readonly source: string;
  readonly theme: "light" | "dark";
  readonly close: () => void;
}) {
  const [showSource, setShowSource] = useState(false);
  const copy = useNativeChatCopy();
  return <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={close}>
    <SafeAreaView style={styles.viewer}>
      <View style={styles.viewerToolbar}>
        <Pressable accessibilityRole="button" accessibilityLabel={showSource ? copy.showDiagram : copy.showDiagramSource} onPress={() => setShowSource(value => !value)} style={styles.viewerAction}>
          {showSource ? <Workflow size={20} color={iconColor} /> : <Code2 size={20} color={iconColor} />}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={copy.closeDiagram} onPress={close} style={styles.viewerAction}><X size={20} color={iconColor} /></Pressable>
      </View>
      <View style={styles.viewerBody}>
        <MermaidWebView html={html} source={source} theme={theme} interactive onRendered={() => undefined} onFailed={() => setShowSource(true)} />
        {showSource ? <ScrollView style={styles.sourceOverlay} contentContainerStyle={styles.sourceContent}><Text selectable style={styles.sourceText}>{source}</Text></ScrollView> : null}
      </View>
    </SafeAreaView>
  </Modal>;
}

function Diagram({ props, loadHtml }: { readonly props: ChatNodeRendererProps; readonly loadHtml: () => Promise<string> }) {
  const { node, context } = props;
  const copy = useNativeChatCopy();
  const source = node.kind === "code-fence" ? node.code : "";
  const theme = context.theme === "dark" ? "dark" : "light";
  const key = `${theme}\u0000${source}`;
  const [html, setHtml] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{ key: string; width: number; height: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  const currentKey = useRef(key);
  currentKey.current = key;

  useEffect(() => {
    let active = true;
    void loadHtml().then(value => { if (active) setHtml(value); }, () => { if (active) setFailedKey(key); });
    return () => { active = false; };
  }, [key, loadHtml]);

  const visible = rendered?.key === key ? rendered : null;
  useEffect(() => {
    if (visible !== null || failedKey === key || html === null) return;
    const timer = setTimeout(() => setFailedKey(key), 20_000);
    return () => clearTimeout(timer);
  }, [failedKey, html, key, visible]);

  const height = visible === null ? 240 : nativeMermaidPreviewHeight(containerWidth, visible.width, visible.height);
  return <View onLayout={event => setContainerWidth(event.nativeEvent.layout.width)} style={styles.container}>
    {visible !== null
      ? <Pressable accessibilityRole="imagebutton" accessibilityLabel={copy.openDiagram} onPress={() => setViewerOpen(true)} style={[styles.preview, { height }]} />
      : failedKey === key
        ? <NativeCodeRenderer {...props} />
        : <View style={styles.placeholder}><ActivityIndicator color={iconColor} /></View>}
    {html !== null && failedKey !== key ? <View pointerEvents="none" style={visible === null ? styles.hiddenRuntime : [styles.visibleRuntime, { height }]}>
      <MermaidWebView html={html} source={source} theme={theme} interactive={false} onRendered={(width, nextHeight) => {
        if (currentKey.current !== key) return;
        setRendered({ key, width, height: nextHeight });
        context.requestMeasurement?.({ geometryChanged: true, reason: "diagram-render" });
      }} onFailed={() => { if (currentKey.current === key) setFailedKey(key); }} />
    </View> : null}
    {viewerOpen && html !== null ? <MermaidViewer html={html} source={source} theme={theme} close={() => setViewerOpen(false)} /> : null}
  </View>;
}

/** Streaming/incomplete diagrams stay readable as code until a full fence arrives. */
export function NativeMermaidRenderer(props: ChatNodeRendererProps) {
  const loadHtml = useContext(MermaidRuntimeContext);
  if (props.node.kind !== "code-fence" || props.node.completeness !== "complete"
    || props.node.language?.toLowerCase() !== "mermaid" || props.node.code.length > 15_000 || loadHtml === null) {
    return <NativeCodeRenderer {...props} />;
  }
  return <Diagram props={props} loadHtml={loadHtml} />;
}

const iconColor = nativeThemes.light.color.text.primary;
const styles = StyleSheet.create(theme => ({
  container: { minWidth: 0, maxWidth: "100%" },
  preview: { borderColor: theme.color.border.default, borderWidth: StyleSheet.hairlineWidth, borderRadius: theme.radii.lg, marginVertical: 9, overflow: "hidden" },
  placeholder: { height: 240, backgroundColor: theme.color.surface.subtle, borderColor: theme.color.border.default, borderWidth: StyleSheet.hairlineWidth, borderRadius: theme.radii.lg, marginVertical: 9, justifyContent: "center", alignItems: "center" },
  hiddenRuntime: { position: "absolute", left: 0, right: 0, top: 0, height: 240, opacity: 0 },
  visibleRuntime: { position: "absolute", left: 0, right: 0, top: 9, overflow: "hidden" },
  webView: { flex: 1, backgroundColor: "transparent" },
  viewer: { flex: 1, backgroundColor: theme.color.surface.main },
  viewerToolbar: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 12, paddingVertical: 6 },
  viewerAction: { alignItems: "center", justifyContent: "center", width: 44, height: 44 },
  viewerBody: { flex: 1 },
  sourceOverlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: theme.color.surface.main },
  sourceContent: { padding: 16 },
  sourceText: { color: theme.color.text.primary, ...nativeTypographyStyle("proseCode", Platform.OS) },
}));
