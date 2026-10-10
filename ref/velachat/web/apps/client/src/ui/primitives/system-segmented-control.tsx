import {I18nManager, Pressable, Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

export interface SystemSegmentedOption<T extends string> {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  value: T;
}

export interface SystemSegmentedControlProps<T extends string> {
  accessibilityLabel: string;
  disabled?: boolean;
  onChange(value: T): void;
  options: readonly SystemSegmentedOption<T>[];
  testID?: string;
  value: T;
}

interface KeyEvent {
  nativeEvent?: {key?: string};
  preventDefault?(): void;
}

export function SystemSegmentedControl<T extends string>({
  accessibilityLabel,
  disabled = false,
  onChange,
  options,
  testID,
  value,
}: SystemSegmentedControlProps<T>) {
  const enabled = options.filter(option => !disabled && !option.disabled);
  const selectedIndex = options.findIndex(option => option.value === value);
  const focusableValue = selectedIndex >= 0 && !options[selectedIndex]?.disabled
    ? value
    : enabled[0]?.value;

  const selectRelative = (currentIndex: number, delta: number) => {
    if (!enabled.length) return;
    const currentValue = options[currentIndex]?.value;
    const enabledIndex = enabled.findIndex(option => option.value === currentValue);
    const origin = enabledIndex >= 0 ? enabledIndex : 0;
    const next = enabled[(origin + delta + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  };

  const handleKeyDown = (event: KeyEvent, index: number) => {
    const key = event.nativeEvent?.key;
    const backwardKey = I18nManager.isRTL ? "ArrowRight" : "ArrowLeft";
    const forwardKey = I18nManager.isRTL ? "ArrowLeft" : "ArrowRight";
    if (key === backwardKey) {
      event.preventDefault?.();
      selectRelative(index, -1);
    } else if (key === forwardKey) {
      event.preventDefault?.();
      selectRelative(index, 1);
    } else if (key === "Home") {
      event.preventDefault?.();
      if (enabled[0]) onChange(enabled[0].value);
    } else if (key === "End") {
      event.preventDefault?.();
      const last = enabled.at(-1);
      if (last) onChange(last.value);
    } else if (key === "Enter" || key === " ") {
      event.preventDefault?.();
      const option = options[index];
      if (option && !disabled && !option.disabled) onChange(option.value);
    }
  };

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="radiogroup"
      style={styles.group}
      testID={testID}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const unavailable = disabled || Boolean(option.disabled);
        return (
          <Pressable
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityRole="radio"
            accessibilityState={{checked, disabled: unavailable}}
            aria-checked={checked}
            disabled={unavailable}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={({pressed}) => [
              styles.option,
              checked && styles.optionChecked,
              pressed && !unavailable && styles.optionPressed,
              unavailable && styles.optionDisabled,
            ]}
            {...({
              onKeyDown: (event: KeyEvent) => handleKeyDown(event, index),
              tabIndex: option.value === focusableValue && !unavailable ? 0 : -1,
            } as object)}
          >
            <Text style={[styles.label, checked && styles.labelChecked]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: theme.semantic.color.fieldSurfaceRecessed,
    borderColor: theme.semantic.color.separator,
    borderRadius: theme.semantic.radius.compactControl,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: 0,
    overflow: "hidden",
    padding: theme.spacing.xxs,
  },
  label: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.label,
  },
  labelChecked: {
    color: theme.semantic.color.textPrimary,
  },
  option: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderRadius: theme.semantic.radius.compactControl,
    borderWidth: 0,
    justifyContent: "center",
    minHeight: theme.recipes.managementWorkspace.headerActionHeight,
    minWidth: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.md,
    ...theme.semantic.motion.transition.control,
  },
  optionChecked: {
    backgroundColor: theme.semantic.color.sectionSurface,
  },
  optionDisabled: {
    opacity: theme.semantic.interaction.disabledOpacity,
  },
  optionPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
  },
}));
