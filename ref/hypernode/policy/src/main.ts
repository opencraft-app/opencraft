import { Context } from "@deepseek-ai/cordis";
import { AccountService } from "./services/account.js";
import { AccountCatalogService } from "./services/account-catalog.js";
import { AdministratorService } from "./services/administrator.js";
import { AgentCapabilityEgressService } from "./services/agent-capability-egress.ts";
import { AllThreadService } from "./services/all-thread.ts";
import { ConfigService } from "./services/config.js";
import { CodexAccountBindingService } from "./services/codex-account-binding.js";
import { CodexRuntimeAdapterService } from "./services/codex-runtime-adapter.js";
import { CanonicalTimelineService } from "./services/canonical-timeline.js";
import { CredentialService } from "./services/credential.js";
import { CollaborationModeService } from "./services/collaboration-mode.ts";
import { FeatureService } from "./services/feature.ts";
import { DeviceIdentityService } from "./services/device-identity.ts";
import { DurableStorageService } from "./services/durable-storage.js";
import { DshAppServerProjectionService } from "./services/dsh-appserver-projection.js";
import { DshEngineAdapterService } from "./services/dsh-engine-adapter.js";
import { ExecutionEngineService } from "./services/execution-engine.ts";
import { DshNativeSessionStoreService } from "./services/dsh-native-session-store.js";
import { DshRuntimeHostService } from "./services/dsh-runtime-host.ts";
import { TextDeltaPacerService } from "./services/text-delta-pacer.js";
import { DashboardService } from "./services/dashboard.ts";
import { ModelCatalogService } from "./services/model-catalog.js";
import { ModelMetadataService } from "./services/model-metadata.ts";
import { ModelGatewayService } from "./services/model-gateway.js";
import { ModelGatewayIngressService } from "./services/model-gateway-ingress.js";
import { McpRegistryService } from "./services/mcp-registry.ts";
import { CalculatorService } from "./services/calculator.ts";
import { McpAppLauncherService } from "./services/mcp-app-launcher.ts";
import { McpAppBuilderService } from "./services/mcp-app-builder.ts";
import { ThreadPrivacyService } from "./services/thread-privacy.ts";
import { SessionStatusService } from "./services/session-status.ts";
import { ManagementCatalogAppsService } from "./services/management-catalog-apps.ts";
import { SharedCodexService } from "./services/shared-codex.ts";
import { HttpClientService } from "./services/http-client.js";
import { HttpIngressService } from "./services/http-ingress.js";
import { HotUpgradeService } from "./services/hot-upgrade.js";
import { LocalEnvironmentService } from "./services/local-environment.js";
import { OutboundTcpService } from "./services/outbound-tcp.js";
import { VirtualFilesystemService } from "./services/virtual-filesystem.js";
import { VisualizationProjectionService } from "./services/visualization-projection.js";
import { WorkspaceFilesystemService } from "./services/workspace-filesystem.js";
import { WorkspaceViewService } from "./services/workspace-view.js";
import { RuntimeWorkspaceService } from "./services/runtime-workspace.ts";
import { WorkspaceOperationJournalService } from "./services/workspace-operation-journal.js";
import { WorkspaceAttachmentService } from "./services/workspace-attachment.js";
import { WorkspaceDriverService } from "./services/workspace-driver.js";
import { WorkspaceRootService } from "./services/workspace-root.js";
import { FileSystemService } from "./services/file-system.ts";
import { SandboxProcessService } from "./services/sandbox-process.js";
import { ShellCommandClassifierService } from "./services/shell-command-classifier.js";
import { PermissionProfileService } from "./services/permission-profile.ts";
import { PluginService } from "./services/plugin.js";
import { PortForwardService } from "./services/port-forward.js";
import { PrincipalService } from "./services/principal.ts";
import { ProjectCatalogService } from "./services/project-catalog.js";
import { ProjectProjectionService } from "./services/project-projection.js";
import { RootThreadService } from "./services/root-thread.ts";
import { RemoteControlService } from "./services/remote-control.js";
import { ThreadCatalogService } from "./services/thread-catalog.ts";
import { ThreadLifecycleService } from "./services/thread-lifecycle.ts";
import { ThreadManagerService } from "./services/thread-manager.js";
import { ThreadTitleService } from "./services/thread-title.js";
import { ThreadSectionService } from "./services/thread-section.js";
import { ThreadSearchService } from "./services/thread-search.js";
import { ThreadTombstoneService } from "./services/thread-tombstone.js";
import { ThreadExecutionService } from "./services/thread-execution.js";
import { ThreadGoalService } from "./services/thread-goal.ts";
import { ThreadEngineBindingService } from "./services/thread-engine-binding.js";
import { CodexRolloutArtifactStoreService } from "./services/thread-artifact-store.js";
import { ThreadPresentationService } from "./services/thread-presentation.js";
import { ThreadProjectBindingService } from "./services/thread-project-binding.js";
import { ThreadWriteLeaseService } from "./services/thread-write-lease.js";
import { SshInteractiveTerminalService } from "./services/ssh-interactive-terminal.js";
import { TransparentCodexThreadService } from "./services/transparent-codex-thread.js";
import { TransparentProcessBridgeService } from "./services/transparent-process-bridge.ts";
import { TransparentThreadBindingService } from "./services/transparent-thread-binding.ts";
import { TransparentProtocolMapperService } from "./services/transparent-protocol-mapper.ts";
import { TransparentRuntimeRecoveryService } from "./services/transparent-runtime-recovery.ts";
import { TransparentRuntimeLocatorService } from "./services/transparent-runtime-locator.ts";
import { TransparentRuntimeAccessService } from "./services/transparent-runtime-access.ts";
import { TransparentRuntimeRetirementService } from "./services/transparent-runtime-retirement.ts";
import { TransparentConnectionCleanupService } from "./services/transparent-connection-cleanup.ts";
import { TransparentControlRoutingService } from "./services/transparent-control-routing.ts";
import { TransparentBackendChannelService } from "./services/transparent-backend-channel.ts";
import { TransparentBackendProjectionService } from "./services/transparent-backend-projection.ts";
import { TransparentBackendRegistryService } from "./services/transparent-backend-registry.ts";
import { TransparentBackendLifecycleService } from "./services/transparent-backend-lifecycle.ts";
import { TransparentBackendIngressService } from "./services/transparent-backend-ingress.ts";
import { TransparentBackendPumpService } from "./services/transparent-backend-pump.ts";
import { TransparentBackendBootstrapService } from "./services/transparent-backend-bootstrap.ts";
import { TransparentBackendOpenService } from "./services/transparent-backend-open.ts";
import { TransparentHandoffService } from "./services/transparent-handoff.ts";
import { TransparentEngineSwitchService } from "./services/transparent-engine-switch.ts";
import { TransparentAccountEventService } from "./services/transparent-account-event.ts";
import { TransparentRequestRouterService } from "./services/transparent-request-router.ts";
import { TransparentRequestDispatchService } from "./services/transparent-request-dispatch.ts";
import { TransparentModelListService } from "./services/transparent-model-list.ts";
import { TransparentWorkspaceControlService } from "./services/transparent-workspace-control.ts";
import { TransparentTurnExecutionService } from "./services/transparent-turn-execution.ts";
import { TransparentThreadQueueService } from "./services/transparent-thread-queue.ts";
import { TransparentThreadAdmissionService } from "./services/transparent-thread-admission.ts";
import { TransparentThreadSettingsService } from "./services/transparent-thread-settings.ts";
import { TransparentThreadActivationService } from "./services/transparent-thread-activation.ts";
import { TransparentThreadForkService } from "./services/transparent-thread-fork.ts";
import { TransparentOuterQueueService } from "./services/transparent-outer-queue.ts";
import { TransparentOuterDispatchService } from "./services/transparent-outer-dispatch.ts";
import { TransparentBackendMessageService } from "./services/transparent-backend-message.ts";
import {
  TransparentBackendMessageCoordinatorService,
} from "./services/transparent-backend-message-coordinator.ts";
import { TransparentBackendSessionService } from "./services/transparent-backend-session.ts";
import { TransparentBackendOutboundService } from "./services/transparent-backend-outbound.ts";
import { TransparentForwardedResponseService } from "./services/transparent-forwarded-response.ts";
import { TransparentInternalResponseService } from "./services/transparent-internal-response.ts";
import {
  TransparentInternalResponseCoordinatorService,
} from "./services/transparent-internal-response-coordinator.ts";
import { TransparentBackendRpcService } from "./services/transparent-backend-rpc.ts";
import { TransparentSubscriptionService } from "./services/transparent-subscription.ts";
import { RuntimeRegistryService } from "./services/runtime-registry.js";
import { TurnLifecycleService } from "./services/turn-lifecycle.ts";
import { TurnManagerService } from "./services/turn-manager.ts";
import { UserDirectoryService } from "./services/user-directory.js";
import { VirtualSkillService } from "./services/virtual-skill.js";
import { VSSHService } from "./services/vssh.js";
import { installWebCrypto } from "./runtime/web-crypto.ts";
import { installDshQuickJsCompatibility } from "./runtime/dsh-quickjs-compat.js";
import { utf8Encode } from "./runtime/bytes.js";
import { POLICY_CONFIG } from "./config.ts";
import { AppServerVService } from "./services/appserver.ts";
import { AppServerProjectionService } from "./services/appserver-projection.ts";
import { MemoryVFS } from "./services/memory-vfs.ts";
import {
  DirectWebSocketTransportService,
  webSocketVServer,
} from "./services/direct-websocket-transport.ts";
import { createHostPolicy } from "./host-policy.ts";
import { WeComBotService } from "./services/wecom-bot.ts";
import { CodeReviewBotService } from "./services/code-review-bot.ts";

// Hypernode policy executes inside QuickJS. It has no filesystem, process, or network access.
// Go exposes only crypto.* and secrets.verifyPassword().
installWebCrypto();
installDshQuickJsCompatibility();

const context = new Context();
const fibers = [
  context.plugin(MemoryVFS),
  context.plugin(AppServerVService),
  context.plugin(HotUpgradeService),
  context.plugin(VirtualFilesystemService),
  context.plugin(VisualizationProjectionService),
  context.plugin(WorkspaceDriverService),
	context.plugin(WorkspaceAttachmentService),
  context.plugin(WorkspaceFilesystemService),
  context.plugin(DurableStorageService),
  context.plugin(DashboardService),
  context.plugin(LocalEnvironmentService),
  context.plugin(SandboxProcessService),
  context.plugin(FileSystemService, []),
  context.plugin(DeviceIdentityService),
  context.plugin(RemoteControlService),
  context.plugin(AccountService),
  context.plugin(ConfigService),
  context.plugin(ModelMetadataService),
  context.plugin(ModelGatewayService),
  context.plugin(ModelCatalogService),
  context.plugin(CollaborationModeService),
  context.plugin(PermissionProfileService),
  context.plugin(PluginService),
  context.plugin(McpRegistryService),
  context.plugin(FeatureService),
  context.plugin(VirtualSkillService),
  context.plugin(McpAppLauncherService),
  context.plugin(McpAppBuilderService),
  context.plugin(PrincipalService),
  context.plugin(ThreadManagerService),
  context.plugin(ThreadPrivacyService),
  context.plugin(CanonicalTimelineService),
  context.plugin(AppServerProjectionService),
  context.plugin(ThreadSearchService),
  context.plugin(AgentCapabilityEgressService),
  context.plugin(ProjectCatalogService),
  context.plugin(ThreadProjectBindingService),
  context.plugin(ProjectProjectionService),
  context.plugin(ThreadTitleService),
  context.plugin(ThreadSectionService),
  context.plugin(WorkspaceOperationJournalService),
  context.plugin(WorkspaceViewService),
  context.plugin(RuntimeWorkspaceService),
  context.plugin(RootThreadService),
  context.plugin(WorkspaceRootService),
  context.plugin(AllThreadService),
  context.plugin(ThreadTombstoneService),
  context.plugin(ThreadCatalogService),
  context.plugin(ThreadLifecycleService),
  context.plugin(ThreadGoalService),
  context.plugin(TurnManagerService),
  context.plugin(ThreadWriteLeaseService),
  context.plugin(CredentialService),
  context.plugin(ThreadExecutionService),
  context.plugin(ThreadEngineBindingService),
  context.plugin(RuntimeRegistryService),
  context.plugin(CodexRolloutArtifactStoreService),
  context.plugin(CodexRuntimeAdapterService),
  context.plugin(DshRuntimeHostService),
  context.plugin(DshNativeSessionStoreService),
  context.plugin(ShellCommandClassifierService),
  context.plugin(DshAppServerProjectionService),
  context.plugin(TextDeltaPacerService),
  context.plugin(DshEngineAdapterService),
  context.plugin(ExecutionEngineService),
  context.plugin(ThreadPresentationService),
  context.plugin(TransparentBackendRegistryService),
  context.plugin(TransparentBackendLifecycleService),
  context.plugin(TransparentBackendIngressService),
  context.plugin(TransparentBackendPumpService),
  context.plugin(TransparentBackendBootstrapService),
  context.plugin(TransparentBackendOpenService),
  context.plugin(TransparentEngineSwitchService),
  context.plugin(TransparentHandoffService),
  context.plugin(TransparentAccountEventService),
  context.plugin(TransparentRequestRouterService),
  context.plugin(TransparentRequestDispatchService),
  context.plugin(TransparentModelListService),
  context.plugin(TransparentWorkspaceControlService),
  context.plugin(TransparentTurnExecutionService),
  context.plugin(TransparentThreadQueueService),
  context.plugin(TransparentThreadAdmissionService),
  context.plugin(TransparentThreadSettingsService),
  context.plugin(TransparentThreadActivationService),
  context.plugin(TransparentThreadForkService),
  context.plugin(TransparentOuterQueueService),
  context.plugin(TransparentOuterDispatchService),
  context.plugin(TransparentBackendMessageService),
  context.plugin(TransparentBackendMessageCoordinatorService),
  context.plugin(TransparentBackendOutboundService),
  context.plugin(TransparentForwardedResponseService),
  context.plugin(TransparentInternalResponseService),
  context.plugin(TransparentInternalResponseCoordinatorService),
  context.plugin(TransparentBackendSessionService),
  context.plugin(TransparentBackendRpcService),
  context.plugin(TransparentSubscriptionService),
  context.plugin(TransparentThreadBindingService),
  context.plugin(TransparentProtocolMapperService),
  context.plugin(TransparentRuntimeLocatorService),
  context.plugin(TransparentRuntimeAccessService),
  context.plugin(TransparentRuntimeRetirementService),
  context.plugin(TransparentConnectionCleanupService),
  context.plugin(TransparentControlRoutingService),
  context.plugin(TransparentBackendChannelService),
  context.plugin(TransparentBackendProjectionService),
  context.plugin(TransparentRuntimeRecoveryService),
  context.plugin(TransparentProcessBridgeService),
  context.plugin(TransparentCodexThreadService),
  context.plugin(CodexAccountBindingService),
  context.plugin(AccountCatalogService),
  context.plugin(SharedCodexService),
  context.plugin(ManagementCatalogAppsService),
  context.plugin(SessionStatusService),
  context.plugin(TurnLifecycleService),
  context.plugin(UserDirectoryService),
  context.plugin(AdministratorService),
  context.plugin(WeComBotService),
  context.plugin(CodeReviewBotService),
  context.plugin(DirectWebSocketTransportService),
  context.plugin(SshInteractiveTerminalService),
  context.plugin(OutboundTcpService),
  context.plugin(HttpClientService),
  context.plugin(CalculatorService),
  context.plugin(PortForwardService),
  context.plugin(VSSHService),
  context.plugin(ModelGatewayIngressService),
  context.plugin(HttpIngressService),
];
globalThis.hypernodeBootDiagnostics = () => fibers.map((fiber) => ({
  name: fiber.name,
  state: fiber.state,
  missing: Object.keys(fiber.inject ?? {}).filter((name) => fiber.store?.[name] == null),
}));
// Cordis activates injected services through Promise-backed Fibers. The host
// must not accept SSH/app-server traffic until the full dependency graph is
// active; otherwise early requests observe a partially registered protocol.
// Fiber.await() also resolves for a dependency-blocked PENDING Fiber, so
// Promise.all(fibers) is not a readiness barrier. Observe Cordis state changes
// and resolve only after every service is actually ACTIVE.
globalThis.hypernodeBootPromise = new Promise<{ ready: true; fibers: number }>((resolve, reject) => {
  let dispose: (() => void) | null = null;
  const check = () => {
    const failed = fibers.find((fiber) => fiber.state === 3);
    if (failed) {
      dispose?.();
      reject(new Error(`Cordis Fiber failed: ${failed.name}`));
      return;
    }
    if (!fibers.every((fiber) => fiber.state === 2)) return;
    dispose?.();
    resolve({ ready: true, fibers: fibers.length });
  };
  dispose = context.on("internal/status", check);
  check();
});
let servicesSeeded = false;
function services() {
  const vfs = context.vfs;
  const appServer = context.appServer;
  const userDirectory = context.userDirectory;
  const sshInteractiveTerminal = context.sshInteractiveTerminal;
  if (!servicesSeeded) {
    vfs.createDirectory("/workspace/.codex/.tmp/bundled-marketplaces/openai-bundled");
    vfs.createDirectory("/localhost");
    vfs.writeFile(
      "/workspace/.codex/.tmp/bundled-marketplaces/openai-bundled/.materialization-key",
      utf8Encode("hypernode-memory-v1\n"),
    );
    vfs.writeFile(
      `${POLICY_CONFIG.codexHome}/installation_id`,
      utf8Encode(context.deviceIdentity.installationId),
    );
    servicesSeeded = true;
  }
  return { appServer, sshInteractiveTerminal, userDirectory, vfs };
}
webSocketVServer.route("/rpc", (socket, metadata) => services().appServer.attach(socket, metadata));
globalThis.policy = createHostPolicy(context, { ensureServices: services });
