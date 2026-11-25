import "./runtime/browser-compatibility";
import { bindPageLifecycle } from "./runtime/page-lifecycle";

const preparation = new AbortController();
const retirePreparation = bindPageLifecycle(window, () => preparation.abort());
const deploymentAppHost = document.getElementById("opencraft-deployment-config")
  ? import("./runtime/deployment-app-host-startup")
    .then(module => module.prepareDeploymentAppHost(preparation.signal))
    .catch(() => null)
  : undefined;

try {
  const { mountWorkbench } = await import("./main");
  if (!preparation.signal.aborted) mountWorkbench({ deploymentAppHost, retirePreparation });
} catch (error) {
  retirePreparation();
  throw error;
}
