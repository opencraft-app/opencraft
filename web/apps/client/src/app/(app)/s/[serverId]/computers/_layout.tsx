import {Slot, useLocalSearchParams} from "expo-router";

import {ExpoManagementRouteSurface} from "../../../../../features/management/expo-management-route-surface";
import {routeParam} from "../../../../../features/workspace/section-navigation";

/**
 * One Computers surface for list and detail. Sibling routes used to remount
 * ExpoManagementRouteSurface on every /computers ↔ /computers/:id hop and
 * restart polling / drop in-progress create + terminal state.
 */
export default function ComputersLayout() {
  const params = useLocalSearchParams<{computerId?: string | string[]}>();
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
