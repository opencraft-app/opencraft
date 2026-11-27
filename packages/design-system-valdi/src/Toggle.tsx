import { AnimationCurve } from "valdi_core/src/AnimationOptions";
import { StatefulComponent } from "valdi_core/src/Component";
import { triggerHaptic } from "./haptics";
import { radii, themeColors, themeMetrics } from "./tokens";

type Props = {
  id: string;
  label: string;
  value: boolean;
  touch?: boolean;
  disabled?: boolean;
  dark?: boolean;
  onChange(value: boolean): void;
};

type State = { checked: boolean };

/**
 * Adaptive OpenCraft switch matching `.settings-control-switch` (36x20 desktop, 44x26 touch).
 * Animates via pure GPU transform (`translationX`) with `beginFromCurrentState: true`
 * to prevent layout-snapshot jumps or CSS transition collisions.
 */
export class Toggle extends StatefulComponent<Props, State> {
  state: State = { checked: false };

  onCreate(): void {
    this.setState({ checked: this.viewModel.value });
  }

  onViewModelUpdate(previousViewModel?: Readonly<Props>): void {
    if (!previousViewModel) {
      if (this.viewModel.value !== this.state.checked) {
        this.setState({ checked: this.viewModel.value });
      }
      return;
    }
    if (previousViewModel.value !== this.viewModel.value && this.viewModel.value !== this.state.checked) {
      this.animate({ duration: 0.16, curve: AnimationCurve.EaseOut, beginFromCurrentState: true }, () => {
        this.setState({ checked: this.viewModel.value });
      });
    }
  }

  private toggle(): void {
    const next = !this.state.checked;
    triggerHaptic("light");
    this.animate({ duration: 0.16, curve: AnimationCurve.EaseOut, beginFromCurrentState: true }, () => {
      this.setState({ checked: next });
    });
    this.viewModel.onChange(next);
  }

  onRender(): void {
    const { id, label, touch, disabled, dark } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const checked = this.state.checked;
    const trackW = m.sizes.switchWidth;
    const trackH = m.sizes.switchHeight;
    const thumbSize = m.sizes.switchThumb;
    const inset = (trackH - thumbSize) / 2;
    const travel = trackW - inset * 2 - thumbSize;

    <view
      class="oc-switch"
      accessibilityId={id}
      accessibilityLabel={label}
      accessibilityCategory="checkbox"
      accessibilityStateSelected={checked}
      accessibilityStateDisabled={disabled}
      onTap={disabled ? undefined : () => this.toggle()}
      minWidth={m.sizes.switchHitWidth}
      minHeight={m.sizes.switchHitHeight}
      justifyContent="center"
      alignItems="flex-end"
    >
      <view
        class="oc-toggle-track"
        width={trackW}
        height={trackH}
        borderRadius={radii.pill}
        backgroundColor={checked ? c.toggleOn : c.trackOff}
        opacity={disabled ? 0.45 : 1}
      >
        <view
          class="oc-toggle-knob"
          position="absolute"
          top={inset}
          left={inset}
          width={thumbSize}
          height={thumbSize}
          translationX={checked ? travel : 0}
          borderRadius={radii.pill}
          backgroundColor={c.toggleThumb}
          boxShadow="complex 0 1 2 rgba(0, 0, 0, 0.18)"
          accessibilityNavigation="ignored"
        />
      </view>
    </view>;
  }
}
