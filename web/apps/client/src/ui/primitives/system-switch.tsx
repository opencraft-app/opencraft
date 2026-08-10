import {Pressable, Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

export interface SystemSwitchProps {
  accessibilityLabel: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
  testID?: string;
}

export function SystemSwitch({
  accessibilityLabel,
  checked,
  disabled = false,
  onChange,
  testID,
}: SystemSwitchProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="switch"
      accessibilityState={{checked, disabled}}
      aria-checked={checked}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={[
        styles.switchTrack,
        checked && styles.switchTrackChecked,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <SwitchThumb checked={checked} />
    </Pressable>
  );
}

export interface SystemToggleRowProps {
  checked: boolean;
  description?: string;
  disabled?: boolean;
  label: string;
  onChange(checked: boolean): void;
  testID?: string;
}

export function SystemToggleRow({
  checked,
  description,
  disabled = false,
  label,
  onChange,
  testID,
}: SystemToggleRowProps) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="switch"
      accessibilityState={{checked, disabled}}
      aria-checked={checked}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={({pressed}) => [
        styles.toggleRow,
        pressed && styles.toggleRowPressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <View style={styles.toggleCopy}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {description ? (
          <Text style={styles.toggleDescription}>{description}</Text>
        ) : null}
      </View>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[styles.switchTrack, checked && styles.switchTrackChecked]}
      >
        <SwitchThumb checked={checked} />
      </View>
    </Pressable>
  );
}

function SwitchThumb({checked}: {checked: boolean}) {
  return (
    <View style={[styles.switchThumb, checked && styles.switchThumbChecked]} />
  );
}

const styles = StyleSheet.create((theme) => ({
  disabled: {
    opacity: theme.semantic.interaction.disabledOpacity,
  },
  switchThumb: {
    backgroundColor: theme.semantic.color.paneSurface,
    borderRadius: theme.semantic.radius.circle,
    height: theme.semantic.icon.size.feature,
    width: theme.semantic.icon.size.feature,
  },
  switchThumbChecked: {
    alignSelf: "flex-end",
  },
  switchTrack: {
    backgroundColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.pill,
    flexShrink: 0,
    height: theme.recipes.iconControl.microSize,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.xxs,
    width: theme.recipes.iconControl.floatingSize,
    ...theme.semantic.motion.transition.control,
  },
  switchTrackChecked: {
    backgroundColor: theme.semantic.color.statusPositive,
  },
  toggleCopy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
  },
  toggleDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
  },
  toggleLabel: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  toggleRow: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.md,
    minHeight: theme.recipes.control.rowHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    width: "100%",
    ...theme.semantic.motion.transition.control,
    _web: {
      _hover: {
        backgroundColor: theme.semantic.color.interactiveHoverSurface,
        borderColor: theme.semantic.color.borderFieldHover,
      },
      _focusVisible: {
        borderColor: theme.semantic.color.borderFocus,
        boxShadow: `0 0 0 2px ${theme.semantic.color.fieldFocusGlow}`,
        outlineStyle: "none",
      },
    },
  },
  toggleRowPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
  },
}));
