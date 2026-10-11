import {
  createAppStore,
  type AppMessagingPort,
  type AppStoreDependencies,
  type PlatformPort,
} from "../application/app-store";

export interface InjectedRuntimeDependencies
  extends Omit<AppStoreDependencies, "messaging" | "platform"> {
  messaging: AppMessagingPort;
  platform: PlatformPort;
}

export function createInjectedStore(dependencies: InjectedRuntimeDependencies) {
  return createAppStore(dependencies);
}

