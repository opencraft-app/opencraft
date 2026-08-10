import {
  Redirect,
  useLocalSearchParams,
  useRouter,
  type Href,
} from "expo-router";
import type {Server} from "@vela/client-core";
import { LoadingScreen } from "@/ui";
import { AuthScreen } from "../../features/auth/auth-screen";
import {RouteTitle} from "../../features/navigation/route-title";
import {
  authRouteHref,
  resolveServerRouteReference,
  safeReturnTo,
} from "../../features/workspace/section-navigation";
import {
  useAppRuntime,
  useAppState,
} from "../../runtime/app-runtime";
import {browserHostname} from "../../runtime/browser-location";

export default function RegisterRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{returnTo?: string | string[]}>();
  const { store } = useAppRuntime();
  const authStatus = useAppState((state) => state.authStatus);
  const error = useAppState((state) => state.error);
  const servers = useAppState((state) => state.servers);
  const serversStatus = useAppState((state) => state.serversStatus);
  const requestedReturnTo = Array.isArray(params.returnTo)
    ? params.returnTo[0]
    : params.returnTo;
  const returnTo = safeReturnTo(requestedReturnTo, browserHostname());

  if (
    authStatus === "checking" ||
    (authStatus === "signed_in" &&
      (serversStatus === "idle" || serversStatus === "loading"))
  ) {
    return <LoadingScreen />;
  }
  if (authStatus === "signed_in") {
    const destination = serversStatus === "ready"
      ? postRegistrationHref(returnTo, servers)
      : "/home";
    return <Redirect href={destination as Href} />;
  }

  return (
    <>
      <RouteTitle title="注册 · VELA" />
      <AuthScreen
        error={error}
        loading={authStatus === "signing_in"}
        mode="register"
        onDismissError={() => store.setState({error: null})}
        onModeChange={() =>
          router.push(
            authRouteHref("login", returnTo, browserHostname()) as Href,
          )
        }
        onSubmit={(input) => {
          if (!("displayName" in input)) return;
          void store.getState().register(input);
        }}
      />
    </>
  );
}

function postRegistrationHref(returnTo: string, servers: Server[]): string {
  if (returnTo === "/") return "/home";
  const match = /^\/s\/([^/?#]+)/u.exec(returnTo);
  if (!match?.[1]) return returnTo;

  let reference = match[1];
  try {
    reference = decodeURIComponent(reference);
  } catch {
    return "/home";
  }
  return resolveServerRouteReference(servers, reference).status === "ready"
    ? returnTo
    : "/home";
}
