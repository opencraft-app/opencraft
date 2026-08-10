import { Pressable, TextInput, View, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Search from "lucide-react-native/icons/search";
import X from "lucide-react-native/icons/x";

import { velaTheme } from "../tokens";
import {SystemEmptyState} from "../primitives/system-empty-state";

/**
 * The one clearable search field.
 *
 * UserPicker invented it first; the standing sidebar and the compact directory
 * each copied the chrome — icon, field, clear — with three heights and two
 * clear-button sizes between them. The answers they filter already live in one
 * place; the control that feeds them belongs in one place too.
 *
 * Material: recessed well (not a white Bootstrap box). Focus paints the outer
 * chrome via :focus-within so the ring describes the whole control, not the
 * naked inner input.
 */

export interface ClearableSearchFieldProps {
  accessibilityLabel: string;
  clearAccessibilityLabel?: string;
  onChangeText(value: string): void;
  placeholder?: string;
  style?: ViewStyle;
  testID?: string;
  value: string;
}

export function ClearableSearchField({
  accessibilityLabel,
  clearAccessibilityLabel = "清除搜索",
  onChangeText,
  placeholder = "搜索",
  style,
  testID,
  value,
}: ClearableSearchFieldProps) {
  const searching = Boolean(value.trim());

  return (
    <View
      // RN Web maps dataSet → data-* so the focus-ring installer can skip the
      // inner input and leave the chrome as the only focus signal.
      style={[styles.field, style]}
      testID={testID}
      {...({ dataSet: { velaField: "search" } } as object)}
    >
      <Search
        color={velaTheme.semantic.color.iconMuted}
        size={velaTheme.semantic.icon.size.small}
        strokeWidth={velaTheme.semantic.icon.stroke.regular}
      />
      <TextInput
        accessibilityLabel={accessibilityLabel}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={velaTheme.semantic.color.fieldPlaceholder}
        style={styles.input}
        value={value}
      />
      {searching ? (
        <Pressable
          accessibilityLabel={clearAccessibilityLabel}
          accessibilityRole="button"
          hitSlop={velaTheme.semantic.interaction.hitTargetInset}
          onPress={() => onChangeText("")}
          style={styles.clear}
        >
          <X
            color={velaTheme.semantic.color.iconMuted}
            size={velaTheme.semantic.icon.size.small}
            strokeWidth={velaTheme.semantic.icon.stroke.regular}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

export interface SearchEmptyCardProps {
  description: string;
  title: string;
}

export function SearchEmptyCard({
  description,
  title,
}: SearchEmptyCardProps) {
  return (
    <SystemEmptyState
      description={description}
      icon={Search}
      kind="list"
      title={title}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  clear: {
    alignItems: "center",
    height: theme.recipes.iconControl.compactSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.compactSize,
  },
  field: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.fieldSurfaceRecessed,
    borderColor: theme.semantic.color.borderTransparent,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    height: theme.recipes.control.fieldHeight,
    paddingHorizontal: theme.spacing.md,
    ...theme.semantic.motion.transition.control,
    _web: {
      _hover: {
        borderColor: theme.semantic.color.borderFieldHover,
      },
      "_focus-within": {
        borderColor: theme.semantic.color.borderFocus,
        boxShadow: `0 0 0 2px ${theme.semantic.color.fieldFocusGlow}`,
      },
    },
  },
  input: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    ...theme.semantic.typography.bodyCompact,
    minWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
}));
