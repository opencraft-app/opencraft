import {
  createHermesCommandBuilder,
  type HermesProviderSaveConfig,
} from "./hermes-command-builder";

export interface IHermesScriptCommands {
  getGatewayRestartCommand: () => string;
  getProviderSaveCommand: (config: HermesProviderSaveConfig) => string;
  getModelSwitchCommand: (modelFullId: string) => string;
}

export function getHermesScriptCommands(): IHermesScriptCommands {
  const commands = createHermesCommandBuilder();
  return {
    getGatewayRestartCommand: commands.gateway.getRestartCommand,
    getProviderSaveCommand: commands.model.getProviderSaveCommand,
    getModelSwitchCommand: commands.model.getModelSwitchCommand,
  };
}
