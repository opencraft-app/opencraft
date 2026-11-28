export interface ValdiComponentConstructor<TViewModel = Record<string, unknown>, TContext = Record<string, unknown>> {
  new (...args: unknown[]): unknown;
  readonly __viewModelBrand?: TViewModel;
  readonly __contextBrand?: TContext;
}

export declare class ValdiWebRenderer {
  constructor(htmlRoot: HTMLElement | ShadowRoot, contextIdentifierPrefix?: string);
  renderRootComponent<TViewModel extends object>(
    componentConstructor: ValdiComponentConstructor<TViewModel>,
    props?: Record<string, unknown>,
    viewModel?: TViewModel,
    context?: Record<string, unknown>,
  ): void;
  destroy(): void;
}

export type IconName =
  | "home"
  | "inbox"
  | "gear"
  | "link"
  | "arrowLeft"
  | "chevronLeft"
  | "chevronRight"
  | "chevronUp"
  | "check"
  | "info"
  | "warning"
  | "close"
  | "sparkle"
  | "plus"
  | "minus"
  | "external"
  | "sunDim"
  | "sunMax"
  | "toggle"
  | "slider"
  | "segmented"
  | "textfield"
  | "tabbar"
  | "pagecontrol"
  | "list"
  | "sheet"
  | "server"
  | "laptop"
  | "terminal"
  | "copy"
  | "grid"
  | "search"
  | "bot"
  | "gauge"
  | "chevronDown"
  | "refresh"
  | "user"
  | "chat"
  | "bell"
  | "puzzle"
  | "key"
  | "lock";

export type HapticStyle = "selection" | "light" | "medium";

export type ColorTokens = {
  readonly canvas: string;
  readonly surface: string;
  readonly recessed: string;
  readonly border: string;
  readonly ink: string;
  readonly muted: string;
  readonly disabled: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly accentSoft: string;
  readonly primaryButton: string;
  readonly primaryButtonForeground: string;
  readonly toggleOn: string;
  readonly toggleThumb: string;
  readonly segmentThumb: string;
  readonly navCurrent: string;
  readonly info: string;
  readonly infoSurface: string;
  readonly success: string;
  readonly successSurface: string;
  readonly warning: string;
  readonly warningSurface: string;
  readonly danger: string;
  readonly dangerSurface: string;
  readonly skill: string;
  readonly skillSurface: string;
  readonly trackOff: string;
  readonly trackSoft: string;
  readonly trackSubtle: string;
  readonly glassTint: string;
  readonly glassBorder: string;
  readonly overlay: string;
  readonly alert: string;
};

export declare function setValdiThemeColors(
  mode: "light" | "dark",
  overrides?: Partial<ColorTokens> | null,
): void;
export declare function setValdiTouchDensity(touch: boolean): void;
export declare function valdiTouch(explicit?: boolean): boolean;

export type ActionSheetAction = {
  readonly id: string;
  readonly title: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
};

export type TabBarItem = {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  readonly badge?: string;
};

export type GalleryProps = {
  readonly dark?: boolean;
  readonly locale?: string;
  readonly layoutMode?: "auto" | "split" | "compact";
  readonly safeAreaTop?: number;
  readonly safeAreaBottom?: number;
  readonly keyboardHeight?: number;
  readonly onHaptic?: (style: string) => void;
  readonly onThemeChange?: (dark: boolean) => void;
};

export type MobileWelcomeProps = {
  readonly dark?: boolean;
  readonly safeAreaTop?: number;
  readonly safeAreaBottom?: number;
  readonly themePreference?: "light" | "dark" | "system";
  readonly hasSourceSettings?: boolean;
  readonly brandLabel?: string;
  readonly heroBadge?: string;
  readonly title: string;
  readonly subtitle: string;
  readonly tabStart?: string;
  readonly tabAppearance?: string;
  readonly tabComponents?: string;
  readonly connectGroupTitle: string;
  readonly connectServerTitle: string;
  readonly connectServerDetail: string;
  readonly exploreOfflineTitle: string;
  readonly exploreOfflineDetail: string;
  readonly sourceSettingsTitle: string;
  readonly sourceSettingsDetail: string;
  readonly quickActionsBtn?: string;
  readonly openStyleLabBtn?: string;
  readonly appearanceModeTitle?: string;
  readonly lightLabel?: string;
  readonly darkLabel?: string;
  readonly systemLabel?: string;
  readonly physicsGroupTitle?: string;
  readonly hapticsToggleTitle?: string;
  readonly springSliderLabel?: string;
  readonly bannerTitle?: string;
  readonly bannerMessage?: string;
  readonly cancelLabel?: string;
  readonly onConnect: () => void;
  readonly onExplore: () => void;
  readonly onOpenStyleLab?: () => void;
  readonly onOpenSourceSettings?: () => void;
  readonly onThemePreferenceChange?: (preference: "light" | "dark" | "system") => void;
  readonly onHaptic?: (style: string) => void;
};

export type ServerConnectionProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly compact?: boolean;
  readonly badgeLabel: string;
  readonly title: string;
  readonly subtitle: string;
  readonly groupTitle: string;
  readonly addressLabel: string;
  readonly addressPlaceholder: string;
  readonly addressHint: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly clearLabel: string;
  readonly privacyTitle: string;
  readonly privacyMessage: string;
  readonly connectLabel: string;
  readonly connectingLabel: string;
  readonly cancelLabel?: string;
  readonly initialUrl?: string;
  readonly initialName?: string;
  readonly pending?: boolean;
  readonly error?: string;
  readonly connectedMessage?: string;
  readonly onConnect: (url: string, displayName: string) => void;
  readonly onInputChange?: () => void;
  readonly onCancel?: () => void;
  readonly onHaptic?: (style: string) => void;
};

export type PendingMachineSummary = {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
};

export type AddMachineProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly badgeLabel: string;
  readonly title: string;
  readonly subtitle: string;
  readonly closeLabel: string;
  readonly platformLabel: string;
  readonly macosLabel: string;
  readonly linuxLabel: string;
  readonly macosHint: string;
  readonly linuxHint: string;
  readonly commandGroupTitle: string;
  readonly commandHint: string;
  readonly generatingLabel: string;
  readonly noEntranceTitle: string;
  readonly noEntranceMessage: string;
  readonly copyLabel: string;
  readonly copiedLabel: string;
  readonly regenerateLabel: string;
  readonly statusGroupTitle: string;
  readonly waitingTitle: string;
  readonly waitingDetail: string;
  readonly connectedTitle: string;
  readonly connectedMessage?: string;
  readonly doneLabel: string;
  readonly revokeLabel: string;
  readonly command: string;
  readonly generating?: boolean;
  readonly copied?: boolean;
  readonly hasEntrance: boolean;
  readonly error?: string;
  readonly pendingMachines?: readonly PendingMachineSummary[];
  readonly connectedMachineName?: string;
  readonly onCopy: () => void;
  readonly onRegenerate: () => void;
  readonly onRevoke?: (id: string) => void;
  readonly onClose: () => void;
  readonly onHaptic?: (style: string) => void;
};

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

export type RemoteAccessApprovedDeviceItem = {
  readonly thumbprint: string;
  readonly label: string;
  readonly detailLabel: string;
  readonly active: boolean;
};

export type RemoteAccessActiveShareItem = {
  readonly grantId: string;
  readonly permissionLabel: string;
  readonly expiresLabel: string;
  readonly shareUrl?: string;
};

export type RemoteAccessSettingsProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly narrow?: boolean;
  readonly title: string;
  readonly subtitle?: string;
  readonly errorMessage?: string;
  readonly noticeMessage?: string;
  readonly enableTitle: string;
  readonly enableDescription: string;
  readonly enabled: boolean;
  readonly busy?: boolean;
  readonly deviceNameLabel: string;
  readonly deviceNamePlaceholder: string;
  readonly deviceName: string;
  readonly scanInlinePrefix: string;
  readonly copyLinkInlineLabel: string;
  readonly copiedInlineLabel: string;
  readonly scanInlineSuffix?: string;
  readonly pairingUrl: string;
  readonly qrSvgDataUri?: string;
  readonly qrMatrix?: readonly (readonly boolean[])[];
  readonly pairingCopied?: boolean;
  readonly refreshQrLabel: string;
  readonly sleepProtectionTitle?: string;
  readonly sleepProtectionDescription?: string;
  readonly sleepProtectionStatusLabel?: string;
  readonly sleepProtectionActive?: boolean;
  readonly sleepProtectionMode?: "ac" | "always" | "off";
  readonly sleepModeAcLabel?: string;
  readonly sleepModeAlwaysLabel?: string;
  readonly sleepModeOffLabel?: string;
  readonly advancedGroupTitle: string;
  readonly statusTitle: string;
  readonly statusDetail: string;
  readonly connected: boolean;
  readonly refreshRoutesLabel: string;
  readonly directRoutesTitle: string;
  readonly directRoutesEmpty: string;
  readonly directRoutes: readonly RemoteAccessDirectRouteItem[];
  readonly customRelayTitle: string;
  readonly customRelayPlaceholder: string;
  readonly customRelayHint: string;
  readonly customRelayUrl: string;
  readonly requireApprovalTitle: string;
  readonly requireApprovalDescription: string;
  readonly requireApproval: boolean;
  readonly hubClaimed?: boolean;
  readonly hubTitle: string;
  readonly hubDescription: string;
  readonly hubActionLabel: string;
  readonly hubRebindActionLabel?: string;
  readonly claimingHub?: boolean;
  readonly approvalsGroupTitle: string;
  readonly approvalsGroupDescription: string;
  readonly approveButtonLabel: string;
  readonly pendingApprovals: readonly RemoteAccessPendingApprovalItem[];
  readonly devicesGroupTitle?: string;
  readonly devicesGroupDescription?: string;
  readonly devicesEmptyText?: string;
  readonly revokeDeviceLabel?: string;
  readonly approvedDevices?: readonly RemoteAccessApprovedDeviceItem[];
  readonly shareGroupTitle: string;
  readonly shareGroupDescription: string;
  readonly sharePermissionTitle: string;
  readonly sharePermissionDescription: string;
  readonly shareViewOnlyLabel: string;
  readonly shareAllowExecLabel: string;
  readonly shareMode: "view" | "exec";
  readonly createShareLabel: string;
  readonly creatingShare?: boolean;
  readonly latestShareUrl?: string;
  readonly copyShareLabel: string;
  readonly copiedShareLabel: string;
  readonly shareCopied?: boolean;
  readonly activeSharesEmpty: string;
  readonly revokeShareLabel: string;
  readonly activeShares: readonly RemoteAccessActiveShareItem[];
  readonly onToggleEnabled: (next: boolean, relayOriginOverride: string) => void;
  readonly onChangeDeviceName: (name: string) => void;
  readonly onSubmitDeviceName: (name: string) => void;
  readonly onChangeCustomRelayUrl: (value: string) => void;
  readonly onRefreshRoutes: () => void;
  readonly onCopyPairingUrl: () => void;
  readonly onRefreshQr: () => void;
  readonly onChangeSleepProtectionMode?: (mode: "ac" | "always" | "off") => void;
  readonly onChangeRequireApproval: (next: boolean) => void;
  readonly onApproveDevice: (shortCode: string) => void;
  readonly onRevokeDevice?: (thumbprint: string) => void;
  readonly onChangeShareMode: (mode: "view" | "exec") => void;
  readonly onCreateShare: () => void;
  readonly onCopyShareUrl: (url: string) => void;
  readonly onRevokeShare: (grantId: string) => void;
  readonly onHubAction: () => void;
  readonly onHubRebindAction?: () => void;
  readonly onDismissNotice?: () => void;
  readonly onHaptic?: (style: string) => void;
};

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
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly narrow?: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly passkeySupported?: boolean;
  readonly passkeyBusy?: boolean;
  readonly hubSignedIn?: boolean;
  readonly hubSignInLabel: string;
  readonly hubCreateLabel?: string;
  readonly hubCardTitle: string;
  readonly hubCardDescription?: string;
  readonly hubMachineCountLabel?: string;
  readonly hubAddDeviceHint?: string;
  readonly hubPasteTempLinkLabel?: string;
  readonly hubRefreshLabel: string;
  readonly hubSignOutLabel: string;
  readonly backToWorkspaceLabel?: string;
  readonly hubEmptyMachinesText: string;
  readonly hubMachines?: readonly HubMachineDirectoryItem[];
  readonly claimMachineName?: string;
  readonly claimBannerTitle?: string;
  readonly claimBannerDescription?: string;
  readonly claimWithExistingPasskeyLabel?: string;
  readonly claimWithNewPasskeyLabel?: string;
  readonly claimConfirmCurrentHubLabel?: string;
  readonly claimPrivacyHint?: string;
  readonly cancelClaimLabel?: string;
  readonly orPasteLinkLabel?: string;
  readonly stepOneText?: string;
  readonly stepTwoText?: string;
  readonly linkLabel: string;
  readonly linkPlaceholder: string;
  readonly linkValue: string;
  readonly connectLinkLabel: string;
  readonly connectingLabel: string;
  readonly connectingLink?: boolean;
  readonly downloadPrefix?: string;
  readonly downloadActionLabel: string;
  readonly pendingCodeTitle?: string;
  readonly pendingCodeDetail?: string;
  readonly pendingShortCode?: string;
  readonly infoTitle?: string;
  readonly infoMessage?: string;
  readonly errorMessage?: string;
  readonly serverDisclosureTitle: string;
  readonly serverAddressLabel: string;
  readonly serverPlaceholder: string;
  readonly serverValue: string;
  readonly connectServerLabel: string;
  readonly connectingServer?: boolean;
  readonly clearLabel?: string;
  readonly onPasskeySignIn: () => void;
  readonly onPasskeyCreate: () => void;
  readonly onClaimConfirmCurrentHub?: () => void;
  readonly onDismissClaim?: () => void;
  readonly onHubRefresh?: () => void;
  readonly onHubSignOut?: () => void;
  readonly onBackToWorkspace?: () => void;
  readonly onDismissInfo?: () => void;
  readonly onConnectHubMachine?: (machineId: string) => void;
  readonly onChangeLink: (value: string) => void;
  readonly onSubmitLink: () => void;
  readonly onDownloadDesktop: () => void;
  readonly onChangeServer: (value: string) => void;
  readonly onSubmitServer: () => void;
  readonly onDismissError?: () => void;
  readonly onHaptic?: (style: string) => void;
};

export declare const AddMachineSurface: ValdiComponentConstructor<AddMachineProps>;
export declare const RemoteAccessSettingsSurface: ValdiComponentConstructor<RemoteAccessSettingsProps>;
export declare const RemoteWorkbenchWelcomeSurface: ValdiComponentConstructor<RemoteWorkbenchWelcomeProps>;
export declare const ServerConnectionSurface: ValdiComponentConstructor<ServerConnectionProps>;

export type SidebarDockTabItem = {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  readonly badge?: string;
};

export type SidebarDockProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly label: string;
  readonly items: readonly SidebarDockTabItem[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onHaptic?: (style: string) => void;
};

export type SidebarOrbProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly chromeless?: boolean;
  readonly icon: IconName;
  readonly active?: boolean;
  readonly badgeDot?: boolean;
};

export type TokenUsageWindowItem = {
  readonly id: string;
  readonly label: string;
  readonly progress: number;
  readonly percentText: string;
  readonly resetText: string;
  readonly costText?: string;
  readonly warning?: boolean;
};

export type TokenUsageMetricItem = {
  readonly label: string;
  readonly value: string;
};

export type TokenUsageProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly open: boolean;
  readonly title: string;
  readonly summary: string;
  readonly machineLabel?: string;
  readonly machines?: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly selectedMachineId?: string;
  readonly providerLabel: string;
  readonly providers: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly selectedProviderId: string;
  readonly planText?: string;
  readonly accountText?: string;
  readonly refreshLabel: string;
  readonly refreshDisabled?: boolean;
  readonly statusMessage?: string;
  readonly windows: readonly TokenUsageWindowItem[];
  readonly conversationHeading: string;
  readonly conversationProvider?: string;
  readonly contextLabel?: string;
  readonly contextDetail?: string;
  readonly contextProgress?: number;
  readonly conversationFallback?: string;
  readonly metrics: readonly TokenUsageMetricItem[];
  readonly observedAtText?: string;
  readonly onToggleOpen: () => void;
  readonly onSelectMachine?: (id: string) => void;
  readonly onSelectProvider: (id: string) => void;
  readonly onRefresh: () => void;
  readonly onHaptic?: (style: string) => void;
};

export type AgentReadinessProps = {
  readonly id?: string;
  readonly agentName: string;
  readonly statusTitle: string;
  readonly description: string;
  readonly icon?: IconName;
  readonly version?: string | null;
  readonly account?: string | null;
  readonly phase?: "idle" | "running" | "failed";
  readonly errorMessage?: string | null;
  readonly primaryActionTitle?: string | null;
  readonly secondaryActionTitle?: string | null;
  readonly openLinkTitle?: string | null;
  readonly userCode?: string | null;
  readonly copyCodeTitle?: string | null;
  readonly awaitingCode?: boolean;
  readonly authCodeValue?: string;
  readonly authCodePlaceholder?: string;
  readonly submitCodeTitle?: string | null;
  readonly touch?: boolean;
  readonly dark?: boolean;
  readonly onPrimaryAction?: () => void;
  readonly onSecondaryAction?: () => void;
  readonly onOpenLink?: () => void;
  readonly onCopyCode?: () => void;
  readonly onAuthCodeChange?: (value: string) => void;
  readonly onSubmitCode?: () => void;
};

export declare const AgentReadinessSurface: ValdiComponentConstructor<AgentReadinessProps>;
export declare const SidebarDockSurface: ValdiComponentConstructor<SidebarDockProps>;
export declare const SidebarOrbSurface: ValdiComponentConstructor<SidebarOrbProps>;
export declare const TokenUsageSurface: ValdiComponentConstructor<TokenUsageProps>;

export type ChatSettingsProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly badgeLabel: string;
  readonly title: string;
  readonly subtitle: string;
  readonly behaviorGroupTitle: string;
  readonly followUpTitle: string;
  readonly followUpDescription: string;
  readonly immediateFollowUp: boolean;
  readonly savingFollowUp?: boolean;
  readonly rightPanelTitle: string;
  readonly rightPanelDescription: string;
  readonly openPagesInRightPanel: boolean;
  readonly savingRightPanel?: boolean;
  readonly externalNotificationsOwner?: boolean;
  readonly notificationsGroupTitle: string;
  readonly notifyTitle: string;
  readonly notifyDescription: string;
  readonly notifyEnabled: boolean;
  readonly notifyDisabled?: boolean;
  readonly notifyBusy?: boolean;
  readonly showTestNotification?: boolean;
  readonly testNotifyLabel: string;
  readonly testNotifyActionLabel: string;
  readonly connectImLabel?: string;
  readonly errorMessage?: string;
  readonly onChangeImmediateFollowUp: (enabled: boolean) => void;
  readonly onChangeOpenPagesInRightPanel: (enabled: boolean) => void;
  readonly onChangeNotifyEnabled: (enabled: boolean) => void;
  readonly onTestNotification: () => void;
  readonly onOpenImSettings?: () => void;
  readonly onHaptic?: (style: string) => void;
};

export type PluginCatalogItem = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: "builtin" | "installed";
  readonly sourceLabel: string;
  readonly statusTone: "active" | "inactive" | "warning" | "danger";
  readonly statusLabel: string;
  readonly description: string;
  readonly metadata: string;
  readonly icon: IconName;
  readonly enabled: boolean;
  readonly canManage: boolean;
  readonly busy?: boolean;
  readonly error?: string;
  readonly toggleLabel: string;
  readonly openDetailLabel: string;
};

export type PluginDetailModel = {
  readonly id: string;
  readonly name: string;
  readonly versionMetadata: string;
  readonly statusLabel: string;
  readonly statusTone: "active" | "inactive" | "warning" | "danger";
  readonly statusError?: string;
  readonly intentLabel: string;
  readonly capabilitiesText: string;
  readonly sourceUrl?: string;
  readonly updateError?: string;
  readonly actionError?: string;
  readonly canManage: boolean;
  readonly canReload: boolean;
  readonly canRemove: boolean;
  readonly enabled: boolean;
  readonly busy?: boolean;
  readonly icon: IconName;
};

export type PluginsSettingsProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly showHeader?: boolean;
  readonly badgeLabel: string;
  readonly title: string;
  readonly subtitle: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly clearLabel: string;
  readonly sourceFilterLabel: string;
  readonly sourceAllLabel: string;
  readonly sourceBuiltinLabel: string;
  readonly sourceInstalledLabel: string;
  readonly listGroupTitle: string;
  readonly emptyTitle: string;
  readonly noMatchTitle: string;
  readonly backLabel: string;
  readonly detailGroupTitle: string;
  readonly statusRowTitle: string;
  readonly intentRowTitle: string;
  readonly capabilitiesRowTitle: string;
  readonly sourceUrlRowTitle: string;
  readonly updateFailedRowTitle: string;
  readonly updateFailedRowDetail: string;
  readonly enableActionLabel: string;
  readonly disableActionLabel: string;
  readonly reloadActionLabel: string;
  readonly removeActionLabel: string;
  readonly builtinManagedTitle: string;
  readonly builtinManagedMessage: string;
  readonly developerMode?: boolean;
  readonly installGroupTitle: string;
  readonly installUrlLabel: string;
  readonly installUrlPlaceholder: string;
  readonly installActionLabel: string;
  readonly installBusy?: boolean;
  readonly installError?: string;
  readonly confirmRemoveTitle: string;
  readonly confirmRemoveMessage: string;
  readonly confirmRemoveConfirmLabel: string;
  readonly confirmRemoveCancelLabel: string;
  readonly alerts: readonly string[];
  readonly items: readonly PluginCatalogItem[];
  readonly detail?: PluginDetailModel;
  readonly onSelectPlugin: (id: string | null) => void;
  readonly onTogglePlugin: (id: string, enabled: boolean) => void;
  readonly onReloadPlugin: (id: string) => void;
  readonly onRequestRemovePlugin: (id: string) => void;
  readonly onInstallUrl: (url: string) => void;
  readonly confirmingRemoveId?: string | null;
  readonly onConfirmRemove: (id: string) => void;
  readonly onCancelRemove: () => void;
  readonly onHaptic?: (style: string) => void;
};

export declare const ChatSettingsSurface: ValdiComponentConstructor<ChatSettingsProps>;
export declare const PluginsSettingsSurface: ValdiComponentConstructor<PluginsSettingsProps>;

export declare const ActionSheet: ValdiComponentConstructor<{
  id: string;
  title?: string;
  message?: string;
  actions: readonly ActionSheetAction[];
  cancelTitle?: string;
  dark?: boolean;
  onCancel: () => void;
}>;
export declare const Banner: ValdiComponentConstructor<{
  id: string;
  tone?: "info" | "success" | "warning" | "danger";
  title: string;
  message?: string;
  actionTitle?: string;
  dark?: boolean;
  onAction?: () => void;
  onDismiss?: () => void;
}>;
export declare const Button: ValdiComponentConstructor<{
  id?: string;
  title: string;
  variant?: "primary" | "secondary" | "quiet" | "ghost" | "danger";
  size?: "sm" | "md";
  leadingIcon?: IconName;
  loading?: boolean;
  touch?: boolean;
  disabled?: boolean;
  dark?: boolean;
  onPress: () => void;
}>;
export declare const ConfirmDialog: ValdiComponentConstructor<{
  id: string;
  title: string;
  message: string;
  confirmTitle: string;
  cancelTitle: string;
  destructive?: boolean;
  dark?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}>;
export declare const EmptyState: ValdiComponentConstructor<{
  id: string;
  icon?: IconName;
  title: string;
  description?: string;
  actionTitle?: string;
  dark?: boolean;
  onAction?: () => void;
}>;
export declare const Gallery: ValdiComponentConstructor<GalleryProps>;
export declare const Icon: ValdiComponentConstructor<{
  name: IconName;
  size?: number;
  color: string;
}>;
export declare const MobileWelcomeSurface: ValdiComponentConstructor<MobileWelcomeProps>;
export declare const PageControl: ValdiComponentConstructor<{
  id: string;
  label: string;
  count: number;
  current: number;
  showBackground?: boolean;
  dark?: boolean;
  onChange?: (index: number) => void;
}>;
export declare const ProgressBar: ValdiComponentConstructor<{
  id?: string;
  label: string;
  progress: number;
  detail?: string;
  tone?: "accent" | "warning";
  dark?: boolean;
}>;
export declare const SegmentedControl: ValdiComponentConstructor<{
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ id: string; title: string; disabled?: boolean }>;
  disabled?: boolean;
  compact?: boolean;
  dark?: boolean;
  onChange: (value: string) => void;
}>;
export declare const SettingsPageHeader: ValdiComponentConstructor<{
  title: string;
  description?: string;
  touch?: boolean;
  dark?: boolean;
}>;
export declare const SettingsGroup: ValdiComponentConstructor<{
  title: string;
  description?: string;
  appearance?: "card" | "plain";
  touch?: boolean;
  dark?: boolean;
}>;
export declare const SettingsFormRow: ValdiComponentConstructor<{
  title: string;
  description?: string;
  divider?: boolean;
  stacked?: boolean;
  touch?: boolean;
  dark?: boolean;
}>;
export declare const SettingsListItem: ValdiComponentConstructor<{
  id: string;
  title: string;
  openLabel?: string;
  description?: string;
  metadata?: string;
  error?: string;
  icon?: IconName;
  statusTone?: "active" | "inactive" | "warning" | "danger";
  divider?: boolean;
  touch?: boolean;
  dark?: boolean;
  onOpen?: () => void;
}>;
export declare const SettingsRow: ValdiComponentConstructor<{
  id: string;
  title: string;
  detail?: string;
  selected?: boolean;
  disabled?: boolean;
  divider?: boolean;
  touch?: boolean;
  dark?: boolean;
  onSelect: () => void;
}>;
export declare const Slider: ValdiComponentConstructor<{
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  dark?: boolean;
  minIcon?: IconName;
  maxIcon?: IconName;
  onChange: (value: number) => void;
}>;
export declare const Stepper: ValdiComponentConstructor<{
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  dark?: boolean;
  onChange: (value: number) => void;
}>;
export declare const TabBar: ValdiComponentConstructor<{
  id: string;
  label: string;
  items: readonly TabBarItem[];
  value: string;
  dark?: boolean;
  onChange: (id: string) => void;
}>;
export declare const TextField: ValdiComponentConstructor<{
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  clearTitle?: string;
  hideLabel?: boolean;
  inline?: boolean;
  disabled?: boolean;
  dark?: boolean;
  rightActionTitle?: string;
  rightActionDisabled?: boolean;
  onRightAction?: () => void;
  onChange: (value: string) => void;
  onSubmit?: () => void;
}>;
export declare const Toggle: ValdiComponentConstructor<{
  id: string;
  label: string;
  value: boolean;
  disabled?: boolean;
  dark?: boolean;
  onChange: (value: boolean) => void;
}>;

export type SelectMenuOption = {
  readonly id: string;
  readonly title: string;
  readonly disabled?: boolean;
};

export type SelectMenuProps = {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectMenuOption[];
  readonly open?: boolean;
  readonly disabled?: boolean;
  readonly minWidth?: number;
  readonly align?: "left" | "right";
  readonly touch?: boolean;
  readonly dark?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onChange: (value: string) => void;
};

export declare const SelectMenu: ValdiComponentConstructor<SelectMenuProps>;

export type AppearanceThemeCardItem = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly sidebarBg: string;
  readonly headerBg: string;
  readonly canvasBg: string;
  readonly pillBg: string;
  readonly previewBorder: string;
};

export type AppearanceSettingsProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly narrow?: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly errorMessage?: string;
  readonly interfaceGroupTitle: string;
  readonly interfaceGroupDescription: string;
  readonly languageTitle: string;
  readonly languageValue: string;
  readonly languageOptions: readonly SelectMenuOption[];
  readonly touchTitle: string;
  readonly touchDescription: string;
  readonly touchValue: string;
  readonly touchOptions: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly showMobileSource?: boolean;
  readonly mobileSourceTitle?: string;
  readonly mobileSourceDescription?: string;
  readonly mobileSourceActionLabel?: string;
  readonly modeTitle: string;
  readonly modeDescription: string;
  readonly modeValue: string;
  readonly modeOptions: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly themeTitle: string;
  readonly themeDescription: string;
  readonly themeId: string;
  readonly themes: readonly AppearanceThemeCardItem[];
  readonly showUiKit?: boolean;
  readonly uiKitTitle: string;
  readonly uiKitDescription: string;
  readonly uiKitActionLabel: string;
  readonly onChangeLanguage: (locale: string) => void;
  readonly onChangeTouch: (value: string) => void;
  readonly onOpenMobileSource?: () => void;
  readonly onChangeMode: (mode: string) => void;
  readonly onChangeTheme: (themeId: string) => void;
  readonly onOpenUiKit: () => void;
  readonly onHaptic?: (style: string) => void;
};

export declare const AppearanceSettingsSurface: ValdiComponentConstructor<AppearanceSettingsProps>;

export type TokenUsageLocalSection = {
  readonly machineLabel?: string;
  readonly machines?: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly selectedMachineId?: string;
  readonly providerLabel: string;
  readonly providers: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly selectedProviderId: string;
  readonly planText?: string;
  readonly accountText?: string;
  readonly quotaGroupTitle: string;
  readonly quotaGroupDescription: string;
  readonly statusMessage?: string;
  readonly windows: readonly TokenUsageWindowItem[];
  readonly conversationGroupTitle: string;
  readonly conversationProvider?: string;
  readonly contextLabel?: string;
  readonly contextDetail?: string;
  readonly contextProgress?: number;
  readonly conversationFallback?: string;
  readonly metrics: readonly TokenUsageMetricItem[];
  readonly observedAtText?: string;
  readonly serverLedgerNote?: string;
  readonly onSelectMachine?: (id: string) => void;
  readonly onSelectProvider: (id: string) => void;
};

export type TokenUsageLedgerMetricItem = {
  readonly id: string;
  readonly value: string;
  readonly label: string;
  readonly detail: string;
};

export type TokenUsageHeatmapCell = {
  readonly date: string;
  readonly level: number;
  readonly outside: boolean;
  readonly summaryText: string;
};

export type TokenUsageHeatmapWeek = {
  readonly key: string;
  readonly monthLabel?: string;
  readonly cells: readonly TokenUsageHeatmapCell[];
};

export type TokenUsageBarItem = {
  readonly key: string;
  readonly label: string;
  readonly progress: number;
  readonly valueText: string;
};

export type TokenUsageModelCardItem = {
  readonly key: string;
  readonly label: string;
  readonly tokensText: string;
  readonly turnsText: string;
  readonly progress: number;
};

export type TokenUsageTableRowItem = {
  readonly key: string;
  readonly title: string;
  readonly tokensText: string;
  readonly turnsText: string;
  readonly interactive?: boolean;
};

export type TokenUsageTurnRowItem = {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
};

export type TokenUsageDiagnosticStatItem = {
  readonly label: string;
  readonly value: string;
};

export type TokenUsageLedgerSection = {
  readonly scopeLabel: string;
  readonly scopeValue: string;
  readonly scopeOptions: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly rangeLabel: string;
  readonly rangeValue: string;
  readonly rangeOptions: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly customRange?: {
    readonly fromLabel: string;
    readonly fromValue: string;
    readonly throughLabel: string;
    readonly throughValue: string;
    readonly onChangeFrom: (value: string) => void;
    readonly onChangeThrough: (value: string) => void;
  };
  readonly modelLabel: string;
  readonly modelValue: string;
  readonly modelOptions: readonly SelectMenuOption[];
  readonly summaryTitle?: string;
  readonly summarySubtitle?: string;
  readonly partialBadge?: string;
  readonly summaryMeta?: string;
  readonly metrics?: readonly TokenUsageLedgerMetricItem[];
  readonly activityTitle?: string;
  readonly activitySubtitle?: string;
  readonly activityMode: string;
  readonly activityModeOptions: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly weekdayLabels?: readonly string[];
  readonly heatmapWeeks?: readonly TokenUsageHeatmapWeek[];
  readonly defaultCellHint?: string;
  readonly bars?: readonly TokenUsageBarItem[];
  readonly modelSectionTitle?: string;
  readonly modelEmptyText?: string;
  readonly modelCards?: readonly TokenUsageModelCardItem[];
  readonly detailTitle?: string;
  readonly detailEmptyText?: string;
  readonly backToSummaryLabel?: string;
  readonly viewLabel?: string;
  readonly viewValue?: string;
  readonly viewOptions?: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly clearActorLabel?: string;
  readonly rows?: readonly TokenUsageTableRowItem[];
  readonly turnRows?: readonly TokenUsageTurnRowItem[];
  readonly nextPageLabel?: string;
  readonly firstPageLabel?: string;
  readonly diagnosticsTitle?: string;
  readonly diagnosticsToggleLabel?: string;
  readonly collectionStatusText?: string;
  readonly collectionActionLabel?: string;
  readonly diagnosticsLines?: readonly string[];
  readonly diagnosticsPartialNotice?: string;
  readonly categoryStats?: readonly TokenUsageDiagnosticStatItem[];
  readonly onChangeScope: (value: string) => void;
  readonly onChangeRange: (value: string) => void;
  readonly onChangeModel: (value: string) => void;
  readonly onChangeActivityMode: (mode: string) => void;
  readonly onChangeView?: (view: string) => void;
  readonly onSelectRow?: (key: string) => void;
  readonly onBackToSummary?: () => void;
  readonly onClearActor?: () => void;
  readonly onNextPage?: () => void;
  readonly onFirstPage?: () => void;
  readonly onToggleCollection?: () => void;
};

export type TokenUsageGatewayRequestItem = {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
};

export type TokenUsageGatewaySection = {
  readonly title: string;
  readonly subtitle: string;
  readonly budgetLabel?: string;
  readonly budgetDetail?: string;
  readonly budgetProgress?: number;
  readonly budgetWarning?: boolean;
  readonly statusMessage?: string;
  readonly metrics: readonly TokenUsageLedgerMetricItem[];
  readonly requestsTitle?: string;
  readonly requestsEmptyText?: string;
  readonly requests?: readonly TokenUsageGatewayRequestItem[];
  readonly manageModelsLabel?: string;
  readonly onManageModels?: () => void;
};

export type TokenUsageDashboardProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly narrow?: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly refreshLabel: string;
  readonly loading?: boolean;
  readonly loadingText?: string;
  readonly errorMessage?: string;
  readonly localUsage?: TokenUsageLocalSection;
  readonly gatewayBudget?: TokenUsageGatewaySection;
  readonly ledger?: TokenUsageLedgerSection;
  readonly onRefresh: () => void;
  readonly onHaptic?: (style: string) => void;
};

export declare const TokenUsageDashboardSurface: ValdiComponentConstructor<TokenUsageDashboardProps>;

export type ShortcutRowItem = {
  readonly id: string;
  readonly label: string;
  readonly keys: string;
};

export type ShortcutsSettingsProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly rows: readonly ShortcutRowItem[];
  readonly aliasNote?: string;
};

export declare const ShortcutsSettingsSurface: ValdiComponentConstructor<ShortcutsSettingsProps>;

export type ArchivedThreadItem = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly restoring?: boolean;
};

export type ArchivedThreadsProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly loading?: boolean;
  readonly loadingText: string;
  readonly errorMessage?: string;
  readonly emptyText: string;
  readonly refreshLabel: string;
  readonly restoreLabel: string;
  readonly restoringLabel: string;
  readonly items: readonly ArchivedThreadItem[];
  readonly busy?: boolean;
  readonly onRefresh: () => void;
  readonly onRestore: (threadId: string) => void;
  readonly onHaptic?: (style: string) => void;
};

export declare const ArchivedThreadsSurface: ValdiComponentConstructor<ArchivedThreadsProps>;

export type VoiceInputSettingsProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly serviceGroupTitle: string;
  readonly refreshLabel: string;
  readonly refreshing?: boolean;
  readonly saving?: boolean;
  readonly methodTitle: string;
  readonly methodDescription: string;
  readonly methodValue: string;
  readonly methodOptions: readonly SelectMenuOption[];
  readonly modelTitle: string;
  readonly modelDescription: string;
  readonly modelValue: string;
  readonly modelDisabled?: boolean;
  readonly modelOptions: readonly SelectMenuOption[];
  readonly hunyuanTitle: string;
  readonly hunyuanDescription: string;
  readonly hunyuanStatus: string;
  readonly hunyuanTone?: "ready" | "loading" | "unavailable";
  readonly durationTitle: string;
  readonly durationDescription: string;
  readonly durationValue: string;
  readonly errorMessage?: string;
  readonly onRefresh: () => void;
  readonly onChangeMethod: (value: string) => void;
  readonly onChangeModel: (value: string) => void;
  readonly onHaptic?: (style: string) => void;
};

export declare const VoiceInputSettingsSurface: ValdiComponentConstructor<VoiceInputSettingsProps>;

export type AssetTabId = "libraries" | "environments" | "models" | "connections";

export type AssetLibraryItem = {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly compatibleText: string;
  readonly verifiedText: string;
};

export type AssetEnvironmentItem = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: "platform" | "personal";
  readonly editable?: boolean;
};

export type AssetConnectionItem = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly kind: "git" | "cloud";
  readonly disabled?: boolean;
};

export type AssetsSurfaceProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly activeTab: AssetTabId;
  readonly librariesLabel: string;
  readonly environmentsLabel: string;
  readonly modelsLabel?: string;
  readonly modelsTab?: ModelServicesSurfaceProps;
  readonly connectionsLabel: string;
  readonly refreshLabel: string;
  readonly refreshing?: boolean;
  readonly primaryActionLabel?: string;
  readonly primaryActionDisabled?: boolean;
  readonly errorMessage?: string;
  readonly noticeMessage?: string;
  readonly draftRetainedMessage?: string;
  readonly continueEditingLabel?: string;
  readonly editingHere?: boolean;
  readonly loading?: boolean;
  readonly loadingLabel: string;
  readonly searchQuery: string;
  readonly searchPlaceholder: string;
  readonly clearSearchLabel?: string;
  readonly showEnvironmentSearch?: boolean;
  readonly showConnectionSearch?: boolean;
  readonly providerFilter?: string;
  readonly providerFilterOptions?: readonly SelectMenuOption[];
  readonly libraries: readonly AssetLibraryItem[];
  readonly libraryEmptyText: string;
  readonly libraryBoundaryText: string;
  readonly libraryDetailsTitle: string;
  readonly platformTitle: string;
  readonly localLabel: string;
  readonly localDescription: string;
  readonly personalEnvironmentsTitle: string;
  readonly environments: readonly AssetEnvironmentItem[];
  readonly emptyEnvironmentText: string;
  readonly noResultsText: string;
  readonly createEnvironmentLabel: string;
  readonly createEnvironmentDisabled?: boolean;
  readonly clearFiltersLabel: string;
  readonly environmentSaveHint: string;
  readonly viewAssistantsLabel: string;
  readonly connectionsTitle: string;
  readonly connections: readonly AssetConnectionItem[];
  readonly emptyConnectionsText: string;
  readonly providerAboutText: string;
  readonly addAccountLabel: string;
  readonly addAccountDisabled?: boolean;
  readonly codeAccountFooter?: string;
  readonly envVariablesTitle?: string;
  readonly envVariablesLabel?: string;
  readonly envVariablesDescription?: string;
  readonly onTabChange: (tab: AssetTabId) => void;
  readonly onRefresh: () => void;
  readonly onPrimaryAction?: () => void;
  readonly onContinueEditing?: () => void;
  readonly onSearchChange: (query: string) => void;
  readonly onProviderFilterChange?: (value: string) => void;
  readonly onClearFilters: (tab: "environments" | "connections") => void;
  readonly onOpenLibrary: (id: string) => void;
  readonly onOpenEnvironment: (id: string) => void;
  readonly onCreateEnvironment: () => void;
  readonly onViewAssistants: () => void;
  readonly onOpenConnection: (key: string) => void;
  readonly onAddAccount: () => void;
  readonly onOpenVariables?: () => void;
  readonly onHaptic?: (style: string) => void;
};

export declare const AssetsSurface: ValdiComponentConstructor<AssetsSurfaceProps>;

export type AssistantActorCardItem = {
  readonly id: string;
  readonly title: string;
  readonly badgeText?: string;
  readonly statusText: string;
  readonly dutiesText?: string;
  readonly paused: boolean;
  readonly configRequired?: boolean;
  readonly primaryActionKind: "chat" | "choose-model" | "resume";
  readonly primaryActionLabel: string;
  readonly memoryLabel: string;
  readonly settingsLabel: string;
  readonly pauseLabel?: string;
  readonly busy?: boolean;
  readonly activeOperation?: "open" | "pause" | "hire" | null;
};

export type AssistantPresetCardItem = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly cardinalityLabel?: string;
  readonly hireLabel: string;
  readonly hiring?: boolean;
  readonly disabled?: boolean;
};

export type ManagedBotItem = AssistantActorCardItem;

export type AssistantsSurfaceProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title?: string;
  readonly subtitle?: string;
  readonly loading?: boolean;
  readonly errorText?: string;
  readonly retryLabel: string;
  readonly myAgentsTitle: string;
  readonly myAgentsDescription?: string;
  readonly createLabel: string;
  readonly createDisabled?: boolean;
  readonly emptyMineText: string;
  readonly actors: readonly AssistantActorCardItem[];
  readonly availableTitle: string;
  readonly presets: readonly AssistantPresetCardItem[];
  readonly onCreateActor: () => void;
  readonly onRetry: () => void;
  readonly onHirePreset: (presetId: string) => void;
  readonly onPrimaryAction: (botId: string) => void;
  readonly onOpenMemory: (botId: string) => void;
  readonly onOpenSettings: (botId: string) => void;
  readonly onTogglePause: (botId: string) => void;
  readonly onHaptic?: (style: string) => void;
};

export declare const AssistantsSurface: ValdiComponentConstructor<AssistantsSurfaceProps>;

export type InboxTabId = "groups" | "work" | "members";

export type InboxGroupItem = {
  readonly id: string;
  readonly title: string;
  readonly preview: string;
  readonly metaText?: string;
  readonly unreadText?: string;
  readonly selected?: boolean;
  readonly isAssistant?: boolean;
  readonly disabled?: boolean;
};

export type InboxMemberItem = {
  readonly id: string;
  readonly displayName: string;
  readonly kindLabel: string;
  readonly isBot?: boolean;
  readonly reachable?: boolean;
  readonly busy?: boolean;
};

export type InboxSurfaceProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly activeTab: InboxTabId;
  readonly searchQuery: string;
  readonly searchPlaceholder: string;
  readonly clearSearchLabel?: string;
  readonly createGroupLabel?: string;
  readonly showCreateGroup?: boolean;
  readonly groupsLabel: string;
  readonly workLabel: string;
  readonly membersLabel: string;
  readonly loadingText: string;
  readonly retryLabel: string;
  readonly groupsLoading?: boolean;
  readonly groupsError?: string;
  readonly emptyGroupsText: string;
  readonly groups: readonly InboxGroupItem[];
  readonly membersLoading?: boolean;
  readonly membersError?: string;
  readonly emptyMembersText: string;
  readonly members: readonly InboxMemberItem[];
  readonly loadMoreLabel?: string;
  readonly hasMoreMembers?: boolean;
  readonly onSearchChange: (query: string) => void;
  readonly onCreateGroup?: () => void;
  readonly onTabChange: (tab: InboxTabId) => void;
  readonly onOpenGroup: (id: string, isAssistant?: boolean) => void;
  readonly onRetryGroups: () => void;
  readonly onOpenMember: (id: string) => void;
  readonly onRetryMembers: () => void;
  readonly onLoadMoreMembers?: () => void;
  readonly onHaptic?: (style: string) => void;
};

export declare const InboxSurface: ValdiComponentConstructor<InboxSurfaceProps>;

export type InboxEmptyProps = {
  readonly dark?: boolean;
  readonly title: string;
};

export declare const InboxEmptySurface: ValdiComponentConstructor<InboxEmptyProps>;

export type ModelServiceConnectionItem = {
  readonly id: string;
  readonly name: string;
  readonly scopeLabel: string;
  readonly owned: boolean;
  readonly selected?: boolean;
};

export type ModelServiceModelItem = {
  readonly id: string;
  readonly name: string;
  readonly statusLabel: string;
};

export type ModelServicesSurfaceProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly hideHeader?: boolean;
  readonly title: string;
  readonly subtitle?: string;
  readonly addLabel: string;
  readonly addDisabled?: boolean;
  readonly managePlatformLabel?: string;
  readonly showManagePlatform?: boolean;
  readonly loading?: boolean;
  readonly loadingText: string;
  readonly tryAgainLabel: string;
  readonly errorMessage?: string;
  readonly statusMessage?: string;
  readonly busy?: boolean;
  readonly savingText: string;
  readonly searchQuery: string;
  readonly searchPlaceholder: string;
  readonly clearSearchLabel?: string;
  readonly myModelsTitle: string;
  readonly noPersonalConnectionsText: string;
  readonly platformModelsTitle: string;
  readonly personalConnections: readonly ModelServiceConnectionItem[];
  readonly platformConnections: readonly ModelServiceConnectionItem[];
  readonly adding: boolean;
  readonly addTitle: string;
  readonly subscriptionAvailable?: boolean;
  readonly connectionMethodLabel: string;
  readonly connectionType: "api-key" | "subscription";
  readonly connectionTypeOptions: readonly SelectMenuOption[];
  readonly subscriptionTitle: string;
  readonly subscriptionDescription: string;
  readonly subscriptionLoginCode?: string;
  readonly subscriptionLoginHint?: string;
  readonly signInAndConnectLabel: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly nameValue: string;
  readonly urlRegisterMode?: boolean;
  readonly baseUrlLabel?: string;
  readonly baseUrlPlaceholder?: string;
  readonly baseUrlValue?: string;
  readonly recognizedVendorText?: string;
  readonly protocolLabel?: string;
  readonly protocolValue?: string;
  readonly protocolOptions?: readonly SelectMenuOption[];
  readonly discoverLabel?: string;
  readonly discovering?: boolean;
  readonly discoverHint?: string;
  readonly modelIdLabel?: string;
  readonly modelIdPlaceholder?: string;
  readonly modelIdValue?: string;
  readonly contextWindowLabel?: string;
  readonly contextWindowPlaceholder?: string;
  readonly contextWindowValue?: string;
  readonly serviceLabel: string;
  readonly serviceValue: string;
  readonly serviceOptions: readonly SelectMenuOption[];
  readonly modelLabel: string;
  readonly modelValue: string;
  readonly modelOptions: readonly SelectMenuOption[];
  readonly apiKeyLabel: string;
  readonly apiKeyBaseUrl?: string;
  readonly apiKeyValue: string;
  readonly availableToLabel: string;
  readonly availableToHint: string;
  readonly onlyMeLabel: string;
  readonly saveLabel: string;
  readonly saveDisabled?: boolean;
  readonly cancelLabel: string;
  readonly hasSelectedConnection: boolean;
  readonly selectedConnectionName?: string;
  readonly selectedConnectionStatus?: string;
  readonly selectedConnectionOwned?: boolean;
  readonly selectedConnectionSubscription?: boolean;
  readonly selectedConnectionScopeText?: string;
  readonly scopeOpen?: boolean;
  readonly scopeDraft?: "personal" | "team";
  readonly scopeOptions?: readonly SelectMenuOption[];
  readonly scopeConsent?: boolean;
  readonly scopeTeamWarning?: string;
  readonly scopeAllowOthersLabel?: string;
  readonly scopeSaveDisabled?: boolean;
  readonly changeLabel: string;
  readonly modelsTitle: string;
  readonly selectedModels: readonly ModelServiceModelItem[];
  readonly advancedTitle: string;
  readonly endpointLabel: string;
  readonly endpointValue?: string;
  readonly disableLabel: string;
  readonly disableDescription?: string;
  readonly disableActionLabel: string;
  readonly emptyDirectoryText: string;
  readonly usageTitle: string;
  readonly usedThisMonthLabel: string;
  readonly usedThisMonthValue: string;
  readonly heldTokensLabel: string;
  readonly heldTokensValue?: string;
  readonly usageLimitLabel: string;
  readonly usageLimitDescription: string;
  readonly usageLimitValue: string;
  readonly canEditLimit?: boolean;
  readonly limitOpen?: boolean;
  readonly limitDraft?: string;
  readonly limitMaxLabel?: string;
  readonly limitSaveLabel?: string;
  readonly limitSaveDisabled?: boolean;
  readonly onSearchChange: (query: string) => void;
  readonly onStartAdd: () => void;
  readonly onCancelAdd: () => void;
  readonly onManagePlatform?: () => void;
  readonly onRefresh: () => void;
  readonly onSelectConnection: (id: string) => void;
  readonly onConnectionTypeChange: (value: "api-key" | "subscription") => void;
  readonly onStartSubscription?: () => void;
  readonly onNameChange: (value: string) => void;
  readonly onBaseUrlChange?: (value: string) => void;
  readonly onProtocolChange?: (value: string) => void;
  readonly onDiscoverModels?: () => void;
  readonly onModelIdChange?: (value: string) => void;
  readonly onContextWindowChange?: (value: string) => void;
  readonly onBaseUrlChange?: (value: string) => void;
  readonly onProtocolChange?: (value: string) => void;
  readonly onDiscoverModels?: () => void;
  readonly onModelIdChange?: (value: string) => void;
  readonly onContextWindowChange?: (value: string) => void;
  readonly onServiceChange: (value: string) => void;
  readonly onModelChange: (value: string) => void;
  readonly onApiKeyChange: (value: string) => void;
  readonly onSaveConnection: () => void;
  readonly onToggleScope: () => void;
  readonly onScopeDraftChange: (value: "personal" | "team") => void;
  readonly onScopeConsentChange: (checked: boolean) => void;
  readonly onSaveScope: () => void;
  readonly onDisableConnection: () => void;
  readonly onToggleLimit: () => void;
  readonly onLimitDraftChange: (value: string) => void;
  readonly onSaveLimit: () => void;
  readonly onHaptic?: (style: string) => void;
};

export declare const ModelServicesSurface: ValdiComponentConstructor<ModelServicesSurfaceProps>;

export declare const lightColors: ColorTokens;
export declare const darkColors: ColorTokens;
export declare const colors: ColorTokens;
export declare function themeColors(dark?: boolean): ColorTokens;
export declare const radii: { readonly group: number; readonly field: number; readonly pill: number };
export declare function registerHapticHandler(handler?: (style: HapticStyle) => void): void;
export declare function triggerHaptic(style: HapticStyle): void;
