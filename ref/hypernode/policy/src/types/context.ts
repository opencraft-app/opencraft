import type { Context } from "@deepseek-ai/cordis";
import type { DurableStoragePort } from "./storage.js";
import type {
  DshEngineAdapterPort,
  DshRuntimeHostPort,
  EngineRuntimeControlPort,
  ExecutionEnginePort,
} from "./engine.js";
import type {
  DshAppServerProjectionPort,
  ShellCommandClassifierPort,
  ThreadProjectionManagerPort,
  TurnProjectionManagerPort,
} from "./appserver-projection.js";
import type { AppServerProjectionPort } from "./canonical-appserver-projection.js";
import type {
  LocalRuntimeFilesystemPort,
  RootThreadPort,
  RuntimeWorkspacePort,
  WorkspaceAttachmentPort,
  WorkspaceDriverPort,
  WorkspaceRuntimeFilesystemPort,
  WorkspaceThreadManagerPort,
  WorkspaceViewPort,
} from "./workspace.js";
import type {
  AppServerRegistrationPort,
  CanonicalTimelinePort,
  ThreadLookupPort,
} from "./canonical-timeline.js";
import type { MemoryVfsPort } from "./vfs.js";
import type { AppServerRuntimePort } from "./appserver.js";
import type {
  ModelGatewayLifecyclePort,
  PrincipalLifecyclePort,
  ProjectCatalogLifecyclePort,
  ThreadLifecycleManagerPort,
  ThreadMetadataManagerPort,
  ThreadProjectBindingLifecyclePort,
  ThreadTombstoneLifecyclePort,
  ThreadWriteLeaseLifecyclePort,
} from "./thread-lifecycle.js";
import type { TransparentProcessBridgePort } from "./transparent-process.ts";
import type { TransparentThreadBindingPort } from "./transparent-binding.ts";
import type {
  TransparentProtocolMapperPort,
  TransparentProtocolThreadManagerPort,
} from "./transparent-protocol-mapper.ts";
import type {
  RuntimeRegistryPort,
  TransparentRuntimeRecoveryPort,
} from "./transparent-runtime.ts";
import type { TransparentRuntimeAccessPort } from "./transparent-runtime-access.ts";
import type {
  TransparentExecutionLifecyclePort,
  TransparentExecutionLookupPort,
  TransparentRuntimeLocatorPort,
} from "./transparent-runtime-locator.ts";
import type {
  TransparentRuntimeRetirementPort,
} from "./transparent-runtime-retirement.ts";
import type {
  TransparentConnectionCleanupPort,
} from "./transparent-connection-cleanup.ts";
import type { TransparentControlRoutingPort } from "./transparent-control-routing.ts";
import type { TransparentBackendChannelPort } from "./transparent-backend-channel.ts";
import type { TransparentBackendProjectionPort } from "./transparent-backend-projection.ts";
import type { TransparentSubscriptionPort } from "./transparent-subscription.ts";
import type { TransparentAccountEventPort } from "./transparent-account.ts";
import type { TransparentRequestRouterPort } from "./transparent-request.ts";
import type { TransparentRequestDispatchPort } from "./transparent-request-dispatch.ts";
import type { TransparentModelListPort } from "./transparent-model-list.ts";
import type { TransparentWorkspaceControlPort } from "./transparent-workspace-control.ts";
import type { TransparentTurnExecutionPort } from "./transparent-turn-execution.ts";
import type { TransparentThreadQueuePort } from "./transparent-thread-queue.ts";
import type { TransparentThreadAdmissionPort } from "./transparent-thread-admission.ts";
import type { TransparentThreadSettingsPort } from "./transparent-thread-settings.ts";
import type { TransparentThreadActivationPort } from "./transparent-thread-activation.ts";
import type { TransparentThreadForkPort } from "./transparent-thread-fork.ts";
import type { TransparentOuterQueuePort } from "./transparent-outer-queue.ts";
import type { TransparentOuterDispatchPort } from "./transparent-outer-dispatch.ts";
import type { TransparentBackendMessagePort } from "./transparent-backend-message.ts";
import type {
  TransparentBackendMessageCoordinatorPort,
} from "./transparent-backend-message-coordinator.ts";
import type { TransparentBackendOutboundPort } from "./transparent-backend-outbound.ts";
import type { TransparentForwardedResponsePort } from "./transparent-forwarded-response.ts";
import type { TransparentInternalResponsePort } from "./transparent-internal-response.ts";
import type {
  TransparentInternalResponseCoordinatorPort,
} from "./transparent-internal-response-coordinator.ts";
import type { TransparentBackendOpenPort } from "./transparent-open.ts";
import type { TransparentHandoffPort } from "./transparent-handoff.ts";
import type { TransparentEngineSwitchPort } from "./transparent-handoff.ts";
import type { TransparentBackendIngressPort } from "./transparent-ingress.ts";
import type {
  TransparentBackendLifecyclePort,
  TransparentBackendBootstrapPort,
  TransparentBackendPumpPort,
  TransparentBackendRegistryPort,
  TransparentBackendRpcPort,
} from "./transparent-backend.ts";
import type {
  DeviceIdentityPort,
  HostIngressPort,
  HostInteractiveTerminalPort,
  HostTickPort,
  HostUserDirectoryPort,
} from "./host-policy.ts";
import type { CodexRolloutArtifactStorePort } from "./codex-rollout-artifact.ts";
import type { CollaborationModePort, ThreadTitlePort } from "./thread-metadata.ts";
import type { DashboardPort } from "./dashboard.ts";
import type { ModelMetadataPort } from "./model-metadata.ts";
import type {
  SystemThreadPort,
  ThreadCatalogManagerPort,
  ThreadCatalogProjectBindingPort,
} from "./thread-catalog.ts";
import type { VirtualSkillPort } from "./virtual-skill.ts";
import type { AdministratorPort, ThreadSearchPort } from "./administrator.ts";
import type { CredentialPort } from "./credential.ts";
import type { ModelCatalogPort } from "./model-catalog.ts";
import type { ThreadEngineBindingPort } from "../services/thread-engine-binding.ts";
import type { DshNativeSessionStorePort } from "./dsh-native-session.ts";
import type { TransparentBackendSessionPort } from "./transparent-backend-session.ts";
import type {
  AccountCatalogPort,
  CodexAccountBindingPort,
  RemoteControlStatusPort,
} from "./account-config.ts";
import type { SharedCodexPort } from "./shared-codex.ts";
import type { ProtocolAuditPort } from "./protocol-audit.ts";
import type { VisualizationProjectionPort } from "./visualization.ts";
import type { HttpClientPort, OutboundTcpPort, PortForwardPort } from "./network.ts";
import type { RuntimePluginPort } from "./hot-upgrade.ts";
import type { AgentCapabilityEgressPort } from "./agent-capability.ts";
import type { ThreadGoalPort } from "./thread-goal.ts";
import type { McpRegistryPort } from "./mcp.ts";
import type { McpAppBuilderPort } from "./mcp-app-builder.ts";
import type { ThreadPrivacyPort } from "./thread-privacy.ts";
import type { CodeReviewBotPort, WeComBotPort } from "./wecom-bot.ts";

/**
 * Compile-time service catalog for the HyperNode Cordis graph.
 *
 * Every migrated service adds its public port here.  A constructor requests
 * only the keys in its static `inject` declaration, which keeps Cordis hot
 * replacement while making misspelled or undeclared dependencies fail tsc.
 */
export interface HypernodeServices {
  agentCapabilityEgress: AgentCapabilityEgressPort;
  administrator: AdministratorPort;
  accountCatalog: AccountCatalogPort;
  appServer: AppServerRegistrationPort & AppServerRuntimePort;
  appServerProjection: AppServerProjectionPort;
  allThread: SystemThreadPort;
  canonicalTimeline: CanonicalTimelinePort;
  collaborationMode: CollaborationModePort;
  codexAccountBinding: CodexAccountBindingPort;
  codexRuntimeAdapter: EngineRuntimeControlPort;
  dshEngineAdapter: DshEngineAdapterPort;
  dshNativeSessionStore: DshNativeSessionStorePort;
  dshRuntimeHost: DshRuntimeHostPort;
  executionEngine: ExecutionEnginePort;
  dshAppServerProjection: DshAppServerProjectionPort;
  dashboard: DashboardPort;
  deviceIdentity: DeviceIdentityPort;
  httpIngress: HostIngressPort;
  httpClient: HttpClientPort;
  modelGateway: ModelGatewayLifecyclePort;
  modelCatalog: ModelCatalogPort;
  modelMetadata: ModelMetadataPort;
  mcpRegistry: McpRegistryPort;
  mcpAppBuilder: McpAppBuilderPort;
  credential: CredentialPort;
  principal: PrincipalLifecyclePort;
  protocolAudit: ProtocolAuditPort;
  projectCatalog: ProjectCatalogLifecyclePort;
  rootThread: RootThreadPort;
  outboundTcp: HostTickPort & OutboundTcpPort;
  portForward: PortForwardPort;
  remoteControl: HostTickPort & RemoteControlStatusPort;
  runtimePlugins: RuntimePluginPort;
  shellCommandClassifier: ShellCommandClassifierPort;
  storage: DurableStoragePort;
  sshInteractiveTerminal: HostInteractiveTerminalPort;
  textDeltaPacer: HostTickPort;
  threadSearch: HostTickPort & ThreadSearchPort;
  transparentProcessBridge: TransparentProcessBridgePort;
  transparentAccountEvent: TransparentAccountEventPort;
  transparentRequestRouter: TransparentRequestRouterPort;
  transparentRequestDispatch: TransparentRequestDispatchPort;
  transparentModelList: TransparentModelListPort;
  transparentWorkspaceControl: TransparentWorkspaceControlPort;
  transparentTurnExecution: TransparentTurnExecutionPort;
  transparentThreadQueue: TransparentThreadQueuePort;
  transparentThreadAdmission: TransparentThreadAdmissionPort;
  transparentThreadSettings: TransparentThreadSettingsPort;
  transparentThreadActivation: TransparentThreadActivationPort;
  transparentThreadFork: TransparentThreadForkPort;
  transparentOuterQueue: TransparentOuterQueuePort;
  transparentOuterDispatch: TransparentOuterDispatchPort;
  transparentBackendMessage: TransparentBackendMessagePort;
  transparentBackendMessageCoordinator: TransparentBackendMessageCoordinatorPort;
  transparentBackendSession: TransparentBackendSessionPort;
  transparentBackendOutbound: TransparentBackendOutboundPort;
  transparentForwardedResponse: TransparentForwardedResponsePort;
  transparentInternalResponse: TransparentInternalResponsePort;
  transparentInternalResponseCoordinator: TransparentInternalResponseCoordinatorPort;
  transparentBackendLifecycle: TransparentBackendLifecyclePort;
  transparentBackendOpen: TransparentBackendOpenPort;
  transparentHandoff: TransparentHandoffPort;
  transparentEngineSwitch: TransparentEngineSwitchPort;
  transparentBackendBootstrap: TransparentBackendBootstrapPort;
  transparentBackendPump: TransparentBackendPumpPort;
  transparentBackendIngress: TransparentBackendIngressPort;
  transparentBackendRegistry: TransparentBackendRegistryPort;
  transparentBackendRpc: TransparentBackendRpcPort;
  transparentThreadBinding: TransparentThreadBindingPort;
  transparentProtocolMapper: TransparentProtocolMapperPort;
  transparentRuntimeLocator: TransparentRuntimeLocatorPort;
  transparentRuntimeRetirement: TransparentRuntimeRetirementPort;
  transparentConnectionCleanup: TransparentConnectionCleanupPort;
  transparentControlRouting: TransparentControlRoutingPort;
  transparentBackendChannel: TransparentBackendChannelPort;
  transparentBackendProjection: TransparentBackendProjectionPort;
  transparentRuntimeRecovery: TransparentRuntimeRecoveryPort;
  transparentRuntimeAccess: TransparentRuntimeAccessPort;
  transparentSubscription: TransparentSubscriptionPort;
  threadManager: ThreadLookupPort & WorkspaceThreadManagerPort & ThreadProjectionManagerPort &
    ThreadLifecycleManagerPort & ThreadMetadataManagerPort & TransparentProtocolThreadManagerPort &
    ThreadCatalogManagerPort;
  threadTitle: ThreadTitlePort;
  threadExecution: TransparentExecutionLookupPort & TransparentExecutionLifecyclePort;
  threadEngineBinding: ThreadEngineBindingPort;
  threadGoal: ThreadGoalPort;
  threadArtifactStore: CodexRolloutArtifactStorePort;
  threadProjectBinding: ThreadProjectBindingLifecyclePort & ThreadCatalogProjectBindingPort;
  threadPrivacy: ThreadPrivacyPort;
  threadTombstone: ThreadTombstoneLifecyclePort;
  threadWriteLease: ThreadWriteLeaseLifecyclePort;
  turnManager: TurnProjectionManagerPort;
  vfs: MemoryVfsPort;
  workspaceAttachment: WorkspaceAttachmentPort;
  workspaceDriver: WorkspaceDriverPort;
  workspaceFilesystem: WorkspaceRuntimeFilesystemPort;
  virtualFilesystem: LocalRuntimeFilesystemPort;
  workspaceView: WorkspaceViewPort;
  runtimeWorkspace: RuntimeWorkspacePort;
  runtimeRegistry: RuntimeRegistryPort;
  userDirectory: HostUserDirectoryPort;
  sharedCodex: SharedCodexPort;
  virtualSkills: VirtualSkillPort;
  visualizationProjection: VisualizationProjectionPort;
  wecomBot: WeComBotPort;
  codeReviewBot: CodeReviewBotPort;
}

declare module "@deepseek-ai/cordis" {
  interface Context extends HypernodeServices {}
}

export type HypernodeContext<
  Keys extends keyof HypernodeServices = keyof HypernodeServices,
> = Context & Pick<HypernodeServices, Keys>;
