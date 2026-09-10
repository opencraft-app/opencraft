import { Redirect } from "expo-router";

// Account ownership stays above the router. A callback is never a workbench page.
export default function LightVelaLoginCallback() {
  return <Redirect href="/" />;
}
