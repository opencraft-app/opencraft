// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { useMemo, type Dispatch, type SetStateAction } from "react";

import {
  createAgentScriptCommands,
  type AgentScriptCommands,
} from "../hermes-command-builder";
import type { ICommandExecutor } from "../local-command-executor";
import { createLighthouseConfig } from "../product-config";
import type { IExecuteCommandOptions, IFeatureFlags, IInstanceInfo, IProductConfig } from "../types";
import { useGatewayCommand } from "./useGatewayCommand";

export interface IAgentComponentBaseProps {
  instance: IInstanceInfo;
  scriptCommands?: AgentScriptCommands;
  featureFlags: IFeatureFlags;
  productConfig?: IProductConfig;
  commandExecutor?: ICommandExecutor;
}

export interface IAgentInternalsResult {
  scriptCommands: AgentScriptCommands;
  scriptsReady: boolean;
  executor: ICommandExecutor;
  productConfig: IProductConfig;
  executeGatewayCommand: (options: IExecuteCommandOptions) => Promise<void>;
  currentAction: string;
  setCurrentAction: Dispatch<SetStateAction<string>>;
  restartGateway: (showLoading?: boolean) => Promise<void>;
  queryGatewayStatus: () => Promise<void>;
  gatewayStatus: string;
  gatewayLoading: boolean;
}

export function useAgentInternals(props: IAgentComponentBaseProps): IAgentInternalsResult {
  const productConfig = props.productConfig ?? createLighthouseConfig();
  const internalScriptCommands = useMemo(
    () => createAgentScriptCommands(props.instance.ProfileId),
    [props.instance.ProfileId],
  );
  const scriptCommands = props.scriptCommands ?? internalScriptCommands;
  const executor = useMemo<ICommandExecutor>(
    () => props.commandExecutor ?? {
      run: async () => {
        throw new Error("[useAgentInternals] commandExecutor 未注入");
      },
      runWithProgress: async () => {
        throw new Error("[useAgentInternals] commandExecutor 未注入");
      },
    },
    [props.commandExecutor],
  );

  const {
    gatewayLoading,
    currentAction,
    status: gatewayStatus,
    setCurrentAction,
    executeGatewayCommand,
    queryGatewayStatus,
    restartGateway,
  } = useGatewayCommand({
    scriptCommands,
    executor,
    isHermes: productConfig.agentType === "hermes",
  });

  return {
    scriptCommands,
    scriptsReady: true,
    executor,
    productConfig,
    executeGatewayCommand,
    currentAction,
    setCurrentAction,
    restartGateway,
    queryGatewayStatus,
    gatewayStatus,
    gatewayLoading,
  };
}
