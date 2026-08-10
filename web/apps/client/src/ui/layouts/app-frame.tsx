import type { Account, Server } from "@vela/client-core";
import { useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import LogOut from "lucide-react-native/icons/log-out";

import { BrandMark } from "../components/brand-mark";
import {SystemMaterialSurface} from "../primitives/system-material-surface";
import {SystemPopover} from "../primitives/system-popover";
import { workspaceLayoutMode } from "../workspace-layout-mode";
import { MaybeLink } from "./navigation-link";
import {
  visibleSectionNavigation,
  type WorkspaceImStatus,
  type WorkspaceSection,
  type WorkspaceSectionItem,
} from "./workspace-section";

/**
 * The frame every screen sits in: the server rail on a pointer, the bottom bar
 * under a finger, and the account chrome that hangs off both. It lived inside
 * the chat shell, so rendering the Agents screen pulled the message list, the
 * composer and the thread panel in behind it. It belongs to no one screen.
 */
export interface PlatformFrameProps {
  account?: Account | null;
  activeSection: WorkspaceSection;
  children: ReactNode;
  canManageServer?: boolean;
  currentServerId: string | null;
  navigation: ReactNode;
  imStatus?: WorkspaceImStatus;
  onLogout?(): void | Promise<void>;
  onNavigateSection(section: WorkspaceSection): void;
  onSelectServer(serverId: string): void | Promise<void>;
  /**
   * Chat drives the compact bar itself: there the "聊天" tab doubles as the
   * conversation-picker toggle, and the bar steps aside while search is open.
   * Every other screen takes the standard bar.
   */
  renderCompactNavigation?(): ReactNode;
  sectionHref?(section: WorkspaceSection): string;
  serverHref?(server: Server): string;
  servers: Server[];
  viewportWidth?: number;
}

export function PlatformFrame({
  account,
  activeSection,
  children,
  canManageServer = false,
  currentServerId,
  navigation,
  imStatus,
  onLogout,
  onNavigateSection,
  onSelectServer,
  renderCompactNavigation,
  sectionHref,
  serverHref,
  servers,
  viewportWidth,
}: PlatformFrameProps) {
  const window = useWindowDimensions();
  const mode = workspaceLayoutMode(viewportWidth ?? window.width);

  if (mode === "compact") {
    return (
      <View style={styles.compactShell}>
        {children}
        {renderCompactNavigation ? (
          renderCompactNavigation()
        ) : (
          <MobileBottomNavigation
            activeSection={activeSection}
            canManageServer={canManageServer}
            navigationOpen={false}
            onNavigateSection={onNavigateSection}
            onToggle={() => onNavigateSection("chat")}
            sectionHref={sectionHref}
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.shell} testID="workspace-shell">
      <SystemMaterialSurface
        materialRole="navigationChrome"
        style={styles.navigationChrome}
        testID="navigation-chrome"
      >
        <ServerRail
          account={account}
          activeSection={activeSection}
          canManageServer={canManageServer}
          currentServerId={currentServerId}
          imStatus={imStatus}
          onNavigateSection={onNavigateSection}
          onLogout={onLogout}
          onSelectServer={onSelectServer}
          sectionHref={sectionHref}
          serverHref={serverHref}
          servers={servers}
        />
        {navigation}
      </SystemMaterialSurface>
      {children}
    </View>
  );
}

export function ServerRail({
  account,
  activeSection,
  canManageServer,
  currentServerId,
  imStatus,
  onNavigateSection,
  onLogout,
  onSelectServer,
  sectionHref,
  serverHref,
  servers,
}: Pick<
  PlatformFrameProps,
  | "account"
  | "activeSection"
  | "canManageServer"
  | "currentServerId"
  | "imStatus"
  | "onLogout"
  | "onNavigateSection"
  | "onSelectServer"
  | "sectionHref"
  | "serverHref"
  | "servers"
> & { canManageServer: boolean }) {
  const {theme} = useUnistyles();
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <View style={styles.serverRail} testID="server-rail">
      <View accessibilityLabel="Vela" style={styles.railBrand}>
        <BrandMark compact />
      </View>
      {servers.length > 1 ? (
        <ScrollView
          contentContainerStyle={styles.serverMarks}
          showsVerticalScrollIndicator={false}
          style={styles.serverMarksScroller}
          testID="server-marks"
        >
          {servers.map((server) => {
            const selected = server.id === currentServerId;
            const href = serverHref?.(server);
            return (
              <MaybeLink href={href} key={server.id}>
                <Pressable
                  accessibilityLabel={`打开 Server ${server.name}`}
                  accessibilityRole={href ? "link" : "button"}
                  accessibilityState={{ selected }}
                  aria-current={selected ? "page" : undefined}
                  onPress={href ? undefined : () => onSelectServer(server.id)}
                  style={({ pressed }) => [
                    styles.serverMark,
                    selected && styles.serverMarkSelected,
                    pressed && styles.railItemPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.serverMarkText,
                      selected && styles.serverMarkTextSelected,
                    ]}
                  >
                    {server.name.slice(0, 1).toUpperCase()}
                  </Text>
                </Pressable>
              </MaybeLink>
            );
          })}
        </ScrollView>
      ) : null}
      <View style={styles.railNavigation} testID="rail-navigation">
        {visibleSectionNavigation(canManageServer).map((item) => {
          const selected = item.id === activeSection;
          const href = sectionHref?.(item.id);
          return (
            <RailSectionNavigationItem
              href={href}
              item={item}
              key={item.id}
              onPress={() => onNavigateSection?.(item.id)}
              selected={selected}
            />
          );
        })}
      </View>
      <View style={styles.railSpacer} />
      <View style={styles.railFooter}>
        {account ? (
          <SystemPopover
            accessibilityLabel="当前账号"
            onOpenChange={setAccountOpen}
            open={accountOpen}
            overlayId="account-popover"
            placement="right bottom"
            renderTrigger={({
              accessibilityControls,
              accessibilityExpanded,
              onPress,
              ref,
            }) => (
              <Pressable
                accessibilityLabel={`打开当前账号 ${account.displayName}`}
                accessibilityRole="button"
                aria-controls={accessibilityControls}
                aria-expanded={accessibilityExpanded}
                aria-haspopup="dialog"
                onPress={onPress}
                ref={ref as never}
                style={({ pressed }) => [
                  styles.accountRailButton,
                  accountOpen && styles.accountRailButtonActive,
                  pressed && styles.railItemPressed,
                ]}
                testID="rail-account"
              >
                <HumanAvatar account={account} imStatus={imStatus} />
              </Pressable>
            )}
            width={theme.recipes.overlay.accountMenuWidth}
          >
            <View style={styles.accountPopoverContent} testID="account-popover-content">
              <View style={styles.accountPopoverIdentity}>
                <HumanAccountIdentity account={account} imStatus={imStatus} />
              </View>
              {onLogout ? (
                <>
                  <View style={styles.accountPopoverSeparator} />
                  <Pressable
                    accessibilityLabel="退出当前账号"
                    accessibilityRole="button"
                    onPress={() => {
                      setAccountOpen(false);
                      void onLogout();
                    }}
                    style={({hovered, pressed}) => [
                      styles.accountPopoverAction,
                      hovered && styles.accountPopoverActionHovered,
                      pressed && styles.accountPopoverActionPressed,
                    ]}
                  >
                    <LogOut
                      color={theme.semantic.color.statusDangerText}
                      size={theme.semantic.icon.size.small}
                      strokeWidth={theme.semantic.icon.stroke.regular}
                    />
                    <Text style={styles.accountPopoverActionLabel}>
                      退出当前账号
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          </SystemPopover>
        ) : onLogout ? (
          <Pressable
            accessibilityLabel="退出当前账号"
            accessibilityRole="button"
            onPress={onLogout}
            style={({ pressed }) => [
              styles.railNavigationButton,
              pressed && styles.railItemPressed,
            ]}
          >
            <LogOut
              color={theme.semantic.color.iconMuted}
              size={theme.semantic.icon.size.medium}
              strokeWidth={theme.semantic.icon.stroke.regular}
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function RailSectionNavigationItem({
  href,
  item,
  onPress,
  selected,
}: {
  href: string | undefined;
  item: WorkspaceSectionItem;
  onPress: () => void;
  selected: boolean;
}) {
  const {theme} = useUnistyles();
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const labelVisible = focused || hovered;
  const NavigationIcon = item.icon;

  return (
    <View style={styles.railNavigationItem}>
      <MaybeLink href={href}>
        <Pressable
          accessibilityLabel={item.accessibilityLabel}
          accessibilityRole={href ? "link" : "button"}
          accessibilityState={{ selected }}
          aria-current={selected ? "page" : undefined}
          onBlur={() => setFocused(false)}
          onFocus={() => setFocused(true)}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          onPress={href ? undefined : onPress}
          style={({ pressed }) => [
            styles.railNavigationButton,
            selected && styles.railNavigationActive,
            labelVisible && !selected && styles.railNavigationHovered,
            pressed && styles.railItemPressed,
          ]}
          testID={`rail-section-${item.id}`}
        >
          <View testID={`rail-icon-${item.id}`}>
            <NavigationIcon
              color={
                selected
                  ? theme.semantic.color.iconAccent
                  : theme.semantic.color.iconMuted
              }
              size={theme.semantic.icon.size.feature}
              strokeWidth={
                selected
                  ? theme.semantic.icon.stroke.strong
                  : theme.semantic.icon.stroke.regular
              }
            />
          </View>
        </Pressable>
      </MaybeLink>
      {labelVisible ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.railTooltip}
          testID={`rail-tooltip-${item.id}`}
        >
          <Text style={styles.railTooltipText}>{item.label}</Text>
        </View>
      ) : null}
    </View>
  );
}

function accountImPresentation(
  account: Account,
  imStatus: WorkspaceImStatus | undefined,
): { label: string; tone: "connecting" | "error" | "ready" } {
  if (
    account.imState === "error" ||
    imStatus === "error" ||
    imStatus === "kicked_out" ||
    imStatus === "not_ready"
  ) {
    return { label: "IM 未连接", tone: "error" };
  }
  if (account.imState === "ready" && imStatus === "ready") {
    return { label: "IM 已连接", tone: "ready" };
  }
  return { label: "IM 连接中", tone: "connecting" };
}

export function HumanAvatar({
  account,
  imStatus,
}: {
  account: Account;
  imStatus?: WorkspaceImStatus;
}) {
  const status = accountImPresentation(account, imStatus);
  const initial =
    account.displayName.trim().slice(0, 1) ||
    account.email.trim().slice(0, 1).toUpperCase() ||
    "人";
  return (
    <View style={styles.humanAvatar}>
      <Text style={styles.humanAvatarText}>{initial}</Text>
      <View
        style={[
          styles.humanAvatarStatus,
          status.tone === "ready" && styles.humanAvatarStatusReady,
          status.tone === "error" && styles.humanAvatarStatusError,
        ]}
      />
    </View>
  );
}

export function HumanAccountIdentity({
  account,
  imStatus,
}: {
  account: Account;
  imStatus?: WorkspaceImStatus;
}) {
  const status = accountImPresentation(account, imStatus);
  return (
    <View style={styles.accountIdentity}>
      <HumanAvatar account={account} imStatus={imStatus} />
      <View style={styles.accountIdentityCopy}>
        <Text numberOfLines={1} style={styles.accountDisplayName}>
          {account.displayName}
        </Text>
        <Text numberOfLines={1} style={styles.accountEmail}>
          {account.email}
        </Text>
        <View style={styles.accountStatusRow}>
          <View
            style={[
              styles.accountStatusDot,
              status.tone === "ready" && styles.accountStatusDotReady,
              status.tone === "error" && styles.accountStatusDotError,
            ]}
          />
          <Text style={styles.accountStatusText}>{status.label}</Text>
        </View>
      </View>
    </View>
  );
}

export function MobileBottomNavigation({
  activeSection,
  canManageServer,
  navigationOpen,
  onNavigateSection,
  onToggle,
  sectionHref,
}: {
  activeSection: WorkspaceSection;
  canManageServer: boolean;
  navigationOpen: boolean;
  onNavigateSection(section: WorkspaceSection): void;
  onToggle(): void;
  sectionHref?: PlatformFrameProps["sectionHref"];
}) {
  const {theme} = useUnistyles();
  return (
    <View style={styles.mobileBottomNavigation} testID="mobile-bottom-nav">
      {visibleSectionNavigation(canManageServer).map((item) => {
        const selected = item.id === activeSection;
        const chatLabel = navigationOpen ? "返回聊天" : "选择会话";
        const togglesPicker = item.id === "chat" && selected;
        const href = togglesPicker ? undefined : sectionHref?.(item.id);
        const NavigationIcon = item.icon;
        return (
          <View
            key={item.id}
            style={styles.mobileNavigationItem}
            testID={`mobile-nav-item-${item.id}`}
          >
            <MaybeLink href={href}>
              <Pressable
                accessibilityLabel={
                  togglesPicker ? chatLabel : item.accessibilityLabel
                }
                accessibilityRole={href ? "link" : "button"}
                accessibilityState={{ selected }}
                aria-current={selected ? "page" : undefined}
                onPress={
                  href
                    ? undefined
                    : () => {
                        if (togglesPicker) {
                          onToggle();
                          return;
                        }
                        onNavigateSection(item.id);
                      }
                }
                style={[
                  styles.mobileNavigationButton,
                  selected && styles.mobileNavigationButtonActive,
                ]}
              >
                {item.id === "chat" && navigationOpen ? (
                  <ArrowLeft
                    color={theme.semantic.color.iconAccent}
                    size={theme.semantic.icon.size.large}
                    strokeWidth={theme.semantic.icon.stroke.emphasis}
                  />
                ) : (
                  <NavigationIcon
                    color={
                      selected
                        ? theme.semantic.color.iconAccent
                        : theme.semantic.color.iconMuted
                    }
                    size={theme.semantic.icon.size.large}
                    strokeWidth={
                      selected
                        ? theme.semantic.icon.stroke.emphasis
                        : theme.semantic.icon.stroke.regular
                    }
                  />
                )}
                <Text numberOfLines={1} style={styles.mobileNavigationLabel}>
                  {item.label}
                </Text>
              </Pressable>
            </MaybeLink>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  accountPopoverAction: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.compactControl,
    flexDirection: "row",
    flexGrow: 0,
    gap: theme.spacing.sm,
    minHeight: theme.recipes.overlay.menuRowHeight,
    paddingHorizontal: theme.spacing.md,
    ...theme.semantic.motion.transition.control,
  },
  accountPopoverActionHovered: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
  },
  accountPopoverActionLabel: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.bodyCompact,
  },
  accountPopoverActionPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
  },
  accountPopoverContent: {
    flexGrow: 0,
    width: "100%",
  },
  accountPopoverIdentity: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  accountPopoverSeparator: {
    backgroundColor: theme.semantic.color.separator,
    height: theme.semantic.stroke.hairline,
    marginHorizontal: theme.spacing.sm,
    marginVertical: theme.spacing.xs,
  },
  accountDisplayName: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
  },
  accountEmail: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
  },
  accountIdentity: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    minWidth: 0,
  },
  accountIdentityCopy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
  },
  accountRailButton: {
    alignItems: "center",
    borderColor: theme.semantic.color.borderTransparent,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.desktopWorkspace.navigationControlSize,
    justifyContent: "center",
    width: theme.recipes.desktopWorkspace.navigationControlSize,
    ...theme.semantic.motion.transition.control,
    _web: {
      AppRegion: "no-drag",
    },
  },
  accountRailButtonActive: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: theme.semantic.color.borderInteractive,
    ...theme.semantic.motion.transition.control,
  },
  accountStatusDot: {
    backgroundColor: theme.semantic.color.statusWarning,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.statusDotSize,
    width: theme.recipes.identity.statusDotSize,
  },
  accountStatusDotError: {
    backgroundColor: theme.semantic.color.statusDanger,
  },
  accountStatusDotReady: {
    backgroundColor: theme.semantic.color.statusPositive,
  },
  accountStatusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.xxs,
  },
  accountStatusText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
  },
  compactShell: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    flex: 1,
  },
  humanAvatar: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.avatarAccountSurface,
    borderRadius: theme.semantic.radius.section,
    height: theme.recipes.identity.avatarProminentSize,
    justifyContent: "center",
    position: "relative",
    width: theme.recipes.identity.avatarProminentSize,
  },
  humanAvatarStatus: {
    backgroundColor: theme.semantic.color.statusWarning,
    borderColor: theme.semantic.color.paneSurface,
    borderRadius: theme.semantic.radius.circle,
    borderWidth: theme.semantic.stroke.statusRing,
    bottom: -theme.semantic.stroke.hairline,
    height: theme.recipes.identity.presenceDotSize,
    position: "absolute",
    right: -theme.semantic.stroke.hairline,
    width: theme.recipes.identity.presenceDotSize,
  },
  humanAvatarStatusError: {
    backgroundColor: theme.semantic.color.statusDanger,
  },
  humanAvatarStatusReady: {
    backgroundColor: theme.semantic.color.statusPositive,
  },
  humanAvatarText: {
    color: theme.semantic.color.textInverse,
    ...theme.semantic.typography.avatarLabel,
  },
  mobileBottomNavigation: {
    alignItems: "stretch",
    backgroundColor: theme.semantic.color.paneSurface,
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.compactWorkspace.bottomNavigationHeight,
    flexDirection: "row",
    justifyContent: "space-evenly",
  },
  mobileNavigationButton: {
    alignItems: "center",
    flex: 1,
    gap: theme.spacing.xs,
    height: "100%",
    justifyContent: "center",
    minWidth: theme.recipes.compactWorkspace.navigationItemMinWidth,
    width: "100%",
    ...theme.semantic.motion.transition.control,
  },
  mobileNavigationButtonActive: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    ...theme.semantic.motion.transition.control,
  },
  mobileNavigationItem: {
    alignItems: "stretch",
    flex: 1,
    minWidth: theme.recipes.compactWorkspace.navigationItemMinWidth,
  },
  mobileNavigationLabel: {
    ...theme.semantic.typography.navigationLabel,
  },
  navigationChrome: {
    flexDirection: "row",
    flexShrink: 0,
    height: "100%",
    zIndex: theme.semantic.layer.navigation,
  },
  railBrand: {
    alignItems: "center",
    height: theme.recipes.desktopWorkspace.headerHeight,
    justifyContent: "center",
    width: "100%",
    _web: {
      // Window Controls Overlay / Electron traffic-light inset; 0 in ordinary browsers.
      paddingLeft: "env(titlebar-area-x, 0px)",
      // Future desktop shell: allow dragging the window from the brand band.
      AppRegion: "drag",
    },
  },
  railFooter: {
    alignItems: "center",
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    paddingBottom: theme.spacing.md,
    paddingTop: theme.spacing.md,
    position: "relative",
    width: "100%",
    zIndex: theme.semantic.layer.docked,
  },
  railItemPressed: {
    opacity: theme.semantic.opacity.inactive,
    ...theme.semantic.motion.transition.control,
  },
  railNavigation: {
    alignItems: "center",
    gap: theme.recipes.desktopWorkspace.navigationGap,
    paddingTop: theme.recipes.desktopWorkspace.navigationTopInset,
    width: "100%",
    ...theme.semantic.motion.transition.control,
  },
  railNavigationActive: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.selectionSurface,
    borderRadius: theme.semantic.radius.compactControl,
    borderWidth: 0,
    height: theme.recipes.desktopWorkspace.navigationControlSize,
    justifyContent: "center",
    width: theme.recipes.desktopWorkspace.navigationControlSize,
    ...theme.semantic.motion.transition.control,
  },
  railNavigationButton: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.compactControl,
    borderWidth: 0,
    height: theme.recipes.desktopWorkspace.navigationControlSize,
    justifyContent: "center",
    width: theme.recipes.desktopWorkspace.navigationControlSize,
    _web: {
      AppRegion: "no-drag",
    },
  },
  railNavigationHovered: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  railNavigationItem: {
    // Match the icon button — tooltip insets are relative to this box.
    height: theme.recipes.desktopWorkspace.navigationControlSize,
    position: "relative",
    width: theme.recipes.desktopWorkspace.navigationControlSize,
    zIndex: theme.semantic.layer.navigation,
  },
  railSpacer: {
    flex: 1,
  },
  railTooltip: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.inverseSurface,
    borderRadius: theme.semantic.radius.compactControl,
    height: theme.recipes.iconControl.compactSize,
    justifyContent: "center",
    left: theme.recipes.overlay.railTooltipLeftInset,
    paddingHorizontal: theme.spacing.md,
    position: "absolute",
    shadowColor: theme.shadows.overlay.color,
    elevation: theme.semantic.elevation.overlay,
    shadowOffset: { height: theme.shadows.overlay.offsetY, width: 0 },
    shadowOpacity: theme.shadows.overlay.opacity,
    shadowRadius: theme.shadows.overlay.radius,
    top: theme.recipes.overlay.railTooltipTopInset,
    zIndex: theme.semantic.layer.tooltip,
  },
  railTooltipText: {
    color: theme.semantic.color.textInverse,
    ...theme.semantic.typography.tooltip,
    whiteSpace: "nowrap",
  },
  serverMark: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderColor: theme.semantic.color.borderTransparent,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.section,
    height: theme.recipes.identity.avatarNavigationSize,
    justifyContent: "center",
    width: theme.recipes.identity.avatarNavigationSize,
    ...theme.semantic.motion.transition.control,
  },
  serverMarkSelected: {
    backgroundColor: theme.semantic.color.avatarServerSurface,
    borderColor: theme.semantic.color.borderSelected,
    ...theme.semantic.motion.transition.control,
  },
  serverMarkText: {
    ...theme.semantic.typography.messageBody,
    ...theme.semantic.motion.transition.control,
  },
  serverMarkTextSelected: {
    color: theme.semantic.color.avatarServerText,
    ...theme.semantic.motion.transition.control,
  },
  serverMarks: {
    alignItems: "center",
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  serverMarksScroller: {
    flexGrow: 0,
    maxHeight: theme.recipes.overlay.serverListMaxHeight,
  },
  serverRail: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.navigationSurface,
    borderRadius: theme.semantic.radius.pane,
    borderRightColor: theme.semantic.color.separator,
    borderRightWidth: theme.semantic.stroke.hairline,
    position: "relative",
    width: theme.recipes.desktopWorkspace.railWidth,
    zIndex: theme.semantic.layer.popover,
    _web: {
      backgroundColor: theme.semantic.material.navigationFill,
    },
  },
  shell: {
    backgroundColor: theme.semantic.color.shellBackdrop,
    borderRadius: theme.semantic.radius.pane,
    borderWidth: 0,
    flex: 1,
    flexDirection: "row",
    gap: 0,
    margin: 0,
    overflow: "hidden",
    padding: 0,
    _web: {
      backgroundImage: `linear-gradient(165deg, ${theme.semantic.color.shellBackdropHighlight} 0%, ${theme.semantic.color.shellBackdrop} 46%, ${theme.semantic.color.groupedSurface} 100%)`,
    },
  },
}));
