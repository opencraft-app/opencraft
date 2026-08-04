import type {
  AcceptedResource,
  Agent,
  Computer,
  CreateAgentInput,
  Operation,
  Server,
  UpdateAgentInput,
} from "@vela/client-core";
import { useEffect, useMemo, useState } from "react";
import {
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Bot from "lucide-react-native/icons/bot";
import Plus from "lucide-react-native/icons/plus";
import RefreshCw from "lucide-react-native/icons/refresh-cw";

import {ManagementEmptyState} from "../components/management-empty-state";
import {
  ActionButton,
  CollectionIdentityMark,
  CollectionRow,
  DetailSection,
  IconActionButton,
  ManagementCollectionPane,
  ManagementDetailCanvas,
  ManagementDetailScroll,
  ManagementField,
  ManagementForm,
  ManagementFormActions,
  ManagementHeader,
  ResourceIdentityHeader,
  ManagementResourceSwitcher,
  ManagementStage,
  ManagementTextInput,
  ResourceActionRow,
  SelectionButton,
  SelectionGroup,
  InlineFeedback,
  ManagementCollectionFooterAction,
  ManagementCollectionHeader,
} from "../components/management-workspace";
import { layoutMode } from "../layout-mode";
import {breakpoints} from "../theme";
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
  OperationStatusList,
  type OperationStatusItem,
} from "../components/operation-status-list";

const agentHandlePattern = /^[a-z0-9][a-z0-9_-]{1,31}$/u;

export interface AgentsScreenProps {
  agents: Agent[];
  canManage?: boolean;
  computers: Computer[];
  currentAccount?: PlatformFrameProps["account"];
  currentServerId: string | null;
  error: string | null;
  imStatus?: PlatformFrameProps["imStatus"];
  loading: boolean;
  onCreateAgent(
    input: CreateAgentInput,
  ): AcceptedResource | null | Promise<AcceptedResource | null>;
  onDeleteAgent?(
    agentId: string,
  ): AcceptedResource | null | Promise<AcceptedResource | null>;
  onContinueOperation?(operationId: string): void | Promise<void>;
  onLogout?: PlatformFrameProps["onLogout"];
  onNavigateSection(section: WorkspaceSection): void;
  onRefresh(): void | Promise<void>;
  onRotateCredential?(
    agentId: string,
  ): Operation | null | Promise<Operation | null>;
  onRunAgentAction(
    agentId: string,
    action: "deploy" | "restart" | "start" | "stop",
  ): Operation | null | Promise<Operation | null>;
  onSelectServer(serverId: string): void | Promise<void>;
  onUpdateAgent(
    agentId: string,
    input: UpdateAgentInput,
  ): void | Promise<void>;
  pendingAction: string | null;
  operations?: OperationStatusItem[];
  sectionHref?: PlatformFrameProps["sectionHref"];
  serverHref?: PlatformFrameProps["serverHref"];
  servers: Server[];
  viewportWidth?: number;
}

export function AgentsScreen(props: AgentsScreenProps) {
  const {
    agents,
    canManage = false,
    computers,
    currentAccount,
    currentServerId,
    error,
    imStatus,
    loading,
    onCreateAgent,
    onDeleteAgent,
    onContinueOperation,
    onLogout,
    onNavigateSection,
    onRefresh,
    onRotateCredential,
    onRunAgentAction,
    onSelectServer,
    onUpdateAgent,
    pendingAction,
    operations = [],
    sectionHref,
    serverHref,
    servers,
    viewportWidth,
  } = props;
  const window = useWindowDimensions();
  const resolvedViewportWidth = viewportWidth ?? window.width;
  const frameMode = layoutMode(resolvedViewportWidth);
  const compact = frameMode === "compact";
  const medium = frameMode === "medium";
  const phone = resolvedViewportWidth < breakpoints.medium;
  const stackedCollection = compact || medium;
  const showStackedCollection = stackedCollection && agents.length > 1;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const [confirmingRotation, setConfirmingRotation] = useState(false);
  const [createComputerId, setCreateComputerId] = useState<string | undefined>();
  const [createDisplayName, setCreateDisplayName] = useState("");
  const [createHandle, setCreateHandle] = useState("");
  const [createReplyPolicy, setCreateReplyPolicy] =
    useState<Agent["replyPolicy"]>("mention_and_dm");
  const [createRuntime, setCreateRuntime] =
    useState<Agent["runtime"]["kind"]>("codex");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    agents[0]?.id ?? null,
  );
  const [editComputerId, setEditComputerId] = useState<string | undefined>(
    agents[0]?.computerId ?? undefined,
  );
  const [editDisplayName, setEditDisplayName] = useState(
    agents[0]?.displayName ?? "",
  );
  const [editReplyPolicy, setEditReplyPolicy] = useState<Agent["replyPolicy"]>(
    agents[0]?.replyPolicy ?? "mention_and_dm",
  );
  const [editRuntime, setEditRuntime] = useState<Agent["runtime"]["kind"]>(
    agents[0]?.runtime.kind ?? "codex",
  );
  const selected = useMemo(
    () =>
      agents.find((item) => item.id === selectedAgentId) ??
      agents[0] ??
      null,
    [agents, selectedAgentId],
  );
  useEffect(() => {
    setEditComputerId(selected?.computerId ?? undefined);
    setEditDisplayName(selected?.displayName ?? "");
    setEditReplyPolicy(selected?.replyPolicy ?? "mention_and_dm");
    setEditRuntime(selected?.runtime.kind ?? "codex");
    setEditing(false);
    setConfirmingDeletion(false);
    setConfirmingRotation(false);
  }, [
    selected?.computerId,
    selected?.displayName,
    selected?.id,
    selected?.replyPolicy,
    selected?.runtime.kind,
  ]);
  const submitNewAgent = async (input: CreateAgentInput) => {
    await onCreateAgent(input);
    setCreating(false);
    setCreateComputerId(undefined);
    setCreateDisplayName("");
    setCreateHandle("");
    setCreateReplyPolicy("mention_and_dm");
    setCreateRuntime("codex");
  };
  const cancelNewAgent = () => {
    setCreating(false);
    setCreateComputerId(undefined);
    setCreateDisplayName("");
    setCreateHandle("");
    setCreateReplyPolicy("mention_and_dm");
    setCreateRuntime("codex");
  };

  const desktopNavigation = (
    <ManagementCollectionPane
      orientation={stackedCollection ? "horizontal" : "vertical"}
      testID="agent-sidebar"
    >
      {!stackedCollection ? (
        <ManagementCollectionHeader
          eyebrow={`${agents.length} 个 Agent`}
          icon={Bot}
          title="Agent"
        />
      ) : null}
      <ScrollView
        contentContainerStyle={[
          styles.list,
          stackedCollection && styles.listStacked,
        ]}
        horizontal={stackedCollection}
        showsHorizontalScrollIndicator={false}
        style={styles.listScroller}
      >
        {agents.map((agent) => {
          const active = agent.id === selected?.id;
          return (
            <CollectionRow
              accessibilityLabel={`打开 Agent ${agent.handle}`}
              key={agent.id}
              onPress={() => setSelectedAgentId(agent.id)}
              orientation={stackedCollection ? "horizontal" : "vertical"}
              selected={active}
            >
              <CollectionIdentityMark
                identityKind="agent"
                monogram={agent.displayName.slice(0, 1)}
                presence={{
                  label: agentRuntimeStateLabel(agent),
                  tone: agentRuntimeStateTone(agent),
                }}
              />
              <View style={styles.rowCopy}>
                <Text style={styles.rowTitle}>{agent.displayName}</Text>
                <Text style={styles.mono}>
                  @{agent.handle} · {agentRuntimeStateLabel(agent)}
                </Text>
              </View>
            </CollectionRow>
          );
        })}
      </ScrollView>
      {agents.length > 0 && !stackedCollection ? (
        <ManagementCollectionFooterAction
          accessibilityLabel="从侧栏新建 Agent"
          icon={Plus}
          label="新建 Agent"
          onPress={() => setCreating(true)}
        />
      ) : null}
    </ManagementCollectionPane>
  );
  const mobileNavigation = selected ? (
    <ManagementResourceSwitcher
      currentAccessibilityLabel={`切换 Agent，当前 ${selected.handle}`}
      currentContent={(
        <>
        <CollectionIdentityMark
          identityKind="agent"
          monogram={selected.displayName.slice(0, 1)}
          presence={{
            label: agentRuntimeStateLabel(selected),
            tone: agentRuntimeStateTone(selected),
          }}
        />
        <View style={styles.rowCopy}>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {selected.displayName}
          </Text>
          <Text numberOfLines={1} style={styles.mono}>
            @{selected.handle} · {agentRuntimeStateLabel(selected)}
          </Text>
        </View>
        </>
      )}
      expanded={switcherOpen}
      onToggle={() => setSwitcherOpen((current) => !current)}
      options={agents
        .filter((agent) => agent.id !== selected.id)
        .map((agent) => ({
          accessibilityLabel: `打开 Agent ${agent.handle}`,
          content: (
            <>
                <CollectionIdentityMark
                  identityKind="agent"
                  monogram={agent.displayName.slice(0, 1)}
                  presence={{
                    label: agentRuntimeStateLabel(agent),
                    tone: agentRuntimeStateTone(agent),
                  }}
                />
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {agent.displayName}
                  </Text>
                  <Text numberOfLines={1} style={styles.mono}>
                    @{agent.handle} · {agentRuntimeStateLabel(agent)}
                  </Text>
                </View>
            </>
          ),
          id: agent.id,
          onSelect: () => {
            setSelectedAgentId(agent.id);
            setSwitcherOpen(false);
          },
        }))}
      testID="agent-mobile-switcher"
    />
  ) : null;

  const selectedServer = servers.find(item => item.id === currentServerId);
  const assignableComputers = computers.filter(
    (item) => item.lifecycleState === "active",
  );
  const createAction: PresentationAction = {
    disabled: pendingAction !== null || assignableComputers.length === 0,
    id: "create-agent",
    kind: "primary",
    label: agents.length === 0 ? "创建第一个 Agent" : "新建 Agent",
    run: () => setCreating(true),
    shortcut: "N",
  };
  const selectedComputer = selected
    ? computers.find(item => item.id === selected.computerId)
    : undefined;
  const computerReady =
    selectedComputer?.lifecycleState === "active" &&
    selectedComputer.connectionState === "online";
  const lifecycleEnabled = selected ? {
    deploy: computerReady && ["error", "stopped", "unknown"].includes(selected.observedState),
    restart: computerReady && selected.observedState === "running",
    start: computerReady && selected.observedState === "stopped",
    stop: computerReady && selected.observedState === "running",
  } : null;
  const canRotateCredential = Boolean(
    selected &&
    canManage &&
    selected.imState === "ready" &&
    selected.computerId &&
    selected.desiredState === "stopped" &&
    ["unknown", "stopped", "error"].includes(selected.observedState) &&
    onRotateCredential,
  );
  const saveEditedAgent = async () => {
    if (!selected || !editDisplayName.trim() || !editComputerId) return;
    await onUpdateAgent(selected.id, {
      computerId: editComputerId,
      displayName: editDisplayName.trim(),
      replyPolicy: editReplyPolicy,
      runtime: {kind: editRuntime},
    });
    setEditing(false);
  };
  const rotateCredential = async () => {
    if (!selected || !onRotateCredential) return;
    await onRotateCredential(selected.id);
    setConfirmingRotation(false);
  };
  const deleteAgent = async () => {
    if (!selected || !onDeleteAgent) return;
    await onDeleteAgent(selected.id);
    setConfirmingDeletion(false);
  };
  const semanticModel = (): ManagementPageModel => ({
    collection: {
      items: agents.map(item => ({
        id: item.id,
        meta: `@${item.handle}`,
        onSelect: () => setSelectedAgentId(item.id),
        selected: item.id === selected?.id,
        status: agentRuntimeStateLabel(item),
        subtitle: item.runtime.kind,
        title: item.displayName,
      })),
      label: "Agent",
    },
    commands: [
      createAction,
      {
        disabled: loading,
        id: "refresh-agents",
        label: "刷新 Agent",
        run: onRefresh,
        shortcut: "R",
      },
    ],
    ...(creating
      ? {
          form: {
            actions: [
              {
                id: "cancel-create-agent",
                label: "取消",
                run: cancelNewAgent,
              },
              {
                disabled:
                  pendingAction !== null ||
                  createDisplayName.trim().length === 0 ||
                  !agentHandlePattern.test(createHandle.trim()) ||
                  !createComputerId,
                id: "submit-create-agent",
                kind: "primary" as const,
                label: "创建 Agent",
                run: () => submitNewAgent({
                  computerId: createComputerId!,
                  displayName: createDisplayName.trim(),
                  handle: createHandle.trim(),
                  replyPolicy: createReplyPolicy,
                  runtime: {kind: createRuntime},
                }),
              },
            ],
            fields: [
              {
                disabled: pendingAction !== null,
                id: "agent-display-name",
                label: "显示名称",
                onChange: setCreateDisplayName,
                placeholder: "例如：交付助手",
                value: createDisplayName,
              },
              {
                disabled: pendingAction !== null,
                id: "agent-handle",
                label: "Handle",
                onChange: setCreateHandle,
                placeholder: "delivery",
                value: createHandle,
              },
              {
                disabled: pendingAction !== null,
                id: "agent-runtime",
                label: "Runtime",
                onChange: value => setCreateRuntime(value as Agent["runtime"]["kind"]),
                options: runtimeKinds.map(value => ({label: value, value})),
                value: createRuntime,
              },
              {
                disabled: pendingAction !== null,
                id: "agent-reply-policy",
                label: "回复策略",
                onChange: value => setCreateReplyPolicy(value as Agent["replyPolicy"]),
                options: replyPolicies.map(option => ({
                  label: option.label,
                  value: option.value,
                })),
                value: createReplyPolicy,
              },
              {
                disabled: pendingAction !== null,
                id: "agent-computer",
                label: "Computer",
                onChange: value => setCreateComputerId(value || undefined),
                options: assignableComputers.map(item => ({
                  label: item.name,
                  value: item.id,
                })),
                value: createComputerId ?? "",
              },
            ],
            title: "新建 Agent",
          },
        }
      : selected
        ? {
            detail: {
              actions: [
                ...(["deploy", "start", "stop", "restart"] as const).map(action => ({
                  disabled: pendingAction !== null || !lifecycleEnabled?.[action],
                  id: `${action}-agent`,
                  kind: action === "stop" ? "secondary" as const : "primary" as const,
                  label: agentActionLabel[action],
                  run: () => onRunAgentAction(selected.id, action),
                })),
                {
                  disabled: pendingAction !== null,
                  id: "edit-agent",
                  label: "编辑 Agent",
                  run: () => setEditing(true),
                },
                ...(canManage && onRotateCredential
                  ? [{
                      disabled: pendingAction !== null || !canRotateCredential,
                      id: "rotate-agent-credential",
                      kind: "danger" as const,
                      label: "轮换运行凭证",
                      run: () => setConfirmingRotation(true),
                    }]
                  : []),
                ...(canManage && onDeleteAgent
                  ? [{
                      disabled: pendingAction !== null,
                      id: "delete-agent",
                      kind: "danger" as const,
                      label: "删除 Agent",
                      run: () => setConfirmingDeletion(true),
                    }]
                  : []),
              ],
              description: `${selected.runtime.kind} · ${selectedComputer?.name ?? "未绑定 Computer"} · ${agentReplyPolicyLabel[selected.replyPolicy]}`,
              meta: `@${selected.handle}`,
              status: agentRuntimeStateLabel(selected),
              title: selected.displayName,
            },
          }
        : {
            empty: {
              action: createAction,
              description: "创建 Agent，并把它部署到已纳管的 Computer。",
              title: "还没有 Agent",
            },
          }),
    ...(editing && selected
      ? {
          form: {
            actions: [
              {
                id: "cancel-edit-agent",
                label: "取消",
                run: () => setEditing(false),
              },
              {
                disabled:
                  pendingAction !== null ||
                  !editDisplayName.trim() ||
                  !editComputerId,
                id: "submit-edit-agent",
                kind: "primary" as const,
                label: "保存 Agent",
                run: saveEditedAgent,
              },
            ],
            fields: [
              {
                disabled: pendingAction !== null,
                id: "edit-agent-display-name",
                label: "显示名称",
                onChange: setEditDisplayName,
                value: editDisplayName,
              },
              {
                disabled: pendingAction !== null,
                id: "edit-agent-runtime",
                label: "Runtime",
                onChange: value => setEditRuntime(value as Agent["runtime"]["kind"]),
                options: runtimeKinds.map(value => ({label: value, value})),
                value: editRuntime,
              },
              {
                disabled: pendingAction !== null,
                id: "edit-agent-reply-policy",
                label: "回复策略",
                onChange: value => setEditReplyPolicy(value as Agent["replyPolicy"]),
                options: replyPolicies.map(option => ({
                  label: option.label,
                  value: option.value,
                })),
                value: editReplyPolicy,
              },
              {
                disabled: pendingAction !== null,
                id: "edit-agent-computer",
                label: "Computer",
                onChange: value => setEditComputerId(value || undefined),
                options: assignableComputers.map(item => ({
                  label: item.name,
                  value: item.id,
                })),
                value: editComputerId ?? "",
              },
            ],
            title: `编辑 ${selected.displayName}`,
          },
        }
      : confirmingDeletion && selected
        ? {
            form: {
              actions: [
                {
                  id: "cancel-delete-agent",
                  label: "取消",
                  run: () => setConfirmingDeletion(false),
                },
                {
                  disabled: pendingAction !== null,
                  id: "confirm-delete-agent",
                  kind: "danger" as const,
                  label: "确认删除",
                  run: deleteAgent,
                },
              ],
              fields: [
                {
                  disabled: true,
                  id: "agent-delete-warning",
                  label: "删除说明",
                  multiline: true,
                  onChange: () => undefined,
                  value: "删除 Agent 身份和 IM 登录；Computer 与 TAT 不会停止，其他 Agent 不受影响。工作区和历史消息会保留。",
                },
              ],
              title: `删除 ${selected.displayName}`,
            },
          }
        : confirmingRotation && selected
        ? {
            form: {
              actions: [
                {
                  id: "cancel-rotate-agent-credential",
                  label: "取消",
                  run: () => setConfirmingRotation(false),
                },
                {
                  disabled: pendingAction !== null || !canRotateCredential,
                  id: "confirm-rotate-agent-credential",
                  kind: "danger" as const,
                  label: "确认轮换",
                  run: rotateCredential,
                },
              ],
              fields: [
                {
                  disabled: true,
                  id: "agent-credential-warning",
                  label: "轮换说明",
                  multiline: true,
                  onChange: () => undefined,
                  value: "安装成功前旧凭证仍有效；成功后新凭证原子激活，旧凭证撤销。",
                },
              ],
              title: `轮换 ${selected.displayName} 的运行凭证`,
            },
          }
        : {}),
    error: error ?? undefined,
    header: {
      eyebrow: "Agent 管理",
      summary: `${agents.length} 个 Agent`,
      title: creating ? "新建 Agent" : "Agent",
    },
    id: "agents",
    shell: {
      accountLabel: currentAccount?.displayName ?? currentAccount?.email,
      activeSection: "agents",
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
      activeSection="agents"
      canManageServer={canManage}
      currentServerId={currentServerId}
      imStatus={imStatus}
      navigation={stackedCollection ? null : desktopNavigation}
      onLogout={onLogout}
      onNavigateSection={onNavigateSection}
      onSelectServer={onSelectServer}
      sectionHref={sectionHref}
      serverHref={serverHref}
      servers={servers}
      viewportWidth={viewportWidth}
    >
      <ManagementStage>
        <ManagementHeader
          actions={(
            <View style={styles.headerActions}>
            <IconActionButton
              accessibilityLabel="刷新 Agent"
              context="header"
              disabled={loading}
              icon={RefreshCw}
              onPress={onRefresh}
              testID="agent-refresh-icon"
            />
            {agents.length > 0 && !creating ? (
              <ActionButton
                accessibilityLabel="新建 Agent"
                context="header"
                icon={Plus}
                iconTestID="agent-create-icon"
                importance="tonal"
                label="新建"
                onPress={() => setCreating(true)}
              />
            ) : null}
            </View>
          )}
          title={creating ? "新建 Agent" : "Agent"}
          titleTestID="agent-stage-title"
        />
        {error ? <InlineFeedback message={error} /> : null}
        {agents.length > 1 && !creating
          ? phone
            ? mobileNavigation
            : showStackedCollection
              ? desktopNavigation
              : null
          : null}
        <ManagementDetailScroll
          density={phone ? "compact" : medium ? "medium" : "comfortable"}
          testID="agent-detail-scroll"
        >
          {creating ? (
            <AgentCreateForm
              computerId={createComputerId}
              computers={assignableComputers}
              disabled={pendingAction !== null}
              displayName={createDisplayName}
              handle={createHandle}
              onCancel={cancelNewAgent}
              onChangeComputerId={setCreateComputerId}
              onChangeDisplayName={setCreateDisplayName}
              onChangeHandle={setCreateHandle}
              onChangeReplyPolicy={setCreateReplyPolicy}
              onChangeRuntime={setCreateRuntime}
              onSubmit={submitNewAgent}
              replyPolicy={createReplyPolicy}
              runtime={createRuntime}
            />
          ) : selected ? (
            <AgentDetail
              agent={selected}
              canManage={canManage}
              computerId={editComputerId}
              computers={assignableComputers}
              confirmingDeletion={confirmingDeletion}
              confirmingRotation={confirmingRotation}
              disabled={pendingAction !== null}
              displayName={editDisplayName}
              key={selected.id}
              onCancelDeletion={() => setConfirmingDeletion(false)}
              onCancelRotation={() => setConfirmingRotation(false)}
              onChangeComputerId={setEditComputerId}
              onChangeDisplayName={setEditDisplayName}
              onChangeReplyPolicy={setEditReplyPolicy}
              onChangeRuntime={setEditRuntime}
              onConfirmDeletion={deleteAgent}
              onConfirmRotation={rotateCredential}
              onContinueOperation={onContinueOperation}
              onDeleteAgent={onDeleteAgent}
              onRotateCredential={onRotateCredential}
              onStartDeletion={() => setConfirmingDeletion(true)}
              onStartRotation={() => setConfirmingRotation(true)}
              onRun={(action) =>
                onRunAgentAction(selected.id, action)
              }
              onSave={(input) => onUpdateAgent(selected.id, input)}
              operations={operations.filter(
                (item) => !item.resourceId || item.resourceId === selected.id,
              )}
              replyPolicy={editReplyPolicy}
              runtime={editRuntime}
            />
          ) : (
            <ManagementEmptyState
              actionAccessibilityLabel="从空状态新建 Agent"
              actionLabel="创建第一个 Agent"
              description="创建 Agent，并把它部署到已纳管的 Computer。"
              icon={Bot}
              onAction={() => setCreating(true)}
              title="还没有 Agent"
            />
          )}
        </ManagementDetailScroll>
      </ManagementStage>
    </PlatformFrame>
    </ManagementPresentation>
  );
}

function AgentCreateForm({
  computerId,
  computers,
  disabled,
  displayName,
  handle,
  onCancel,
  onChangeComputerId,
  onChangeDisplayName,
  onChangeHandle,
  onChangeReplyPolicy,
  onChangeRuntime,
  onSubmit,
  replyPolicy,
  runtime,
}: {
  computerId: string | undefined;
  computers: Computer[];
  disabled: boolean;
  displayName: string;
  handle: string;
  onCancel(): void;
  onChangeComputerId(value: string | undefined): void;
  onChangeDisplayName(value: string): void;
  onChangeHandle(value: string): void;
  onChangeReplyPolicy(value: Agent["replyPolicy"]): void;
  onChangeRuntime(value: Agent["runtime"]["kind"]): void;
  onSubmit(input: CreateAgentInput): void | Promise<void>;
  replyPolicy: Agent["replyPolicy"];
  runtime: Agent["runtime"]["kind"];
}) {
  const normalizedHandle = handle.trim();
  const handleValid = agentHandlePattern.test(normalizedHandle);
  return (
    <ManagementForm testID="agent-create-form">
      <View style={styles.formGrid}>
        <ManagementField label="显示名称" layout="flex">
          <ManagementTextInput
            accessibilityLabel="Agent 显示名"
            editable={!disabled}
            onChangeText={onChangeDisplayName}
            placeholder="例如：交付助手"
            value={displayName}
          />
        </ManagementField>
        <ManagementField
          error={handle.length > 0 && !handleValid
            ? "Handle 需为 2–32 位小写字母、数字、下划线或连字符。"
            : null}
          hint="Handle 需为 2–32 位小写字母、数字、下划线或连字符。"
          label="Handle"
          layout="flex"
        >
          <ManagementTextInput
            accessibilityLabel="Agent handle"
            autoCapitalize="none"
            editable={!disabled}
            invalid={handle.length > 0 && !handleValid}
            onChangeText={onChangeHandle}
            placeholder="delivery"
            value={handle}
          />
        </ManagementField>
      </View>
      <ChoiceRow
        label="Runtime"
        onSelect={(value) =>
          onChangeRuntime(value as Agent["runtime"]["kind"])
        }
        options={runtimeKinds.map((value) => ({
          accessibilityLabel: `选择 ${value}`,
          label: value,
          value,
        }))}
        selected={runtime}
      />
      <ChoiceRow
        label="回复策略"
        onSelect={(value) =>
          onChangeReplyPolicy(value as Agent["replyPolicy"])
        }
        options={replyPolicies}
        selected={replyPolicy}
      />
      <ChoiceRow
        label="Computer"
        onSelect={(value) => onChangeComputerId(value || undefined)}
        options={computers.map((computer) => ({
          accessibilityLabel: `绑定 Computer ${computer.name}`,
          label: computer.name,
          value: computer.id,
        }))}
        selected={computerId}
      />
      <FormActions
        cancelLabel="取消新建 Agent"
        disabled={
          disabled ||
          displayName.trim().length === 0 ||
          !handleValid ||
          !computerId
        }
        onCancel={onCancel}
        onSubmit={() => {
          if (!computerId) return;
          return onSubmit({
            computerId,
            displayName: displayName.trim(),
            handle: normalizedHandle,
            replyPolicy,
            runtime: {kind: runtime},
          });
        }}
        submitLabel="创建 Agent"
      />
    </ManagementForm>
  );
}

function AgentDetail({
  agent,
  canManage,
  computerId,
  computers,
  confirmingDeletion,
  confirmingRotation,
  disabled,
  displayName,
  onCancelDeletion,
  onCancelRotation,
  onChangeComputerId,
  onChangeDisplayName,
  onChangeReplyPolicy,
  onChangeRuntime,
  onConfirmDeletion,
  onConfirmRotation,
  onContinueOperation,
  onDeleteAgent,
  onRotateCredential,
  onRun,
  onSave,
  onStartDeletion,
  onStartRotation,
  operations,
  replyPolicy,
  runtime,
}: {
  agent: Agent;
  canManage: boolean;
  computerId: string | undefined;
  computers: Computer[];
  confirmingDeletion: boolean;
  confirmingRotation: boolean;
  disabled: boolean;
  displayName: string;
  onCancelDeletion(): void;
  onCancelRotation(): void;
  onChangeComputerId(value: string | undefined): void;
  onChangeDisplayName(value: string): void;
  onChangeReplyPolicy(value: Agent["replyPolicy"]): void;
  onChangeRuntime(value: Agent["runtime"]["kind"]): void;
  onConfirmDeletion(): void | Promise<void>;
  onConfirmRotation(): void | Promise<void>;
  onContinueOperation?(operationId: string): void | Promise<void>;
  onDeleteAgent?(
    agentId: string,
  ): AcceptedResource | null | Promise<AcceptedResource | null>;
  onRotateCredential?(
    agentId: string,
  ): Operation | null | Promise<Operation | null>;
  onRun(
    action: "deploy" | "restart" | "start" | "stop",
  ): Operation | null | Promise<Operation | null>;
  onSave(input: UpdateAgentInput): void | Promise<void>;
  onStartDeletion(): void;
  onStartRotation(): void;
  operations: OperationStatusItem[];
  replyPolicy: Agent["replyPolicy"];
  runtime: Agent["runtime"]["kind"];
}) {
  const computer = computers.find((item) => item.id === agent.computerId);
  const computerReady =
    computer?.lifecycleState === "active" &&
    computer.connectionState === "online";
  const lifecycleActionEnabled = {
    deploy:
      computerReady &&
      ["error", "stopped", "unknown"].includes(agent.observedState),
    restart: computerReady && agent.observedState === "running",
    start: computerReady && agent.observedState === "stopped",
    stop: computerReady && agent.observedState === "running",
  };
  const lifecycleHint = !computerReady
    ? "绑定的 Computer 当前不可用，请恢复连接后再操作。"
    : ["deploying", "starting", "stopping"].includes(agent.observedState)
      ? "Agent 正在切换状态，请等待当前操作完成。"
      : null;
  const canRotate =
    canManage &&
    agent.imState === "ready" &&
    Boolean(agent.computerId) &&
    agent.desiredState === "stopped" &&
    ["unknown", "stopped", "error"].includes(agent.observedState);
  return (
    <ManagementDetailCanvas testID="agent-detail">
      <ResourceIdentityHeader
        identityKind="agent"
        markTestID="agent-hero-avatar"
        metadata={[`@${agent.handle}`]}
        primaryTestID="agent-hero-identity"
        monogram={agent.displayName.slice(0, 1)}
        status={{
          label: agentRuntimeStateLabel(agent),
          tone: agent.observedState === "running"
            ? "positive"
            : agent.observedState === "error"
              ? "danger"
              : "neutral",
        }}
        testID="agent-hero"
        title={agent.displayName}
        titleTestID="agent-detail-title"
      />
      <View style={styles.lifecycle}>
        {(["deploy", "start", "stop", "restart"] as const).map(
          (action) => {
            const actionDisabled =
              disabled || !lifecycleActionEnabled[action];
            return (
              <ActionButton
                accessibilityLabel={`${agentActionLabel[action]} Agent ${agent.handle}`}
                disabled={actionDisabled}
                importance={
                  actionDisabled || action === "stop"
                    ? "secondary"
                    : "tonal"
                }
                key={action}
                label={agentActionLabel[action]}
                onPress={() => onRun(action)}
              />
            );
          },
        )}
      </View>
      {lifecycleHint ? (
        <Text style={styles.lifecycleHint}>{lifecycleHint}</Text>
      ) : null}
      <OperationStatusList
        items={operations}
        onContinue={onContinueOperation ?? (() => undefined)}
      />
      <DetailSection testID="agent-settings-section" title="Agent 设置">
        <ManagementField label="显示名称">
          <ManagementTextInput
            accessibilityLabel="编辑 Agent 显示名"
            editable={!disabled}
            onChangeText={onChangeDisplayName}
            value={displayName}
          />
        </ManagementField>
        <ChoiceRow
          label="Runtime"
          onSelect={(value) =>
            onChangeRuntime(value as Agent["runtime"]["kind"])
          }
          options={runtimeKinds.map((value) => ({
            accessibilityLabel: `编辑 Runtime ${value}`,
            label: value,
            value,
          }))}
          selected={runtime}
        />
        <ChoiceRow
          label="回复策略"
          onSelect={(value) =>
            onChangeReplyPolicy(value as Agent["replyPolicy"])
          }
          options={replyPolicies.map((option) => ({
            ...option,
            accessibilityLabel: `编辑${option.accessibilityLabel}`,
          }))}
          selected={replyPolicy}
        />
        <ChoiceRow
          label="Computer"
          onSelect={(value) => onChangeComputerId(value)}
          options={computers.map((item) => ({
            accessibilityLabel: `编辑绑定 Computer ${item.name}`,
            label: item.name,
            value: item.id,
          }))}
          selected={computerId}
        />
        <ActionButton
          disabled={disabled || displayName.trim().length === 0 || !computerId}
          importance="primary"
          label="保存 Agent"
          onPress={() => {
            if (!computerId) return;
            return onSave({
              computerId,
              displayName: displayName.trim(),
              replyPolicy,
              runtime: {kind: runtime},
            });
          }}
        />
      </DetailSection>
      {canManage ? (
        <DetailSection testID="agent-security-section" title="安全与身份">
          <ResourceActionRow
            action={confirmingRotation ? (
              <ManagementFormActions>
                <ActionButton
                  importance="secondary"
                  label="取消"
                  onPress={onCancelRotation}
                />
                <ActionButton
                  accessibilityLabel="确认轮换运行凭证"
                  disabled={disabled}
                  importance="primary"
                  label="确认轮换"
                  onPress={onConfirmRotation}
                />
              </ManagementFormActions>
            ) : (
              <ActionButton
                accessibilityLabel={`轮换 Agent ${agent.handle} 的运行凭证`}
                disabled={disabled || !canRotate || !onRotateCredential}
                importance="secondary"
                label="轮换凭证"
                onPress={onStartRotation}
              />
            )}
            description={confirmingRotation
              ? "安装成功前旧凭证仍有效；成功后新凭证原子激活，并撤销旧凭证。"
              : !canRotate
                ? `当前版本 ${agent.credentialVersion}。请先停止 Agent，并确认它已绑定在线 Computer。`
                : `当前版本 ${agent.credentialVersion}。轮换后需要显式启动 Agent。`}
            testID="agent-credential-section"
            title={confirmingRotation ? "安装成功前旧凭证仍有效" : "运行凭证"}
          />
          {onDeleteAgent ? (
            <ResourceActionRow
              action={confirmingDeletion ? (
                <ManagementFormActions>
                  <ActionButton
                    importance="secondary"
                    label="取消"
                    onPress={onCancelDeletion}
                  />
                  <ActionButton
                    accessibilityLabel={`确认删除 Agent ${agent.handle}`}
                    disabled={disabled}
                    importance="danger"
                    label="确认删除"
                    onPress={onConfirmDeletion}
                  />
                </ManagementFormActions>
              ) : (
                <ActionButton
                  accessibilityLabel={`删除 Agent ${agent.handle}`}
                  disabled={disabled}
                  importance="danger"
                  label="删除 Agent"
                  onPress={onStartDeletion}
                />
              )}
              description={confirmingDeletion
                ? "Computer 和 TAT 不会停止，其他 Agent 不受影响。Agent 的工作区和历史消息会保留。"
                : "删除 Agent 身份、运行凭证和腾讯 IM 登录；保留工作区与历史消息。"}
              testID="agent-delete-section"
              title={confirmingDeletion ? "确认删除 Agent" : "危险操作"}
            />
          ) : null}
        </DetailSection>
      ) : null}
    </ManagementDetailCanvas>
  );
}

function ChoiceRow({
  label,
  onSelect,
  options,
  selected,
}: {
  label: string;
  onSelect(value: string): void;
  options: Array<{
    accessibilityLabel: string;
    label: string;
    value: string;
  }>;
  selected: string | undefined;
}) {
  return (
    <View style={styles.choiceBlock}>
      <Text style={styles.eyebrow}>{label}</Text>
      <SelectionGroup>
        {options.map((option) => {
          const active = option.value === selected;
          return (
            <SelectionButton
              accessibilityLabel={option.accessibilityLabel}
              key={option.value || "none"}
              label={option.label}
              onPress={() => onSelect(option.value)}
              selected={active}
            />
          );
        })}
      </SelectionGroup>
    </View>
  );
}

function FormActions({
  cancelLabel,
  disabled,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  cancelLabel: string;
  disabled: boolean;
  onCancel(): void;
  onSubmit(): void | Promise<void>;
  submitLabel: string;
}) {
  return (
    <ManagementFormActions>
      <ActionButton
        accessibilityLabel={cancelLabel}
        importance="secondary"
        label="取消"
        onPress={onCancel}
      />
      <ActionButton
        accessibilityLabel={submitLabel}
        disabled={disabled}
        importance="primary"
        label={submitLabel}
        onPress={onSubmit}
      />
    </ManagementFormActions>
  );
}

const runtimeKinds = [
  "codex",
  "hermes-acp",
  "hermes-gateway",
] as const;

const replyPolicies = [
  {
    accessibilityLabel: "选择仅提及和私聊",
    label: "提及 + 私聊",
    value: "mention_and_dm",
  },
  {
    accessibilityLabel: "选择全部频道消息",
    label: "全部频道",
    value: "all_channel_messages",
  },
  {
    accessibilityLabel: "选择仅私聊",
    label: "仅私聊",
    value: "dm_only",
  },
];

const agentActionLabel = {
  deploy: "部署",
  restart: "重启",
  start: "启动",
  stop: "停止",
} as const;

const agentObservedStateLabel: Record<Agent["observedState"], string> = {
  deploying: "部署中",
  error: "异常",
  running: "运行中",
  starting: "启动中",
  stopped: "已停止",
  stopping: "停止中",
  unknown: "状态未知",
};

function agentRuntimeStateLabel(agent: Agent): string {
  if (agent.observedState !== "unknown") {
    return agentObservedStateLabel[agent.observedState];
  }
  return "待部署";
}

function agentRuntimeStateTone(
  agent: Agent,
): "danger" | "info" | "neutral" | "positive" | "warning" {
  switch (agent.observedState) {
    case "running":
      return "positive";
    case "error":
      return "danger";
    case "deploying":
    case "starting":
      return "info";
    case "stopping":
      return "warning";
    case "stopped":
    case "unknown":
      return "neutral";
  }
}

const agentReplyPolicyLabel: Record<Agent["replyPolicy"], string> = {
  all_channel_messages: "全部频道消息",
  dm_only: "仅私信",
  mention_and_dm: "提及与私信",
};

const agentImStateLabel: Record<Agent["imState"], string> = {
  error: "连接异常",
  provisioning: "连接中",
  ready: "已连接",
};

const styles = StyleSheet.create((theme) => ({
  choiceBlock: {
    gap: theme.spacing.xs,
  },
  eyebrow: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.eyebrow,
  },
  formGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  headerActions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  lifecycle: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  lifecycleHint: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
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
  rowCopy: {
    flex: 1,
  },
  rowTitle: {
    ...theme.semantic.typography.sectionTitle,
  },
}));
