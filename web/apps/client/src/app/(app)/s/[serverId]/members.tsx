import {ExpoManagementRouteSurface} from "../../../../features/management/expo-management-route-surface";
import {useServerRoute} from "../../../../features/workspace/server-route-context";

export default function MembersRoute() {
  const server = useServerRoute();
  return <ExpoManagementRouteSurface section="members" server={server} />;
}
