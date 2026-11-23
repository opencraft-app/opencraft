import {
  THREAD_BADGE_CHANNEL,
  THREAD_LIST_GROUPING_CHANNEL,
  THREAD_PARTICIPATION_CHANNEL,
} from "@opencraft/extension-react";
import type { TrustedExtensionApiV1 } from "@opencraft/extension-runtime";
import { CreatorGrouping, type ThreadParticipantsViewer } from "./creator-grouping";
import { ThreadParticipantsController, type ThreadParticipantsClient } from "./controller";
import { createThreadParticipantsBadge } from "./participants-badge";
import { createThreadParticipation } from "./participation";

export * from "./contract";
export {
  ThreadParticipantsController,
  type ThreadParticipantsClient,
  type ThreadParticipantsSnapshot,
  type ThreadParticipantsSource,
} from "./controller";
export {
  CreatorGrouping,
  CREATOR_GROUPING_MODE,
  parseCreatorGroupingPreferences,
  type ThreadParticipantsViewer,
  type ThreadParticipantsViewerIdentity,
} from "./creator-grouping";
export { createThreadParticipantsBadge, participantPeople } from "./participants-badge";
export { createThreadParticipation } from "./participation";

export interface ThreadParticipantsRegistration {
  /** The connected AppServer client for a Host, or undefined while disconnected. */
  getClient(hostId: string): ThreadParticipantsClient | undefined;
  /** The verified reader; drives the personal filter, own-first ordering and preference isolation. */
  readonly viewer: ThreadParticipantsViewer;
  /** Contribution ID prefix. Defaults to `opencraft.thread-participants`. */
  readonly id?: string;
}

/**
 * Registers the participants badge, the participation overview and the
 * "group by creator" list mode on the calling extension. The identity product
 * supplies the reader and installs its photo resolver on `identityAvatar`;
 * the Host side is `ThreadParticipantsMetadata` from `./server`.
 */
export function registerThreadParticipants(
  api: Pick<TrustedExtensionApiV1, "internal" | "subscriptions" | "localPreferences">,
  options: ThreadParticipantsRegistration,
): ThreadParticipantsController {
  const id = options.id ?? "opencraft.thread-participants";
  const controller = new ThreadParticipantsController(options.getClient);
  api.subscriptions.add(() => controller.dispose());
  const accountKey = () => {
    const viewer = options.viewer.getSnapshot();
    return viewer ? JSON.stringify([viewer.accountKey, viewer.loginName]) : null;
  };
  let account = accountKey();
  api.subscriptions.add(
    options.viewer.subscribe(() => {
      const next = accountKey();
      if (next !== account) {
        account = next;
        controller.clear();
      }
    }),
  );
  api.internal.register(
    THREAD_PARTICIPATION_CHANNEL,
    createThreadParticipation(`${id}.participation`, options.getClient, accountKey),
  );
  api.internal.register(THREAD_BADGE_CHANNEL, createThreadParticipantsBadge(`${id}.badge`, controller));
  const grouping = new CreatorGrouping(
    `${id}.creator-grouping`,
    options.viewer,
    controller,
    api.localPreferences ?? null,
  );
  api.subscriptions.add(() => grouping.dispose());
  api.internal.register(THREAD_LIST_GROUPING_CHANNEL, grouping);
  return controller;
}
