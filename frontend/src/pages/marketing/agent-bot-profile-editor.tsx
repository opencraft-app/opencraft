import type { BuddyProfile } from "@/pages/marketing/agent-buddy-profile";
import type { SetupExec } from "@/pages/marketing/agent-buddy-setup-runner";
import { CreatingLoadingView } from "@/pages/marketing/agent-creating-loading";
import { ProfileEditDialog, useOverviewProfileEditor } from "@/pages/marketing/agent-overview-panel";

type AgentBotProfileEditorProps = {
  botId: string;
  profileId?: string;
  profile: BuddyProfile;
  execDebugCommand: SetupExec;
  onClose: () => void;
  onChanged: () => void;
};

export function AgentBotProfileEditor({ botId, profileId, profile, execDebugCommand, onClose, onChanged }: AgentBotProfileEditorProps) {
  const { steps, writeError, isReadingSoul, applyProfile } = useOverviewProfileEditor({
    botId,
    profileId,
    execDebugCommand,
    onProfileChanged: () => {
      onChanged();
      onClose();
    },
  });
  if (steps) return <CreatingLoadingView errorMessage={writeError} steps={steps} />;
  return <ProfileEditDialog profile={profile} errorMessage={writeError} saving={isReadingSoul} onClose={onClose} onSave={(next) => void applyProfile(next)} />;
}
