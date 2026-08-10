import type {
  Agent,
  Computer,
  CreateComputerInput,
  RegistrationScript,
  Server,
} from "@vela/client-core";
import { useMemo, useState } from "react";
import {
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Monitor from "lucide-react-native/icons/monitor";
import X from "lucide-react-native/icons/x";

import {ManagementEmptyState} from "../components/management-empty-state";
import {
  CodeBlock,
  CollectionIdentityMark,
  CollectionRow,
  CollectionRowCopy,
  DetailSection,
  ManagementDetailCanvas,
  ManagementDetailScroll,
  ManagementStageFill,
  ManagementField,
  ManagementForm,
  ManagementFormFooter,
  ManagementHeader,
  ManagementHeaderActions,
  NoticeBanner,
  ResourceIdentityHeader,
  ManagementResourceDirectory,
  ManagementResourceSelect,
  ManagementStage,
  ManagementTextInput,
  ResourceActionRow,
} from "../components/management-workspace";
import {SystemButton, SystemIconButton} from "../primitives/system-button";
import {SystemFeedback} from "../primitives/system-feedback";
import {SystemDialog} from "../primitives/system-dialog";
import {formatReadableDateTime} from "../date-time";
import {
  buildManagementShellModel,
  ManagementPresentation,
  type ManagementPageModel,
  type PresentationAction,
  type PresentationForm,
} from "../presentation";
import type { PlatformFrameProps } from "../layouts/app-frame";
import { ManagementScreenFrame } from "../layouts/management-screen-frame";
import {
  computerEmptyCopy,
  computerNotFoundCopy,
} from "../management-empty-copy";
import { managementSurfaceLayout } from "../management-surface-layout";
import {
  computerConnectionLabel,
  computerConnectionTone,
  computerListItemViewModel,
} from "../presentation/resources/computer";
import type { WorkspaceSection } from "../layouts/workspace-section";
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
  /**
   * When false, render section body only. Parent WorkspaceChrome owns the
   * shared rail / bottom bar so navigation membership stays stable.
   */
  framed?: boolean;
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
    framed = true,
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
  const surface = managementSurfaceLayout(resolvedViewportWidth);
  const {density, phone, stackedCollection} = surface;
  const showStackedCollection = stackedCollection && computers.length > 1;
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

  const selectListedComputer = (computerId: string) => {
    terminal?.close();
    setTerminal(null);
    setRegistration(null);
    setReleaseConfirming(false);
    selectComputer(computerId);
  };
  const computerItems = computers.map(computer => ({
    resource: computer,
    view: computerListItemViewModel(computer, computer.id === selected?.id),
  }));
  const selectedComputerItem = selected
    ? computerItems.find(item => item.resource.id === selected.id)
    : undefined;
  const desktopNavigation = (
    <ManagementResourceDirectory
      eyebrow={`${computers.length} 台 Computer`}
      horizontal={stackedCollection}
      icon={Monitor}
      testID="computer-sidebar"
      title="Computer"
    >
      {computerItems.map(({resource: computer, view}) => {
        return (
          <CollectionRow
            accessibilityLabel={view.accessibilityLabel}
            key={view.id}
            onPress={() => selectListedComputer(computer.id)}
            orientation={stackedCollection ? "horizontal" : "vertical"}
            selected={view.selected}
          >
            <CollectionIdentityMark
              icon={Monitor}
              presence={{
                label: view.status,
                tone: view.tone,
              }}
            />
            <CollectionRowCopy
              meta={view.meta}
              title={view.title}
            />
          </CollectionRow>
        );
      })}
    </ManagementResourceDirectory>
  );
  const mobileNavigation = selected ? (
    <ManagementResourceSelect
      accessibilityLabel={`切换 Computer，当前 ${selected.name}`}
      currentContent={(
        <>
        <CollectionIdentityMark
          icon={Monitor}
          presence={{
            label: selectedComputerItem!.view.status,
            tone: selectedComputerItem!.view.tone,
          }}
        />
        <CollectionRowCopy
          meta={selectedComputerItem!.view.meta}
          numberOfLines={1}
          title={selected.name}
        />
        </>
      )}
      onChange={selectListedComputer}
      onOpenChange={setSwitcherOpen}
      open={switcherOpen}
      options={computerItems.map(({resource: computer, view}) => ({
          accessibilityLabel: view.accessibilityLabel,
          label: computer.name,
          value: computer.id,
        }))}
      testID="computer-mobile-switcher"
      value={selected.id}
    />
  ) : null;
  const hideCollection = creating || terminal !== null;
  const frameNavigation =
    stackedCollection || hideCollection ? null : desktopNavigation;

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
      items: computerItems.map(({resource, view}) => ({
        id: view.id,
        meta: view.meta,
        onSelect: () => selectComputer(resource.id),
        selected: view.selected,
        status: view.status,
        subtitle: view.subtitle,
        title: view.title,
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
                      description: computerNotFoundCopy.description,
                      title: computerNotFoundCopy.title,
                    }
                  : {
                      action: createAction,
                      description: computerEmptyCopy.description,
                      title: computerEmptyCopy.title,
                    },
              }),
    error: error ?? undefined,
    header: {
      eyebrow: "计算资源",
      summary: `${computers.length} 台 Computer`,
      title: creating ? "纳管 Computer" : "Computer",
    },
    id: "computers",
    shell: buildManagementShellModel({
      accountLabel: currentAccount?.displayName ?? currentAccount?.email,
      activeSection: "computers",
      canManageServer: canManage,
      currentServerId,
      ...(onLogout ? {onLogout} : {}),
      onNavigateSection,
      onSelectServer,
      servers,
    }),
  });

  const renderStage = (pageModel: ManagementPageModel) => (
      <ManagementStage testID="computer-stage">
        <ManagementHeader
          actions={(
            <ManagementHeaderActions
              createAccessibilityLabel="纳管 Computer"
              createIconTestID="computer-create-icon"
              createLabel="纳管"
              createVisible={computers.length > 0 && !creating}
              onCreate={() => setCreating(true)}
              onRefresh={onRefresh}
              refreshAccessibilityLabel="刷新 Computer"
              refreshDisabled={loading}
              refreshTestID="computer-refresh-icon"
            />
          )}
          title={pageModel.header.title}
          titleTestID="computer-stage-title"
        />
        {pageModel.error ? (
          <SystemFeedback
            kind="inline"
            message={pageModel.error}
            testID="computer-feedback"
            tone={pageModel.error.includes("已完成连接") ? "positive" : "danger"}
          />
        ) : null}
        {!hideCollection && computers.length > 1
          ? phone
            ? mobileNavigation
            : showStackedCollection
              ? desktopNavigation
              : null
          : null}
        {terminal && selected ? (
          <ManagementStageFill density={density} testID="computer-terminal-host">
            <TerminalPanel
              controller={terminal}
              name={selected.name}
              onClose={() => setTerminal(null)}
            />
          </ManagementStageFill>
        ) : (
        <ManagementDetailScroll
          density={density}
          testID="computer-detail-scroll"
        >
          {creating ? (
            <ComputerCreateForm
              form={pageModel.form!}
            />
          ) : registration ? (
            <RegistrationPanel
              onClose={() => setRegistration(null)}
              registration={registration}
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
                    tone: computerConnectionTone(selected.connectionState),
                }}
                testID="computer-hero"
                title={selected.name}
                titleTestID="computer-detail-title"
              />
              <View style={styles.supportGrid} testID="computer-support-grid">
                <DetailSection
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
                  testID="computer-management-panel"
                  title="管理"
                >
                  <ResourceActionRow
                    action={(
                      <SystemButton
                        accessibilityLabel={`生成${selected.name}的一键安装命令`}
                        disabled={pendingAction !== null}
                        variant="secondary"
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
                    showSeparator={false}
                    testID="computer-install-action-row"
                    title="安装与重新连接"
                  />
                  {canManage &&
                    selected.lifecycleState === "active" &&
                    selected.connectionState === "online" &&
                    onCreateTerminalController ? (
                      <ResourceActionRow
                        action={(
                          <SystemButton
                            accessibilityLabel={`打开${selected.name}终端`}
                            disabled={terminal !== null}
                            variant="secondary"
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
                {canManage && onRemoveComputer ? (
                  <DetailSection
                    testID="computer-release-section"
                    title="危险操作"
                  >
                    <ResourceActionRow
                      action={(
                        <SystemButton
                          accessibilityLabel={`解除纳管${selected.name}`}
                          disabled={
                            boundAgents.length > 0 || pendingAction !== null
                          }
                          label="解除纳管"
                          onPress={() => setReleaseConfirming(true)}
                          variant="destructive"
                        />
                      )}
                      description={
                        boundAgents.length > 0
                          ? `请先迁移或解绑 ${boundAgents.length} 个 Agent`
                          : "从当前 Server 移除记录，不操作真实机器。"
                      }
                      showSeparator={false}
                      testID="computer-release-action-row"
                      title="解除纳管"
                    />
                  </DetailSection>
                ) : null}
              </View>
            </ManagementDetailCanvas>
          ) : hasRouteSelectedComputer ? (
            <View style={styles.notFound} testID="computer-not-found">
                  <Text style={styles.formTitle}>{computerNotFoundCopy.title}</Text>
                  <Text style={styles.panelDescription}>
                    {computerNotFoundCopy.description}
              </Text>
              {computers[0] ? (
                <SystemButton
                  accessibilityLabel="打开第一台 Computer"
                  variant="secondary"
                  label="查看可用 Computer"
                  onPress={() => selectComputer(computers[0]!.id)}
                />
              ) : null}
            </View>
          ) : (
            <ManagementEmptyState
              actionAccessibilityLabel="从空状态纳管 Computer"
              actionLabel="纳管 Computer"
              description={computerEmptyCopy.description}
              onAction={() => setCreating(true)}
              title={computerEmptyCopy.title}
            />
          )}
        </ManagementDetailScroll>
        )}
      </ManagementStage>
  );

  return (
    <ManagementPresentation model={semanticModel}>
      {(pageModel) => (
        <>
          <ManagementScreenFrame
          account={currentAccount}
          activeSection="computers"
          canManageServer={canManage}
          currentServerId={currentServerId}
          framed={framed}
          imStatus={imStatus}
          navigation={frameNavigation}
          onLogout={onLogout}
          onNavigateSection={onNavigateSection}
          onSelectServer={onSelectServer}
          sectionHref={sectionHref}
          serverHref={serverHref}
          servers={servers}
          viewportWidth={viewportWidth}
        >
          {renderStage(pageModel)}
          </ManagementScreenFrame>
          {selected && releaseConfirming ? (
            <SystemDialog
              actions={[
                {id: "cancel", intent: "secondary", kind: "cancel", label: "取消"},
                {
                  disabled: pendingAction !== null,
                  id: "confirm",
                  intent: "destructive",
                  kind: "action",
                  label: "确认解除纳管",
                },
              ]}
              busy={pendingAction !== null}
              description="不会删除真实机器上的文件或程序。再次纳管会创建新的 Computer。"
              dialogId="release-computer-dialog"
              onAction={id => {
                if (id === "confirm") void onRemoveComputer?.(selected.id);
              }}
              onOpenChange={() => setReleaseConfirming(false)}
              open
              title={`解除纳管 ${selected.name}？`}
            />
          ) : null}
        </>
      )}
    </ManagementPresentation>
  );
}

function ComputerCreateForm({
  form,
}: {
  form: PresentationForm;
}) {
  const name = form.fields.find(field => field.id === "computer-name")!;
  const cancel = form.actions.find(action => action.id === "cancel-create-computer")!;
  const submit = form.actions.find(action => action.id === "submit-create-computer")!;
  return (
    <ManagementForm testID="computer-create-form">
      <ManagementField error={name.error} hint={name.hint} label={name.label}>
        <ManagementTextInput
          accessibilityLabel={name.accessibilityLabel ?? name.label}
          editable={!name.disabled}
          onChangeText={name.onChange}
          placeholder={name.placeholder}
          value={name.value}
        />
      </ManagementField>
      <ManagementFormFooter
        cancelAction={{
          accessibilityLabel: "取消纳管 Computer",
          ...cancel,
          onPress: cancel.run,
        }}
        flowAction={{
          accessibilityLabel: "创建 Computer",
          intent: "submit",
          ...submit,
          onPress: submit.run,
        }}
      />
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
        <SystemIconButton
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
  emptyText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
  },
  formTitle: {
    ...theme.semantic.typography.sectionTitle,
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


  supportGrid: {
    gap: theme.spacing.lg,
  },
}));
