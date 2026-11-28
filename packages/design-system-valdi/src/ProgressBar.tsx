import { Component } from "valdi_core/src/Component";
import { radii, themeColors, themeMetrics } from "./tokens";

type Props = {
  id?: string;
  label: string;
  progress: number;
  detail?: string;
  tone?: "accent" | "warning";
  touch?: boolean;
  dark?: boolean;
};

/** Adaptive linear progress indicator with optional status detail. */
export class ProgressBar extends Component<Props> {
  onRender(): void {
    const { id, label, progress, detail, tone, touch, dark } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const clamped = Math.max(0, Math.min(1, progress));
    const percent = `${Math.round(clamped * 100)}%`;
    <view accessibilityId={id} accessibilityLabel={`${label} ${percent}`} gap={5}>
      <view flexDirection="row" alignItems="center" justifyContent="space-between" gap={8}>
        <label value={label} font={m.fonts.detail} color={c.ink} flexGrow={1} flexShrink={1} />
        <label value={detail ?? percent} font={m.fonts.detail} color={c.muted} />
      </view>
      <view width="100%" height={5} borderRadius={radii.pill} backgroundColor={c.trackSoft} slowClipping={true}>
        <view
          width={percent}
          height="100%"
          borderRadius={radii.pill}
          backgroundColor={tone === "warning" ? c.warning : c.accent}
        />
      </view>
    </view>;
  }
}
