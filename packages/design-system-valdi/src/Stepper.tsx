import { Component } from "valdi_core/src/Component";
import { triggerHaptic } from "./haptics";
import { Icon } from "./Icon";
import { themeColors, themeMetrics } from "./tokens";

type Props = {
  id: string;
  label: string;
  decrementLabel?: string;
  incrementLabel?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  touch?: boolean;
  disabled?: boolean;
  dark?: boolean;
  onChange(value: number): void;
};

/** Adaptive OpenCraft compact stepper (72x28 desktop, 86x36 touch). */
export class Stepper extends Component<Props> {
  onRender(): void {
    const {
      id,
      label,
      decrementLabel,
      incrementLabel,
      value,
      min = 0,
      max = 100,
      step = 1,
      touch,
      disabled,
      dark,
      onChange,
    } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const canDecrement = !disabled && value - step >= min;
    const canIncrement = !disabled && value + step <= max;
    const width = m.touch ? 86 : 72;
    const height = m.touch ? 36 : 28;

    <view accessibilityId={id} accessibilityLabel={label} minHeight={height} justifyContent="center">
      <view
        width={width}
        height={height}
        borderRadius={m.radii.control}
        backgroundColor={c.trackSoft}
        borderWidth={0.5}
        borderColor={c.border}
        flexDirection="row"
        alignItems="center"
        opacity={disabled ? 0.45 : 1}
      >
        <view
          class="oc-pill-button"
          accessibilityId={`${id}-decrement`}
          accessibilityLabel={decrementLabel ?? `${label} -`}
          accessibilityCategory="button"
          accessibilityStateDisabled={!canDecrement}
          onTap={
            canDecrement
              ? () => {
                  triggerHaptic("light");
                  onChange(Math.max(min, value - step));
                }
              : undefined
          }
          flexGrow={1}
          flexBasis={0}
          height="100%"
          justifyContent="center"
          alignItems="center"
        >
          <Icon name="minus" size={13} color={canDecrement ? c.ink : c.disabled} />
        </view>
        <view width={0.5} height={height - 10} backgroundColor={c.border} />
        <view
          class="oc-pill-button"
          accessibilityId={`${id}-increment`}
          accessibilityLabel={incrementLabel ?? `${label} +`}
          accessibilityCategory="button"
          accessibilityStateDisabled={!canIncrement}
          onTap={
            canIncrement
              ? () => {
                  triggerHaptic("light");
                  onChange(Math.min(max, value + step));
                }
              : undefined
          }
          flexGrow={1}
          flexBasis={0}
          height="100%"
          justifyContent="center"
          alignItems="center"
        >
          <Icon name="plus" size={13} color={canIncrement ? c.ink : c.disabled} />
        </view>
      </view>
    </view>;
  }
}
