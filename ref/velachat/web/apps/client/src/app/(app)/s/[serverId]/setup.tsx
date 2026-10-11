import {
  memberCanManageServer,
  selectCurrentHumanMember,
} from "@vela/client-core";
import {useShallow} from "zustand/react/shallow";
import {ServerSetupScreen} from "@/ui";

import {executionReadiness} from "../../../../features/onboarding/execution-readiness";
import {useServerWorkspace} from "../../../../features/workspace/server-route-context";
import {
  firstRoutableChannelId,
  workspaceSectionHref,
} from "../../../../features/workspace/section-navigation";
import {useAppRuntime, useAppState} from "../../../../runtime/app-runtime";

export default function ServerSetupRoute() {
  const {navigation, server} = useServerWorkspace();
  const {store} = useAppRuntime();
  const state = useAppState(
    useShallow((current) => ({
      account: current.account,
      agents: current.agents,
      channels: current.channels,
      computers: current.computers,
      error: current.error,
      members: current.members,
      pendingAction: current.pendingAction,
    })),
  );
  const currentMember = selectCurrentHumanMember(state.members, {
    accountId: state.account?.id,
    imUserId: state.account?.imUserId,
  });
  const canManage = memberCanManageServer(currentMember);
  const continueToChat = () =>
    navigation.replace(
      workspaceSectionHref(
        server.slug,
        "chat",
        firstRoutableChannelId(state.channels),
      ),
    );

  return (
    <ServerSetupScreen
      error={state.error}
      onContinue={continueToChat}
      onCreateAgent={(input, options) =>
        store.getState().createAgent(input, options)
      }
      onCreateComputer={(input) => store.getState().createComputer(input)}
      onOpenAgents={() => navigation.navigateSection("agents")}
      onRefreshAgents={() => store.getState().refreshAgents({force: true})}
      onRefreshComputers={() =>
        store.getState().refreshComputers({force: true})
      }
      onRequestRegistrationScript={(computerId) =>
        store.getState().requestComputerRegistrationScript(computerId)
      }
      pendingAction={state.pendingAction}
      readiness={executionReadiness({
        agents: state.agents,
        canManage,
        computers: state.computers,
      })}
      serverName={server.name}
    />
  );
}
