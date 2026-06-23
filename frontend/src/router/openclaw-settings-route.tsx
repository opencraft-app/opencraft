import { useParams } from "react-router-dom";

import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";
import { getAgentSectionFromSlug } from "@/router/paths";

export function OpenClawSettingsRoutePage() {
  const { section } = useParams<{ section?: string }>();
  return <AgentSettingsPage sectionId={getAgentSectionFromSlug(section) ?? undefined} />;
}
