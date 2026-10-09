import {
  Redirect,
  useLocalSearchParams,
  useRouter,
  type Href,
} from "expo-router";
import { LoadingScreen } from "@/ui";
import { AuthScreen } from "../../features/auth/auth-screen";
import {RouteTitle} from "../../features/navigation/route-title";
import {
  authRouteHref,
  safeReturnTo,
} from "../../features/workspace/section-navigation";
import {
  useAppRuntime,
  useAppState,
} from "../../runtime/app-runtime";
import {browserHostname} from "../../runtime/browser-location";

export default function LoginRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{returnTo?: string | string[]}>();
  const { store } = useAppRuntime();
  const authStatus = useAppState((state) => state.authStatus);
  const error = useAppState((state) => state.error);
  const requestedReturnTo = Array.isArray(params.returnTo)
    ? params.returnTo[0]
    : params.returnTo;
  const returnTo = safeReturnTo(requestedReturnTo, browserHostname());

  if (authStatus === "checking") return <LoadingScreen />;
  if (authStatus === "signed_in") {
    return <Redirect href={returnTo as Href} />;
  }

  return (
    <>
      <RouteTitle title="登录 · VELA" />
      <AuthScreen
        error={error}
        loading={authStatus === "signing_in"}
        mode="login"
        onDismissError={() => store.setState({error: null})}
        onModeChange={() =>
          router.push(
            authRouteHref("register", returnTo, browserHostname()) as Href,
          )
        }
        onSubmit={(input) => {
          if (!("email" in input) || !("password" in input)) return;
          void store.getState().login(input.email, input.password);
        }}
      />
    </>
  );
}
