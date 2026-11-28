import { StatefulComponent } from "valdi_core/src/Component";
import { Icon, type IconName } from "./Icon";
import { themeColors, themeMetrics } from "./tokens";

type Props = {
  id: string;
  title: string;
  variant?: "primary" | "secondary" | "quiet" | "ghost" | "danger";
  size?: "sm" | "md";
  leadingIcon?: IconName;
  loading?: boolean;
  touch?: boolean;
  disabled?: boolean;
  dark?: boolean;
  onPress(): void;
};

type State = { pressing: boolean };

/** Adaptive OpenCraft control button (macOS desktop compact + iPadOS touch density). */
export class Button extends StatefulComponent<Props, State> {
  state: State = { pressing: false };

  private setPressing(pressing: boolean): void {
    if (this.state.pressing === pressing) return;
    this.setState({ pressing });
  }

  onRender(): void {
    const {
      id,
      title,
      variant = "primary",
      size = "md",
      leadingIcon,
      loading = false,
      touch,
      disabled,
      dark,
      onPress,
    } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const isDisabled = Boolean(disabled || loading);
    const pressing = this.state.pressing && !isDisabled;
    const isSmall = size === "sm";
    const isGhost = variant === "ghost";
    const minHeight = isSmall ? m.sizes.buttonSmHeight : m.sizes.buttonHeight;
    const padX = isGhost ? 8 : isSmall ? 11 : m.sizes.buttonPaddingX;
    const radius = isSmall ? m.radii.control - 1 : m.radii.control;
    const background = isGhost
      ? undefined
      : variant === "primary"
        ? c.primaryButton
        : variant === "danger"
          ? c.dangerSurface
          : c.trackSoft;
    const foreground = isGhost
      ? c.muted
      : variant === "primary"
        ? c.primaryButtonForeground
        : variant === "danger"
          ? c.danger
          : c.ink;
    const borderWidth = isGhost || variant === "primary" ? 0 : 0.5;
    const borderColor = variant === "danger" ? c.danger : c.border;

    <view
      class={isGhost ? "oc-ghost-button" : "oc-pill-button"}
      accessibilityId={id}
      accessibilityLabel={title}
      accessibilityCategory="button"
      accessibilityStateDisabled={isDisabled}
      onTouchStart={isDisabled ? undefined : () => this.setPressing(true)}
      onTouchEnd={isDisabled ? undefined : () => this.setPressing(false)}
      onTap={isDisabled ? undefined : onPress}
      minHeight={minHeight}
      paddingLeft={padX}
      paddingRight={padX}
      paddingTop={4}
      paddingBottom={4}
      flexDirection="row"
      justifyContent="center"
      alignItems="center"
      gap={6}
      borderRadius={radius}
      borderWidth={borderWidth}
      borderColor={borderColor}
      opacity={isDisabled ? 0.48 : pressing ? 0.86 : 1}
      backgroundColor={background}
    >
      {loading ? (
        <Icon name="refresh" size={isSmall ? 13 : 14} color={foreground} />
      ) : leadingIcon ? (
        <Icon name={leadingIcon} size={isSmall ? 13 : 14} color={foreground} />
      ) : null}
      <label
        value={title}
        color={foreground}
        font={isSmall ? m.fonts.controlCompact : m.fonts.control}
        textAlign="center"
        numberOfLines={0}
      />
    </view>;
  }
}
