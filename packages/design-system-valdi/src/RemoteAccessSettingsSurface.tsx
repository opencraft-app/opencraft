import { StatefulComponent } from "valdi_core/src/Component";
import { systemFont, systemSemiboldFont } from "valdi_core/src/SystemFont";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { registerHapticHandler, triggerHaptic } from "./haptics";
import { Icon } from "./Icon";
import { SegmentedControl } from "./SegmentedControl";
import { SettingsFormRow, SettingsGroup } from "./SettingsGroup";
import { TextField } from "./TextField";
import { Toggle } from "./Toggle";
import { radii, themeColors, themeMetrics } from "./tokens";

export type RemoteAccessDirectRouteItem = {
  readonly id: string;
  readonly kindLabel: string;
  readonly url: string;
};

export type RemoteAccessPendingApprovalItem = {
  readonly shortCode: string;
  readonly label: string;
  readonly expiresLabel: string;
};

export type RemoteAccessActiveShareItem = {
  readonly grantId: string;
  readonly permissionLabel: string;
  readonly expiresLabel: string;
  readonly shareUrl?: string;
};

export type RemoteAccessSettingsProps = {
  dark?: boolean;
  touch?: boolean;
  narrow?: boolean;
  title: string;
  subtitle?: string;
  errorMessage?: string;
  noticeMessage?: string;

  // Unified Primary Remote Control Card
  enableTitle: string;
  enableDescription: string;
  enabled: boolean;
  busy?: boolean;
  deviceNameLabel: string;
  deviceNamePlaceholder: string;
  deviceName: string;
  scanInlinePrefix: string;
  copyLinkInlineLabel: string;
  copiedInlineLabel: string;
  scanInlineSuffix?: string;
  pairingUrl: string;
  qrSvgDataUri?: string;
  qrMatrix?: readonly (readonly boolean[])[];
  pairingCopied?: boolean;
  refreshQrLabel: string;

  // Connection & Advanced Details
  advancedGroupTitle: string;
  statusTitle: string;
  statusDetail: string;
  connected: boolean;
  refreshRoutesLabel: string;
  directRoutesTitle: string;
  directRoutesEmpty: string;
  directRoutes: readonly RemoteAccessDirectRouteItem[];
  customRelayTitle: string;
  customRelayPlaceholder: string;
  customRelayHint: string;
  customRelayUrl: string;
  requireApprovalTitle: string;
  requireApprovalDescription: string;
  requireApproval: boolean;

  // Personal Hub (Passkey Multi-Machine Claim)
  hubClaimed?: boolean;
  hubTitle: string;
  hubDescription: string;
  hubActionLabel: string;
  claimingHub?: boolean;

  // Pending 6-digit Approvals Group
  approvalsGroupTitle: string;
  approvalsGroupDescription: string;
  approveButtonLabel: string;
  pendingApprovals: readonly RemoteAccessPendingApprovalItem[];

  // Collaborator Share Group
  shareGroupTitle: string;
  shareGroupDescription: string;
  sharePermissionTitle: string;
  sharePermissionDescription: string;
  shareViewOnlyLabel: string;
  shareAllowExecLabel: string;
  shareMode: "view" | "exec";
  createShareLabel: string;
  creatingShare?: boolean;
  latestShareUrl?: string;
  copyShareLabel: string;
  copiedShareLabel: string;
  shareCopied?: boolean;
  activeSharesEmpty: string;
  revokeShareLabel: string;
  activeShares: readonly RemoteAccessActiveShareItem[];

  // Callbacks
  onToggleEnabled: (next: boolean, relayOriginOverride: string) => void;
  onChangeDeviceName: (name: string) => void;
  onSubmitDeviceName: (name: string) => void;
  onChangeCustomRelayUrl: (value: string) => void;
  onRefreshRoutes: () => void;
  onCopyPairingUrl: () => void;
  onRefreshQr: () => void;
  onChangeRequireApproval: (next: boolean) => void;
  onApproveDevice: (shortCode: string) => void;
  onChangeShareMode: (mode: "view" | "exec") => void;
  onCreateShare: () => void;
  onCopyShareUrl: (url: string) => void;
  onRevokeShare: (grantId: string) => void;
  onHubAction: () => void;
  onDismissNotice?: () => void;
  onHaptic?: (style: string) => void;
};

type State = {
  advancedOpen: boolean;
};

const isWeb = typeof (globalThis as { document?: unknown }).document !== "undefined";

/**
 * Adaptive OpenCraft Valdi surface for Settings -> Remote Control (`/settings/remote-access`).
 * Features a unified two-row Remote Control hero card (toggle on top; editable pill device name +
 * inline copy link + compact framed QR code on bottom), live 6-character device approvals,
 * collaborator share links, and a collapsible Advanced section.
 */
export class RemoteAccessSettingsSurface extends StatefulComponent<RemoteAccessSettingsProps, State> {
  state: State = {
    advancedOpen: false,
  };

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  onViewModelUpdate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  private renderCompactQr(
    dark: boolean,
    qrSvgDataUri?: string,
    qrMatrix?: readonly (readonly boolean[])[],
    refreshLabel?: string,
    onRefresh?: () => void,
  ): void {
    const c = themeColors(dark);
    const boxSize = 122;
    const innerSize = 104;
    const qrBg = dark ? "#111113" : "#ffffff";
    const qrFg = dark ? "#f5f5f7" : "#141416";

    <view
      width={boxSize}
      height={boxSize}
      flexShrink={0}
      padding={8}
      borderRadius={12}
      backgroundColor={qrBg}
      borderWidth={0.5}
      borderColor={c.border}
      alignItems="center"
      justifyContent="center"
      accessibilityId="oc-relay-qr-code"
      accessibilityLabel={refreshLabel}
      accessibilityCategory={onRefresh ? "button" : undefined}
      onTap={
        onRefresh
          ? () => {
              triggerHaptic("light");
              onRefresh();
            }
          : undefined
      }
    >
      {isWeb && qrSvgDataUri ? (
        <image
          src={qrSvgDataUri}
          width={innerSize}
          height={innerSize}
          objectFit="contain"
          accessibilityNavigation="ignored"
        />
      ) : qrMatrix && qrMatrix.length > 0 ? (
        <view
          width={innerSize}
          height={innerSize}
          justifyContent="center"
          alignItems="center"
          accessibilityNavigation="ignored"
        >
          {qrMatrix.forEach((row, rIdx) => {
            const cell = Math.max(2, Math.floor(innerSize / qrMatrix.length));
            <view key={`qr-r-${rIdx}`} flexDirection="row">
              {row.forEach((darkCell, cIdx) => {
                <view key={`qr-c-${cIdx}`} width={cell} height={cell} backgroundColor={darkCell ? qrFg : qrBg} />;
              })}
            </view>;
          })}
        </view>
      ) : (
        <Icon name="grid" size={26} color={c.muted} />
      )}
    </view>;
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const c = themeColors(dark);
    const m = themeMetrics(vm.touch);
    const stackedHero = Boolean(vm.narrow);
    const pillInputHeight = vm.touch ? 40 : 36;

    <view width="100%" gap={24}>
      {/* Clean Section Title matching Remote Control hero pattern */}
      <view width="100%" gap={6}>
        <label
          value={vm.title}
          font={m.fonts.pageTitle}
          color={c.ink}
          accessibilityCategory="header"
          numberOfLines={0}
        />
        {vm.subtitle ? <label value={vm.subtitle} font={m.fonts.detail} color={c.muted} numberOfLines={0} /> : null}
      </view>

      {vm.errorMessage && (
        <Banner id="oc-relay-error" tone="danger" title={vm.errorMessage} touch={vm.touch} dark={dark} />
      )}

      {vm.noticeMessage && (
        <Banner
          id="oc-relay-notice"
          tone="success"
          title={vm.noticeMessage}
          onDismiss={vm.onDismissNotice}
          touch={vm.touch}
          dark={dark}
        />
      )}

      {/* Primary Unified Remote Control Card (Toggle Row + Device Name / Inline Copy Link / Right QR) */}
      <SettingsGroup title="" touch={vm.touch} dark={dark}>
        <SettingsFormRow title={vm.enableTitle} description={vm.enableDescription} touch={vm.touch} dark={dark}>
          <Toggle
            id="oc-relay-enable-toggle"
            label={vm.enableTitle}
            value={vm.enabled}
            disabled={Boolean(vm.busy)}
            touch={vm.touch}
            dark={dark}
            onChange={(next) => vm.onToggleEnabled(next, vm.customRelayUrl)}
          />
        </SettingsFormRow>

        {vm.enabled && (
          <view width="100%">
            <view
              height={0.5}
              marginLeft={m.sizes.rowPaddingX}
              marginRight={m.sizes.rowPaddingX}
              backgroundColor={c.border}
            />
            <view
              width="100%"
              paddingLeft={m.sizes.rowPaddingX}
              paddingRight={m.sizes.rowPaddingX}
              paddingTop={18}
              paddingBottom={18}
              flexDirection={stackedHero ? "column" : "row"}
              alignItems={stackedHero ? "stretch" : "center"}
              justifyContent="space-between"
              gap={20}
            >
              {/* Left Column: Device Name + Pill Input + Inline "Scan the code..., or copy link." */}
              <view flexGrow={1} flexShrink={1} minWidth={0} gap={10}>
                <view flexDirection="row" alignItems="center" justifyContent="space-between" gap={8}>
                  <label value={vm.deviceNameLabel} font={m.fonts.rowTitle} color={c.ink} numberOfLines={1} />
                  <view flexDirection="row" alignItems="center" gap={6}>
                    <view
                      width={7}
                      height={7}
                      borderRadius={3.5}
                      backgroundColor={vm.connected ? c.success : c.warning}
                      accessibilityNavigation="ignored"
                    />
                    <label
                      value={vm.connected ? vm.statusTitle : vm.statusDetail}
                      font={m.fonts.caption}
                      color={c.muted}
                      numberOfLines={1}
                    />
                  </view>
                </view>

                {/* Pill-shaped Device Name Input */}
                <view
                  borderRadius={radii.pill}
                  borderWidth={0.5}
                  borderColor={c.border}
                  backgroundColor={c.recessed}
                  paddingLeft={14}
                  paddingRight={14}
                  flexDirection="row"
                  alignItems="center"
                >
                  <textfield
                    accessibilityId="oc-relay-device-name"
                    accessibilityLabel={vm.deviceNameLabel}
                    value={vm.deviceName}
                    placeholder={vm.deviceNamePlaceholder}
                    placeholderColor={c.disabled}
                    height={pillInputHeight}
                    flexGrow={1}
                    flexBasis={0}
                    minWidth={0}
                    color={c.ink}
                    font={m.fonts.body}
                    enabled={!vm.busy}
                    contentType="noSuggestions"
                    autocapitalization="none"
                    autocorrection="none"
                    onChange={(ev) => vm.onChangeDeviceName(ev.text)}
                    onReturn={() => vm.onSubmitDeviceName(vm.deviceName)}
                  />
                </view>

                {/* Inline Caption + Clickable Accent "copy link" */}
                <view flexDirection="row" flexWrap="wrap" alignItems="center" gap={0}>
                  <label value={vm.scanInlinePrefix} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
                  <view
                    class="oc-ghost-button"
                    accessibilityId="oc-relay-copy-pair-url"
                    accessibilityLabel={vm.copyLinkInlineLabel}
                    accessibilityCategory="button"
                    accessibilityStateDisabled={!vm.pairingUrl}
                    onTap={
                      !vm.pairingUrl
                        ? undefined
                        : () => {
                            triggerHaptic("selection");
                            vm.onCopyPairingUrl();
                          }
                    }
                    paddingTop={2}
                    paddingBottom={2}
                  >
                    <label
                      value={vm.pairingCopied ? vm.copiedInlineLabel : vm.copyLinkInlineLabel}
                      font={m.fonts.detail}
                      color={c.accent}
                    />
                  </view>
                  {vm.scanInlineSuffix ? (
                    <label value={vm.scanInlineSuffix} font={m.fonts.detail} color={c.muted} />
                  ) : null}
                </view>
              </view>

              {/* Right Column: Compact Framed QR Code */}
              <view alignItems={stackedHero ? "center" : "flex-end"} justifyContent="center">
                {this.renderCompactQr(dark, vm.qrSvgDataUri, vm.qrMatrix, vm.refreshQrLabel, vm.onRefreshQr)}
              </view>
            </view>
          </view>
        )}
      </SettingsGroup>

      {/* Personal Hub (Passkey Multi-Device Sync) */}
      {vm.enabled && (
        <SettingsGroup title="" touch={vm.touch} dark={dark}>
          <SettingsFormRow title={vm.hubTitle} description={vm.hubDescription} touch={vm.touch} dark={dark}>
            <Button
              id="oc-relay-hub-action"
              title={vm.hubActionLabel}
              variant={vm.hubClaimed ? "quiet" : "secondary"}
              size="sm"
              leadingIcon={vm.hubClaimed ? "external" : "key"}
              disabled={Boolean(vm.claimingHub || vm.busy)}
              touch={vm.touch}
              dark={dark}
              onPress={() => {
                triggerHaptic("selection");
                vm.onHubAction();
              }}
            />
          </SettingsFormRow>
        </SettingsGroup>
      )}

      {/* Pending 6-character Device Confirmation Requests (Only visible when waiting) */}
      {vm.enabled && vm.pendingApprovals.length > 0 && (
        <SettingsGroup
          title={vm.approvalsGroupTitle}
          description={vm.approvalsGroupDescription}
          touch={vm.touch}
          dark={dark}
        >
          {vm.pendingApprovals.forEach((item, index) => {
            <view key={item.shortCode} width="100%">
              {index > 0 && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
              <view
                minHeight={m.sizes.rowMinHeight}
                paddingLeft={m.sizes.rowPaddingX}
                paddingRight={m.sizes.rowPaddingX}
                paddingTop={12}
                paddingBottom={12}
                flexDirection="row"
                alignItems="center"
                justifyContent="space-between"
                gap={12}
              >
                <view flexDirection="row" alignItems="center" gap={12} flexGrow={1} flexShrink={1} minWidth={0}>
                  <view
                    paddingLeft={10}
                    paddingRight={10}
                    paddingTop={5}
                    paddingBottom={5}
                    borderRadius={8}
                    backgroundColor={c.warningSurface}
                    borderWidth={0.5}
                    borderColor={c.border}
                  >
                    <label class="oc-mono" value={item.shortCode} font={systemSemiboldFont(14)} color={c.ink} />
                  </view>
                  <view flexGrow={1} flexShrink={1} minWidth={0} gap={2}>
                    <label value={item.label} font={m.fonts.rowTitle} color={c.ink} numberOfLines={1} />
                    <label value={item.expiresLabel} font={m.fonts.detail} color={c.muted} numberOfLines={1} />
                  </view>
                </view>
                <Button
                  id={`oc-relay-approve-${item.shortCode}`}
                  title={vm.approveButtonLabel}
                  variant="primary"
                  size="sm"
                  disabled={Boolean(vm.busy)}
                  touch={vm.touch}
                  dark={dark}
                  onPress={() => {
                    triggerHaptic("medium");
                    vm.onApproveDevice(item.shortCode);
                  }}
                />
              </view>
            </view>;
          })}
        </SettingsGroup>
      )}

      {/* Collaborator Share Links (Compact Secondary Card) */}
      {vm.enabled && (
        <SettingsGroup title={vm.shareGroupTitle} description={vm.shareGroupDescription} touch={vm.touch} dark={dark}>
          <SettingsFormRow
            title={vm.sharePermissionTitle}
            description={vm.sharePermissionDescription}
            touch={vm.touch}
            dark={dark}
          >
            <view flexDirection="row" alignItems="center" gap={8}>
              <SegmentedControl
                id="oc-relay-share-mode"
                label={vm.sharePermissionTitle}
                value={vm.shareMode}
                options={[
                  { id: "view", title: vm.shareViewOnlyLabel },
                  { id: "exec", title: vm.shareAllowExecLabel },
                ]}
                compact={true}
                touch={vm.touch}
                dark={dark}
                onChange={(next) => vm.onChangeShareMode(next as "view" | "exec")}
              />
              <Button
                id="oc-relay-create-share"
                title={vm.createShareLabel}
                variant="secondary"
                size="sm"
                leadingIcon="plus"
                disabled={Boolean(vm.creatingShare || vm.busy)}
                touch={vm.touch}
                dark={dark}
                onPress={() => {
                  triggerHaptic("selection");
                  vm.onCreateShare();
                }}
              />
            </view>
          </SettingsFormRow>

          {vm.latestShareUrl && (
            <view width="100%">
              <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
              <view
                paddingLeft={m.sizes.rowPaddingX}
                paddingRight={m.sizes.rowPaddingX}
                paddingTop={12}
                paddingBottom={12}
                flexDirection="row"
                alignItems="center"
                gap={10}
              >
                <view
                  flexGrow={1}
                  flexShrink={1}
                  minWidth={0}
                  paddingLeft={12}
                  paddingRight={12}
                  paddingTop={7}
                  paddingBottom={7}
                  borderRadius={radii.pill}
                  backgroundColor={c.recessed}
                  borderWidth={0.5}
                  borderColor={c.border}
                >
                  <label
                    class="oc-mono"
                    accessibilityId="oc-relay-latest-share-url"
                    value={vm.latestShareUrl}
                    font={systemFont(12)}
                    color={c.ink}
                    numberOfLines={1}
                  />
                </view>
                <Button
                  id="oc-relay-copy-latest-share"
                  title={vm.shareCopied ? vm.copiedShareLabel : vm.copyShareLabel}
                  variant="secondary"
                  size="sm"
                  leadingIcon={vm.shareCopied ? "check" : "copy"}
                  touch={vm.touch}
                  dark={dark}
                  onPress={() => {
                    triggerHaptic("selection");
                    if (vm.latestShareUrl) vm.onCopyShareUrl(vm.latestShareUrl);
                  }}
                />
              </view>
            </view>
          )}

          {vm.activeShares.length > 0 && (
            <view width="100%">
              <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
              {vm.activeShares.forEach((share, idx) => {
                <view key={share.grantId} width="100%">
                  {idx > 0 && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
                  <view
                    minHeight={m.sizes.rowMinHeight}
                    paddingLeft={m.sizes.rowPaddingX}
                    paddingRight={m.sizes.rowPaddingX}
                    paddingTop={10}
                    paddingBottom={10}
                    flexDirection="row"
                    alignItems="center"
                    justifyContent="space-between"
                    gap={10}
                  >
                    <view flexGrow={1} flexShrink={1} minWidth={0} gap={2}>
                      <label value={share.permissionLabel} font={m.fonts.rowTitle} color={c.ink} numberOfLines={1} />
                      <label value={share.expiresLabel} font={m.fonts.detail} color={c.muted} numberOfLines={1} />
                    </view>
                    <view flexDirection="row" alignItems="center" gap={8}>
                      {share.shareUrl && (
                        <Button
                          id={`oc-relay-copy-share-${share.grantId}`}
                          title={vm.copyShareLabel}
                          variant="quiet"
                          size="sm"
                          touch={vm.touch}
                          dark={dark}
                          onPress={() => {
                            triggerHaptic("selection");
                            if (share.shareUrl) vm.onCopyShareUrl(share.shareUrl);
                          }}
                        />
                      )}
                      <Button
                        id={`oc-relay-revoke-share-${share.grantId}`}
                        title={vm.revokeShareLabel}
                        variant="danger"
                        size="sm"
                        disabled={Boolean(vm.busy)}
                        touch={vm.touch}
                        dark={dark}
                        onPress={() => {
                          triggerHaptic("light");
                          vm.onRevokeShare(share.grantId);
                        }}
                      />
                    </view>
                  </view>
                </view>;
              })}
            </view>
          )}
        </SettingsGroup>
      )}

      {/* Collapsible Advanced Options (6-digit toggle, Direct Routes, Custom Relay Origin) */}
      <SettingsGroup title="" touch={vm.touch} dark={dark}>
        <view
          class="oc-settings-row"
          accessibilityId="oc-relay-advanced-disclosure"
          accessibilityLabel={vm.advancedGroupTitle}
          accessibilityCategory="button"
          onTap={() => {
            triggerHaptic("selection");
            this.setState({ advancedOpen: !this.state.advancedOpen });
          }}
          minHeight={44}
          paddingLeft={m.sizes.rowPaddingX}
          paddingRight={m.sizes.rowPaddingX}
          flexDirection="row"
          alignItems="center"
          justifyContent="space-between"
        >
          <label value={vm.advancedGroupTitle} font={m.fonts.rowTitle} color={c.ink} />
          <Icon name={this.state.advancedOpen ? "chevronUp" : "chevronDown"} size={14} color={c.muted} />
        </view>

        {this.state.advancedOpen && (
          <view width="100%">
            {vm.enabled && (
              <view width="100%">
                <SettingsFormRow
                  title={vm.requireApprovalTitle}
                  description={vm.requireApprovalDescription}
                  divider={true}
                  touch={vm.touch}
                  dark={dark}
                >
                  <Toggle
                    id="oc-relay-require-approval"
                    label={vm.requireApprovalTitle}
                    value={vm.requireApproval}
                    disabled={Boolean(vm.busy)}
                    touch={vm.touch}
                    dark={dark}
                    onChange={(next) => vm.onChangeRequireApproval(next)}
                  />
                </SettingsFormRow>

                <SettingsFormRow
                  title={vm.directRoutesTitle}
                  description={vm.directRoutes.length === 0 ? vm.directRoutesEmpty : vm.statusDetail}
                  divider={true}
                  stacked={vm.directRoutes.length > 0}
                  touch={vm.touch}
                  dark={dark}
                >
                  {vm.directRoutes.length > 0 ? (
                    <view width="100%" gap={6}>
                      {vm.directRoutes.forEach((route) => {
                        <view
                          key={route.id}
                          paddingLeft={10}
                          paddingRight={10}
                          paddingTop={7}
                          paddingBottom={7}
                          borderRadius={m.radii.control}
                          backgroundColor={c.recessed}
                          borderWidth={0.5}
                          borderColor={c.border}
                          flexDirection="row"
                          alignItems="center"
                          justifyContent="space-between"
                          gap={10}
                        >
                          <label value={route.kindLabel} font={m.fonts.caption} color={c.muted} />
                          <label
                            class="oc-mono"
                            value={route.url}
                            font={systemFont(12)}
                            color={c.ink}
                            flexShrink={1}
                            numberOfLines={1}
                          />
                        </view>;
                      })}
                    </view>
                  ) : (
                    <Button
                      id="oc-relay-refresh-routes"
                      title={vm.refreshRoutesLabel}
                      variant="quiet"
                      size="sm"
                      disabled={Boolean(vm.busy)}
                      touch={vm.touch}
                      dark={dark}
                      onPress={() => {
                        triggerHaptic("light");
                        vm.onRefreshRoutes();
                      }}
                    />
                  )}
                </SettingsFormRow>
              </view>
            )}

            {!vm.enabled && (
              <view width="100%">
                <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
                <TextField
                  id="oc-relay-custom-origin"
                  label={vm.customRelayTitle}
                  value={vm.customRelayUrl}
                  placeholder={vm.customRelayPlaceholder}
                  hint={vm.customRelayHint}
                  leadingIcon="server"
                  inline={true}
                  contentType="url"
                  autocapitalization="none"
                  disabled={Boolean(vm.busy)}
                  touch={vm.touch}
                  dark={dark}
                  onChange={(val) => vm.onChangeCustomRelayUrl(val)}
                />
              </view>
            )}
          </view>
        )}
      </SettingsGroup>
    </view>;
  }
}
