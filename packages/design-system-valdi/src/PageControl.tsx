import { Component } from "valdi_core/src/Component";
import { radii, themeColors } from "./tokens";

type Props = {
  id: string;
  label: string;
  count: number;
  current: number;
  showBackground?: boolean;
  dark?: boolean;
  onChange?(index: number): void;
};

/** Cross-platform iOS-style dot page indicator with optional capsule backdrop. */
export class PageControl extends Component<Props> {
  onRender(): void {
    const { id, label, count, current, showBackground = true, dark, onChange } = this.viewModel;
    const c = themeColors(dark);
    const indices = Array.from({ length: Math.max(0, count) }, (_, index) => index);
    <view accessibilityId={id} accessibilityLabel={label} minHeight={36} justifyContent="center" alignItems="center">
      <view
        flexDirection="row"
        alignItems="center"
        gap={8}
        paddingLeft={showBackground ? 12 : 0}
        paddingRight={showBackground ? 12 : 0}
        height={24}
        borderRadius={radii.pill}
        backgroundColor={showBackground ? c.trackSoft : undefined}
      >
        {indices.forEach((index) => {
          const selected = index === current;
          <view
            key={String(index)}
            accessibilityId={`${id}-dot-${index}`}
            accessibilityLabel={`${label} ${index + 1}`}
            accessibilityCategory={onChange ? "button" : "view"}
            accessibilityStateSelected={selected}
            onTap={onChange ? () => onChange(index) : undefined}
            width={10}
            height={10}
            justifyContent="center"
            alignItems="center"
          >
            <view width={8} height={8} borderRadius={4} backgroundColor={selected ? c.ink : c.trackOff} />
          </view>;
        })}
      </view>
    </view>;
  }
}
