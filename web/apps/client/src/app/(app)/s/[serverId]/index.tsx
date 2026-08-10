import {ServerRoot} from "../../../../features/workspace/server-root";
import {useServerRoute} from "../../../../features/workspace/server-route-context";
import {useAppRuntime, useAppState} from "../../../../runtime/app-runtime";

export default function ServerRootRoute() {
  const server = useServerRoute();
  const {store} = useAppRuntime();
  const channels = useAppState(state => state.channels);
  return (
    <ServerRoot
      channels={channels}
      onRetry={() => void store.getState().selectServer(server.id)}
      server={server}
    />
  );
}
