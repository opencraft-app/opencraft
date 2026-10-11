import type {CSSProperties, MouseEvent} from "react";
import {useState} from "react";
import {useUnistyles} from "react-native-unistyles";

import type {
  SystemButtonProps,
  SystemButtonVariant,
  SystemButtonVisualState,
  SystemIconButtonProps,
} from "./system-button.types";
import {webTypography} from "./web-typography";
import {densityScale} from "../tokens";
import {useSystemWindowActive} from "../system-window-state";

export type {
  SystemButtonProps,
  SystemButtonVariant,
  SystemIconButtonProps,
} from "./system-button.types";

type InteractionState = SystemButtonVisualState;

function actionColors(
  theme: ReturnType<typeof useUnistyles>["theme"],
  variant: SystemButtonVariant,
  state: InteractionState,
) {
  const destructive = variant === "destructive";
  const toolbar = variant === "toolbar";
  return {
    background: state === "pressed"
      ? theme.semantic.color.interactivePressedSurface
      : state === "hovered"
        ? theme.semantic.color.interactiveHoverSurface
        : destructive
          ? theme.semantic.color.actionDangerSurface
          : toolbar
            ? theme.semantic.color.surfaceTransparent
            : theme.semantic.color.actionSecondarySurface,
    borderColor: destructive
      ? theme.semantic.color.actionDangerBorder
      : toolbar
        ? theme.semantic.color.borderTransparent
        : theme.semantic.color.borderControl,
    color: destructive
      ? theme.semantic.color.actionDangerText
      : theme.semantic.color.actionSecondaryText,
    iconColor: destructive
      ? theme.semantic.color.statusDanger
      : toolbar
        ? theme.semantic.color.iconSecondary
        : theme.semantic.color.iconPrimary,
  };
}

export function SystemButton({
  accessibilityLabel,
  align = "start",
  busy = false,
  density,
  disabled = false,
  icon: Icon,
  iconTestID,
  label,
  nativeID,
  onPress,
  testID,
  variant = "standard",
  visualState,
}: SystemButtonProps) {
  const {theme} = useUnistyles();
  const windowActive = useSystemWindowActive();
  const [state, setState] = useState<InteractionState>("idle");
  const unavailable = disabled || busy;
  const effectiveState = visualState ?? state;
  const colors = actionColors(theme, variant, effectiveState);
  const toolbar = variant === "toolbar";
  const style: CSSProperties = {
    ...webTypography(theme.semantic.typography.button),
    alignItems: "center",
    alignSelf: align === "center" ? "center" : align === "stretch" ? "stretch" : "flex-start",
    appearance: "none",
    background: colors.background,
    border: `${theme.semantic.stroke.hairline}px solid ${colors.borderColor}`,
    borderRadius: theme.semantic.radius.control,
    boxSizing: "border-box",
    color: colors.color,
    cursor: unavailable ? "not-allowed" : "default",
    display: "inline-flex",
    gap: theme.spacing.sm,
    height: density
      ? toolbar
        ? densityScale[density].headerActionHeight
        : densityScale[density].controlHeight
      : toolbar
        ? theme.recipes.managementWorkspace.headerActionHeight
        : theme.recipes.control.height,
    justifyContent: "center",
    opacity: unavailable
      ? theme.semantic.interaction.disabledOpacity
      : windowActive
        ? 1
        : theme.semantic.opacity.inactive,
    outline: effectiveState === "focused"
      ? `${theme.semantic.interaction.focusRingWidth}px solid ${theme.semantic.color.borderFocus}`
      : "none",
    outlineOffset: effectiveState === "focused" ? 1 : undefined,
    padding: `0 ${toolbar ? theme.spacing.md : theme.spacing.lg}px`,
    position: "relative",
    transitionDuration: `${theme.semantic.motion.duration.feedback}ms`,
    transitionProperty: "background-color, border-color, color, opacity, transform",
    transitionTimingFunction: theme.semantic.motion.easing.standard,
    transform: effectiveState === "pressed"
      ? `scale(${theme.semantic.interaction.pressedScaleSubtle})`
      : effectiveState === "hovered" && !toolbar
        ? "translateY(-1px)"
        : "none",
    width: align === "stretch" ? "100%" : undefined,
  };
  const enter = () => {
    if (!unavailable) setState("hovered");
  };
  const leave = () => setState("idle");
  const down = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.button === 0 && !unavailable) setState("pressed");
  };
  return (
    <button
      aria-busy={busy}
      aria-label={accessibilityLabel ?? label}
      data-testid={testID}
      disabled={unavailable}
      id={nativeID}
      onBlur={leave}
      onFocus={() => setState("focused")}
      onClick={onPress}
      onMouseDown={down}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onMouseUp={enter}
      style={style}
      type="button"
    >
      {Icon ? (
        <Icon
          color={colors.iconColor}
          size={theme.semantic.icon.size.small}
          strokeWidth={theme.semantic.icon.stroke.emphasis}
          testID={iconTestID}
        />
      ) : null}
      <span style={{opacity: busy ? 0 : 1}}>{label}</span>
      {busy ? (
        <span aria-hidden style={{color: colors.iconColor, position: "absolute"}}>…</span>
      ) : null}
    </button>
  );
}

export function SystemIconButton({
  accessibilityLabel,
  busy = false,
  density,
  disabled = false,
  icon: Icon,
  iconTestID,
  nativeID,
  onPress,
  testID,
  variant = "toolbar",
  visualState,
}: SystemIconButtonProps) {
  const {theme} = useUnistyles();
  const windowActive = useSystemWindowActive();
  const [state, setState] = useState<InteractionState>("idle");
  const unavailable = disabled || busy;
  const effectiveState = visualState ?? state;
  const colors = actionColors(theme, variant, effectiveState);
  const size = density
    ? densityScale[density].headerActionHeight
    : theme.recipes.managementWorkspace.headerActionHeight;
  return (
    <button
      aria-busy={busy}
      aria-label={accessibilityLabel}
      data-testid={testID}
      disabled={unavailable}
      id={nativeID}
      onBlur={() => setState("idle")}
      onFocus={() => setState("focused")}
      onClick={onPress}
      onMouseDown={(event) => {
        if (event.button === 0 && !unavailable) setState("pressed");
      }}
      onMouseEnter={() => {
        if (!unavailable) setState("hovered");
      }}
      onMouseLeave={() => setState("idle")}
      onMouseUp={() => {
        if (!unavailable) setState("hovered");
      }}
      style={{
        alignItems: "center",
        appearance: "none",
        background: colors.background,
        border: `${theme.semantic.stroke.hairline}px solid ${colors.borderColor}`,
        borderRadius: theme.semantic.radius.compactControl,
        boxSizing: "border-box",
        cursor: unavailable ? "not-allowed" : "default",
        display: "inline-flex",
        height: size,
        justifyContent: "center",
        opacity: unavailable
          ? theme.semantic.interaction.disabledOpacity
          : windowActive
            ? 1
            : theme.semantic.opacity.inactive,
        outline: effectiveState === "focused"
          ? `${theme.semantic.interaction.focusRingWidth}px solid ${theme.semantic.color.borderFocus}`
          : "none",
        outlineOffset: effectiveState === "focused" ? 1 : undefined,
        padding: 0,
        position: "relative",
        transitionDuration: `${theme.semantic.motion.duration.feedback}ms`,
        transitionProperty: "background-color, border-color, opacity, transform",
        transitionTimingFunction: theme.semantic.motion.easing.standard,
        width: size,
      }}
      type="button"
    >
      <Icon
        color={colors.iconColor}
        size={theme.semantic.icon.size.medium}
        strokeWidth={theme.semantic.icon.stroke.emphasis}
        testID={iconTestID}
      />
      {busy ? (
        <span aria-hidden style={{color: colors.iconColor, position: "absolute"}}>…</span>
      ) : null}
    </button>
  );
}
