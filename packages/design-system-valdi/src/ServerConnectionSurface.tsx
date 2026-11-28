import { StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { registerHapticHandler, triggerHaptic } from "./haptics";
import { Icon } from "./Icon";
import { SettingsGroup } from "./SettingsGroup";
import { TextField } from "./TextField";
import { themeColors, themeMetrics, type ColorTokens } from "./tokens";

export type ServerConnectionProps = {
  dark?: boolean;
  touch?: boolean;
  compact?: boolean;
  badgeLabel: string;
  title: string;
  subtitle: string;
  groupTitle: string;
  addressLabel: string;
  addressPlaceholder: string;
  addressHint: string;
  nameLabel: string;
  namePlaceholder: string;
  clearLabel: string;
  privacyTitle: string;
  privacyMessage: string;
  connectLabel: string;
  connectingLabel: string;
  cancelLabel?: string;
  initialUrl?: string;
  initialName?: string;
  pending?: boolean;
  error?: string;
  connectedMessage?: string;
  onConnect: (url: string, displayName: string) => void;
  onInputChange?: () => void;
  onCancel?: () => void;
  onHaptic?: (style: string) => void;
};

type State = {
  url: string;
  displayName: string;
};

/**
 * Adaptive OpenCraft server connection configuration surface (macOS desktop + iPadOS/mobile).
 */
export class ServerConnectionSurface extends StatefulComponent<ServerConnectionProps, State> {
  state: State = {
    url: "",
    displayName: "",
  };

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
    this.setState({
      url: this.viewModel.initialUrl ?? "",
      displayName: this.viewModel.initialName ?? "",
    });
  }

  onViewModelUpdate(previous?: Readonly<ServerConnectionProps>): void {
    registerHapticHandler(this.viewModel.onHaptic);
    if (previous && previous.initialUrl !== this.viewModel.initialUrl && this.viewModel.initialUrl !== undefined) {
      this.setState({ url: this.viewModel.initialUrl });
    }
  }

  private get c(): ColorTokens {
    return themeColors(this.viewModel.dark);
  }

  private submit(): void {
    const trimmedUrl = this.state.url.trim();
    if (!trimmedUrl || this.viewModel.pending) return;
    triggerHaptic("medium");
    this.viewModel.onConnect(trimmedUrl, this.state.displayName.trim());
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const c = this.c;
    const m = themeMetrics(vm.touch);
    const trimmedUrl = this.state.url.trim();
    const canSubmit = trimmedUrl.length > 0 && !vm.pending;

    <view
      width="100%"
      paddingLeft={vm.compact ? 4 : 0}
      paddingRight={vm.compact ? 4 : 0}
      paddingTop={vm.compact ? 4 : 0}
      paddingBottom={vm.compact ? 8 : 0}
    >
      <view width="100%" maxWidth={vm.compact ? 520 : undefined} gap={vm.compact ? 20 : 32}>
        <view flexDirection="row" alignItems="flex-start" justifyContent="space-between" gap={12}>
          <view flexGrow={1} flexShrink={1} minWidth={0} gap={6}>
            <label
              value={vm.title}
              font={vm.compact ? m.fonts.sectionTitle : m.fonts.pageTitle}
              color={c.ink}
              accessibilityCategory="header"
              numberOfLines={0}
            />
            <label
              value={vm.subtitle}
              font={vm.compact ? m.fonts.detail : m.fonts.pageSummary}
              color={c.muted}
              numberOfLines={0}
            />
          </view>
          {vm.cancelLabel && vm.onCancel && (
            <view
              class="oc-pill-button"
              accessibilityId="oc-server-connect-close"
              accessibilityLabel={vm.cancelLabel}
              accessibilityCategory="button"
              onTap={
                vm.pending
                  ? undefined
                  : () => {
                      triggerHaptic("selection");
                      vm.onCancel?.();
                    }
              }
              width={28}
              height={28}
              borderRadius={m.radii.control - 1}
              backgroundColor={c.trackSoft}
              borderWidth={0.5}
              borderColor={c.border}
              alignItems="center"
              justifyContent="center"
            >
              <Icon name="close" size={13} color={c.muted} />
            </view>
          )}
        </view>

        <SettingsGroup title={vm.groupTitle} description={vm.addressHint} touch={vm.touch} dark={dark}>
          <TextField
            id="oc-server-connect-url"
            label={vm.addressLabel}
            value={this.state.url}
            placeholder={vm.addressPlaceholder}
            clearTitle={vm.clearLabel}
            inline={true}
            touch={vm.touch}
            disabled={vm.pending}
            dark={dark}
            contentType="url"
            autocapitalization="none"
            onChange={(url) => {
              this.setState({ url });
              this.viewModel.onInputChange?.();
            }}
            onSubmit={() => this.submit()}
          />
          <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
          <TextField
            id="oc-server-connect-name"
            label={vm.nameLabel}
            value={this.state.displayName}
            placeholder={vm.namePlaceholder}
            clearTitle={vm.clearLabel}
            inline={true}
            touch={vm.touch}
            disabled={vm.pending}
            dark={dark}
            autocapitalization="words"
            onChange={(displayName) => {
              this.setState({ displayName });
              this.viewModel.onInputChange?.();
            }}
            onSubmit={() => this.submit()}
          />
        </SettingsGroup>

        {vm.error ? (
          <Banner id="oc-server-connect-error" tone="danger" title={vm.error} touch={vm.touch} dark={dark} />
        ) : vm.connectedMessage ? (
          <Banner id="oc-server-connect-ok" tone="success" title={vm.connectedMessage} touch={vm.touch} dark={dark} />
        ) : (
          <Banner
            id="oc-server-connect-privacy"
            tone="info"
            title={vm.privacyTitle}
            message={vm.privacyMessage}
            touch={vm.touch}
            dark={dark}
          />
        )}

        <view flexDirection="row" justifyContent={m.touch ? "space-between" : "flex-end"} gap={8}>
          {vm.cancelLabel && vm.onCancel && (
            <view flexGrow={m.touch ? 1 : 0} flexBasis={m.touch ? 0 : undefined}>
              <Button
                id="oc-server-connect-cancel"
                title={vm.cancelLabel}
                variant="quiet"
                touch={vm.touch}
                disabled={vm.pending}
                dark={dark}
                onPress={() => {
                  triggerHaptic("selection");
                  vm.onCancel?.();
                }}
              />
            </view>
          )}
          <view flexGrow={m.touch ? 2 : 0} flexBasis={m.touch ? 0 : undefined}>
            <Button
              id="oc-server-connect-submit"
              title={vm.pending ? vm.connectingLabel : vm.connectLabel}
              variant="primary"
              touch={vm.touch}
              disabled={!canSubmit}
              dark={dark}
              onPress={() => this.submit()}
            />
          </view>
        </view>
      </view>
    </view>;
  }
}
