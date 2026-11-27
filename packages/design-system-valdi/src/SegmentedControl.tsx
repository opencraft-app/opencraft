import { StatefulComponent } from "valdi_core/src/Component";
import { systemFont, systemMediumFont } from "valdi_core/src/SystemFont";
import { triggerHaptic } from "./haptics";
import { themeColors, themeMetrics } from "./tokens";

type Option = { id: string; title: string; disabled?: boolean };
type Props = {
  id: string;
  label: string;
  value: string;
  options: readonly Option[];
  disabled?: boolean;
  compact?: boolean;
  touch?: boolean;
  dark?: boolean;
  onChange(value: string): void;
};
type State = { displayedIndex: number };

/** Adaptive OpenCraft inset SegmentedControl (macOS 9px/7px rounded-rect + iPadOS touch density). */
export class SegmentedControl extends StatefulComponent<Props, State> {
  state: State = { displayedIndex: 0 };

  private resolveIndex(): number {
    return this.viewModel.options.findIndex((option) => option.id === this.viewModel.value);
  }

  onCreate(): void {
    this.setState({ displayedIndex: this.resolveIndex() });
  }

  onViewModelUpdate(previousViewModel?: Readonly<Props>): void {
    const nextIndex = this.resolveIndex();
    if (
      !previousViewModel ||
      (previousViewModel.value !== this.viewModel.value && nextIndex !== this.state.displayedIndex)
    ) {
      this.setState({ displayedIndex: nextIndex });
    }
  }

  private selectOption(index: number, id: string): void {
    if (index >= 0 && index !== this.state.displayedIndex) {
      triggerHaptic("selection");
      this.setState({ displayedIndex: index });
    }
    this.viewModel.onChange(id);
  }

  onRender(): void {
    const { id, label, value, options, disabled, compact, touch, dark } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const displayedIndex = this.state.displayedIndex;
    const segmentWidth = options.length ? 100 / options.length : 0;
    const optionHeight = compact ? m.sizes.segmentCompactHeight : m.sizes.segmentHeight;
    const fontSize = m.touch ? (compact ? 13 : 13.5) : compact ? 12 : 12.5;
    const maxUnits = options.reduce((max, option) => {
      let units = 0;
      for (let i = 0; i < option.title.length; i++) {
        units += option.title.charCodeAt(i) > 255 ? 1.85 : 1;
      }
      return Math.max(max, units);
    }, 0);
    const minOptionWidth = Math.ceil(maxUnits * (fontSize * 0.62) + 22);

    <view
      class="oc-segment-track"
      accessibilityId={id}
      accessibilityLabel={label}
      minWidth={0}
      maxWidth="100%"
      flexShrink={1}
      borderRadius={m.radii.segmentTrack}
      backgroundColor={c.trackSubtle}
      borderWidth={0.5}
      borderColor={c.border}
      padding={2.5}
      opacity={disabled ? 0.5 : 1}
    >
      <view class="oc-segment-options" flexDirection="row" width="100%" minWidth={0} flexShrink={1}>
        {displayedIndex >= 0 && (
          <view
            class="oc-segment-thumb"
            position="absolute"
            left={`${displayedIndex * segmentWidth}%`}
            width={`${segmentWidth}%`}
            top={0}
            bottom={0}
            borderRadius={m.radii.segmentThumb}
            backgroundColor={c.segmentThumb}
            borderWidth={0.5}
            borderColor={c.border}
            boxShadow={dark ? "complex 0 1 2 rgba(0, 0, 0, 0.22)" : "complex 0 1 2 rgba(0, 0, 0, 0.06)"}
            accessibilityNavigation="ignored"
          />
        )}
        {options.forEach((option, index) => {
          const selected = option.id === value;
          const optionDisabled = disabled || option.disabled;
          <view
            key={option.id}
            class="oc-segment-option"
            accessibilityId={`${id}-${option.id}`}
            accessibilityLabel={option.title}
            accessibilityCategory="button"
            accessibilityStateSelected={selected}
            accessibilityStateDisabled={optionDisabled}
            onTap={optionDisabled ? undefined : () => this.selectOption(index, option.id)}
            flexGrow={1}
            flexShrink={1}
            flexBasis={minOptionWidth}
            minWidth={0}
            minHeight={optionHeight}
            paddingLeft={8}
            paddingRight={8}
            paddingTop={2}
            paddingBottom={2}
            justifyContent="center"
            alignItems="center"
            borderRadius={m.radii.segmentThumb}
          >
            <label
              value={option.title}
              font={selected ? systemMediumFont(fontSize) : systemFont(fontSize)}
              color={optionDisabled ? c.disabled : selected ? c.ink : c.muted}
              textAlign="center"
              numberOfLines={1}
            />
          </view>;
        })}
      </view>
    </view>;
  }
}
