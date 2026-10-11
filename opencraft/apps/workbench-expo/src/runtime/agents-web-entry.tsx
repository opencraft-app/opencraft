import "../../global.css";
import { createRoot } from "react-dom/client";
import { HeroUINativeProvider } from "heroui-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { AgentsExpoWebApplication } from "@opencraft/mobile-bot-bridge";
import { AgentsWebShell } from "../components/agents-web-shell.web";

const application: AgentsExpoWebApplication = {
  mount(element, options) {
    const root = createRoot(element);
    const update = (options: Parameters<AgentsExpoWebApplication["mount"]>[1]) => root.render(<GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><HeroUINativeProvider>
      <AgentsWebShell options={options} />
    </HeroUINativeProvider></SafeAreaProvider></GestureHandlerRootView>);
    update(options);
    return { update, dispose: () => root.unmount() };
  },
};
(globalThis as typeof globalThis & { __OPENCRAFT_EXPO_AGENTS__?: AgentsExpoWebApplication }).__OPENCRAFT_EXPO_AGENTS__ = application;
