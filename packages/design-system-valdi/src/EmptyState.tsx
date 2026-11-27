import { Component } from "valdi_core/src/Component";
import { Button } from "./Button";
import { Icon, IconName } from "./Icon";
import { themeColors, themeMetrics } from "./tokens";

type Props = {
  id?: string;
  icon?: IconName;
  title: string;
  description: string;
  actionTitle?: string;
  touch?: boolean;
  dark?: boolean;
  onAction?(): void;
};

/** Quiet OpenCraft empty state container with neutral icon tile and optional action. */
export class EmptyState extends Component<Props> {
  onRender(): void {
    const { id, icon = "sparkle", title, description, actionTitle, touch, dark, onAction } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);

    <view
      accessibilityId={id}
      padding={24}
      borderRadius={m.radii.card}
      backgroundColor={c.surface}
      borderWidth={0.5}
      borderColor={c.border}
      alignItems="center"
      gap={8}
    >
      <view
        width={36}
        height={36}
        borderRadius={m.radii.iconBox}
        backgroundColor={c.recessed}
        borderWidth={0.5}
        borderColor={c.border}
        alignItems="center"
        justifyContent="center"
        accessibilityNavigation="ignored"
      >
        <Icon name={icon} size={18} color={c.muted} />
      </view>
      <label value={title} font={m.fonts.sectionTitle} color={c.ink} textAlign="center" numberOfLines={0} />
      <label value={description} font={m.fonts.detail} color={c.muted} textAlign="center" numberOfLines={0} />
      {actionTitle && onAction && (
        <view paddingTop={6}>
          <Button
            id={id ? `${id}-action` : "empty-state-action"}
            title={actionTitle}
            touch={touch}
            dark={dark}
            onPress={onAction}
          />
        </view>
      )}
    </view>;
  }
}
