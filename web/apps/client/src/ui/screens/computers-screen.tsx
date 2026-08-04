import type {
  Agent,
  Computer,
  CreateComputerInput,
  RegistrationScript,
  Server,
} from "@vela/client-core";
import { useMemo, useState } from "react";
import {
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Monitor from "lucide-react-native/icons/monitor";
import Plus from "lucide-react-native/icons/plus";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import X from "lucide-react-native/icons/x";

import {ManagementEmptyState} from "../components/management-empty-state";
import {
  ActionButton,
  CodeBlock,
  CollectionIdentityMark,
  CollectionRow,
  DetailSection,
  IconActionButton,
  InlineFeedback,
  ManagementCollectionPane,
  ManagementDetailCanvas,
  ManagementDetailScroll,
  ManagementField,
  ManagementForm,
  ManagementFormActions,
  ManagementHeader,
  NoticeBanner,
  ResourceIdentityHeader,
  ManagementResourceSwitcher,
  ManagementStage,
  ManagementTextInput,
  ResourceActionRow,
} from "../components/management-workspace";
import {formatReadableDateTime} from "../date-time";
import { layoutMode } from "../layout-mode";
import {
  breakpoints,
  computerSupportStackBreakpoint,
  workspaceShellWideBreakpoint,
} from "../theme";
import {
  ManagementPresentation,
  type ManagementPageModel,
  type PresentationAction,
} from "../presentation";
import {
  PlatformFrame,
  type PlatformFrameProps,
  type WorkspaceSection,
} from "../layouts/workspace-shell";
import {
  TerminalPanel,
  type TerminalSurfaceController,
} from "../components/terminal-panel";

export interface ComputersScreenProps {
  agents: Agent[];
  canManage?: boolean;
  computers: Computer[];
  currentAccount?: PlatformFrameProps["account"];
  currentServerId: string | null;
  error: string | null;
  imStatus?: PlatformFrameProps["imStatus"];
  loading: boolean;
  onCreateComputer(
    input: CreateComputerInput,
  ): Computer | null | Promise<Computer | null>;
  onCreateTerminalController?(
    computerId: string,
  ): TerminalSurfaceController;
  onLogout?: PlatformFrameProps["onLogout"];
  onNavigateSection(section: WorkspaceSection): void;
  onRefresh(): void | Promise<void>;
  onRemoveComputer?(computerId: string): boolean | Promise<boolean>;
  onRequestRegistrationScript(
    computerId: string,
  ): RegistrationScript | null | Promise<RegistrationScript | null>;
  onSelectComputer?(computerId: string): void;
  onSelectServer(serverId: string): void | Promise<void>;
  pendingAction: string | null;
  sectionHref?: PlatformFrameProps["sectionHref"];
  selectedComputerId?: string | null;
  serverHref?: PlatformFrameProps["serverHref"];
  servers: Server[];
  terminalUnavailableReason?: string;
  viewportWidth?: number;
}

export function ComputersScreen(props: ComputersScreenProps) {
  const {
    agents,
    canManage = false,
    computers,
    currentAccount,
    currentServerId,
    error,
    imStatus,
    loading,
    onCreateComputer,
    onCreateTerminalController,
    onLogout,
    onNavigateSection,
    onRefresh,
    onRemoveComputer,
    onRequestRegistrationScript,
    onSelectComputer,
    onSelectServer,
    pendingAction,
    sectionHref,
    selectedComputerId: routeSelectedComputerId,
    serverHref,
    servers,
    terminalUnavailableReason,
    viewportWidth,
  } = props;
  const window = useWindowDimensions();
  const resolvedViewportWidth = viewportWidth ?? window.width;
  const frameMode = layoutMode(resolvedViewportWidth);
  const compactFrame = frameMode === "compact";
  const phone = resolvedViewportWidth < breakpoints.medium;
  const mediumSurface =
    resolvedViewportWidth >= breakpoints.medium && resolvedViewportWidth < breakpoints.wide;
  const wideWorkspace = resolvedViewportWidth >= workspaceShellWideBreakpoint;
  const stackSupportPanels = resolvedViewportWidth < computerSupportStackBreakpoint;
  const hasComputerDirectory =
    computers.length > 0 && (wideWorkspace || computers.length > 1);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [registration, setRegistration] =
    useState<RegistrationScript | null>(null);
  const [terminal, setTerminal] =
    useState<TerminalSurfaceController | null>(null);
  const [releaseConfirming, setReleaseConfirming] = useState(false);
  const [localSelectedComputerId, setLocalSelectedComputerId] = useState<
    string | null
  >(computers[0]?.id ?? null);
  const hasRouteSelectedComputer = routeSelectedComputerId != null;
  const selectedComputerId = routeSelectedComputerId
    ?? localSelectedComputerId
    ?? computers[0]?.id
    ?? null;
  const selectComputer = (computerId: string) => {
    if (onSelectComputer) {
      onSelectComputer(computerId);
      return;
    }
    setLocalSelectedComputerId(computerId);
  };
  const selected = useMemo(
    () => {
      const matched = computers.find(
        (item) => item.id === selectedComputerId,
      );
      if (hasRouteSelectedComputer) return matched ?? null;
      return matched ?? computers[0] ?? null;
    },
    [computers, hasRouteSelectedComputer, selectedComputerId],
  );
  const boundAgents = selected
    ? agents.filter((agent) => agent.computerId === selected.id)
    : [];
  const submitNewComputer = async (input: CreateComputerInput) => {
    await onCreateComputer(input);
    setCreating(false);
    setCreateName("");
  };
  const cancelNewComputer = () => {
    setCreating(false);
    setCreateName("");
  };

  const desktopNavigation = (
    <ManagementCollectionPane
      orientation={wideWorkspace ? "vertical" : "horizontal"}
      testID="computer-sidebar"
    >
      <ScrollView
        contentContainerStyle={[
          styles.list,
          !wideWorkspace && styles.listStacked,
        ]}
        horizontal={!wideWorkspace}
        showsHorizontalScrollIndicator={false}
        style={styles.listScroller}
      >
        {computers.map((computer) => {
          const active = computer.id === selected?.id;
          return (
            <CollectionRow
              accessibilityLabel={`打开 Computer ${computer.name}`}
              key={computer.id}
              onPress={() => {
                terminal?.close();
                setTerminal(null);
                setRegistration(null);
                setReleaseConfirming(false);
                selectComputer(computer.id);
              }}
              orientation={wideWorkspace ? "vertical" : "horizontal"}
              selected={active}
            >
              <CollectionIdentityMark
                icon={Monitor}
                presence={{
                  label: computerConnectionLabel[computer.connectionState],
                  tone: computerConnectionTone(computer.connectionState),
                }}
              />
              <View style={styles.rowCopy}>
                <Text style={styles.rowTitle}>{computer.name}</Text>
                <Text style={styles.mono}>
                  {computer.osType} · {computerConnectionLabel[computer.connectionState]}
                </Text>
              </View>
            </CollectionRow>
          );
        })}
      </ScrollView>
    </ManagementCollectionPane>
  );
  const mobileNavigation = selected ? (
    <ManagementResourceSwitcher
      currentAccessibilityLabel={`切换 Computer，当前 ${selected.name}`}
      currentContent={(
        <>
        <CollectionIdentityMark
          icon={Monitor}
          presence={{
            label: computerConnectionLabel[selected.connectionState],
            tone: computerConnectionTone(selected.connectionState),
          }}
        />
        <View style={styles.rowCopy}>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {selected.name}
          </Text>
          <Text numberOfLines={1} style={styles.mono}>
            {selected.osType} · {computerConnectionLabel[selected.connectionState]}
          </Text>
        </View>
        </>
      )}
      expanded={switcherOpen}
      onToggle={() => setSwitcherOpen((current) => !current)}
      options={computers
        .filter((computer) => computer.id !== selected.id)
        .map((computer) => ({
          accessibilityLabel: `打开 Computer ${computer.name}`,
          content: (
            <>
                <CollectionIdentityMark
                  icon={Monitor}
                  presence={{
                    label: computerConnectionLabel[computer.connectionState],
                    tone: computerConnectionTone(computer.connectionState),
                  }}
                />
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {computer.name}
                  </Text>
                  <Text numberOfLines={1} style={styles.mono}>
                    {computer.osType} · {computerConnectionLabel[computer.connectionState]}
                  </Text>
                </View>
            </>
          ),
          id: computer.id,
          onSelect: () => {
            terminal?.close();
            setTerminal(null);
            setRegistration(null);
            setReleaseConfirming(false);
            selectComputer(computer.id);
            setSwitcherOpen(false);
          },
        }))}
      testID="computer-mobile-switcher"
    />
  ) : null;
  const navigation = phone ? mobileNavigation : desktopNavigation;

  const selectedServer = servers.find(item => item.id === currentServerId);
  const createAction: PresentationAction = {
    disabled: pendingAction !== null,
    id: "create-computer",
    kind: "primary",
    label: computers.length === 0 ? "纳管第一台 Computer" : "纳管 Computer",
    run: () => setCreating(true),
    shortcut: "N",
  };
  const selectedActions: PresentationAction[] = selected ? [
    {
      disabled: pendingAction !== null,
      id: "registration-script",
      kind: "primary",
      label: "生成一键安装命令",
      run: async () => {
        const value = await onRequestRegistrationScript(selected.id);
        if (value) setRegistration(value);
      },
    },
    ...(canManage &&
    selected.lifecycleState === "active" &&
    selected.connectionState === "online" &&
    onCreateTerminalController
      ? [{
          disabled: terminal !== null,
          id: "open-computer-terminal",
          label: "打开终端",
          run: () => {
            setRegistration(null);
            setTerminal(onCreateTerminalController(selected.id));
          },
        } satisfies PresentationAction]
      : []),
    ...(canManage && onRemoveComputer
      ? releaseConfirming
        ? [
            {
              id: "cancel-remove-computer",
              label: "取消解除纳管",
              run: () => setReleaseConfirming(false),
            },
            {
              disabled: pendingAction !== null,
              id: "confirm-remove-computer",
              kind: "danger" as const,
              label: "确认解除纳管",
              run: async () => {
                const removed = await onRemoveComputer(selected.id);
                if (removed) setReleaseConfirming(false);
              },
            },
          ]
        : [{
            disabled: boundAgents.length > 0 || pendingAction !== null,
            id: "remove-computer",
            kind: "danger" as const,
            label: "解除纳管",
            run: () => setReleaseConfirming(true),
          }]
      : []),
  ] : [];
  const semanticModel = (): ManagementPageModel => ({
    collection: {
      items: computers.map(item => ({
        id: item.id,
        meta: item.osType,
        onSelect: () => selectComputer(item.id),
        selected: item.id === selected?.id,
        status: computerConnectionLabel[item.connectionState],
        subtitle: item.lifecycleState,
        title: item.name,
      })),
      label: "Computer",
    },
    commands: [
      createAction,
      {
        disabled: loading,
        id: "refresh-computers",
        label: "刷新 Computer",
        run: onRefresh,
        shortcut: "R",
      },
    ],
    ...(creating
      ? {
          form: {
            actions: [
              {
                id: "cancel-create-computer",
                label: "取消",
                run: cancelNewComputer,
              },
              {
                disabled: pendingAction !== null || createName.trim().length === 0,
                id: "submit-create-computer",
                kind: "primary" as const,
                label: "创建 Computer",
                run: () => submitNewComputer({name: createName.trim()}),
              },
            ],
            fields: [
              {
                disabled: pendingAction !== null,
                id: "computer-name",
                label: "Computer 名称",
                onChange: setCreateName,
                placeholder: "例如：研发机",
                value: createName,
              },
            ],
            title: "纳管 Computer",
          },
        }
      : registration
        ? {
            form: {
              actions: [
                {
                  id: "close-registration-script",
                  label: "关闭",
                  run: () => setRegistration(null),
                },
              ],
              fields: [
                {
                  disabled: true,
                  id: "registration-script",
                  label: `一键安装命令 · 有效期至 ${registration.expiresAt}`,
                  multiline: true,
                  onChange: () => undefined,
                  value: registration.script,
                },
              ],
              title: "Computer 一键安装命令",
            },
          }
        : terminal && selected
          ? {
              form: {
                actions: [
                  {
                    id: "close-computer-terminal",
                    label: "关闭终端",
                    run: () => setTerminal(null),
                  },
                ],
                fields: [
                  {
                    disabled: true,
                    id: "computer-terminal-status",
                    label: "终端状态",
                    onChange: () => undefined,
                    value: "终端会话已打开",
                  },
                ],
                title: `${selected.name} 终端`,
              },
            }
          : selected
            ? {
                detail: {
                  actions: selectedActions,
                  description: `${selected.osType} · ${selected.lastObservedAt ? `最近连接 ${formatReadableDateTime(selected.lastObservedAt)}` : "尚未连接"} · ${boundAgents.length} 个绑定 Agent`,
                  meta: selected.lifecycleState,
                  status: computerConnectionLabel[selected.connectionState],
                  title: selected.name,
                },
              }
            : {
                empty: hasRouteSelectedComputer
                  ? {
                      description: "这条链接可能已经失效，或者你没有访问权限。",
                      title: "找不到这台 Computer",
                    }
                  : {
                      action: createAction,
                      description: "纳管一台可出网机器，再把 Agent 绑定到它。",
                      title: "还没有 Computer",
                    },
              }),
    error: error ?? undefined,
    header: {
      eyebrow: "计算资源",
      summary: `${computers.length} 台 Computer`,
      title: creating ? "纳管 Computer" : "Computer",
    },
    id: "computers",
    shell: {
      accountLabel: currentAccount?.displayName ?? currentAccount?.email,
      activeSection: "computers",
      navigation: ([
        ["chat", "聊天"],
        ["tasks", "任务"],
        ["agents", "Agent"],
        ["computers", "Computer"],
        ["members", "成员"],
      ] as const).map(([section, label]) => ({
        id: `navigate-${section}`,
        label,
        run: () => onNavigateSection(section),
      })),
      ...(onLogout ? {onLogout} : {}),
      serverName: selectedServer?.name,
      serverOptions: servers.map(server => ({
        id: server.id,
        label: server.name,
        onSelect: () => onSelectServer(server.id),
        selected: server.id === currentServerId,
      })),
    },
  });

  return (
    <ManagementPresentation model={semanticModel}>
    <PlatformFrame
      account={currentAccount}
      activeSection="computers"
      currentServerId={currentServerId}
      imStatus={imStatus}
      navigation={null}
      onLogout={onLogout}
      onNavigateSection={onNavigateSection}
      onSelectServer={onSelectServer}
      sectionHref={sectionHref}
      serverHref={serverHref}
      servers={servers}
      viewportWidth={viewportWidth}
    >
      <ManagementStage testID="computer-stage">
        <ManagementHeader
          actions={(
            <View style={styles.headerActions}>
            <IconActionButton
              accessibilityLabel="刷新 Computer"
              disabled={loading}
              context="header"
              icon={RefreshCw}
              onPress={onRefresh}
              testID="computer-refresh-icon"
            />
            {computers.length > 0 && !creating ? (
              <ActionButton
                accessibilityLabel="纳管 Computer"
                context="header"
                icon={Plus}
                iconTestID="computer-create-icon"
                importance="tonal"
                label="纳管"
                onPress={() => setCreating(true)}
              />
            ) : null}
            </View>
          )}
          title={creating ? "纳管 Computer" : "Computer"}
          titleTestID="computer-stage-title"
        />
        {error ? (
          <InlineFeedback
            message={error}
            testID="computer-feedback"
            tone={error.includes("已完成连接") ? "positive" : "danger"}
          />
        ) : null}
        <View
          style={[
            styles.workspaceBody,
            wideWorkspace && styles.workspaceBodyWide,
          ]}
          testID="computer-workspace"
        >
          {hasComputerDirectory && !creating && !terminal
            ? navigation
            : null}
          <ManagementDetailScroll
            density={phone ? "compact" : mediumSurface ? "medium" : "comfortable"}
            testID="computer-detail-scroll"
          >
          {creating ? (
            <ComputerCreateForm
              disabled={pendingAction !== null}
              name={createName}
              onCancel={cancelNewComputer}
              onChangeName={setCreateName}
              onSubmit={submitNewComputer}
            />
          ) : registration ? (
            <RegistrationPanel
              onClose={() => setRegistration(null)}
              registration={registration}
            />
          ) : terminal && selected ? (
            <TerminalPanel
              controller={terminal}
              name={selected.name}
              onClose={() => setTerminal(null)}
            />
          ) : selected ? (
            <ManagementDetailCanvas testID="computer-detail">
              <ResourceIdentityHeader
                icon={Monitor}
                markTestID="computer-hero-icon"
                metadata={[
                  selected.osType,
                  selected.lastObservedAt
                    ? `最近连接 ${formatReadableDateTime(selected.lastObservedAt)}`
                    : "尚未连接",
                ]}
                metadataTestID="computer-identity-meta"
                primaryTestID="computer-hero-identity"
                status={{
                  label: computerConnectionLabel[selected.connectionState],
                  tone: selected.connectionState === "online"
                    ? "positive"
                    : selected.connectionState === "error"
                      ? "danger"
                      : "neutral",
                }}
                testID="computer-hero"
                title={selected.name}
                titleTestID="computer-detail-title"
              />
              <View
                style={[
                  styles.supportGrid,
                  stackSupportPanels && styles.supportGridCompact,
                ]}
                testID="computer-support-grid"
              >
                <DetailSection
                  grow
                  span="major"
                  stacked={stackSupportPanels}
                  testID="computer-binding-panel"
                  title="绑定的 Agent"
                >
                  <Text style={styles.panelDescription}>
                    在这台 Computer 上运行的 Agent。
                  </Text>
                  {boundAgents.length === 0 ? (
                    <Text style={styles.emptyText}>尚未绑定 Agent。</Text>
                  ) : (
                    boundAgents.map((agent) => (
                      <View key={agent.id} style={styles.bindingRow}>
                        <Text style={styles.bindingName}>
                          {agent.displayName}
                        </Text>
                        <Text style={styles.mono}>@{agent.handle}</Text>
                      </View>
                    ))
                  )}
                </DetailSection>
                <DetailSection
                  grow
                  span="minor"
                  stacked={stackSupportPanels}
                  testID="computer-management-panel"
                  title="管理"
                >
                  <ResourceActionRow
                    action={(
                      <ActionButton
                        accessibilityLabel={`生成${selected.name}的一键安装命令`}
                        disabled={pendingAction !== null}
                        importance="secondary"
                        label="生成安装命令"
                        onPress={async () => {
                          const value = await onRequestRegistrationScript(
                            selected.id,
                          );
                          if (value) setRegistration(value);
                        }}
                      />
                    )}
                    description="生成一次性安装脚本，连接这台机器。"
                    testID="computer-install-action-row"
                    title="安装与重新连接"
                  />
                  {canManage &&
                    selected.lifecycleState === "active" &&
                    selected.connectionState === "online" &&
                    onCreateTerminalController ? (
                      <ResourceActionRow
                        action={(
                          <ActionButton
                            accessibilityLabel={`打开${selected.name}终端`}
                            disabled={terminal !== null}
                            importance="quiet"
                            label="打开终端"
                            onPress={() => {
                              setRegistration(null);
                              setTerminal(onCreateTerminalController(selected.id));
                            }}
                          />
                        )}
                        description="通过安全会话进入当前在线 Computer。"
                        testID="computer-terminal-action-row"
                        title="安全终端"
                      />
                    ) : null}
                  {canManage &&
                  selected.lifecycleState === "active" &&
                  selected.connectionState === "online" &&
                  !onCreateTerminalController &&
                  terminalUnavailableReason ? (
                    <Text style={styles.panelDescription}>
                      {terminalUnavailableReason}
                    </Text>
                  ) : null}
                </DetailSection>
              </View>
              {canManage && onRemoveComputer ? (
                <View
                  style={styles.releaseSection}
                  testID="computer-release-section"
                >
                  {releaseConfirming ? (
                    <ResourceActionRow
                      action={(
                        <View style={styles.detailActions}>
                        <ActionButton
                          accessibilityLabel="取消解除纳管"
                          importance="secondary"
                          label="取消"
                          onPress={() => setReleaseConfirming(false)}
                        />
                        <ActionButton
                          accessibilityLabel={`确认解除纳管${selected.name}`}
                          disabled={pendingAction !== null}
                          importance="danger"
                          label="确认解除纳管"
                          onPress={async () => {
                            const removed = await onRemoveComputer(selected.id);
                            if (removed) setReleaseConfirming(false);
                          }}
                        />
                        </View>
                      )}
                      description="不会删除真实机器上的文件或程序。再次纳管会创建新的 Computer。"
                      testID="computer-release-action-row"
                      title="确认解除纳管"
                    />
                  ) : (
                    <ResourceActionRow
                      action={(
                        <ActionButton
                          accessibilityLabel={`解除纳管${selected.name}`}
                          disabled={
                            boundAgents.length > 0 || pendingAction !== null
                          }
                          importance="danger"
                          label="解除纳管"
                          onPress={() => setReleaseConfirming(true)}
                        />
                      )}
                      description={boundAgents.length > 0
                        ? `请先迁移或解绑 ${boundAgents.length} 个 Agent`
                        : "从当前 Server 移除记录，不操作真实机器。"}
                      testID="computer-release-action-row"
                      title="危险操作"
                    />
                  )}
                </View>
              ) : null}
            </ManagementDetailCanvas>
          ) : hasRouteSelectedComputer ? (
            <View style={styles.notFound} testID="computer-not-found">
              <Text style={styles.formTitle}>找不到这台 Computer</Text>
              <Text style={styles.panelDescription}>
                这条链接可能已经失效，或者你没有访问权限。
              </Text>
              {computers[0] ? (
                <ActionButton
                  accessibilityLabel="打开第一台 Computer"
                  importance="secondary"
                  label="查看可用 Computer"
                  onPress={() => selectComputer(computers[0]!.id)}
                />
              ) : null}
            </View>
          ) : (
            <ManagementEmptyState
              actionAccessibilityLabel="从空状态纳管 Computer"
              actionLabel="纳管第一台 Computer"
              description="纳管一台可出网机器，再把 Agent 绑定到它。"
              icon={Monitor}
              onAction={() => setCreating(true)}
              title="还没有 Computer"
            />
          )}
          </ManagementDetailScroll>
        </View>
      </ManagementStage>
    </PlatformFrame>
    </ManagementPresentation>
  );
}

function ComputerCreateForm({
  disabled,
  name,
  onCancel,
  onChangeName,
  onSubmit,
}: {
  disabled: boolean;
  name: string;
  onCancel(): void;
  onChangeName(value: string): void;
  onSubmit(input: CreateComputerInput): void | Promise<void>;
}) {
  const submitDisabled = disabled || name.trim().length === 0;
  return (
    <ManagementForm testID="computer-create-form">
      <ManagementField label="Computer 名称">
        <ManagementTextInput
          accessibilityLabel="Computer 名称"
          editable={!disabled}
          onChangeText={onChangeName}
          placeholder="例如：研发机"
          value={name}
        />
      </ManagementField>
      <ManagementFormActions>
        <ActionButton
          accessibilityLabel="取消纳管 Computer"
          importance="secondary"
          label="取消"
          onPress={onCancel}
        />
        <ActionButton
          accessibilityLabel="创建 Computer"
          disabled={submitDisabled}
          importance="primary"
          label="创建 Computer"
          onPress={() =>
            onSubmit({
              name: name.trim(),
            })
          }
        />
      </ManagementFormActions>
    </ManagementForm>
  );
}

function RegistrationPanel({
  onClose,
  registration,
}: {
  onClose(): void;
  registration: RegistrationScript;
}) {
  return (
    <NoticeBanner
      actions={(
        <IconActionButton
          accessibilityLabel="关闭一键安装命令"
          icon={X}
          onPress={onClose}
        />
      )}
      description="关闭后不再保留。请勿粘贴到聊天、Issue 或日志。"
      testID="computer-registration-notice"
      title="一键安装命令"
      tone="info"
    >
      <CodeBlock
        testID="computer-registration-code"
        value={registration.script}
      />
      <Text style={styles.mono}>
        有效期至 {registration.expiresAt}
      </Text>
    </NoticeBanner>
  );
}

const computerConnectionLabel: Record<
  Computer["connectionState"],
  string
> = {
  error: "连接失败",
  offline: "离线",
  online: "在线",
  unknown: "等待连接",
};

function computerConnectionTone(
  state: Computer["connectionState"],
): "danger" | "neutral" | "positive" {
  if (state === "online") return "positive";
  if (state === "error") return "danger";
  return "neutral";
}

const styles = StyleSheet.create((theme) => ({
  bindingName: {
    ...theme.semantic.typography.bodyEmphasis,
  },
  bindingRow: {
    alignItems: "center",
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: theme.spacing.sm,
  },
  detailActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  emptyText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
  },
  formTitle: {
    ...theme.semantic.typography.sectionTitle,
  },
  headerActions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  list: {
    gap: theme.spacing.xs,
    padding: theme.spacing.sm,
  },
  listStacked: {
    alignItems: "center",
  },
  listScroller: {
    flex: 1,
  },
  mono: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  notFound: {
    alignSelf: "center",
    gap: theme.spacing.md,
    maxWidth: theme.recipes.managementWorkspace.emptyStateMaxWidth,
    padding: theme.spacing.xxl,
    width: "100%",
  },
  panelDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
  },
  rowCopy: {
    flex: 1,
  },
  rowTitle: {
    ...theme.semantic.typography.sectionTitle,
  },
  supportGrid: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: theme.spacing.lg,
  },
  supportGridCompact: {
    flexDirection: "column",
  },
  releaseSection: {
    borderRadius: theme.semantic.radius.pane,
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.md,
    paddingTop: theme.spacing.xl,
  },
  workspaceBody: {
    flex: 1,
    minHeight: 0,
  },
  workspaceBodyWide: {
    flexDirection: "row",
  },
}));
