import { Component, StatefulComponent } from "valdi_core/src/Component";
import { triggerHaptic } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { themeColors, themeMetrics } from "./tokens";

type PageHeaderProps = {
  title: string;
  description?: string;
  touch?: boolean;
  dark?: boolean;
};

/** Canonical OpenCraft Settings page header matching `.settings-control-page-header`. */
export class SettingsPageHeader extends Component<PageHeaderProps> {
  onRender(): void {
    const { title, description, touch, dark } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);

    <view width="100%" flexDirection="row" alignItems="flex-start" justifyContent="space-between" gap={16}>
      <view flexGrow={1} flexShrink={1} minWidth={0} gap={8}>
        <label value={title} font={m.fonts.pageTitle} color={c.ink} accessibilityCategory="header" numberOfLines={0} />
        {description ? (
          <label value={description} font={m.fonts.pageSummary} color={c.muted} numberOfLines={0} />
        ) : null}
      </view>
      <slot />
    </view>;
  }
}

type GroupProps = {
  title: string;
  description?: string;
  appearance?: "card" | "plain";
  clip?: boolean;
  zIndex?: number;
  touch?: boolean;
  dark?: boolean;
};

/** OpenCraft Settings section + grouped card container matching `.settings-control-section` / `.settings-control-group`. */
export class SettingsGroup extends Component<GroupProps> {
  onRender(): void {
    const { title, description, appearance = "card", clip = true, zIndex, touch, dark } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const hasHeading = Boolean(title || description);
    const isPlain = appearance === "plain";

    <view width="100%" gap={hasHeading ? 12 : 0} zIndex={zIndex}>
      {hasHeading && (
        <view width="100%" gap={4}>
          {title ? (
            <label
              value={title}
              color={c.ink}
              font={m.fonts.sectionTitle}
              accessibilityCategory="header"
              numberOfLines={0}
            />
          ) : null}
          {description ? <label value={description} color={c.muted} font={m.fonts.detail} numberOfLines={0} /> : null}
        </view>
      )}
      {isPlain ? (
        <view width="100%">
          <slot />
        </view>
      ) : (
        <view
          class="oc-settings-group"
          width="100%"
          borderRadius={m.radii.card}
          backgroundColor={c.surface}
          borderWidth={0.5}
          borderColor={c.border}
          slowClipping={clip}
        >
          <slot />
        </view>
      )}
    </view>;
  }
}

type FormRowProps = {
  title: string;
  description?: string;
  divider?: boolean;
  stacked?: boolean;
  touch?: boolean;
  dark?: boolean;
};

/** Canonical two-column OpenCraft Settings control row matching `.settings-control-row`. */
export class SettingsFormRow extends Component<FormRowProps> {
  onRender(): void {
    const { title, description, divider = false, stacked = false, touch, dark } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);

    <view width="100%">
      {divider && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
      <view
        width="100%"
        minHeight={m.sizes.rowMinHeight}
        paddingLeft={m.sizes.rowPaddingX}
        paddingRight={m.sizes.rowPaddingX}
        paddingTop={stacked ? 16 : m.sizes.rowPaddingY}
        paddingBottom={stacked ? 16 : m.sizes.rowPaddingY}
        flexDirection={stacked ? "column" : "row"}
        alignItems={stacked ? "stretch" : "center"}
        justifyContent="space-between"
        gap={stacked ? 12 : 20}
      >
        <view flexGrow={1} flexShrink={1} minWidth={0} gap={4}>
          <label value={title} font={m.fonts.rowTitle} color={c.ink} numberOfLines={0} />
          {description ? <label value={description} font={m.fonts.detail} color={c.muted} numberOfLines={0} /> : null}
        </view>
        <view flexShrink={0} alignItems={stacked ? "stretch" : "center"} justifyContent="flex-end">
          <slot />
        </view>
      </view>
    </view>;
  }
}

type ListItemStatusTone = "active" | "inactive" | "warning" | "danger";

type ListItemProps = {
  id: string;
  title: string;
  openLabel?: string;
  description?: string;
  metadata?: string;
  error?: string;
  icon?: IconName;
  statusTone?: ListItemStatusTone;
  divider?: boolean;
  touch?: boolean;
  dark?: boolean;
  onOpen?(): void;
};

/**
 * Canonical OpenCraft object list row matching `.settings-control-list-item`,
 * with unified 10px-rounded inset hover container and trailing action slot.
 */
export class SettingsListItem extends Component<ListItemProps> {
  private statusColor(tone: ListItemStatusTone, dark?: boolean): string {
    const c = themeColors(dark);
    if (tone === "active") return c.success;
    if (tone === "danger") return c.danger;
    if (tone === "warning") return c.warning;
    return c.disabled;
  }

  onRender(): void {
    const {
      id,
      title,
      openLabel,
      description,
      metadata,
      error,
      icon,
      statusTone,
      divider = false,
      touch,
      dark,
      onOpen,
    } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);

    <view width="100%">
      {divider && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
      <view width="100%" paddingLeft={6} paddingRight={6} paddingTop={4} paddingBottom={4}>
        <view
          class="oc-settings-row"
          width="100%"
          minHeight={m.sizes.rowMinHeight - 8}
          paddingLeft={10}
          paddingRight={8}
          paddingTop={8}
          paddingBottom={8}
          borderRadius={m.radii.control + 2}
          flexDirection="row"
          alignItems="center"
          gap={12}
        >
          <view
            accessibilityId={id}
            accessibilityLabel={openLabel ?? title}
            accessibilityCategory={onOpen ? "button" : undefined}
            onTap={
              onOpen
                ? () => {
                    triggerHaptic("selection");
                    onOpen();
                  }
                : undefined
            }
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            flexDirection="row"
            alignItems="center"
            gap={12}
          >
            {icon && (
              <view
                width={32}
                height={32}
                borderRadius={m.radii.iconBox}
                backgroundColor={c.recessed}
                borderWidth={0.5}
                borderColor={c.border}
                alignItems="center"
                justifyContent="center"
                accessibilityNavigation="ignored"
              >
                <Icon name={icon} size={16} color={c.muted} />
              </view>
            )}
            <view flexGrow={1} flexShrink={1} minWidth={0} gap={3}>
              <view flexDirection="row" alignItems="center" gap={6}>
                <label value={title} font={m.fonts.rowTitle} color={c.ink} flexShrink={1} numberOfLines={1} />
                {statusTone && (
                  <view
                    width={6}
                    height={6}
                    borderRadius={3}
                    backgroundColor={this.statusColor(statusTone, dark)}
                    accessibilityNavigation="ignored"
                  />
                )}
              </view>
              {description ? (
                <label value={description} font={m.fonts.detail} color={c.muted} numberOfLines={2} />
              ) : null}
              {metadata ? <label value={metadata} font={m.fonts.caption} color={c.muted} numberOfLines={1} /> : null}
              {error ? <label value={error} font={m.fonts.detail} color={c.danger} numberOfLines={2} /> : null}
            </view>
          </view>
          <view flexDirection="row" alignItems="center" gap={6}>
            <slot />
          </view>
        </view>
      </view>
    </view>;
  }
}

type RowProps = {
  id: string;
  title: string;
  detail?: string;
  selected?: boolean;
  disabled?: boolean;
  divider?: boolean;
  touch?: boolean;
  dark?: boolean;
  onSelect(): void;
};

type RowState = { pressing: boolean };

export class SettingsRow extends StatefulComponent<RowProps, RowState> {
  state: RowState = { pressing: false };

  onRender(): void {
    const { id, title, detail, selected, disabled, divider, touch, dark, onSelect } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const pressing = this.state.pressing && !disabled;

    <view width="100%">
      {divider && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
      <view width="100%" paddingLeft={6} paddingRight={6} paddingTop={4} paddingBottom={4}>
        <view
          class="oc-settings-row"
          width="100%"
          minHeight={m.sizes.rowMinHeight - 8}
          paddingLeft={m.sizes.rowPaddingX - 6}
          paddingRight={m.sizes.rowPaddingX - 6}
          paddingTop={6}
          paddingBottom={6}
          borderRadius={m.radii.control + 2}
          gap={8}
          flexDirection="row"
          alignItems="center"
          backgroundColor={pressing ? c.trackSubtle : undefined}
          accessibilityId={id}
          accessibilityLabel={detail ? `${title}, ${detail}` : title}
          accessibilityCategory="button"
          accessibilityStateSelected={selected}
          accessibilityStateDisabled={disabled}
          onTouchStart={disabled ? undefined : () => this.setState({ pressing: true })}
          onTouchEnd={disabled ? undefined : () => this.setState({ pressing: false })}
          onTap={disabled ? undefined : onSelect}
        >
          <label
            value={title}
            font={m.fonts.body}
            color={disabled ? c.disabled : c.ink}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            numberOfLines={0}
          />
          {detail && (
            <label
              value={detail}
              font={m.fonts.detail}
              color={disabled ? c.disabled : c.muted}
              maxWidth="58%"
              flexShrink={1}
              textAlign="right"
              numberOfLines={1}
            />
          )}
          {!disabled && (
            <view width={16} alignItems="flex-end" justifyContent="center" accessibilityNavigation="ignored">
              <Icon name={selected ? "check" : "chevronRight"} size={14} color={selected ? c.accent : c.disabled} />
            </view>
          )}
        </view>
      </view>
    </view>;
  }
}
