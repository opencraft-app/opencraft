// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import {
  createHermesCommandBuilder,
  type HermesProviderSaveConfig,
} from "./hermes-command-builder";

export interface IHermesScriptCommands {
  getGatewayRestartCommand: () => string;
  getProviderSaveCommand: (config: HermesProviderSaveConfig) => string;
  getModelSwitchCommand: (modelFullId: string) => string;
}

export function getHermesScriptCommands(agentId?: string): IHermesScriptCommands {
  const commands = createHermesCommandBuilder(agentId);
  return {
    getGatewayRestartCommand: commands.gateway.getRestartCommand,
    getProviderSaveCommand: commands.model.getProviderSaveCommand,
    getModelSwitchCommand: commands.model.getModelSwitchCommand,
  };
}
