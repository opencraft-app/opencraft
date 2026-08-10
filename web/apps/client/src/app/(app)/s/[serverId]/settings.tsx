import {ExpoManagementRouteSurface} from "../../../../features/management/expo-management-route-surface";
import {useServerRoute} from "../../../../features/workspace/server-route-context";

export default function SettingsRoute() {
  const server = useServerRoute();
  return <ExpoManagementRouteSurface section="settings" server={server} />;
}
