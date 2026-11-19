import { installWorkspaceBrowserRouting } from './assets/workspace-browser-composition.mjs';
import { createOwnedWorkspaceAuthority } from './assets/workspace-authority-owner.ts';
import { InstalledSandboxBudget } from './assets/installed-sandbox-budget.ts';
import { OrdinaryWorkspaceServices } from './assets/ordinary-workspace-services.ts';
import { migrateInstalledSandboxConfiguration } from "./assets/installed-sandbox-config.ts";
import { createIoaNotificationDefaultTarget } from './plugins/tencentoa/src/notification-defaults.mjs';
import { withTencentOaModelDefaults } from './plugins/tencentoa/src/model-defaults-composition.mjs';
import { loadRuntimePlugins, runtimePluginDirectory } from './runtime-plugins/host.mjs';
import { rtxReservationClaim } from './plugins/tencentoa/src/rtx-directory.mjs';
import {createNativeMemberOwnerDirectory} from './plugins/tencentoa/src/native-member-owner-directory.mjs';
import { avatarProfiles } from './plugins/tencentoa/src/avatar-profiles.mjs';
import { TencentOaServerPlugin, TencentOaParticipants } from './plugins/tencentoa/src/server.ts';
import { TENCENTOA_SESSION_PATH, TENCENTOA_PHOTO_PATH, TENCENTOA_ENVIRONMENT_PATH, TENCENTOA_MODEL_DEFAULTS_PATH } from './plugins/tencentoa/src/contract.ts';
import { EmployeeGitVaultStore } from '../../scripts/employee-git-vault-store.ts';
import { AccountEnvironment } from '../../scripts/account-environment.ts';
import { AccountEnvironmentHttp } from '../../scripts/account-environment-http.ts';
import { ExecutionEnvironmentRuntime } from '../../scripts/execution-environment.ts';
import { createIoaCapabilities } from './plugins/tencentoa/src/instance-capabilities.mjs';
import { SandboxConfigurations } from './assets/sandbox-configurations.ts';
import { SANDBOX_CONFIG_PATH } from './assets/contract.ts';
import { createConfiguredSandboxProviders } from './assets/sandbox-providers.mjs';
import { GIT_CREDENTIALS_PATH } from './plugins/tencentoa/src/git-credentials-contract.ts';

export function joinIdentityComposition({pluginSourceFactory}={}) {
  let access,memberDirectory,ordinaryWorkspaces;
  return withTencentOaModelDefaults({
    restoreCodexProvisionalWorkspace(input) {
      if (!ordinaryWorkspaces) throw Error('Ordinary workspace services unavailable');
      return ordinaryWorkspaces.restoreProvisional({ ...input, hostId: 'local-codex' });
    },
    selectHostFiles(hostId, context, params, local) {
      if (!ordinaryWorkspaces) {
        if (params && typeof params === 'object' && Object.hasOwn(params, 'workspaceThreadId'))
          throw Error('Ordinary workspace services unavailable');
        return local(context, params);
      }
      return ordinaryWorkspaces.selectFiles(hostId, context, params, local);
    },
    selectHostTerminalService(hostId, scope, context, local) {
      if (!ordinaryWorkspaces) return local(scope, context);
      return ordinaryWorkspaces.selectTerminal(hostId, scope, context, local);
    },
    resolveNativeMemberRtx(subject) {
      return memberDirectory?.lookup(subject)??null;
    },
    // Verified Relay directory claims may prepare the existing policy decision;
    // this never registers an Actor or grants membership.
    async prepareDirectoryIdentity(principal) {
      if (principal?.provider !== 'tencentoa' || principal.expiresAt <= Date.now()) return;
      await access?.()?.admissionPolicy?.prepare(principal);
    },
    async createIdentity({ dataDirectory, hubAuthority, resolveIdentity, getInstanceAccess, actors, machineIdentity, sshIngressEnabled, workspaceExecution }) {
      access = getInstanceAccess;
      memberDirectory=createNativeMemberOwnerDirectory(dataDirectory);
      const releaseMemberDirectory=actors?.onHumanRegistered(principal=>memberDirectory?.observe(principal));
      if (!hubAuthority?.providers.includes('tencentoa')) throw new Error('Demo IOA requires an enrolled Tencent OA Hub authority');
      const releaseClaim = actors?.registerHumanReservationResolver(rtxReservationClaim);
      const vault = new EmployeeGitVaultStore(dataDirectory);
      const executionEnvironment = new ExecutionEnvironmentRuntime(dataDirectory, vault, false, 'issuer');
      const sandboxConfigurations = new SandboxConfigurations(vault);
      try { await migrateInstalledSandboxConfiguration(sandboxConfigurations, process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG); }
      catch { console.warn("assistant_environment_configuration_migration_unavailable"); }
      const installedBudget = new InstalledSandboxBudget(vault, () => {
        const installed = sandboxConfigurations.installedRuntime();
        if (!installed) throw Error('Installed sandbox budget unavailable');
        return installed.policy.capacity;
      });
      const sandboxProviders = createConfiguredSandboxProviders(sandboxConfigurations, { actors, getInstanceAccess, installedBudget });
      const profiles = avatarProfiles(dataDirectory);
      const capabilities = await createIoaCapabilities({ dataDirectory, resolveIdentity, getInstanceAccess, actors, machineIdentity, sshIngressEnabled }, { vault });
      const ioa = new TencentOaServerPlugin(null, { sandboxConfigurations: { store: sandboxConfigurations,
        allowed: request => { const p=resolveIdentity(request), a=getInstanceAccess(); return p?.provider==='tencentoa' && p.expiresAt>Date.now() && a?.admissionStatus(request)===204 && a.role(p)!==null; },
        allowCustomEndpoints: request => getInstanceAccess()?.role(resolveIdentity(request))==='admin',
        canManagePlatform: request => getInstanceAccess()?.role(resolveIdentity(request))==='admin',
      }, gitCredentials: capabilities.gitCredentials, identityResolver: request => {
        const principal = resolveIdentity(request);
        try {memberDirectory?.observe(principal);} catch { /* Metadata cannot block authentication. */ }
        try { profiles.observePrincipal(principal); } catch { /* Photo cache failure never prevents authentication. */ }
        return principal;
      },
        environment: { http: new AccountEnvironmentHttp(new AccountEnvironment(vault)),
          projects: async () => executionEnvironment.projects(),
          isAllowed(request) {
            const principal = resolveIdentity(request), access = getInstanceAccess();
            return !!principal && principal.expiresAt > Date.now() && !!access && access.role(principal) !== null;
          },
        },
      });
      const closeIdentity = () => { capabilities.close(); access = undefined; releaseMemberDirectory?.(); memberDirectory?.close(); memberDirectory=undefined; releaseClaim?.(); ioa.close(); executionEnvironment.close(); vault.close(); };
      let runtimePlugins,workspaceAuthority;
      try {
        if (machineIdentity?.machineId && actors) ordinaryWorkspaces = new OrdinaryWorkspaceServices({
          dataDirectory, machineId: machineIdentity.machineId, configurations: sandboxConfigurations, budget: installedBudget,
          actors, getInstanceAccess,
        });
        if (workspaceExecution) {
          if (!ordinaryWorkspaces) throw Error('Workspace routing requires a persistent machine identity');
          workspaceAuthority = await createOwnedWorkspaceAuthority(workspaceExecution);
        }
        runtimePlugins = await loadRuntimePlugins({ packageSource: pluginSourceFactory?()=>pluginSourceFactory(dataDirectory):undefined,
          cacheDirectory: dataDirectory+'/runtime-plugin-cache', directory: runtimePluginDirectory(dataDirectory), role: 'gateway',
          protectedPaths: [TENCENTOA_SESSION_PATH,TENCENTOA_ENVIRONMENT_PATH,TENCENTOA_PHOTO_PATH,TENCENTOA_MODEL_DEFAULTS_PATH,GIT_CREDENTIALS_PATH,SANDBOX_CONFIG_PATH],
          authority: {
            authenticate: request => resolveIdentity(request),
            admissionStatus: request => {
              const instance = getInstanceAccess();
              return instance?.admissionStatus(request) ?? 403;
            },
          },
        });
      } catch (error) {
        const cleanup = await Promise.allSettled([workspaceAuthority?.close(),ordinaryWorkspaces?.close()]);
        ordinaryWorkspaces = undefined;closeIdentity();
        const failures = cleanup.filter(r=>r.status==='rejected').map(r=>r.reason);
        if(failures.length)throw new AggregateError([error,...failures], 'Identity startup cleanup unconfirmed');
        throw error;
      }
      return {
        providers: [],
        notificationDefaultTarget: createIoaNotificationDefaultTarget({resolveIdentity,actors}),
        capabilityProviders: capabilities.capabilityProviders,
        assistantEnvironmentConfigurationManaged: true,
        environmentProvidersFor: context => sandboxProviders.forContext(context),
        sshAccess: capabilities.sshAccess,
        executionEnvironment,
        ordinaryWorkspaces,
        codexWorkspaceRouting: workspaceAuthority ? {
          connectBrowserRouting: ({service, assertThreadAccess}) => installWorkspaceBrowserRouting({ service,
            resolveConversation: (descriptor, local) => ordinaryWorkspaces.browserRoute(descriptor, local,
              () => assertThreadAccess(descriptor)),
          }),
          readFileScope: (hostId, context, threadId) => ordinaryWorkspaces.readFileScope(hostId,context,threadId),
          readCatalog: (hostId, context) => ordinaryWorkspaces.readCatalog(hostId,context),
          createCodexWorkspaceHooks: ({hostId}) => ordinaryWorkspaces.nativeHooks(hostId,workspaceAuthority),
        } : undefined,
        getStorageOutcomes: () => [{ name: 'personal-environment', status: vault.outcome.status }],
        service: {
          admissionStatus: request => ioa.admissionStatus(request),
          connectionContext: request => ioa.connectionContext(request),
          handle(request, response) {
            if (runtimePlugins.handle(request, response)) return true;
            const { pathname } = new URL(request.url ?? '/', 'http://opencraft.invalid');
            if (pathname === TENCENTOA_SESSION_PATH || pathname === TENCENTOA_ENVIRONMENT_PATH || pathname === GIT_CREDENTIALS_PATH || pathname === SANDBOX_CONFIG_PATH || pathname.startsWith(TENCENTOA_PHOTO_PATH)) {
              return ioa.handle(request, response);
            }
            return false;
          },
        },
        createThreadMetadata: (database, context) => new TencentOaParticipants(database, context),
        close: async () => {
          const failures = [];
          try { await runtimePlugins.close(); } catch (error) { failures.push(error); }
          const results = await Promise.allSettled([workspaceAuthority?.close(), sandboxProviders.close(), ordinaryWorkspaces?.close()]);
          for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
          // Keep the closed owner as a routing tombstone until composition dies.
          // Late requests must not regain the local fallback after shutdown.
          try { closeIdentity(); } catch (error) { failures.push(error); }
          if (failures.length) throw new AggregateError(failures, 'Identity cleanup unconfirmed');
        },
      };
    },
  });
}
