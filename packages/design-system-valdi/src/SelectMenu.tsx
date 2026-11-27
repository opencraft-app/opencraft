import { StatefulComponent } from "valdi_core/src/Component";
import { triggerHaptic } from "./haptics";
import { Icon } from "./Icon";
import { themeColors, themeMetrics } from "./tokens";

export type SelectMenuOption = {
  readonly id: string;
  readonly title: string;
  readonly disabled?: boolean;
};

export type SelectMenuProps = {
  id: string;
  label: string;
  value: string;
  options: readonly SelectMenuOption[];
  open?: boolean;
  disabled?: boolean;
  minWidth?: number;
  align?: "left" | "right";
  touch?: boolean;
  dark?: boolean;
  onOpenChange?: (open: boolean) => void;
  onChange: (value: string) => void;
};

type State = {
  internalOpen: boolean;
};

/**
 * Native-grade OpenCraft Valdi popover menu button (replaces browser `<select>`).
 * Single crisp chevron, 0.5px hair-border pill trigger, and Liquid Glass floating menu.
 */
export class SelectMenu extends StatefulComponent<SelectMenuProps, State> {
  state: State = { internalOpen: false };

  private isOpen(): boolean {
    return this.viewModel.open !== undefined ? this.viewModel.open : this.state.internalOpen;
  }

  private setOpen(next: boolean): void {
    if (this.viewModel.open === undefined) {
      this.setState({ internalOpen: next });
    }
    this.viewModel.onOpenChange?.(next);
  }

  onRender(): void {
    const {
      id,
      label,
      value,
      options,
      disabled,
      minWidth = 148,
      align = "right",
      touch,
      dark,
      onChange,
    } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const open = !disabled && this.isOpen();
    const selectedOption = options.find((opt) => opt.id === value) ?? options[0];
    const triggerHeight = m.touch ? 36 : 30;
    const optionFontSize = m.touch ? 14 : 13;
    const maxOptionUnits = options.reduce((max, option) => {
      let units = 0;
      for (let i = 0; i < option.title.length; i++) {
        units += option.title.charCodeAt(i) > 255 ? 1.85 : 1;
      }
      return Math.max(max, units);
    }, 0);
    const estimatedMenuWidth = Math.ceil(maxOptionUnits * (optionFontSize * 0.64) + 68);
    const menuWidth = Math.min(360, Math.max(minWidth, 176, estimatedMenuWidth));
    const glassClass = dark ? "oc-liquid-glass oc-dark" : "oc-liquid-glass";

    <view zIndex={open ? 70 : 1}>
      <view
        class="oc-pill-button oc-select-trigger"
        accessibilityId={id}
        accessibilityLabel={`${label}: ${selectedOption?.title ?? ""}`}
        accessibilityCategory="button"
        accessibilityStateDisabled={disabled}
        accessibilityStateSelected={open}
        onTap={
          disabled
            ? undefined
            : () => {
                triggerHaptic("selection");
                this.setOpen(!open);
              }
        }
        minWidth={minWidth}
        minHeight={triggerHeight}
        paddingLeft={12}
        paddingRight={10}
        paddingTop={4}
        paddingBottom={4}
        borderRadius={m.radii.control}
        backgroundColor={c.trackSubtle}
        borderWidth={0.5}
        borderColor={open ? c.accent : c.border}
        flexDirection="row"
        alignItems="center"
        justifyContent="space-between"
        gap={8}
        opacity={disabled ? 0.5 : 1}
      >
        <label
          value={selectedOption?.title ?? ""}
          font={m.fonts.controlCompact}
          color={disabled ? c.disabled : c.ink}
          flexShrink={1}
          numberOfLines={1}
        />
        <Icon name={open ? "chevronUp" : "chevronDown"} size={13} color={c.muted} />
      </view>

      {open && (
        <glass
          class={`${glassClass} oc-select-menu`}
          position="absolute"
          top={triggerHeight + 6}
          left={align === "left" ? 0 : undefined}
          right={align === "right" ? 0 : undefined}
          width={menuWidth}
          minWidth={menuWidth}
          zIndex={80}
          borderRadius={m.radii.card - 2}
          glassStyle="regular"
          backgroundColor={c.alert}
          glassTintColor={c.glassTint}
          borderWidth={0.5}
          borderColor={c.glassBorder}
          boxShadow={dark ? "complex 0 14 32 rgba(0, 0, 0, 0.42)" : "complex 0 10 26 rgba(24, 24, 28, 0.12)"}
          padding={4}
          gap={2}
          slowClipping={true}
        >
          {options.forEach((option) => {
            const isSelected = option.id === value;
            const isDisabled = Boolean(option.disabled);
            <view
              key={option.id}
              class="oc-settings-row"
              accessibilityId={`${id}-option-${option.id || "default"}`}
              accessibilityLabel={option.title}
              accessibilityCategory="button"
              accessibilityStateSelected={isSelected}
              accessibilityStateDisabled={isDisabled}
              onTap={
                isDisabled
                  ? undefined
                  : () => {
                      triggerHaptic("selection");
                      this.setOpen(false);
                      if (option.id !== value) onChange(option.id);
                    }
              }
              minHeight={m.touch ? 38 : 32}
              paddingLeft={10}
              paddingRight={10}
              paddingTop={6}
              paddingBottom={6}
              borderRadius={m.radii.control}
              backgroundColor={isSelected ? c.trackSoft : undefined}
              flexDirection="row"
              alignItems="center"
              justifyContent="space-between"
              gap={12}
            >
              <label
                value={option.title}
                font={isSelected ? m.fonts.control : m.fonts.body}
                color={isDisabled ? c.disabled : isSelected ? c.ink : c.muted}
                flexShrink={1}
                numberOfLines={1}
              />
              <view
                width={16}
                height={16}
                alignItems="center"
                justifyContent="center"
                accessibilityNavigation="ignored"
              >
                {isSelected && <Icon name="check" size={14} color={c.accent} />}
              </view>
            </view>;
          })}
        </glass>
      )}
    </view>;
  }
}
