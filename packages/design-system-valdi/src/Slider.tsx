import { AnimationCurve } from "valdi_core/src/AnimationOptions";
import { StatefulComponent } from "valdi_core/src/Component";
import { triggerHaptic } from "./haptics";
import { Icon, IconName } from "./Icon";
import { radii, themeColors, themeMetrics } from "./tokens";

type Props = {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  touch?: boolean;
  disabled?: boolean;
  dark?: boolean;
  minIcon?: IconName;
  maxIcon?: IconName;
  onChange(value: number): void;
};

type State = { trackWidth: number; displayedValue: number; pressing: boolean };

/** Adaptive OpenCraft slider with circular precision knob (18px desktop, 22px touch). */
export class Slider extends StatefulComponent<Props, State> {
  state: State = { trackWidth: 0, displayedValue: 0, pressing: false };

  onCreate(): void {
    this.setState({ displayedValue: this.viewModel.value });
  }

  onViewModelUpdate(previousViewModel?: Readonly<Props>): void {
    if (
      !previousViewModel ||
      (previousViewModel.value !== this.viewModel.value && this.viewModel.value !== this.state.displayedValue)
    ) {
      this.setState({ displayedValue: this.viewModel.value });
    }
  }

  private knobSize(): number {
    return themeMetrics(this.viewModel.touch).touch ? 22 : 18;
  }

  private resolveValue(x: number): number | undefined {
    const { min = 0, max = 100, step = 1 } = this.viewModel;
    const knob = this.knobSize();
    const usable = this.state.trackWidth - knob;
    if (usable <= 0 || max <= min) return undefined;
    const ratio = Math.max(0, Math.min(1, (x - knob / 2) / usable));
    const raw = min + ratio * (max - min);
    const snapped = Math.round((raw - min) / step) * step + min;
    return Math.max(min, Math.min(max, Number(snapped.toFixed(4))));
  }

  private updateFromX(x: number, animated: boolean): void {
    const next = this.resolveValue(x);
    if (next === undefined) return;
    const { min = 0, max = 100 } = this.viewModel;
    const prev = this.state.displayedValue;
    if ((next === min || next === max) && next !== prev) {
      triggerHaptic("light");
    } else if (animated && next !== prev) {
      triggerHaptic("selection");
    }
    if (animated && next !== prev) {
      this.animate({ duration: 0.14, curve: AnimationCurve.EaseOut }, () => {
        this.setState({ displayedValue: next });
      });
    } else {
      this.setState({ displayedValue: next });
    }
    this.viewModel.onChange(next);
  }

  private setPressing(pressing: boolean): void {
    if (this.state.pressing === pressing) return;
    this.animate({ duration: 0.12, curve: AnimationCurve.EaseOut }, () => {
      this.setState({ pressing });
    });
  }

  onRender(): void {
    const { id, label, min = 0, max = 100, touch, disabled, dark, minIcon, maxIcon } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const knob = m.touch ? 22 : 18;
    const hitHeight = m.touch ? 40 : 28;
    const ratio = max > min ? Math.max(0, Math.min(1, (this.state.displayedValue - min) / (max - min))) : 0;
    const usable = Math.max(0, this.state.trackWidth - knob);
    const knobLeft = Math.round(ratio * usable);
    const pressing = this.state.pressing && !disabled;

    <view width="100%" flexDirection="row" alignItems="center" gap={10} opacity={disabled ? 0.45 : 1}>
      {minIcon && <Icon name={minIcon} size={15} color={c.muted} />}
      <view
        class="oc-slider-track"
        accessibilityId={id}
        accessibilityLabel={label}
        accessibilityValue={`${this.state.displayedValue}`}
        accessibilityStateDisabled={disabled}
        flexGrow={1}
        flexBasis={0}
        minWidth={0}
        height={hitHeight}
        justifyContent="center"
        onLayout={(frame) => {
          if (frame.width > 0 && frame.width !== this.state.trackWidth) this.setState({ trackWidth: frame.width });
        }}
        onTouchStart={disabled ? undefined : () => this.setPressing(true)}
        onTouchEnd={disabled ? undefined : () => this.setPressing(false)}
        onTap={disabled ? undefined : (event) => this.updateFromX(event.x, true)}
        onDrag={
          disabled
            ? undefined
            : (event) => {
                this.setPressing(event.state !== 2);
                this.updateFromX(event.x, false);
              }
        }
      >
        <view width="100%" height={4} borderRadius={radii.pill} backgroundColor={c.trackSoft} slowClipping={true}>
          <view
            width={`${Math.round(ratio * 1000) / 10}%`}
            height="100%"
            backgroundColor={disabled ? c.disabled : c.accent}
          />
        </view>
        <view
          class="oc-slider-knob"
          position="absolute"
          left={knobLeft}
          width={knob}
          height={knob}
          borderRadius={radii.pill}
          backgroundColor="#FFFFFF"
          borderWidth={0.5}
          borderColor={c.border}
          scaleX={pressing ? 1.08 : 1}
          scaleY={pressing ? 1.08 : 1}
          boxShadow="complex 0 1 3 rgba(0, 0, 0, 0.18)"
          accessibilityNavigation="ignored"
        />
      </view>
      {maxIcon && <Icon name={maxIcon} size={16} color={c.muted} />}
    </view>;
  }
}
