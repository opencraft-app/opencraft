import { Redirect, type Href } from "expo-router";
import { LoadingScreen } from "@/ui";
import { useAppState } from "../runtime/app-runtime";

export default function IndexRoute() {
  const authStatus = useAppState((state) => state.authStatus);
  if (authStatus === "checking" || authStatus === "signing_in") {
    return <LoadingScreen />;
  }
  if (authStatus === "signed_out") {
    return <Redirect href="/login" />;
  }
  return <Redirect href={"/home" as Href} />;
}

export { LoadingScreen };
