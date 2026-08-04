import type {Server} from "@raft-platform/client-core";
import {useEffect} from "react";
import {useShallow} from "zustand/react/shallow";

import {selectManagementState} from "../../application/app-selectors";
import {useAppRuntime, useAppState} from "../../runtime/app-runtime";
import {
  AgentsScreen,
  ComputersScreen,
  MembersScreen,
  TasksScreen,
  type TerminalSurfaceController,
  type WorkspaceSection,
} from "@/ui";

export type ManagementSection = Exclude<WorkspaceSection, "chat">;

export interface ManagementNavigationPort {
  navigateSection(section: WorkspaceSection): void;
  selectComputer?(computerId: string): void;
  selectServer(serverId: string, section: ManagementSection): void;
  showComputerList?(): void;
}

export interface ManagementRouteSurfaceProps {
  createTerminalController?(computerId: string): TerminalSurfaceController;
  navigation: ManagementNavigationPort;
  section: ManagementSection;
  selectedComputerId?: string | null;
  server: Server;
  terminalUnavailableReason?: string;
}

export function ManagementRouteSurface({
  createTerminalController,
  navigation,
  section,
  selectedComputerId = null,
  server,
  terminalUnavailableReason,
}: ManagementRouteSurfaceProps) {
  const {store} = useAppRuntime();
  const state = useAppState(
    useShallow(value => selectManagementState(value, section)),
  );

  useEffect(() => {
    if (section === "agents") {
      void Promise.all([
        store.getState().refreshAgents(),
        store.getState().refreshComputers(),
        store.getState().refreshOrganization(),
      ]);
    } else if (section === "computers") {
      void Promise.all([
        store.getState().refreshComputers(),
        store.getState().refreshAgents(),
        store.getState().refreshOrganization(),
      ]);
    } else if (section === "tasks") {
      void Promise.all([
        store.getState().refreshWork(),
        store.getState().refreshReminders(),
        store.getState().refreshAgents(),
      ]);
    } else {
      void store.getState().refreshOrganization();
    }
    return () => store.getState().cancelOperationPolling();
  }, [section, server.id, store]);

  useEffect(() => {
    if (section !== "agents" && section !== "members") return;
    const channelIds = new Set(state.channels.map(channel => channel.id));
    for (const item of Object.values(state.operationsById)) {
      if (item.pollingState !== "idle") continue;
      if (
        section === "members" &&
        (!item.operation.kind.startsWith("im.membership.") ||
          channelIds.has(item.resourceId ?? ""))
      ) {
        continue;
      }
      void store.getState().continueOperationPolling(item.operation.id);
    }
  }, [section, state.channels, state.operationsById, store]);

  const canManage =
    state.currentMember?.role === "owner" || state.currentMember?.role === "admin";
  const navigateSection = (next: WorkspaceSection) =>
    navigation.navigateSection(next);
  const selectServer = (serverId: string) =>
    navigation.selectServer(serverId, section);

  if (section === "agents") {
    return (
      <AgentsScreen
        agents={state.agents}
        canManage={canManage}
        computers={state.computers}
        currentAccount={state.account}
        currentServerId={state.currentServerId}
        error={state.error}
        imStatus={state.imState.status}
        loading={state.loadingAgents || state.loadingComputers}
        onCreateAgent={input => store.getState().createAgent(input)}
        onDeleteAgent={agentId => store.getState().deleteAgent(agentId)}
        onContinueOperation={operationId =>
          store.getState().continueOperationPolling(operationId)
        }
        onLogout={() => store.getState().logout()}
        onNavigateSection={navigateSection}
        onRefresh={() =>
          Promise.all([
            store.getState().refreshAgents({force: true}),
            store.getState().refreshComputers({force: true}),
          ]).then(() => undefined)
        }
        onRotateCredential={agentId =>
          store.getState().rotateAgentCredential(agentId)
        }
        onRunAgentAction={(agentId, action) =>
          store.getState().runAgentAction(agentId, action)
        }
        onSelectServer={selectServer}
        onUpdateAgent={(agentId, input) =>
          store.getState().updateAgent(agentId, input)
        }
        operations={Object.values(state.operationsById)}
        pendingAction={state.pendingAction}
        servers={state.servers}
      />
    );
  }

  if (section === "computers") {
    return (
      <ComputersScreen
        agents={state.agents}
        canManage={canManage}
        computers={state.computers}
        currentAccount={state.account}
        currentServerId={state.currentServerId}
        error={state.error}
        imStatus={state.imState.status}
        loading={state.loadingComputers}
        onCreateComputer={input => store.getState().createComputer(input)}
        {...(createTerminalController
          ? {onCreateTerminalController: createTerminalController}
          : {})}
        onLogout={() => store.getState().logout()}
        onNavigateSection={navigateSection}
        onRefresh={() => store.getState().refreshComputers({force: true})}
        onRemoveComputer={async computerId => {
          const removed = await store.getState().removeComputer(computerId);
          if (removed) navigation.showComputerList?.();
          return removed;
        }}
        onRequestRegistrationScript={computerId =>
          store.getState().requestComputerRegistrationScript(computerId)
        }
        onSelectComputer={navigation.selectComputer}
        onSelectServer={selectServer}
        pendingAction={state.pendingAction}
        selectedComputerId={selectedComputerId}
        servers={state.servers}
        {...(terminalUnavailableReason
          ? {terminalUnavailableReason}
          : {})}
      />
    );
  }

  if (section === "tasks") {
    return (
      <TasksScreen
        agents={state.agents}
        currentAccount={state.account}
        currentServerId={state.currentServerId}
        error={state.error}
        imStatus={state.imState.status}
        inbox={state.inbox}
        loading={state.loadingWork}
        loadingReminders={state.loadingReminders}
        onCancelReminder={reminderId =>
          store.getState().cancelReminder(reminderId)
        }
        onCreateReminder={input => store.getState().createReminder(input)}
        onCreateTask={input => store.getState().createTask(input)}
        onLogout={() => store.getState().logout()}
        onNavigateSection={navigateSection}
        onRefresh={() => store.getState().refreshWork({force: true})}
        onRefreshReminders={() =>
          store.getState().refreshReminders({force: true})
        }
        onSelectServer={selectServer}
        onUpdateReminder={(reminderId, input) =>
          store.getState().updateReminder(reminderId, input)
        }
        onUpdateTask={(taskId, input) =>
          store.getState().updateTask(taskId, input)
        }
        pendingAction={state.pendingAction}
        reminders={state.reminders}
        servers={state.servers}
        tasks={state.tasks}
      />
    );
  }

  const channelIds = new Set(state.channels.map(channel => channel.id));
  const memberOperations = Object.values(state.operationsById).filter(
    item =>
      item.operation.kind.startsWith("im.membership.") &&
      !channelIds.has(item.resourceId ?? ""),
  );
  if (!state.account) return null;
  return (
    <MembersScreen
      accountId={state.account.id}
      currentAccount={state.account}
      currentServerId={state.currentServerId}
      error={state.error}
      imStatus={state.imState.status}
      invites={state.invites}
      loading={state.loadingOrganization}
      members={state.members}
      onAcceptInvite={token => store.getState().acceptInvite(token)}
      onContinueOperation={operationId =>
        store.getState().continueOperationPolling(operationId)
      }
      onCreateInvite={input => store.getState().createInvite(input)}
      onLogout={() => store.getState().logout()}
      onNavigateSection={navigateSection}
      onRefresh={() => store.getState().refreshOrganization({force: true})}
      onRemoveMember={memberId => store.getState().removeMember(memberId)}
      onRevokeInvite={inviteId => store.getState().revokeInvite(inviteId)}
      onSelectServer={selectServer}
      onUpdateMember={(memberId, input) =>
        store.getState().updateMember(memberId, input)
      }
      operations={memberOperations}
      pendingAction={state.pendingAction}
      servers={state.servers}
    />
  );
}
