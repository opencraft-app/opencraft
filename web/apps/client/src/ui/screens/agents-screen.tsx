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
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";
import Bot from "lucide-react-native/icons/bot";
import Check from "lucide-react-native/icons/check";
import Plus from "lucide-react-native/icons/plus";

import {ManagementEmptyState} from "../components/management-empty-state";
import {
  CollectionIdentityMark,
  CollectionRow,
  CollectionRowCopy,
  DetailSection,
  ManagementDetailCanvas,
      ManagementDetailScroll,
      ManagementField,
      ManagementForm,
      ManagementFormFooter,
  ManagementHeader,
  ManagementHeaderActions,
  ResourceIdentityHeader,
  ManagementResourceDirectory,
  ManagementResourceSelect,
  ManagementStage,
  ManagementTextInput,
  ResourceActionRow,
  ManagementCollectionFooterAction,
} from "../components/management-workspace";
import {SystemButton} from "../primitives/system-button";
import {SystemFeedback} from "../primitives/system-feedback";
import {SystemDialog} from "../primitives/system-dialog";
import {SystemToggleRow} from "../primitives/system-switch";
import {SystemSegmentedControl} from "../primitives/system-segmented-control";
import {SystemSelectField} from "../primitives/system-select-field";
import {
  buildManagementShellModel,
  ManagementPresentation,
  type ManagementPageModel,
  type PresentationAction,
  type PresentationForm,
} from "../presentation";
import {
  agentActionLabel,
  agentListItemViewModel,
  agentReplyPolicyLabel,
  agentRuntimeStateLabel,
} from "../presentation/resources/agent";
import type { PlatformFrameProps } from "../layouts/app-frame";
import { ManagementScreenFrame } from "../layouts/management-screen-frame";
import type { WorkspaceSection } from "../layouts/workspace-section";
import {agentEmptyCopy} from "../management-empty-copy";
import { managementSurfaceLayout } from "../management-surface-layout";
import {
  OperationStatusList,
  type OperationStatusItem,
} from "../components/operation-status-list";

const agentHandlePattern = /^[a-z0-9][a-z0-9_-]{1,31}$/u;
type AgentCreateStep = 1 | 2 | 3;

export interface AgentsScreenProps {
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
  onCreateAgent(
    input: CreateAgentInput,
    options: {deployAndStart: boolean},
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
    framed = true,
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
  const surface = managementSurfaceLayout(resolvedViewportWidth);
  const {density, phone, stackedCollection} = surface;
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
  const [createStep, setCreateStep] = useState<AgentCreateStep>(1);
  const [createDeployAndStart, setCreateDeployAndStart] = useState(true);
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
  const resetCreateForm = () => {
    setCreateComputerId(undefined);
    setCreateDisplayName("");
    setCreateHandle("");
    setCreateReplyPolicy("mention_and_dm");
    setCreateRuntime("codex");
    setCreateStep(1);
    setCreateDeployAndStart(true);
  };
  const createHandleValid = agentHandlePattern.test(createHandle.trim());
  const createIdentityReady =
    createDisplayName.trim().length > 0 && createHandleValid;
  const createEnvironmentReady = Boolean(createComputerId);
  const submitNewAgent = async (
    input: CreateAgentInput,
    options: {deployAndStart: boolean},
  ) => {
    const accepted = await onCreateAgent(input, options);
    if (!accepted) return;
    setSelectedAgentId(accepted.resourceId);
    setCreating(false);
    resetCreateForm();
  };
  const cancelNewAgent = () => {
    setCreating(false);
    resetCreateForm();
  };
  const agentItems = agents.map(agent => ({
    resource: agent,
    view: agentListItemViewModel(agent, agent.id === selected?.id),
  }));
  const selectedAgentItem = selected
    ? agentItems.find(item => item.resource.id === selected.id)
    : undefined;

  const desktopNavigation = (
    <ManagementResourceDirectory
      eyebrow={`${agents.length} 个 Agent`}
      footer={agents.length > 0 && !stackedCollection ? (
        canManage ? (
          <ManagementCollectionFooterAction
            accessibilityLabel="从侧栏新建 Agent"
            icon={Plus}
            label="新建 Agent"
            onPress={() => setCreating(true)}
          />
        ) : null
      ) : null}
      horizontal={stackedCollection}
      icon={Bot}
      testID="agent-sidebar"
      title="Agent"
    >
      {agentItems.map(({resource: agent, view}) => {
        return (
          <CollectionRow
            accessibilityLabel={view.accessibilityLabel}
            key={view.id}
            onPress={() => setSelectedAgentId(agent.id)}
            orientation={stackedCollection ? "horizontal" : "vertical"}
            selected={view.selected}
          >
            <CollectionIdentityMark
              identityKind="agent"
              monogram={view.monogram}
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
      accessibilityLabel={`切换 Agent，当前 ${selected.handle}`}
      currentContent={(
        <>
        <CollectionIdentityMark
          identityKind="agent"
          monogram={selectedAgentItem!.view.monogram}
          presence={{
            label: selectedAgentItem!.view.status,
            tone: selectedAgentItem!.view.tone,
          }}
        />
        <CollectionRowCopy
          meta={selectedAgentItem!.view.meta}
          numberOfLines={1}
          title={selectedAgentItem!.view.title}
        />
        </>
      )}
      onChange={setSelectedAgentId}
      onOpenChange={setSwitcherOpen}
      open={switcherOpen}
      options={agentItems.map(({resource: agent, view}) => ({
          accessibilityLabel: view.accessibilityLabel,
          label: view.title,
          value: agent.id,
        }))}
      testID="agent-mobile-switcher"
      value={selected.id}
    />
  ) : null;

  const assignableComputers = computers.filter(
    (item) =>
      item.lifecycleState === "active" && item.connectionState === "online",
  );
  const createAction: PresentationAction = {
    disabled: !canManage || pendingAction !== null,
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
      items: agentItems.map(({resource, view}) => ({
        id: view.id,
        meta: view.meta,
        onSelect: () => setSelectedAgentId(resource.id),
        selected: view.selected,
        status: view.status,
        subtitle: view.subtitle,
        title: view.title,
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
                label: createStep === 1 ? "取消" : "上一步",
                run: () => {
                  if (createStep === 1) cancelNewAgent();
                  else setCreateStep((createStep - 1) as AgentCreateStep);
                },
              },
              createStep < 3
                ? {
                    disabled:
                      pendingAction !== null ||
                      (createStep === 1
                        ? !createIdentityReady
                        : !createEnvironmentReady),
                    id: "continue-create-agent",
                    kind: "primary" as const,
                    label: "继续",
                    run: () =>
                      setCreateStep((createStep + 1) as AgentCreateStep),
                  }
                : {
                    disabled:
                      pendingAction !== null ||
                      !createIdentityReady ||
                      !createEnvironmentReady,
                    id: "submit-create-agent",
                    kind: "primary" as const,
                    label: createDeployAndStart ? "创建并启动" : "创建 Agent",
                    run: () =>
                      submitNewAgent(
                        {
                          computerId: createComputerId!,
                          displayName: createDisplayName.trim(),
                          handle: createHandle.trim(),
                          replyPolicy: createReplyPolicy,
                          runtime: {kind: createRuntime},
                        },
                        {deployAndStart: createDeployAndStart},
                      ),
                  },
            ],
            fields:
              createStep === 1
                ? [
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
                      id: "agent-reply-policy",
                      label: "回复策略",
                      onChange: value =>
                        setCreateReplyPolicy(value as Agent["replyPolicy"]),
                      options: replyPolicies.map(option => ({
                        label: option.label,
                        value: option.value,
                      })),
                      value: createReplyPolicy,
                    },
                  ]
                : createStep === 2
                  ? [
                      {
                        disabled: pendingAction !== null,
                        id: "agent-runtime",
                        label: "Runtime",
                        onChange: value =>
                          setCreateRuntime(value as Agent["runtime"]["kind"]),
                        options: runtimeKinds.map(value => ({
                          label: value,
                          value,
                        })),
                        value: createRuntime,
                      },
                      {
                        disabled: pendingAction !== null,
                        id: "agent-computer",
                        label: "Computer",
                        onChange: value =>
                          setCreateComputerId(value || undefined),
                        options: assignableComputers.map(item => ({
                          label: item.name,
                          value: item.id,
                        })),
                        value: createComputerId ?? "",
                      },
                    ]
                  : [
                      {
                        disabled: pendingAction !== null,
                        id: "agent-deploy-and-start",
                        label: "部署并启动",
                        onChange: value =>
                          setCreateDeployAndStart(value === "true"),
                        options: [
                          {label: "是", value: "true"},
                          {label: "否", value: "false"},
                        ],
                        value: createDeployAndStart ? "true" : "false",
                      },
                    ],
            title:
              createStep === 1
                ? "它叫什么"
                : createStep === 2
                  ? "跑在哪台 Computer"
                  : "创建后自动完成",
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
              description: agentEmptyCopy.description,
              title: agentEmptyCopy.title,
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
    shell: buildManagementShellModel({
      accountLabel: currentAccount?.displayName ?? currentAccount?.email,
      activeSection: "agents",
      canManageServer: canManage,
      currentServerId,
      ...(onLogout ? {onLogout} : {}),
      onNavigateSection,
      onSelectServer,
      servers,
    }),
  });

  const navigation = stackedCollection ? null : desktopNavigation;
  const renderStage = (pageModel: ManagementPageModel) => (
    <ManagementStage>
      <ManagementHeader
        actions={(
          <ManagementHeaderActions
            createAccessibilityLabel="新建 Agent"
            createIconTestID="agent-create-icon"
            createLabel="新建"
            createVisible={canManage && agents.length > 0 && !creating}
            onCreate={() => setCreating(true)}
            onRefresh={onRefresh}
            refreshAccessibilityLabel="刷新 Agent"
            refreshDisabled={loading}
            refreshTestID="agent-refresh-icon"
          />
        )}
        title={pageModel.header.title}
        titleTestID="agent-stage-title"
      />
      {pageModel.error ? (
        <SystemFeedback kind="inline" message={pageModel.error} tone="danger" />
      ) : null}
      {agents.length > 1 && !creating
        ? phone
          ? mobileNavigation
          : showStackedCollection
            ? desktopNavigation
            : null
        : null}
      <ManagementDetailScroll
        density={density}
        testID="agent-detail-scroll"
      >
        {creating ? (
          <AgentCreateForm
            computerId={createComputerId}
            computers={assignableComputers}
            deployAndStart={createDeployAndStart}
            disabled={pendingAction !== null}
            displayName={createDisplayName}
            form={pageModel.form!}
            handle={createHandle}
            onNavigateComputers={() => onNavigateSection("computers")}
            replyPolicy={createReplyPolicy}
            runtime={createRuntime}
            step={createStep}
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
            actionAccessibilityLabel={
              canManage ? "从空状态新建 Agent" : undefined
            }
            actionLabel={canManage ? pageModel.empty?.action?.label : undefined}
            description={
              canManage
                ? pageModel.empty?.description ?? agentEmptyCopy.description
                : "还没有可用 Agent，请联系 Server Owner 或 Admin 创建。"
            }
            icon={Bot}
            onAction={canManage ? () => setCreating(true) : undefined}
            title={pageModel.empty?.title ?? agentEmptyCopy.title}
          />
        )}
      </ManagementDetailScroll>
    </ManagementStage>
  );

  return (
    <ManagementPresentation model={semanticModel}>
      {(pageModel) => (
        <ManagementScreenFrame
          account={currentAccount}
          activeSection="agents"
          canManageServer={canManage}
          currentServerId={currentServerId}
          framed={framed}
          imStatus={imStatus}
          navigation={navigation}
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
      )}
    </ManagementPresentation>
  );
}

function AgentCreateForm({
  computerId,
  computers,
  deployAndStart,
  disabled,
  displayName,
  form,
  handle,
  onNavigateComputers,
  replyPolicy,
  runtime,
  step,
}: {
  computerId: string | undefined;
  computers: Computer[];
  deployAndStart: boolean;
  disabled: boolean;
  displayName: string;
  form: PresentationForm;
  handle: string;
  onNavigateComputers(): void;
  replyPolicy: Agent["replyPolicy"];
  runtime: Agent["runtime"]["kind"];
  step: AgentCreateStep;
}) {
  const {theme} = useUnistyles();
  const primaryAction = form.actions.find(action => action.kind === "primary")!;
  const navigationAction = form.actions.find(action => action.kind !== "primary")!;
  const field = (id: string) => form.fields.find(item => item.id === id);
  const normalizedHandle = handle.trim();
  const handleValid = agentHandlePattern.test(normalizedHandle);
  const selectedComputerName =
    computers.find((item) => item.id === computerId)?.name ?? "未选择";
  const stepCopy = {
    1: {
      description: "显示名用于聊天里被 @；Handle 是稳定短名",
      title: "它叫什么",
    },
    2: {
      description: "Agent 需要一台已纳管的 Computer 来安装运行时",
      title: "跑在哪台 Computer",
    },
    3: {
      description: "默认部署并启动，创建完就能用",
      title: "创建后自动完成",
    },
  } as const;

  return (
    <ManagementForm testID="agent-create-form">
      <View style={styles.wizardSteps} testID="agent-create-steps">
        {(["身份", "运行环境", "启动"] as const).map((label, index) => {
          const value = (index + 1) as 1 | 2 | 3;
          const complete = step > value;
          const active = step === value;
          return (
            <View key={label} style={styles.wizardStepItem}>
              {index > 0 ? <View style={styles.wizardStepRule} /> : null}
              <View
                style={[
                  styles.wizardStepBadge,
                  (active || complete) && styles.wizardStepBadgeActive,
                ]}
              >
                {complete ? (
                  <Check
                    color={theme.semantic.color.iconInverse}
                    size={theme.semantic.icon.size.compact}
                    strokeWidth={theme.semantic.icon.stroke.emphasis}
                  />
                ) : (
                  <Text
                    style={[
                      styles.wizardStepBadgeText,
                      active && styles.wizardStepBadgeTextActive,
                    ]}
                  >
                    {value}
                  </Text>
                )}
              </View>
              <Text
                style={[
                  styles.wizardStepLabel,
                  active && styles.wizardStepLabelActive,
                ]}
              >
                {label}
              </Text>
            </View>
          );
        })}
      </View>

      <View style={styles.wizardIntro}>
        <Text style={styles.wizardTitle}>{stepCopy[step].title}</Text>
        <Text style={styles.wizardDescription}>
          {stepCopy[step].description}
        </Text>
      </View>

      {step === 1 ? (
        <>
          <View style={styles.formGrid}>
            <ManagementField label="显示名称" layout="flex">
              <ManagementTextInput
                accessibilityLabel="Agent 显示名"
                editable={!field("agent-display-name")?.disabled}
                onChangeText={field("agent-display-name")!.onChange}
                placeholder="例如：交付助手"
                value={field("agent-display-name")!.value}
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
                editable={!field("agent-handle")?.disabled}
                invalid={handle.length > 0 && !handleValid}
                onChangeText={field("agent-handle")!.onChange}
                placeholder="delivery"
                value={field("agent-handle")!.value}
              />
            </ManagementField>
          </View>
          <ManagementField label="回复策略">
            <SystemSegmentedControl
              accessibilityLabel="回复策略"
              onChange={field("agent-reply-policy")!.onChange}
              options={replyPolicies}
              value={replyPolicy}
            />
          </ManagementField>
          <View style={styles.wizardFooter}>
            <ManagementFormFooter
              cancelAction={{
                accessibilityLabel: "取消新建 Agent",
                label: navigationAction.label,
                onPress: navigationAction.run,
              }}
              primaryAction={{
                disabled: primaryAction.disabled,
                label: primaryAction.label,
                onPress: primaryAction.run,
              }}
            />
          </View>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <ManagementField label="Runtime">
            <SystemSegmentedControl
              accessibilityLabel="Runtime"
              onChange={field("agent-runtime")!.onChange}
              options={runtimeKinds.map((value) => ({
                accessibilityLabel: `选择 ${value}`,
                label: value,
                value,
              }))}
              value={runtime}
            />
          </ManagementField>
          {computers.length > 0 ? (
            <ManagementField label="Computer">
              <SystemSelectField
                accessibilityLabel="Computer"
                onChange={field("agent-computer")!.onChange}
                options={computers.map((computer) => ({
                  accessibilityLabel: `绑定 Computer ${computer.name}`,
                  label: computer.name,
                  value: computer.id,
                }))}
                overlayId="agent-create-computer-listbox"
                placeholder="选择 Computer"
                value={computerId || null}
              />
            </ManagementField>
          ) : (
            <View style={styles.wizardNotice}>
              <Text style={styles.wizardCheckTitle}>还没有可用 Computer</Text>
              <Text style={styles.wizardDescription}>
                先纳管一台 Computer，再回来创建 Agent。
              </Text>
              <SystemButton
                accessibilityLabel="先去纳管一台 Computer"
                variant="accentedSecondary"
                label="先去纳管一台 Computer"
                onPress={onNavigateComputers}
              />
            </View>
          )}
          <View style={styles.wizardFooter}>
            <ManagementFormFooter
              backAction={{
                label: navigationAction.label,
                onPress: navigationAction.run,
              }}
              primaryAction={{
                disabled: primaryAction.disabled,
                label: primaryAction.label,
                onPress: primaryAction.run,
              }}
            />
          </View>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <Text style={styles.wizardSummary} testID="agent-create-summary">
            {displayName.trim()} · @{normalizedHandle} · {runtime} ·{" "}
            {selectedComputerName}
          </Text>
          <SystemToggleRow
            checked={deployAndStart}
            description={deployAndStart
              ? "装到所选 Computer 并上线，创建后即可在 Channel 里 @"
              : "只保存档案，稍后再手动部署"}
            disabled={disabled}
            label="部署并启动"
            onChange={(checked) =>
              field("agent-deploy-and-start")?.onChange(String(checked))}
            testID="agent-create-deploy-start"
          />
          <View style={styles.wizardFooter}>
            <ManagementFormFooter
              backAction={{
                label: navigationAction.label,
                onPress: navigationAction.run,
              }}
              primaryAction={{
                disabled: primaryAction.disabled,
                label: primaryAction.label,
                onPress: primaryAction.run,
              }}
            />
          </View>
        </>
      ) : null}
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
              <SystemButton
                accessibilityLabel={`${agentActionLabel[action]} Agent ${agent.handle}`}
                disabled={actionDisabled}
                variant={
                  actionDisabled || action === "stop"
                    ? "secondary"
                    : "accentedSecondary"
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
        <ManagementField label="Runtime">
          <SystemSegmentedControl
            accessibilityLabel="Runtime"
            disabled={disabled}
            onChange={(value) =>
              onChangeRuntime(value as Agent["runtime"]["kind"])
            }
            options={runtimeKinds.map((value) => ({
              accessibilityLabel: `编辑 Runtime ${value}`,
              label: value,
              value,
            }))}
            value={runtime}
          />
        </ManagementField>
        <ManagementField label="回复策略">
          <SystemSegmentedControl
            accessibilityLabel="回复策略"
            disabled={disabled}
            onChange={(value) =>
              onChangeReplyPolicy(value as Agent["replyPolicy"])
            }
            options={replyPolicies.map((option) => ({
              ...option,
              accessibilityLabel: `编辑${option.accessibilityLabel}`,
            }))}
            value={replyPolicy}
          />
        </ManagementField>
        <ManagementField label="Computer">
          <SystemSelectField
            accessibilityLabel="Computer"
            disabled={disabled}
            onChange={onChangeComputerId}
            options={computers.map((item) => ({
              accessibilityLabel: `编辑绑定 Computer ${item.name}`,
              label: item.name,
              value: item.id,
            }))}
            overlayId={`agent-${agent.id}-computer-listbox`}
            placeholder="选择 Computer"
            value={computerId || null}
          />
        </ManagementField>
        <SystemButton
          disabled={disabled || displayName.trim().length === 0 || !computerId}
          variant="default"
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
            action={(
              <SystemButton
                accessibilityLabel={`轮换 Agent ${agent.handle} 的运行凭证`}
                disabled={disabled || !canRotate || !onRotateCredential}
                variant="secondary"
                label="轮换凭证"
                onPress={onStartRotation}
              />
            )}
            description={!canRotate
              ? `当前版本 ${agent.credentialVersion}。请先停止 Agent，并确认它已绑定在线 Computer。`
              : `当前版本 ${agent.credentialVersion}。轮换后需要显式启动 Agent。`}
            testID="agent-credential-section"
            title="运行凭证"
          />
          {onDeleteAgent ? (
            <ResourceActionRow
              action={(
                <SystemButton
                  accessibilityLabel={`删除 Agent ${agent.handle}`}
                  disabled={disabled}
                  variant="destructive"
                  label="删除 Agent"
                  onPress={onStartDeletion}
                />
              )}
              description="删除 Agent 身份、运行凭证和腾讯 IM 登录；保留工作区与历史消息。"
              testID="agent-delete-section"
              title="危险操作"
            />
          ) : null}
        </DetailSection>
      ) : null}
      {confirmingRotation ? (
        <SystemDialog
          actions={[
            {id: "cancel", intent: "secondary", kind: "cancel", label: "取消"},
            {
              disabled,
              id: "confirm",
              intent: "default",
              kind: "action",
              label: "确认轮换",
            },
          ]}
          busy={disabled}
          description="安装成功后新凭证会原子激活，并撤销旧凭证；随后需要显式启动 Agent。"
          dialogId={`rotate-agent-${agent.id}-dialog`}
          onAction={id => {
            if (id === "confirm") void onConfirmRotation();
          }}
          onOpenChange={onCancelRotation}
          open
          title="安装成功前旧凭证仍有效"
        />
      ) : null}
      {confirmingDeletion ? (
        <SystemDialog
          actions={[
            {id: "cancel", intent: "secondary", kind: "cancel", label: "取消"},
            {
              disabled,
              id: "confirm",
              intent: "destructive",
              kind: "action",
              label: "确认删除",
            },
          ]}
          busy={disabled}
          description="Computer 和 TAT 不会停止，其他 Agent 不受影响。Agent 的工作区和历史消息会保留。"
          dialogId={`delete-agent-${agent.id}-dialog`}
          onAction={id => {
            if (id === "confirm") void onConfirmDeletion();
          }}
          onOpenChange={onCancelDeletion}
          open
          title={`删除 ${agent.displayName}？`}
        />
      ) : null}
    </ManagementDetailCanvas>
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

const styles = StyleSheet.create((theme) => ({
  formGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
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
  wizardCheckTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
  },
  wizardDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  wizardFooter: {
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    marginTop: theme.spacing.xs,
    paddingTop: theme.spacing.md,
  },
  wizardIntro: {
    gap: theme.spacing.xxs,
  },
  wizardNotice: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderRadius: theme.semantic.radius.control,
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
  },
  wizardStepBadge: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.iconControl.microSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.microSize,
  },
  wizardStepBadgeActive: {
    backgroundColor: theme.semantic.color.actionPrimarySurface,
  },
  wizardStepBadgeText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.micro,
  },
  wizardStepBadgeTextActive: {
    color: theme.semantic.color.actionPrimaryText,
  },
  wizardStepItem: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.xs,
  },
  wizardStepLabel: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  wizardStepLabelActive: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  wizardStepRule: {
    backgroundColor: theme.semantic.color.separator,
    height: theme.semantic.stroke.hairline,
    marginRight: theme.spacing.xs,
    width: theme.spacing.lg,
  },
  wizardSteps: {
    alignItems: "center",
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
  },
  wizardSummary: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  wizardTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.workspaceTitle,
  },
}));
