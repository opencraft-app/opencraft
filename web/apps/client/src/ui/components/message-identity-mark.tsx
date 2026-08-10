import Bot from "lucide-react-native/icons/bot";
import {Text, View} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

import type {MessageActorIdentity} from "./message-presentation";

export function MessageIdentityMark({
  actor,
  compact,
  messageId,
  tone,
}: {
  actor: MessageActorIdentity;
  compact: boolean;
  messageId: string;
  tone: 0 | 1 | 2;
}) {
  const {theme} = useUnistyles();
  const accessibilityLabel =
    actor.kind === "agent"
      ? `Agent ${actor.label}`
      : actor.kind === "self"
        ? "当前用户 我"
        : `成员 ${actor.label}`;
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      style={[
        styles.mark,
        compact && styles.markCompact,
        actor.kind === "agent" && styles.markAgent,
        actor.kind === "self" && styles.markSelf,
        actor.kind === "human" && tone === 0 && styles.markHumanViolet,
        actor.kind === "human" && tone === 1 && styles.markHumanGreen,
        actor.kind === "human" && tone === 2 && styles.markHumanOrange,
      ]}
      testID={`message-avatar-${messageId}`}
    >
      {actor.kind === "agent" ? (
        <Bot
          color={theme.semantic.color.avatarAgentText}
          size={theme.semantic.icon.size.small}
          strokeWidth={theme.semantic.icon.stroke.regular}
        />
      ) : (
        <Text
          style={[
            styles.label,
            actor.kind === "self" && styles.labelSelf,
            actor.kind === "human" && tone === 0 && styles.labelHumanViolet,
            actor.kind === "human" && tone === 1 && styles.labelHumanGreen,
            actor.kind === "human" && tone === 2 && styles.labelHumanOrange,
          ]}
        >
          {actor.kind === "self" ? "我" : actor.label.slice(0, 1)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    color: theme.semantic.color.iconSecondary,
    ...theme.semantic.typography.sectionTitle,
  },
  labelHumanGreen: {
    color: theme.semantic.color.avatarHumanGreenText,
  },
  labelHumanOrange: {
    color: theme.semantic.color.avatarHumanOrangeText,
  },
  labelHumanViolet: {
    color: theme.semantic.color.avatarHumanVioletText,
  },
  labelSelf: {
    color: theme.semantic.color.iconInverse,
  },
  mark: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.circle,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.identity.avatarCompactSize,
    justifyContent: "center",
    width: theme.recipes.identity.avatarCompactSize,
  },
  markAgent: {
    backgroundColor: theme.semantic.color.avatarAgentSurface,
    borderColor: theme.semantic.color.borderTransparent,
    borderRadius: theme.semantic.radius.compactControl,
  },
  markCompact: {
    height: theme.recipes.identity.avatarRowSize,
    width: theme.recipes.identity.avatarRowSize,
  },
  markHumanGreen: {
    backgroundColor: theme.semantic.color.avatarHumanGreenSurface,
    borderColor: theme.semantic.color.avatarHumanGreenBorder,
  },
  markHumanOrange: {
    backgroundColor: theme.semantic.color.avatarHumanOrangeSurface,
    borderColor: theme.semantic.color.avatarHumanOrangeBorder,
  },
  markHumanViolet: {
    backgroundColor: theme.semantic.color.avatarHumanVioletSurface,
    borderColor: theme.semantic.color.avatarHumanVioletBorder,
  },
  markSelf: {
    backgroundColor: theme.semantic.color.avatarAccountSurface,
    borderColor: theme.semantic.color.borderTransparent,
  },
}));
