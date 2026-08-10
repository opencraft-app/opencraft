import type {ReactNode} from "react";
import {Pressable, Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import {MaybeLink} from "../layouts/navigation-link";

interface SystemSourceListRowBaseProps {
  accessibilityLabel: string;
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
  rowId: string;
  selected?: boolean;
  testID?: string;
}

type SystemSourceListRowContentProps =
  | {
      badge?: string;
      children?: never;
      description?: string;
      leading?: ReactNode;
      title: string;
      trailing?: ReactNode;
    }
  | {
      badge?: never;
      children: ReactNode;
      description?: never;
      leading?: never;
      title?: never;
      trailing?: never;
    };

type SystemSourceListRowActionProps =
  | {kind: "link"; href: string; onPress?: never}
  | {kind: "button"; href?: never; onPress(): void}
  | {kind: "static"; href?: never; onPress?: never};

export type SystemSourceListRowProps = SystemSourceListRowBaseProps &
  SystemSourceListRowContentProps &
  SystemSourceListRowActionProps;

export function SystemSourceListRow(props: SystemSourceListRowProps) {
  const {
    accessibilityLabel,
    children,
    disabled = false,
    orientation = "vertical",
    rowId,
    selected = false,
    testID = rowId,
  } = props;
  const content = children ?? (
    <>
      {props.leading ? <View style={styles.leading}>{props.leading}</View> : null}
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={styles.title}>{props.title}</Text>
          {props.trailing ? <View style={styles.trailing}>{props.trailing}</View> : null}
        </View>
        {props.description || props.badge ? (
          <View style={styles.descriptionRow}>
            {props.description ? (
              <Text numberOfLines={1} style={styles.description}>
                {props.description}
              </Text>
            ) : <View style={styles.description} />}
            {props.badge ? (
              <View accessibilityLabel={`${props.badge} 条未读`} style={styles.badge}>
                <Text style={styles.badgeText}>{props.badge}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </>
  );
  const rowStyle = [
    styles.row,
    orientation === "horizontal" && styles.rowHorizontal,
    selected && styles.rowSelected,
    disabled && styles.rowDisabled,
  ];

  if (props.kind === "static") {
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{disabled, selected}}
        aria-selected={selected}
        style={rowStyle}
        testID={testID}
      >
        {content}
      </View>
    );
  }

  const row = (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={props.kind === "link" ? "link" : "button"}
      accessibilityState={{disabled, selected}}
      aria-selected={selected}
      aria-current={props.kind === "link" && selected ? "page" : undefined}
      disabled={disabled}
      onPress={props.kind === "button" ? props.onPress : undefined}
      style={({pressed}) => [
        rowStyle,
        pressed && !disabled && styles.rowPressed,
        pressed && !disabled && selected && styles.rowSelectedPressed,
      ]}
      testID={testID}
    >
      {content}
    </Pressable>
  );

  return props.kind === "link" ? (
    <MaybeLink href={disabled ? undefined : props.href}>{row}</MaybeLink>
  ) : row;
}

const styles = StyleSheet.create(theme => ({
  badge: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionPrimarySurface,
    borderRadius: theme.semantic.radius.pill,
    justifyContent: "center",
    minHeight: theme.recipes.status.notificationBadgeSize,
    minWidth: theme.recipes.status.notificationBadgeSize,
    paddingHorizontal: theme.spacing.xs,
  },
  badgeText: {
    color: theme.semantic.color.textInverse,
    ...theme.semantic.typography.captionEmphasis,
  },
  copy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
  },
  description: {
    color: theme.semantic.color.textMuted,
    flex: 1,
    minWidth: 0,
    ...theme.semantic.typography.meta,
  },
  descriptionRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  leading: {flexShrink: 0},
  row: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.compactControl,
    borderWidth: 0,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.control.rowHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    ...theme.semantic.motion.transition.control,
    _web: {
      _hover: {backgroundColor: theme.semantic.color.interactiveHoverSurface},
    },
  },
  rowDisabled: {opacity: theme.semantic.interaction.disabledOpacity},
  rowHorizontal: {
    height: theme.recipes.control.rowHeight,
    width: theme.recipes.managementWorkspace.collectionCompactRowWidth,
  },
  rowPressed: {backgroundColor: theme.semantic.color.interactivePressedSurface},
  rowSelected: {
    backgroundColor: theme.semantic.color.selectionSurface,
    _web: {
      _hover: {backgroundColor: theme.semantic.color.selectionHoverSurface},
    },
  },
  rowSelectedPressed: {backgroundColor: theme.semantic.color.selectionPressedSurface},
  title: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    minWidth: 0,
    ...theme.semantic.typography.bodyEmphasis,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  trailing: {flexShrink: 0},
}));
