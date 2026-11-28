import { StatefulComponent } from "valdi_core/src/Component";
import { systemFont, systemMediumFont, systemSemiboldFont } from "valdi_core/src/SystemFont";
import { Banner } from "./Banner";
import { registerHapticHandler, triggerHaptic } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { radii, themeColors } from "./tokens";

export type HubThreadPreviewItem = {
  readonly threadId: string;
  readonly title: string;
  readonly statusLabel: string;
  readonly statusTone: "active" | "waiting" | "danger" | "muted";
};

export type HubMachineDirectoryItem = {
  readonly machineId: string;
  readonly displayName: string;
  readonly online: boolean;
  readonly statusLabel: string;
  readonly connectLabel?: string;
  readonly threads: readonly HubThreadPreviewItem[];
};

export type RemoteWorkbenchWelcomeProps = {
  dark?: boolean;
  touch?: boolean;
  narrow?: boolean;
  title: string;
  subtitle: string;

  // Passkey & My Computers State
  passkeySupported?: boolean;
  passkeyBusy?: boolean;
  hubSignedIn?: boolean;
  hubSignInLabel: string;
  hubCreateLabel?: string;
  hubCardTitle: string;
  hubCardDescription?: string;
  hubMachineCountLabel?: string;
  hubAddDeviceHint?: string;
  hubPasteTempLinkLabel?: string;
  hubRefreshLabel: string;
  hubSignOutLabel: string;
  backToWorkspaceLabel?: string;
  hubEmptyMachinesText: string;
  hubMachines?: readonly HubMachineDirectoryItem[];

  // Optional Desktop Claim Ticket (`/claim#ticket=...`)
  claimMachineName?: string;
  claimBannerTitle?: string;
  claimBannerDescription?: string;
  claimWithExistingPasskeyLabel?: string;
  claimWithNewPasskeyLabel?: string;
  claimConfirmCurrentHubLabel?: string;
  claimPrivacyHint?: string;
  cancelClaimLabel?: string;

  // Quick Pairing / Share Link Capsule
  orPasteLinkLabel?: string;
  stepOneText?: string;
  stepTwoText?: string;
  linkLabel: string;
  linkPlaceholder: string;
  linkValue: string;
  connectLinkLabel: string;
  connectingLabel: string;
  connectingLink?: boolean;
  downloadPrefix?: string;
  downloadActionLabel: string;
  pendingCodeTitle?: string;
  pendingCodeDetail?: string;
  pendingShortCode?: string;
  infoTitle?: string;
  infoMessage?: string;
  errorMessage?: string;

  // Self-Hosted Server Disclosure
  serverDisclosureTitle: string;
  serverAddressLabel: string;
  serverPlaceholder: string;
  serverValue: string;
  connectServerLabel: string;
  connectingServer?: boolean;
  clearLabel?: string;

  // Callbacks
  onPasskeySignIn: () => void;
  onPasskeyCreate: () => void;
  onClaimConfirmCurrentHub?: () => void;
  onDismissClaim?: () => void;
  onHubRefresh?: () => void;
  onHubSignOut?: () => void;
  onBackToWorkspace?: () => void;
  onDismissInfo?: () => void;
  onConnectHubMachine?: (machineId: string) => void;
  onChangeLink: (value: string) => void;
  onSubmitLink: () => void;
  onDownloadDesktop: () => void;
  onChangeServer: (value: string) => void;
  onSubmitServer: () => void;
  onDismissError?: () => void;
  onHaptic?: (style: string) => void;
};

type State = {
  serverOpen: boolean;
  hubLinkOpen: boolean;
};

/**
 * Standalone Apple-inspired full-screen entry surface for `my.opencraft.app`.
 * Presents one calm, elevated squircle sheet at a time:
 * 1. Cold visit: Passkey sign-in + unified pairing/share link capsule + quiet footer;
 * 2. Desktop-initiated Passkey bind (`/claim#ticket=...`): focused 1-step bind sheet;
 * 3. Signed-in `My Computers` directory: online computers connect in 1 tap, offline computers show lightweight recent thread status.
 */
export class RemoteWorkbenchWelcomeSurface extends StatefulComponent<RemoteWorkbenchWelcomeProps, State> {
  state: State = {
    serverOpen: false,
    hubLinkOpen: false,
  };

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  onViewModelUpdate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  private renderEmblem(icon: IconName, dark: boolean): void {
    const emblemBg = dark ? "#262629" : "#f5f5f7";
    const emblemBorder = dark ? "rgba(255, 255, 255, 0.11)" : "rgba(0, 0, 0, 0.06)";
    const iconColor = dark ? "#f5f5f7" : "#1d1d1f";

    <view
      class={dark ? "oc-apple-emblem oc-dark" : "oc-apple-emblem"}
      width={54}
      height={54}
      borderRadius={16}
      backgroundColor={emblemBg}
      borderWidth={0.5}
      borderColor={emblemBorder}
      alignItems="center"
      justifyContent="center"
      accessibilityNavigation="ignored"
    >
      <Icon name={icon} size={24} color={iconColor} />
    </view>;
  }

  private renderCapsuleAction(opts: {
    id: string;
    title: string;
    variant: "primary" | "tonal";
    icon?: IconName;
    disabled?: boolean;
    loading?: boolean;
    dark: boolean;
    touch?: boolean;
    compact?: boolean;
    onPress: () => void;
  }): void {
    const isDisabled = Boolean(opts.disabled || opts.loading);
    const minHeight = opts.compact ? (opts.touch ? 36 : 32) : opts.touch ? 48 : 44;
    const padX = opts.compact ? 14 : 20;
    const bg = opts.variant === "primary" ? (opts.dark ? "#f5f5f7" : "#1d1d1f") : opts.dark ? "#2c2c2e" : "#f2f2f7";
    const fg = opts.variant === "primary" ? (opts.dark ? "#141416" : "#ffffff") : opts.dark ? "#f5f5f7" : "#1d1d1f";
    const borderColor = opts.dark ? "rgba(255, 255, 255, 0.09)" : "rgba(0, 0, 0, 0.05)";
    const font = opts.compact ? systemMediumFont(opts.touch ? 13.5 : 12.5) : systemMediumFont(opts.touch ? 15 : 14);

    <view
      class="oc-pill-button oc-apple-capsule"
      accessibilityId={opts.id}
      accessibilityLabel={opts.title}
      accessibilityCategory="button"
      accessibilityStateDisabled={isDisabled}
      onTap={
        isDisabled
          ? undefined
          : () => {
              triggerHaptic("selection");
              opts.onPress();
            }
      }
      minHeight={minHeight}
      paddingLeft={padX}
      paddingRight={padX}
      paddingTop={4}
      paddingBottom={4}
      borderRadius={radii.pill}
      borderWidth={opts.variant === "tonal" ? 0.5 : 0}
      borderColor={borderColor}
      backgroundColor={bg}
      opacity={isDisabled ? 0.46 : 1}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      gap={7}
    >
      {opts.loading ? (
        <Icon name="refresh" size={opts.compact ? 13 : 15} color={fg} />
      ) : opts.icon ? (
        <Icon name={opts.icon} size={opts.compact ? 13 : 15} color={fg} />
      ) : null}
      <label value={opts.title} font={font} color={fg} textAlign="center" numberOfLines={1} />
    </view>;
  }

  private renderUnifiedInputCapsule(opts: {
    inputId: string;
    buttonId: string;
    ariaLabel: string;
    value: string;
    placeholder: string;
    buttonTitle: string;
    canSubmit: boolean;
    busy?: boolean;
    dark: boolean;
    touch?: boolean;
    onChange: (text: string) => void;
    onSubmit: () => void;
  }): void {
    const capsuleBg = opts.dark ? "#2c2c2e" : "#f2f2f7";
    const capsuleBorder = opts.dark ? "rgba(255, 255, 255, 0.09)" : "rgba(0, 0, 0, 0.05)";
    const ink = opts.dark ? "#f5f5f7" : "#1d1d1f";
    const placeholderColor = opts.dark ? "rgba(235, 235, 245, 0.36)" : "rgba(60, 60, 67, 0.42)";
    const outerHeight = opts.touch ? 48 : 44;
    const innerBtnHeight = opts.touch ? 38 : 34;
    const activeBtnBg = opts.dark ? "#f5f5f7" : "#1d1d1f";
    const activeBtnFg = opts.dark ? "#141416" : "#ffffff";
    const idleBtnBg = opts.dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
    const idleBtnFg = opts.dark ? "rgba(235, 235, 245, 0.48)" : "rgba(60, 60, 67, 0.48)";

    <view
      class="oc-apple-input-capsule"
      width="100%"
      minHeight={outerHeight}
      borderRadius={radii.pill}
      backgroundColor={capsuleBg}
      borderWidth={0.5}
      borderColor={capsuleBorder}
      paddingLeft={16}
      paddingRight={5}
      flexDirection="row"
      alignItems="center"
      gap={8}
    >
      <textfield
        accessibilityId={opts.inputId}
        accessibilityLabel={opts.ariaLabel}
        value={opts.value}
        placeholder={opts.placeholder}
        placeholderColor={placeholderColor}
        height={outerHeight - 4}
        flexGrow={1}
        flexBasis={0}
        minWidth={0}
        color={ink}
        font={systemFont(opts.touch ? 14.5 : 13.5)}
        enabled={!opts.busy}
        contentType="url"
        autocapitalization="none"
        autocorrection="none"
        onChange={(ev) => opts.onChange(ev.text)}
        onReturn={() => {
          if (opts.canSubmit) {
            triggerHaptic("selection");
            opts.onSubmit();
          }
        }}
      />
      <view
        class="oc-pill-button"
        accessibilityId={opts.buttonId}
        accessibilityLabel={opts.buttonTitle}
        accessibilityCategory="button"
        accessibilityStateDisabled={!opts.canSubmit}
        onTap={
          !opts.canSubmit
            ? undefined
            : () => {
                triggerHaptic("selection");
                opts.onSubmit();
              }
        }
        minHeight={innerBtnHeight}
        paddingLeft={15}
        paddingRight={15}
        borderRadius={radii.pill}
        backgroundColor={opts.canSubmit ? activeBtnBg : idleBtnBg}
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
      >
        <label
          value={opts.buttonTitle}
          font={systemMediumFont(opts.touch ? 13.5 : 12.5)}
          color={opts.canSubmit ? activeBtnFg : idleBtnFg}
          numberOfLines={1}
        />
      </view>
    </view>;
  }

  private renderPendingVerificationCard(dark: boolean, touch?: boolean): void {
    const vm = this.viewModel;
    if (!vm.pendingShortCode || !vm.pendingCodeTitle) return;
    const c = themeColors(dark);
    const boxBg = dark ? "#2c2c2e" : "#f5f5f7";
    const border = dark ? "rgba(255, 255, 255, 0.10)" : "rgba(0, 0, 0, 0.06)";
    const ink = dark ? "#f5f5f7" : "#1d1d1f";
    const muted = dark ? "rgba(235, 235, 245, 0.62)" : "rgba(60, 60, 67, 0.66)";

    <view
      width="100%"
      borderRadius={18}
      backgroundColor={boxBg}
      borderWidth={0.5}
      borderColor={border}
      paddingLeft={16}
      paddingRight={16}
      paddingTop={14}
      paddingBottom={14}
      alignItems="center"
      gap={8}
    >
      <label
        value={vm.pendingCodeTitle}
        font={systemMediumFont(touch ? 14 : 13)}
        color={ink}
        textAlign="center"
        numberOfLines={0}
      />
      <view
        paddingLeft={18}
        paddingRight={18}
        paddingTop={7}
        paddingBottom={7}
        borderRadius={12}
        backgroundColor={dark ? "#1c1c1e" : "#ffffff"}
        borderWidth={0.5}
        borderColor={c.border}
      >
        <label class="oc-mono" value={vm.pendingShortCode} font={systemSemiboldFont(20)} color={ink} />
      </view>
      {vm.pendingCodeDetail ? (
        <label value={vm.pendingCodeDetail} font={systemFont(12)} color={muted} textAlign="center" numberOfLines={0} />
      ) : null}
    </view>;
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const c = themeColors(dark);
    const touch = Boolean(vm.touch);

    const sheetBg = dark ? "#1c1c1e" : "#ffffff";
    const sheetBorder = dark ? "rgba(255, 255, 255, 0.10)" : "rgba(0, 0, 0, 0.06)";
    const ink = dark ? "#f5f5f7" : "#1d1d1f";
    const muted = dark ? "rgba(235, 235, 245, 0.62)" : "rgba(60, 60, 67, 0.66)";
    const subtle = dark ? "rgba(235, 235, 245, 0.42)" : "rgba(60, 60, 67, 0.45)";
    const divider = dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
    const insetBg = dark ? "#2c2c2e" : "#f5f5f7";
    const appleGreen = dark ? "#30d158" : "#34c759";
    const appleGray = dark ? "#8e8e93" : "#aeaeb2";

    const isClaimMode = Boolean(vm.claimMachineName && vm.claimBannerTitle);
    const machines = vm.hubMachines ?? [];
    const isHubMode = !isClaimMode && (Boolean(vm.hubSignedIn) || machines.length > 0);
    const cardMaxWidth = isHubMode ? 456 : 412;
    const sheetPad = vm.narrow ? 22 : 28;
    const canSubmitLink = vm.linkValue.trim().length > 8 && !vm.connectingLink;
    const canSubmitServer = vm.serverValue.trim().length > 3 && !vm.connectingServer;

    <view
      class={dark ? "oc-apple-stage oc-dark" : "oc-apple-stage"}
      width="100%"
      alignItems="center"
      justifyContent="center"
      paddingTop={28}
      paddingBottom={32}
      paddingLeft={16}
      paddingRight={16}
    >
      <view
        class={dark ? "oc-apple-sheet oc-dark" : "oc-apple-sheet"}
        width="100%"
        maxWidth={cardMaxWidth}
        borderRadius={26}
        backgroundColor={sheetBg}
        borderWidth={0.5}
        borderColor={sheetBorder}
        paddingTop={sheetPad}
        paddingBottom={sheetPad - 4}
        paddingLeft={sheetPad}
        paddingRight={sheetPad}
        gap={20}
      >
        {/* =========================================================
            MODE 1: DESKTOP-INITIATED PASSKEY BIND (`/claim`)
           ========================================================= */}
        {isClaimMode ? (
          <view width="100%" gap={20}>
            <view width="100%" alignItems="center" gap={14}>
              {/* Device Live Pill */}
              <view
                paddingLeft={12}
                paddingRight={12}
                paddingTop={5}
                paddingBottom={5}
                borderRadius={radii.pill}
                backgroundColor={insetBg}
                borderWidth={0.5}
                borderColor={divider}
                flexDirection="row"
                alignItems="center"
                gap={7}
              >
                <view width={7} height={7} borderRadius={3.5} backgroundColor={appleGreen} />
                <label value={vm.claimMachineName ?? ""} font={systemMediumFont(12.5)} color={ink} numberOfLines={1} />
              </view>

              {this.renderEmblem("key", dark)}

              <view width="100%" maxWidth={340} alignItems="center" gap={7}>
                <label
                  value={vm.claimBannerTitle ?? ""}
                  font={systemSemiboldFont(touch ? 24 : 23)}
                  color={ink}
                  textAlign="center"
                  accessibilityCategory="header"
                  numberOfLines={0}
                />
                {vm.claimBannerDescription ? (
                  <label
                    value={vm.claimBannerDescription}
                    font={systemFont(touch ? 14.5 : 13.5)}
                    color={muted}
                    textAlign="center"
                    numberOfLines={0}
                  />
                ) : null}
              </view>
            </view>

            {vm.errorMessage ? (
              <Banner
                id="oc-remote-welcome-error"
                tone="danger"
                title={vm.errorMessage}
                onDismiss={vm.onDismissError}
                touch={touch}
                dark={dark}
              />
            ) : vm.infoTitle ? (
              <Banner
                id="oc-remote-welcome-info"
                tone="info"
                title={vm.infoTitle}
                message={vm.infoMessage}
                onDismiss={vm.onDismissInfo}
                touch={touch}
                dark={dark}
              />
            ) : null}

            <view width="100%" gap={10}>
              {vm.hubSignedIn && vm.claimConfirmCurrentHubLabel ? (
                this.renderCapsuleAction({
                  id: "oc-claim-confirm-current",
                  title: vm.claimConfirmCurrentHubLabel,
                  variant: "primary",
                  icon: "key",
                  disabled: vm.passkeyBusy,
                  loading: vm.passkeyBusy,
                  dark,
                  touch,
                  onPress: () => vm.onClaimConfirmCurrentHub?.(),
                })
              ) : vm.passkeySupported ? (
                <view width="100%" gap={10}>
                  {this.renderCapsuleAction({
                    id: "oc-claim-create-passkey",
                    title: vm.claimWithNewPasskeyLabel ?? vm.hubSignInLabel,
                    variant: "primary",
                    icon: "key",
                    disabled: vm.passkeyBusy,
                    loading: vm.passkeyBusy,
                    dark,
                    touch,
                    onPress: () => vm.onPasskeyCreate(),
                  })}
                  {this.renderCapsuleAction({
                    id: "oc-claim-signin-passkey",
                    title: vm.claimWithExistingPasskeyLabel ?? vm.hubSignInLabel,
                    variant: "tonal",
                    disabled: vm.passkeyBusy,
                    dark,
                    touch,
                    onPress: () => vm.onPasskeySignIn(),
                  })}
                </view>
              ) : null}
            </view>

            <view
              width="100%"
              paddingTop={12}
              borderColor={divider}
              flexDirection="row"
              alignItems="center"
              justifyContent="center"
              gap={6}
            >
              <Icon name="lock" size={12} color={subtle} />
              <label
                value={vm.claimPrivacyHint ?? ""}
                font={systemFont(12)}
                color={subtle}
                textAlign="center"
                numberOfLines={0}
              />
              {vm.cancelClaimLabel && vm.onDismissClaim ? (
                <view
                  class="oc-ghost-button"
                  accessibilityId="oc-claim-cancel"
                  accessibilityLabel={vm.cancelClaimLabel}
                  accessibilityCategory="button"
                  onTap={() => {
                    triggerHaptic("light");
                    vm.onDismissClaim?.();
                  }}
                  paddingLeft={6}
                  paddingRight={6}
                  paddingTop={2}
                  paddingBottom={2}
                >
                  <label value={vm.cancelClaimLabel} font={systemMediumFont(12)} color={muted} />
                </view>
              ) : null}
            </view>
          </view>
        ) : isHubMode ? (
          /* =========================================================
             MODE 2: SIGNED-IN DEVICE PICKER (`我的电脑`)
             ========================================================= */
          <view width="100%" gap={15}>
            {vm.backToWorkspaceLabel && vm.onBackToWorkspace ? (
              <view width="100%" flexDirection="row" alignItems="center">
                <view
                  class="oc-ghost-button"
                  accessibilityId="oc-hub-back-workspace"
                  accessibilityLabel={vm.backToWorkspaceLabel}
                  accessibilityCategory="button"
                  onTap={() => {
                    triggerHaptic("light");
                    vm.onBackToWorkspace?.();
                  }}
                  marginLeft={-6}
                  paddingLeft={6}
                  paddingRight={8}
                  paddingTop={3}
                  paddingBottom={3}
                  flexDirection="row"
                  alignItems="center"
                  gap={4}
                >
                  <Icon name="arrowLeft" size={13} color={muted} />
                  <label value={vm.backToWorkspaceLabel} font={systemMediumFont(12.5)} color={muted} />
                </view>
              </view>
            ) : null}

            <view width="100%" flexDirection="row" alignItems="center" justifyContent="space-between" gap={8}>
              <view flexDirection="row" alignItems="center" gap={8} flexShrink={1} minWidth={0}>
                <label
                  value={vm.hubCardTitle}
                  font={systemSemiboldFont(touch ? 21 : 20)}
                  color={ink}
                  accessibilityCategory="header"
                  numberOfLines={1}
                />
                {vm.hubMachineCountLabel ? (
                  <view
                    paddingLeft={9}
                    paddingRight={9}
                    paddingTop={3}
                    paddingBottom={3}
                    borderRadius={radii.pill}
                    backgroundColor={insetBg}
                    flexShrink={0}
                  >
                    <label
                      value={vm.hubMachineCountLabel}
                      font={systemMediumFont(11.5)}
                      color={muted}
                      numberOfLines={1}
                    />
                  </view>
                ) : null}
              </view>

              <view flexDirection="row" alignItems="center" gap={4} flexShrink={0}>
                {vm.hubSignedIn && vm.onHubRefresh ? (
                  <view
                    class="oc-ghost-button"
                    accessibilityId="oc-hub-refresh"
                    accessibilityLabel={vm.hubRefreshLabel}
                    accessibilityCategory="button"
                    accessibilityStateDisabled={Boolean(vm.passkeyBusy)}
                    onTap={
                      vm.passkeyBusy
                        ? undefined
                        : () => {
                            triggerHaptic("light");
                            vm.onHubRefresh?.();
                          }
                    }
                    paddingLeft={9}
                    paddingRight={9}
                    paddingTop={5}
                    paddingBottom={5}
                    flexDirection="row"
                    alignItems="center"
                    gap={5}
                  >
                    <Icon name="refresh" size={13} color={muted} />
                    <label value={vm.hubRefreshLabel} font={systemMediumFont(12.5)} color={muted} />
                  </view>
                ) : null}
                {vm.onHubSignOut ? (
                  <view
                    class="oc-ghost-button"
                    accessibilityId="oc-hub-signout"
                    accessibilityLabel={vm.hubSignOutLabel}
                    accessibilityCategory="button"
                    accessibilityStateDisabled={Boolean(vm.passkeyBusy)}
                    onTap={
                      vm.passkeyBusy
                        ? undefined
                        : () => {
                            triggerHaptic("selection");
                            vm.onHubSignOut?.();
                          }
                    }
                    paddingLeft={9}
                    paddingRight={9}
                    paddingTop={5}
                    paddingBottom={5}
                  >
                    <label value={vm.hubSignOutLabel} font={systemMediumFont(12.5)} color={muted} />
                  </view>
                ) : null}
              </view>
            </view>

            <view width="100%" height={0.5} backgroundColor={divider} />

            {vm.errorMessage ? (
              <Banner
                id="oc-remote-welcome-error"
                tone="danger"
                title={vm.errorMessage}
                onDismiss={vm.onDismissError}
                touch={touch}
                dark={dark}
              />
            ) : vm.infoTitle ? (
              <Banner
                id="oc-remote-welcome-info"
                tone="info"
                title={vm.infoTitle}
                message={vm.infoMessage}
                onDismiss={vm.onDismissInfo}
                touch={touch}
                dark={dark}
              />
            ) : null}

            {this.renderPendingVerificationCard(dark, touch)}

            {machines.length === 0 ? (
              <view
                width="100%"
                borderRadius={16}
                backgroundColor={insetBg}
                paddingLeft={16}
                paddingRight={16}
                paddingTop={18}
                paddingBottom={18}
              >
                <label value={vm.hubEmptyMachinesText} font={systemFont(13.5)} color={muted} numberOfLines={0} />
              </view>
            ) : (
              <view width="100%" gap={10}>
                {machines.forEach((mach) => {
                  <view
                    key={mach.machineId}
                    width="100%"
                    borderRadius={16}
                    backgroundColor={insetBg}
                    borderWidth={0.5}
                    borderColor={divider}
                    paddingLeft={15}
                    paddingRight={15}
                    paddingTop={13}
                    paddingBottom={13}
                    gap={10}
                    opacity={mach.online ? 1 : 0.88}
                  >
                    <view flexDirection="row" alignItems="center" justifyContent="space-between" gap={10}>
                      <view flexGrow={1} flexShrink={1} minWidth={0} gap={3}>
                        <view flexDirection="row" alignItems="center" gap={7}>
                          <view
                            width={8}
                            height={8}
                            borderRadius={4}
                            backgroundColor={mach.online ? appleGreen : appleGray}
                            flexShrink={0}
                          />
                          <label
                            value={mach.displayName}
                            font={systemSemiboldFont(touch ? 14.5 : 13.5)}
                            color={ink}
                            flexShrink={1}
                            numberOfLines={1}
                          />
                          <label
                            value={mach.statusLabel}
                            font={systemMediumFont(11.5)}
                            color={mach.online ? appleGreen : subtle}
                            flexShrink={0}
                          />
                        </view>
                        {mach.online && mach.threads.length > 0 ? (
                          <view paddingLeft={15}>
                            <label
                              value={`${mach.threads[0]!.title} · ${mach.threads[0]!.statusLabel}`}
                              font={systemFont(12)}
                              color={muted}
                              numberOfLines={1}
                            />
                          </view>
                        ) : null}
                      </view>

                      {mach.online && mach.connectLabel && vm.onConnectHubMachine
                        ? this.renderCapsuleAction({
                            id: `oc-hub-connect-${mach.machineId}`,
                            title: mach.connectLabel,
                            variant: "primary",
                            compact: true,
                            dark,
                            touch,
                            onPress: () => vm.onConnectHubMachine?.(mach.machineId),
                          })
                        : null}
                    </view>

                    {!mach.online && mach.threads.length > 0 ? (
                      <view width="100%" paddingLeft={15} paddingTop={6} borderColor={divider} gap={5}>
                        {mach.threads.slice(0, 3).forEach((thread) => {
                          const statusColor =
                            thread.statusTone === "active"
                              ? c.accent
                              : thread.statusTone === "waiting"
                                ? c.warning
                                : thread.statusTone === "danger"
                                  ? c.danger
                                  : subtle;
                          <view
                            key={thread.threadId}
                            flexDirection="row"
                            alignItems="center"
                            justifyContent="space-between"
                            gap={10}
                          >
                            <label
                              value={thread.title}
                              font={systemFont(12.5)}
                              color={muted}
                              flexGrow={1}
                              flexShrink={1}
                              numberOfLines={1}
                            />
                            <label
                              value={thread.statusLabel}
                              font={systemFont(11.5)}
                              color={statusColor}
                              flexShrink={0}
                            />
                          </view>;
                        })}
                      </view>
                    ) : null}
                  </view>;
                })}
              </view>
            )}

            {this.state.hubLinkOpen ? (
              <view width="100%" paddingTop={2}>
                {this.renderUnifiedInputCapsule({
                  inputId: "oc-remote-welcome-link-input",
                  buttonId: "oc-remote-welcome-connect",
                  ariaLabel: vm.linkLabel,
                  value: vm.linkValue,
                  placeholder: vm.linkPlaceholder,
                  buttonTitle: vm.connectingLink ? vm.connectingLabel : vm.connectLinkLabel,
                  canSubmit: canSubmitLink,
                  busy: vm.connectingLink,
                  dark,
                  touch,
                  onChange: (val) => vm.onChangeLink(val),
                  onSubmit: () => vm.onSubmitLink(),
                })}
              </view>
            ) : null}

            <view width="100%" height={0.5} backgroundColor={divider} />

            <view
              width="100%"
              flexDirection="row"
              flexWrap="wrap"
              alignItems="center"
              justifyContent="space-between"
              gap={8}
            >
              <label
                value={vm.hubAddDeviceHint ?? ""}
                font={systemFont(12)}
                color={subtle}
                flexShrink={1}
                numberOfLines={0}
              />
              <view
                class="oc-ghost-button"
                accessibilityId="oc-hub-toggle-temp-link"
                accessibilityLabel={vm.hubPasteTempLinkLabel ?? vm.linkLabel}
                accessibilityCategory="button"
                onTap={() => {
                  triggerHaptic("selection");
                  this.setState({ hubLinkOpen: !this.state.hubLinkOpen });
                }}
                paddingLeft={8}
                paddingRight={8}
                paddingTop={4}
                paddingBottom={4}
              >
                <label value={vm.hubPasteTempLinkLabel ?? vm.linkLabel} font={systemMediumFont(12)} color={muted} />
              </view>
            </view>
          </view>
        ) : (
          /* =========================================================
             MODE 3: COLD VISIT (`my.opencraft.app`)
             ========================================================= */
          <view width="100%" gap={20}>
            {/* Apple Emblem + Centered Display Title & Calm Subtitle */}
            <view width="100%" alignItems="center" gap={14}>
              {this.renderEmblem("laptop", dark)}
              <view width="100%" maxWidth={360} alignItems="center" gap={6}>
                <label
                  value={vm.title}
                  font={systemSemiboldFont(touch ? 24 : 23)}
                  color={ink}
                  textAlign="center"
                  accessibilityCategory="header"
                  numberOfLines={0}
                />
                <label
                  value={vm.subtitle}
                  font={systemFont(touch ? 14.5 : 13.5)}
                  color={muted}
                  textAlign="center"
                  numberOfLines={0}
                />
              </view>
            </view>

            {vm.errorMessage ? (
              <Banner
                id="oc-remote-welcome-error"
                tone="danger"
                title={vm.errorMessage}
                onDismiss={vm.onDismissError}
                touch={touch}
                dark={dark}
              />
            ) : vm.infoTitle ? (
              <Banner
                id="oc-remote-welcome-info"
                tone="info"
                title={vm.infoTitle}
                message={vm.infoMessage}
                onDismiss={vm.onDismissInfo}
                touch={touch}
                dark={dark}
              />
            ) : null}

            {this.renderPendingVerificationCard(dark, touch)}

            {/* Primary Returning User CTA: Passkey Sign-in ONLY (Zero "Create Personal Hub" button!) */}
            {vm.passkeySupported ? (
              <view width="100%" gap={18}>
                {this.renderCapsuleAction({
                  id: "oc-hub-passkey-signin",
                  title: vm.hubSignInLabel,
                  variant: "primary",
                  icon: "key",
                  disabled: vm.passkeyBusy,
                  loading: vm.passkeyBusy,
                  dark,
                  touch,
                  onPress: () => vm.onPasskeySignIn(),
                })}

                <view width="100%" flexDirection="row" alignItems="center" gap={12}>
                  <view height={0.5} flexGrow={1} backgroundColor={divider} />
                  <label value={vm.orPasteLinkLabel ?? vm.linkLabel} font={systemFont(12)} color={subtle} />
                  <view height={0.5} flexGrow={1} backgroundColor={divider} />
                </view>
              </view>
            ) : null}

            {/* Unified Apple Capsule Input for Pairing / Collaborator Share Link */}
            <view width="100%" gap={10}>
              {this.renderUnifiedInputCapsule({
                inputId: "oc-remote-welcome-link-input",
                buttonId: "oc-remote-welcome-connect",
                ariaLabel: vm.linkLabel,
                value: vm.linkValue,
                placeholder: vm.linkPlaceholder,
                buttonTitle: vm.connectingLink ? vm.connectingLabel : vm.connectLinkLabel,
                canSubmit: canSubmitLink,
                busy: vm.connectingLink,
                dark,
                touch,
                onChange: (val) => vm.onChangeLink(val),
                onSubmit: () => vm.onSubmitLink(),
              })}
            </view>

            {/* Quiet Hairline Footer + Contextual Self-Hosted Server Disclosure */}
            <view width="100%" gap={12} paddingTop={2}>
              <view width="100%" height={0.5} backgroundColor={divider} />
              <view width="100%" flexDirection="row" alignItems="center" justifyContent="space-between" gap={8}>
                <view
                  class="oc-ghost-button"
                  accessibilityId="oc-remote-welcome-server-disclosure"
                  accessibilityLabel={vm.serverDisclosureTitle}
                  accessibilityCategory="button"
                  onTap={() => {
                    triggerHaptic("selection");
                    this.setState({ serverOpen: !this.state.serverOpen });
                  }}
                  paddingLeft={8}
                  paddingRight={8}
                  paddingTop={4}
                  paddingBottom={4}
                  flexDirection="row"
                  alignItems="center"
                  gap={4}
                >
                  <label value={vm.serverDisclosureTitle} font={systemFont(12.5)} color={muted} />
                  <Icon name={this.state.serverOpen ? "chevronUp" : "chevronDown"} size={11} color={subtle} />
                </view>

                <view
                  class="oc-ghost-button"
                  accessibilityId="oc-remote-welcome-download"
                  accessibilityLabel={vm.downloadActionLabel}
                  accessibilityCategory="button"
                  onTap={() => {
                    triggerHaptic("light");
                    vm.onDownloadDesktop();
                  }}
                  paddingLeft={8}
                  paddingRight={8}
                  paddingTop={4}
                  paddingBottom={4}
                  flexDirection="row"
                  alignItems="center"
                  gap={4}
                >
                  <label value={vm.downloadActionLabel} font={systemFont(12.5)} color={muted} />
                  <Icon name="external" size={11} color={subtle} />
                </view>
              </view>

              {this.state.serverOpen ? (
                <view width="100%" paddingTop={2}>
                  {this.renderUnifiedInputCapsule({
                    inputId: "oc-remote-welcome-server-url",
                    buttonId: "oc-remote-welcome-server-submit",
                    ariaLabel: vm.serverAddressLabel,
                    value: vm.serverValue,
                    placeholder: vm.serverPlaceholder,
                    buttonTitle: vm.connectServerLabel,
                    canSubmit: canSubmitServer,
                    busy: vm.connectingServer,
                    dark,
                    touch,
                    onChange: (val) => vm.onChangeServer(val),
                    onSubmit: () => vm.onSubmitServer(),
                  })}
                </view>
              ) : null}
            </view>
          </view>
        )}
      </view>
    </view>;
  }
}
