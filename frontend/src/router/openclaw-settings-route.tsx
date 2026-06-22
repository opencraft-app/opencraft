import { useParams } from "react-router-dom";

import { OpenClawSettingsPage } from "@/pages/marketing/openclaw-settings-page";

export function OpenClawSettingsRoutePage() {
  const { section } = useParams<{ section?: string }>();
  return <OpenClawSettingsPage sectionSlug={section} />;
}
