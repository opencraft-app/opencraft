import { nativeTypographyStyle, typographyRole } from "@opencraft/design-system/typography";
import {
  chatFileCitationPresentation,
  chatMediaPresentationKey,
  chatReferenceTarget,
  useSettledResourceTarget,
  type ChatNodeRendererProps,
  type ChatResourcePolicyService,
} from "@opencraft/chat-render-react";
import * as Clipboard from "expo-clipboard";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, Alert, Image, Linking, Platform, Pressable, Text, View } from "react-native";
import { StyleSheet } from "../styles";
import { useNativeChatCopy } from "../presentation-language";
import { useNativeImageGallery } from "./image-gallery";
import { nativeImageBox } from "./image-size";
import { nativeLinkOpenRoute } from "./resource-opening";

interface NativeResourceRendererProps extends ChatNodeRendererProps {
  readonly resources: ChatResourcePolicyService;
}

function NativeLinkRenderer({ node, renderNodes, context, resources }: NativeResourceRendererProps) {
  const copy = useNativeChatCopy();
  const decision = node.kind === "link" ? resources.resolve(node.href, context) : null;
  const directTarget = decision?.target ?? null;
  const external = decision?.kind === "external" && /^https?:/iu.test(directTarget ?? "");
  const localResource = decision?.kind === "file" || decision?.kind === "workspace-file"
    || decision?.kind === "resource" || decision?.kind === "app-route";
  const route = nativeLinkOpenRoute({
    allowed: decision?.allowed === true,
    target: directTarget,
    hasHostOpener: context.openResource !== undefined,
    hostAllowsOpen: decision !== null && directTarget !== null
      && context.canOpenResource?.(directTarget, decision) !== false,
  });
  const actionableTarget = route === null ? null : directTarget;
  const target = useSettledResourceTarget(actionableTarget, context.streaming && external);
  const currentTarget = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentTarget.current = target;
    return () => { currentTarget.current = null; };
  }, [target]);
  if (node.kind !== "link") return null;
  const open = () => {
    if (target === null || decision === null) return;
    if (route === "host") context.openResource?.(target, decision, external
      ? { source: "pointer", target: "default", disposition: "current-tab" }
      : undefined);
    else void Linking.openURL(target.startsWith("//") ? `https:${target}` : target).catch(() => undefined);
  };
  const showExternalActions = () => {
    if (!external || target === null || decision === null) return;
    const menuTarget = target;
    const stillCurrent = () => currentTarget.current === menuTarget;
    const openExternally = () => {
      if (!stillCurrent()) return;
      if (route === "host") context.openResource?.(target, decision, {
        source: "context-menu", target: "external-browser", disposition: "current-tab",
      });
      else void Linking.openURL(target.startsWith("//") ? `https:${target}` : target).catch(() => undefined);
    };
    const copyTarget = () => {
      if (!stillCurrent()) return;
      void Clipboard.setStringAsync(target).catch(() => undefined);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({
        options: [copy.openInBrowser, copy.copyLink, copy.cancel],
        cancelButtonIndex: 2,
      }, index => { if (index === 0) openExternally(); else if (index === 1) copyTarget(); });
    } else {
      Alert.alert(copy.link, undefined, [
        { text: copy.openInBrowser, onPress: openExternally },
        { text: copy.copyLink, onPress: copyTarget },
        { text: copy.cancel, style: "cancel" },
      ]);
    }
  };
  return <Text accessibilityHint={external && target !== null ? copy.linkActions : undefined} accessibilityRole={target === null ? undefined : "link"} accessibilityState={target === null ? { disabled: true } : undefined} onLongPress={external && target !== null ? showExternalActions : undefined} onPress={target === null ? undefined : open} style={[
    localResource ? styles.localLink : styles.link,
    target === null && styles.inactiveLink,
  ]}>
    {renderNodes(node.children, node.kind)}
  </Text>;
}

export function createNativeLinkRenderer(resources: ChatResourcePolicyService) {
  return function NativeLinkResourceRenderer(props: ChatNodeRendererProps) {
    return <NativeLinkRenderer {...props} resources={resources} />;
  };
}

function NativeReferenceRenderer({ node, context, resources }: NativeResourceRendererProps) {
  if (node.kind !== "reference") return null;
  const source = chatReferenceTarget(node);
  const decision = source === null ? null : resources.resolve(source, context);
  const canOpen = decision?.allowed === true && decision.target !== null && context.openResource !== undefined
    && context.canOpenResource?.(decision.target, decision) !== false;
  const open = () => {
    if (canOpen && decision?.target !== null) context.openResource?.(decision.target, decision);
  };
  return <Text accessibilityRole={canOpen ? "link" : undefined} onPress={canOpen ? open : undefined} style={[styles.inlineReference, canOpen && styles.link]}>
    {node.segments.length > 0 ? node.segments.map(segment => <Text key={segment.key}>{segment.text}</Text>) : node.text}
  </Text>;
}

export function createNativeReferenceRenderer(resources: ChatResourcePolicyService) {
  return function NativeReferenceResourceRenderer(props: ChatNodeRendererProps) {
    return <NativeReferenceRenderer {...props} resources={resources} />;
  };
}

function NativeFileCitationRenderer({ node, context, resources }: NativeResourceRendererProps) {
  if (node.kind !== "directive" || node.name !== "file-citation") return null;
  const presentation = chatFileCitationPresentation(node);
  if (presentation === null) return <Text>{node.raw}</Text>;
  const decision = resources.resolve(presentation.target, context);
  const canOpen = decision.allowed && decision.target !== null && context.openResource !== undefined
    && context.canOpenResource?.(decision.target, decision) !== false;
  const open = () => {
    if (canOpen && decision.target !== null) context.openResource?.(decision.target, decision);
  };
  return <Text accessibilityRole={canOpen ? "link" : undefined} onPress={canOpen ? open : undefined} style={styles.fileCitation}>{presentation.label}</Text>;
}

export function createNativeFileCitationRenderer(resources: ChatResourcePolicyService) {
  return function NativeFileCitationResourceRenderer(props: ChatNodeRendererProps) {
    return <NativeFileCitationRenderer {...props} resources={resources} />;
  };
}

function NativeImageRenderer({ node, context, position, resources }: NativeResourceRendererProps) {
  const copy = useNativeChatCopy();
  const gallery = useNativeImageGallery();
  const [mediaState, setMediaState] = useState<{ key: string; source: string | null; status: "loading" | "ready" | "unavailable" } | null>(null);
  const [intrinsicSize, setIntrinsicSize] = useState<{ key: string; width: number; height: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const source = node.kind === "image" ? node.src : "";
  const decision = /^data:image\//iu.test(source)
    ? { allowed: true as const, kind: "external" as const, target: source }
    : resources.resolve(source, context);
  const resourceNeedsHost = decision.kind === "file" || decision.kind === "workspace-file" || decision.kind === "resource";
  const key = chatMediaPresentationKey(source, decision, context);
  const directSource = decision.allowed && decision.target !== null && !resourceNeedsHost
    && (/^https?:/iu.test(decision.target) || /^data:image\//iu.test(decision.target))
    ? decision.target : null;
  const effectiveState = useMemo(() => {
    if (mediaState?.key === key && mediaState.status === "unavailable") return mediaState;
    if (directSource !== null) return { key, source: directSource, status: "ready" as const };
    if (resourceNeedsHost && context.loadMediaSource !== undefined && decision.allowed) {
      return mediaState?.key === key ? mediaState : { key, source: null, status: "loading" as const };
    }
    return { key, source: null, status: "unavailable" as const };
  }, [context.loadMediaSource, decision.allowed, directSource, key, mediaState, resourceNeedsHost]);
  useEffect(() => {
    if (!resourceNeedsHost || !decision.allowed || decision.target === null || context.loadMediaSource === undefined) return;
    let active = true;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setMediaState({ key, source: null, status: "loading" });
    void context.loadMediaSource({
      signal: controller.signal,
      source,
      resolvedTarget: decision.target,
      resourceKind: decision.kind,
      documentId: context.documentId,
      conversationId: context.conversationId ?? null,
      hostId: context.hostId ?? null,
      cwd: context.cwd ?? null,
    }).then(result => {
      if (!active) { result?.release?.(); return; }
      release = result?.release;
      setMediaState({ key, source: result?.source ?? null, status: result === null ? "unavailable" : "ready" });
      context.requestMeasurement?.({ geometryChanged: true, reason: "resource-resolve" });
    }, () => {
      if (!active) return;
      setMediaState({ key, source: null, status: "unavailable" });
      context.requestMeasurement?.({ geometryChanged: true, reason: "resource-resolve" });
    });
    return () => { active = false; controller.abort(); release?.(); };
  }, [context.conversationId, context.cwd, context.documentId, context.hostId, context.loadMediaSource, context.requestMeasurement, decision.allowed, decision.kind, decision.target, key, resourceNeedsHost, source]);
  const readySource = effectiveState.status === "ready" ? effectiveState.source : null;
  useEffect(() => {
    if (node.kind !== "image" || readySource === null || gallery === null) return;
    return gallery.register({ key: node.stableKey, source: readySource, alt: node.alt, order: node.sourceRange.start });
  }, [gallery, node.kind, node.kind === "image" ? node.alt : null, node.sourceRange.start, node.stableKey, readySource]);
  if (node.kind !== "image") return null;
  const size = nativeImageBox(intrinsicSize?.key === key ? intrinsicSize.width : null, intrinsicSize?.key === key ? intrinsicSize.height : null, containerWidth);
  const inline = position?.parentKind === "strong" || position?.parentKind === "emphasis"
    || position?.parentKind === "delete" || position?.parentKind === "link";
  if (effectiveState.status === "loading") return inline
    ? <Text accessibilityLabel={node.alt || "Image loading"}>{" "}</Text>
    : <View accessibilityLabel={node.alt || "Image loading"} accessibilityRole="progressbar" onLayout={event => setContainerWidth(event.nativeEvent.layout.width)} style={styles.imageFrame}><View style={[styles.imagePlaceholder, size]} /></View>;
  if (effectiveState.source === null) return <Text style={styles.unavailable}>{node.alt || "Image unavailable"}</Text>;
  const imageSource = effectiveState.source;
  const image = <Image accessibilityLabel={node.alt} onError={() => {
    setMediaState({ key, source: null, status: "unavailable" });
    context.requestMeasurement?.({ geometryChanged: true, reason: "image-load" });
  }} onLoad={({ nativeEvent }) => {
    const { width, height } = nativeEvent.source;
    if (width > 0 && height > 0) setIntrinsicSize({ key, width, height });
    context.requestMeasurement?.({ geometryChanged: true, reason: "image-load" });
  }}
    resizeMode="contain" source={{ uri: imageSource }} style={[styles.image, size]} />;
  return inline ? image : <View onLayout={event => setContainerWidth(event.nativeEvent.layout.width)} style={styles.imageFrame}>
    {gallery === null ? image : <Pressable accessibilityLabel={node.alt || copy.previewImage} accessibilityRole="imagebutton" onPress={() => gallery.open({ key: node.stableKey, source: imageSource, alt: node.alt, order: node.sourceRange.start })} style={styles.imageButton}>{image}</Pressable>}
  </View>;
}

export function createNativeImageRenderer(resources: ChatResourcePolicyService) {
  return function NativeImageResourceRenderer(props: ChatNodeRendererProps) {
    return <NativeImageRenderer {...props} resources={resources} />;
  };
}

const styles = StyleSheet.create((theme) => ({
  link: { color: theme.color.text.primary, textDecorationLine: "underline" },
  localLink: { color: theme.color.text.primary, backgroundColor: theme.color.surface.code, borderRadius: theme.radii.xs, ...nativeTypographyStyle("inlineCode", Platform.OS), paddingHorizontal: 4 },
  inactiveLink: { color: theme.color.text.tertiary },
  inlineReference: { backgroundColor: theme.color.surface.code, borderRadius: theme.radii.xs, ...nativeTypographyStyle("inlineCode", Platform.OS), paddingHorizontal: 4 },
  fileCitation: { color: theme.color.accent.blue, fontWeight: typographyRole("body", "native").fontWeight },
  imageFrame: { alignSelf: "stretch", maxWidth: "100%", marginVertical: 9 },
  image: { borderColor: theme.color.border.default, borderWidth: 1, borderRadius: theme.radii.lg },
  imageButton: { alignSelf: "flex-start" },
  imagePlaceholder: { borderRadius: theme.radii.lg, backgroundColor: theme.color.surface.code },
  unavailable: { color: theme.color.text.tertiary },
}));
