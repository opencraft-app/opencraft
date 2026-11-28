import { AnimationCurve } from "valdi_core/src/AnimationOptions";
import { StatefulComponent } from "valdi_core/src/Component";
import { ActionSheet, type ActionSheetAction } from "./ActionSheet";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { registerHapticHandler, triggerHaptic } from "./haptics";
import { Icon } from "./Icon";
import { MobileWelcomeSurface, type MobileWelcomeProps } from "./MobileWelcomeSurface";
import { SegmentedControl } from "./SegmentedControl";
import { TextField } from "./TextField";
import { radii, themeColors, type } from "./tokens";

export type MobileOverlayMode = "idle" | "welcome" | "source-settings" | "confirm-dialog" | "action-sheet";

export type OverlayActionItem = {
  id: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
};

export type MobileNativeOverlayProps = {
  mode?: MobileOverlayMode;
  dark?: boolean;
  safeAreaTop?: number;
  safeAreaBottom?: number;
  keyboardHeight?: number;
  showFloatingControl?: boolean;
  sourceKind?: string;
  sourceUrl?: string;
  pending?: boolean;
  sourceError?: string;
  // Localized copy supplied by the native host from canonical locale catalogs
  sourceLabel?: string;
  sourceDescription?: string;
  bundledLabel?: string;
  selfHostedLabel?: string;
  urlLabel?: string;
  urlPlaceholder?: string;
  clearLabel?: string;
  privacyHint?: string;
  applyLabel?: string;
  cancelLabel?: string;
  // Delegated ConfirmDialog props
  dialogTitle?: string;
  dialogMessage?: string;
  dialogConfirmLabel?: string;
  dialogCancelLabel?: string;
  dialogDestructive?: boolean;
  // Delegated ActionSheet props
  sheetTitle?: string;
  sheetMessage?: string;
  sheetCancelLabel?: string;
  sheetActions?: readonly OverlayActionItem[];
  // Native Welcome props (when mode === 'welcome' or overlaid by modal)
  welcomeVisible?: boolean;
  welcomeBrandLabel?: string;
  welcomeTitle?: string;
  welcomeSubtitle?: string;
  welcomeQuickGroup?: string;
  welcomeConnectTitle?: string;
  welcomeConnectDetail?: string;
  welcomeExploreTitle?: string;
  welcomeExploreDetail?: string;
  // Host callbacks
  onHaptic?: (style: string) => void;
  onOpenSourceSettings?: () => void;
  onCloseOverlay?: () => void;
  onSaveSource?: (kind: string, url: string) => void;
  onConfirmResult?: (confirmed: boolean) => void;
  onActionSheetResult?: (actionId: string) => void;
  onWelcomeConnect?: () => void;
  onWelcomeExplore?: () => void;
};

type State = {
  remoteSelected: boolean;
  draftUrl: string;
  sheetEntered: boolean;
  pillPressing: boolean;
};

/**
 * Native Valdi overlay surface hosted above WKWebView in the thin native shell.
 * Owns only transient UI choreography; source persistence and Web state remain in their owners.
 */
export class MobileNativeOverlay extends StatefulComponent<MobileNativeOverlayProps, State> {
  state: State = {
    remoteSelected: false,
    draftUrl: "",
    sheetEntered: false,
    pillPressing: false,
  };

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
    this.syncFromViewModel(undefined);
  }

  onViewModelUpdate(previous?: Readonly<MobileNativeOverlayProps>): void {
    registerHapticHandler(this.viewModel.onHaptic);
    this.syncFromViewModel(previous);
  }

  private syncFromViewModel(previous?: Readonly<MobileNativeOverlayProps>): void {
    const mode = this.viewModel.mode ?? "idle";
    const prevMode = previous?.mode ?? "idle";
    if (!previous || (mode === "source-settings" && prevMode !== "source-settings")) {
      this.setState({
        remoteSelected: this.viewModel.sourceKind === "self-hosted",
        draftUrl: this.viewModel.sourceUrl ?? "",
        sheetEntered: false,
      });
      if (mode === "source-settings") {
        setTimeout(() => {
          if (this.isDestroyed()) return;
          this.animate({ stiffness: 340, damping: 30 }, () => {
            this.setState({ sheetEntered: true });
          });
        }, 16);
      }
    }
  }

  private setPillPressing(pressing: boolean): void {
    if (this.state.pillPressing === pressing) return;
    this.animate({ duration: 0.12, curve: AnimationCurve.EaseOut }, () => {
      this.setState({ pillPressing: pressing });
    });
  }

  onRender(): void {
    const vm = this.viewModel;
    const mode = vm.mode ?? "idle";
    const dark = Boolean(vm.dark);
    const c = themeColors(dark);
    const safeTop = vm.safeAreaTop ?? 0;
    const safeBottom = vm.safeAreaBottom ?? 0;
    const keyboard = vm.keyboardHeight ?? 0;

    if (vm.welcomeVisible || mode === "welcome") {
      const welcomeProps: MobileWelcomeProps = {
        dark,
        safeAreaTop: safeTop,
        safeAreaBottom: safeBottom,
        hasSourceSettings: true,
        brandLabel: vm.welcomeBrandLabel ?? "OpenCraft",
        title: vm.welcomeTitle ?? "",
        subtitle: vm.welcomeSubtitle ?? "",
        connectGroupTitle: vm.welcomeQuickGroup ?? "",
        connectServerTitle: vm.welcomeConnectTitle ?? "",
        connectServerDetail: vm.welcomeConnectDetail ?? "HTTPS",
        exploreOfflineTitle: vm.welcomeExploreTitle ?? "",
        exploreOfflineDetail: vm.welcomeExploreDetail ?? "",
        sourceSettingsTitle: vm.sourceLabel ?? "",
        sourceSettingsDetail: "Host",
        onConnect: () => vm.onWelcomeConnect?.(),
        onExplore: () => vm.onWelcomeExplore?.(),
        onOpenSourceSettings: () => vm.onOpenSourceSettings?.(),
        onHaptic: vm.onHaptic,
      };
      <MobileWelcomeSurface {...welcomeProps} />;
    }

    if (mode === "confirm-dialog" && vm.dialogTitle && vm.dialogConfirmLabel && vm.dialogCancelLabel) {
      <ConfirmDialog
        id="oc-native-confirm"
        title={vm.dialogTitle}
        message={vm.dialogMessage}
        confirmTitle={vm.dialogConfirmLabel}
        cancelTitle={vm.dialogCancelLabel}
        destructive={vm.dialogDestructive}
        dark={dark}
        onCancel={() => vm.onConfirmResult?.(false)}
        onConfirm={() => vm.onConfirmResult?.(true)}
      />;
      return;
    }

    if (mode === "action-sheet" && vm.sheetCancelLabel && vm.sheetActions && vm.sheetActions.length > 0) {
      const actions: ActionSheetAction[] = vm.sheetActions.map((item) => ({
        id: item.id,
        title: item.label,
        destructive: item.destructive,
        disabled: item.disabled,
        onPress: () => vm.onActionSheetResult?.(item.id),
      }));
      <ActionSheet
        id="oc-native-action-sheet"
        title={vm.sheetTitle}
        message={vm.sheetMessage}
        cancelTitle={vm.sheetCancelLabel}
        bottomInset={Math.max(20, safeBottom + 10)}
        actions={actions}
        dark={dark}
        onCancel={() => vm.onActionSheetResult?.("")}
      />;
      return;
    }

    if (mode === "source-settings") {
      const entered = this.state.sheetEntered;
      const bottomInset = Math.max(20, safeBottom + 12, keyboard + 12);
      const sourceTitle = vm.sourceLabel ?? "";
      const applyTitle = vm.applyLabel ?? "";
      const cancelTitle = vm.cancelLabel ?? "";
      <view
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        zIndex={10}
        justifyContent="flex-end"
        alignItems="center"
        paddingLeft={12}
        paddingRight={12}
        paddingBottom={bottomInset}
      >
        <view
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          backgroundColor={c.overlay}
          opacity={entered ? 1 : 0}
          onTap={
            vm.pending
              ? undefined
              : () => {
                  triggerHaptic("selection");
                  vm.onCloseOverlay?.();
                }
          }
          accessibilityNavigation="ignored"
        />
        <glass
          class={dark ? "oc-liquid-glass oc-dark" : "oc-liquid-glass"}
          accessibilityId="oc-source-settings-sheet"
          accessibilityLabel={sourceTitle}
          width="100%"
          maxWidth={440}
          borderRadius={radii.alert}
          glassStyle="regular"
          backgroundColor={c.alert}
          glassTintColor={c.glassTint}
          borderWidth={0.5}
          borderColor={c.glassBorder}
          boxShadow={dark ? "complex 0 18 44 rgba(0, 0, 0, 0.36)" : "complex 0 16 38 rgba(24, 24, 28, 0.14)"}
          padding={18}
          gap={14}
          translationY={entered ? 0 : 160}
          opacity={entered ? 1 : 0}
        >
          <view alignItems="center" paddingBottom={2}>
            <view
              width={36}
              height={5}
              borderRadius={3}
              backgroundColor={c.trackOff}
              accessibilityNavigation="ignored"
            />
          </view>
          <view gap={4} paddingLeft={4} paddingRight={4}>
            <label value={sourceTitle} font={type.section} color={c.ink} accessibilityCategory="header" />
            {vm.sourceDescription && (
              <label value={vm.sourceDescription} font={type.detail} color={c.muted} numberOfLines={0} />
            )}
          </view>
          <SegmentedControl
            id="oc-source-kind"
            label={sourceTitle}
            value={this.state.remoteSelected ? "self-hosted" : "bundled"}
            options={[
              { id: "bundled", title: vm.bundledLabel ?? "" },
              { id: "self-hosted", title: vm.selfHostedLabel ?? "" },
            ]}
            disabled={vm.pending}
            dark={dark}
            onChange={(id) => this.setState({ remoteSelected: id === "self-hosted" })}
          />
          {this.state.remoteSelected && (
            <view gap={10}>
              <TextField
                id="oc-source-url"
                label={vm.urlLabel ?? ""}
                value={this.state.draftUrl}
                placeholder={vm.urlPlaceholder}
                clearTitle={vm.clearLabel}
                disabled={vm.pending}
                dark={dark}
                contentType="url"
                autocapitalization="none"
                onChange={(value) => this.setState({ draftUrl: value })}
                onSubmit={() => {
                  if (!vm.pending) {
                    triggerHaptic("medium");
                    vm.onSaveSource?.("self-hosted", this.state.draftUrl);
                  }
                }}
              />
              {vm.privacyHint && (
                <label
                  value={vm.privacyHint}
                  font={type.detail}
                  color={c.muted}
                  marginLeft={8}
                  marginRight={8}
                  numberOfLines={0}
                />
              )}
            </view>
          )}
          {vm.sourceError && <Banner id="oc-source-error" tone="danger" title={vm.sourceError} dark={dark} />}
          <view flexDirection="row" gap={10} paddingTop={4}>
            <view flexGrow={1} flexBasis={0}>
              <Button
                id="oc-source-cancel"
                title={cancelTitle}
                variant="quiet"
                disabled={vm.pending}
                dark={dark}
                onPress={() => {
                  triggerHaptic("selection");
                  vm.onCloseOverlay?.();
                }}
              />
            </view>
            <view flexGrow={1} flexBasis={0}>
              <Button
                id="oc-source-apply"
                title={applyTitle}
                variant="primary"
                disabled={vm.pending}
                dark={dark}
                onPress={() => {
                  triggerHaptic("medium");
                  vm.onSaveSource?.(this.state.remoteSelected ? "self-hosted" : "bundled", this.state.draftUrl);
                }}
              />
            </view>
          </view>
        </glass>
      </view>;
      return;
    }

    if (vm.showFloatingControl && !vm.welcomeVisible && mode !== "welcome") {
      const pressing = this.state.pillPressing;
      <view
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        justifyContent="center"
        alignItems="flex-end"
        paddingRight={10}
      >
        <glass
          accessibilityId="oc-floating-source-button"
          accessibilityLabel={vm.sourceLabel ?? ""}
          accessibilityCategory="button"
          onTouchStart={() => this.setPillPressing(true)}
          onTouchEnd={() => this.setPillPressing(false)}
          onTap={() => {
            triggerHaptic("light");
            vm.onOpenSourceSettings?.();
          }}
          width={44}
          height={44}
          borderRadius={22}
          glassStyle="regular"
          glassTintColor={c.glassTint}
          borderWidth={0.5}
          borderColor={c.glassBorder}
          scaleX={pressing ? 0.92 : 1}
          scaleY={pressing ? 0.92 : 1}
          boxShadow={dark ? "complex 0 6 20 rgba(0, 0, 0, 0.30)" : "complex 0 4 16 rgba(24, 24, 28, 0.12)"}
          justifyContent="center"
          alignItems="center"
        >
          <Icon name="link" size={20} color={c.ink} />
        </glass>
      </view>;
    }
  }
}
