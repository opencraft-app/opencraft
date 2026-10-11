import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n/t";
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
  avatarOnly?: boolean;
};

export function AgentBotProfileEditor({ botId, profileId, profile, execDebugCommand, onClose, onChanged, avatarOnly = false }: AgentBotProfileEditorProps) {
  const t = useT();
  const { steps, writeError, isReadingSoul, applyProfile } = useOverviewProfileEditor({
    botId,
    profileId,
    execDebugCommand,
    onProfileChanged: () => {
      onChanged();
      onClose();
    },
  });
  if (steps) return <Dialog open onOpenChange={(open) => { if (!open && writeError) onClose(); }}>
    <DialogContent className="max-h-[92dvh] overflow-y-auto rounded-3xl [&>button]:hidden"
      onEscapeKeyDown={(event) => { if (!writeError) event.preventDefault(); }}
      onPointerDownOutside={(event) => { if (!writeError) event.preventDefault(); }}>
      <DialogTitle className="sr-only">{t("更换头像")}</DialogTitle>
      <CreatingLoadingView errorMessage={writeError} steps={steps} />
      {writeError && <div><button type="button" className="min-h-11 cursor-pointer" onClick={onClose}>{t("关闭")}</button></div>}
    </DialogContent>
  </Dialog>;
  return <ProfileEditDialog avatarOnly={avatarOnly} profile={profile} errorMessage={writeError} saving={isReadingSoul} onClose={onClose} onSave={(next) => void applyProfile(next)} />;
}
