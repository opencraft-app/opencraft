import {
  resolveStandardChatResource,
  type ChatNodeRendererProps,
} from "@opencraft/chat-render-react";
import { Image, Linking, Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function NativeLinkRenderer({ node, renderNodes, context }: ChatNodeRendererProps) {
  if (node.kind !== "link") return null;
  const open = () => {
    const decision = resolveStandardChatResource(node.href, context);
    if (!decision.allowed || decision.target === null) return;
    if (context.openResource) context.openResource(decision.target, decision);
    else void Linking.openURL(decision.target);
  };
  return <Pressable onPress={open}><Text style={styles.link}>{renderNodes(node.children)}</Text></Pressable>;
}

export function NativeImageRenderer({ node }: ChatNodeRendererProps) {
  if (node.kind !== "image") return null;
  return <Image accessibilityLabel={node.alt} resizeMode="contain" source={{ uri: node.src }} style={styles.image} />;
}

const styles = StyleSheet.create((theme) => ({
  link: { color: theme.color.accent.blue, textDecorationLine: "underline" },
  image: { borderRadius: theme.radii.lg, height: 220, marginVertical: 9, maxWidth: "100%", width: 360 },
}));
