import { nativeTypographyStyle, typographyRegistry } from "@opencraft/design-system/typography";
import { Platform } from "react-native";
import { codeBlockWrapPreference, codeLanguageLabel, resolveCodeSurfacePolicy, type ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { nativeThemes } from "@opencraft/design-system/tokens.native";
import { CheckIcon as Check, CopyIcon as Copy, WrapTextIcon } from "@opencraft/design-system-native/action-icons";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ChatCodeTokenLines, CodeHighlightTheme } from "@opencraft/chat-render-react/code-highlight";
import { StyleSheet } from "../styles";
import { useNativeHorizontalOverflowTouchOwner } from "../horizontal-scroll-owner";
import { useCopyFeedback } from "./use-copy-feedback";

const MAX_NATIVE_HIGHLIGHT_CHARS = 12_000;
let highlightEnginePromise: Promise<typeof import("@opencraft/chat-render-react/code-highlight")> | null = null;

function loadHighlightEngine() {
  highlightEnginePromise ??= import("@opencraft/chat-render-react/code-highlight").catch(error => {
    highlightEnginePromise = null;
    throw error;
  });
  return highlightEnginePromise;
}

function HighlightedCode({ lines, wrap }: { readonly lines: ChatCodeTokenLines; readonly wrap: boolean }) {
  return <Text selectable style={[styles.code, wrap && styles.wrappedCode]}>{lines.map((line, lineIndex) => <Text key={lineIndex}>
    {lineIndex > 0 ? "\n" : null}
    {line.map((token, tokenIndex) => <Text key={tokenIndex} style={{
      color: token.color,
      fontStyle: token.fontStyle & 1 ? "italic" : "normal",
      fontWeight: token.fontStyle & 2 ? String(typographyRegistry.weights.bold) as "700" : String(typographyRegistry.weights.regular) as "400",
      textDecorationLine: token.fontStyle & 4 ? "underline" : "none",
    }}>{token.content}</Text>)}
  </Text>)}</Text>;
}

export function NativeCodeRenderer({ node, context }: ChatNodeRendererProps) {
  const horizontalScrollOwner = useNativeHorizontalOverflowTouchOwner(node.kind === "code-fence" ? node.code : "");
  const wrapPreference = useSyncExternalStore(
    codeBlockWrapPreference.subscribe,
    codeBlockWrapPreference.getSnapshot,
    codeBlockWrapPreference.getSnapshot,
  );
  const { copied, copy } = useCopyFeedback(node.kind === "code-fence" ? node.code : "", 1_500);
  const code = node.kind === "code-fence" ? node.code : "";
  const language = node.kind === "code-fence" ? node.language : null;
  const complete = node.kind === "code-fence" && node.completeness === "complete";
  const theme: CodeHighlightTheme = context.theme === "dark" ? "dark" : "light";
  const [highlighted, setHighlighted] = useState<{
    code: string; language: string | null; theme: CodeHighlightTheme; lines: ChatCodeTokenLines;
  } | null>(null);
  useEffect(() => {
    if (!complete || !language || language === "mermaid" || code.length > MAX_NATIVE_HIGHLIGHT_CHARS) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadHighlightEngine().then(engine => engine.highlightChatCodeTokens(code, language, theme, controller.signal))
        .then(lines => {
          if (!active) return;
          // A native Text tree must preserve the original selection/copy source.
          if (lines.map(line => line.map(token => token.content).join("")).join("\n") !== code) return;
          setHighlighted({ code, language, theme, lines });
        }).catch(() => undefined);
    }, 120);
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [code, complete, language, theme]);
  if (node.kind !== "code-fence") return null;
  const open = node.completeness === "open";
  const policy = resolveCodeSurfacePolicy({ code: node.code, language: node.language });
  const wrap = policy.wrap === "always" || (policy.wrap === "user-controlled" && wrapPreference);
  const lines = highlighted?.code === code && highlighted.language === language && highlighted.theme === theme
    ? highlighted.lines : null;
  const body = lines === null ? <Text selectable style={[styles.code, wrap && styles.wrappedCode]}>{code}</Text>
    : <HighlightedCode lines={lines} wrap={wrap} />;
  return (
    <View style={styles.surface}>
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.label}>{codeLanguageLabel(node.language, open)}</Text>
        {policy.wrap === "user-controlled" ? <Pressable accessibilityLabel={wrap ? "Disable word wrap" : "Enable word wrap"} accessibilityRole="button" accessibilityState={{ selected: wrap }} onPress={() => codeBlockWrapPreference.toggle()} style={styles.action}>
          <WrapTextIcon size={16} color={actionColor} />
        </Pressable> : null}
        {!open ? <Pressable accessibilityLabel={copied ? "Copied code" : "Copy code"} accessibilityRole="button" onPress={copy} style={styles.action}>
          {copied ? <Check size={16} color={actionColor} /> : <Copy size={16} color={actionColor} />}
        </Pressable> : null}
      </View>
      {wrap ? <View style={styles.wrappedBody}>{body}</View>
        : <ScrollView horizontal nestedScrollEnabled scrollEnabled={horizontalScrollOwner.scrollEnabled}
          onLayout={event => horizontalScrollOwner.setViewportWidth(event.nativeEvent.layout.width)}
          onContentSizeChange={width => horizontalScrollOwner.setContentWidth(width)}
          onTouchStart={horizontalScrollOwner.beginTouch} onTouchEnd={horizontalScrollOwner.endTouch} onTouchCancel={horizontalScrollOwner.endTouch}
          style={styles.codeScroller}>{body}</ScrollView>}
    </View>
  );
}

export function NativeDiagramFallback(props: ChatNodeRendererProps) {
  return <NativeCodeRenderer {...props} />;
}

const actionColor = nativeThemes.light.color.text.tertiary;

const styles = StyleSheet.create((theme) => ({
  surface: { backgroundColor: theme.color.surface.code, borderColor: theme.color.border.default, borderRadius: theme.radii.lg, borderWidth: StyleSheet.hairlineWidth, marginVertical: 9, minWidth: 0, maxWidth: "100%", overflow: "hidden" },
  header: { alignItems: "center", borderBottomColor: theme.color.border.soft, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", minHeight: 34, paddingHorizontal: 8 },
  label: { color: theme.color.text.tertiary, flex: 1, minWidth: 0, fontSize: theme.platformTypography.caption.fontSize },
  action: { alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: theme.radii.sm },
  actionText: { color: theme.color.text.tertiary, ...nativeTypographyStyle("primaryAction", Platform.OS) },
  codeScroller: { maxWidth: "100%" },
  wrappedBody: { maxWidth: "100%", minWidth: 0 },
  wrappedCode: { flexShrink: 1 },
  code: { color: theme.color.text.primary, ...nativeTypographyStyle("proseCode", Platform.OS), padding: 12, writingDirection: "ltr" },
}));
