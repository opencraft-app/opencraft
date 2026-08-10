import {I18nManager, Pressable, Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

export interface SystemTabOption<T extends string> {
  disabled?: boolean;
  label: string;
  panelId: string;
  value: T;
}

export interface SystemTabsProps<T extends string> {
  accessibilityLabel: string;
  onChange(value: T): void;
  options: readonly SystemTabOption<T>[];
  testID?: string;
  value: T;
}

interface KeyEvent {
  nativeEvent?: {key?: string};
  preventDefault?(): void;
}

export function SystemTabs<T extends string>({
  accessibilityLabel,
  onChange,
  options,
  testID,
  value,
}: SystemTabsProps<T>) {
  const enabled = options.filter(option => !option.disabled);
  const selected = options.find(option => option.value === value && !option.disabled);
  const focusableValue = selected?.value ?? enabled[0]?.value;

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
      if (option && !option.disabled) onChange(option.value);
    }
  };

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="tablist"
      style={styles.tablist}
      testID={testID}
    >
      {options.map((option, index) => {
        const isSelected = option.value === value;
        const disabled = Boolean(option.disabled);
        return (
          <Pressable
            accessibilityLabel={option.label}
            accessibilityRole="tab"
            accessibilityState={{disabled, selected: isSelected}}
            aria-controls={option.panelId}
            aria-selected={isSelected}
            disabled={disabled}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={({pressed, hovered}) => [
              styles.tab,
              isSelected && styles.tabSelected,
              hovered && !disabled && !isSelected && styles.tabHovered,
              pressed && !disabled && styles.tabPressed,
              disabled && styles.tabDisabled,
            ]}
            {...({
              onKeyDown: (event: KeyEvent) => handleKeyDown(event, index),
              tabIndex: option.value === focusableValue && !disabled ? 0 : -1,
            } as object)}
          >
            <Text style={[styles.label, isSelected && styles.labelSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create(theme => ({
  label: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.label,
  },
  labelSelected: {
    color: theme.semantic.color.textPrimary,
  },
  tab: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderRadius: theme.semantic.radius.compactControl,
    height: theme.recipes.managementWorkspace.headerActionHeight,
    justifyContent: "center",
    minWidth: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.md,
    ...theme.semantic.motion.transition.control,
  },
  tabDisabled: {
    opacity: theme.semantic.interaction.disabledOpacity,
  },
  tabHovered: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
  },
  tabPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
  },
  tabSelected: {
    backgroundColor: theme.semantic.color.sectionSurface,
  },
  tablist: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: theme.semantic.color.fieldSurfaceRecessed,
    borderColor: theme.semantic.color.separator,
    borderRadius: theme.semantic.radius.compactControl,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: 0,
    padding: theme.spacing.xxs,
  },
}));
