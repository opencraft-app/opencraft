import {Slot, useGlobalSearchParams} from "expo-router";

import {ExpoManagementRouteSurface} from "../../../../../features/management/expo-management-route-surface";
import {routeParam} from "../../../../../features/workspace/section-navigation";

/**
 * One Computers surface for list and detail. Sibling routes used to remount
 * ExpoManagementRouteSurface on every /computers ↔ /computers/:id hop and
 * restart polling / drop in-progress create + terminal state.
 */
export default function ComputersLayout() {
  // This retained parent layout observes a dynamic child route. Local params
  // stay scoped to the previously matched child during sibling navigation;
  // the current URL is the selection authority, so consume global params here.
  const params = useGlobalSearchParams<{computerId?: string | string[]}>();
  const selectedComputerId = routeParam(params.computerId) || null;

  return (
    <>
      <ExpoManagementRouteSurface
        section="computers"
        selectedComputerId={selectedComputerId}
      />
      <Slot />
    </>
  );
}
