import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { Suspense } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { WorkbenchFrame } from "../components/workbench-frame";
import { createExpoWorkbenchApplication, WorkbenchRuntimeProvider } from "./runtime-context";
import { createExpoPresentationRuntime, ExpoPresentationRuntimeProvider } from "./presentation-runtime";
import { CoreRenderCapabilities } from "./core-render-capabilities";

// Like the existing product root, the application graph precedes React and
// belongs to this entry, not to a page or adaptive layout.
const application = createExpoWorkbenchApplication();
const presentation = createExpoPresentationRuntime();

export function CoreWorkbenchRoot() {
  return (
    <SafeAreaProvider>
      <HeroUINativeProvider>
        <Suspense fallback={null}>
          <ExpoPresentationRuntimeProvider runtime={presentation}>
            <WorkbenchRuntimeProvider application={application}>
              <CoreRenderCapabilities>
                <StatusBar style="dark" />
                <WorkbenchFrame />
              </CoreRenderCapabilities>
            </WorkbenchRuntimeProvider>
          </ExpoPresentationRuntimeProvider>
        </Suspense>
      </HeroUINativeProvider>
    </SafeAreaProvider>
  );
}
