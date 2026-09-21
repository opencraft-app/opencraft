import type { ExtensionActivationIdentity } from "@opencraft/extension-contract";
import type { AnnouncementCenter } from "@opencraft/extension-runtime";
import announcementLabMediaUrl from "../../assets/announcement-lab.svg?url&no-inline";
import { resolveAnnouncementMediaUrl } from "./announcement-media-url";

const workbenchOwner: ExtensionActivationIdentity = Object.freeze({
  extensionId: "opencraft.workbench",
  activationId: "opencraft.workbench",
  generation: 1,
});

/** The Settings laboratory uses the exact same serialized path as JS extensions. */
export function showAnnouncementLab(center: AnnouncementCenter) {
  return center.show(workbenchOwner, {
    id: "opencraft.workbench.announcement-lab",
    title: "Announcements are now a platform capability",
    body: "OpenCraft can present product news, onboarding, and release notes through one themed window on Web, Electron, and native hosts.",
    media: {
      kind: "image-url",
      url: resolveAnnouncementMediaUrl(announcementLabMediaUrl, import.meta.url),
      alt: "Two OpenCraft workbench surfaces sharing the same design system",
    },
    secondaryAction: { id: "later", label: "Maybe later" },
    primaryAction: { id: "continue", label: "Looks good" },
  });
}
