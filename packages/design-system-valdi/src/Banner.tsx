import { Component } from "valdi_core/src/Component";
import { Icon, IconName } from "./Icon";
import { themeColors, themeMetrics } from "./tokens";

type Tone = "info" | "success" | "warning" | "danger";

type Props = {
  id?: string;
  tone?: Tone;
  title: string;
  message?: string;
  actionTitle?: string;
  dismissLabel?: string;
  touch?: boolean;
  dark?: boolean;
  onAction?(): void;
  onDismiss?(): void;
};

const toneIcons: Record<Tone, IconName> = {
  info: "info",
  success: "check",
  warning: "warning",
  danger: "warning",
};

/** Compact OpenCraft inline callout banner (macOS + iPadOS adaptive). */
export class Banner extends Component<Props> {
  onRender(): void {
    const {
      id,
      tone = "info",
      title,
      message,
      actionTitle,
      dismissLabel,
      touch,
      dark,
      onAction,
      onDismiss,
    } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const bg =
      tone === "success"
        ? c.successSurface
        : tone === "warning"
          ? c.warningSurface
          : tone === "danger"
            ? c.dangerSurface
            : c.trackSubtle;
    const fg = tone === "success" ? c.success : tone === "warning" ? c.warning : tone === "danger" ? c.danger : c.muted;
    const icon = toneIcons[tone];

    <view
      accessibilityId={id}
      paddingLeft={12}
      paddingRight={12}
      paddingTop={10}
      paddingBottom={10}
      borderRadius={m.radii.control + 2}
      backgroundColor={bg}
      borderWidth={0.5}
      borderColor={c.border}
      flexDirection="row"
      alignItems="flex-start"
      gap={10}
    >
      <view paddingTop={2} accessibilityNavigation="ignored">
        <Icon name={icon} size={15} color={fg} />
      </view>
      <view flexGrow={1} flexShrink={1} minWidth={0} gap={2}>
        <label value={title} font={m.fonts.control} color={c.ink} numberOfLines={0} />
        {message && <label value={message} font={m.fonts.detail} color={c.muted} numberOfLines={0} />}
      </view>
      {actionTitle && onAction && (
        <view
          class="oc-pill-button"
          accessibilityId={id ? `${id}-action` : "banner-action"}
          accessibilityLabel={actionTitle}
          accessibilityCategory="button"
          onTap={onAction}
          minHeight={m.sizes.buttonSmHeight}
          paddingLeft={10}
          paddingRight={10}
          borderRadius={m.radii.control - 1}
          backgroundColor={c.surface}
          borderWidth={0.5}
          borderColor={c.border}
          justifyContent="center"
          alignItems="center"
        >
          <label value={actionTitle} font={m.fonts.controlCompact} color={c.ink} />
        </view>
      )}
      {onDismiss && (
        <view
          accessibilityId={id ? `${id}-dismiss` : "banner-dismiss"}
          accessibilityLabel={dismissLabel ?? title}
          accessibilityCategory="button"
          onTap={onDismiss}
          width={24}
          height={24}
          justifyContent="center"
          alignItems="center"
        >
          <Icon name="close" size={12} color={c.muted} />
        </view>
      )}
    </view>;
  }
}
