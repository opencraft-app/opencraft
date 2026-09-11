// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { useState } from 'react';
import { t } from "../../../../i18n/t";
import { GATEWAY_STATUS } from '../utils/model-providers';
import type { AgentScriptCommands } from '../hermes-command-builder';
import type { ICommandExecutor } from '../local-command-executor';
import { getKnownSafeExecutorErrorOutput } from '../utils/model-operation-errors';

interface UseGatewayCommandOptions {
  scriptCommands: AgentScriptCommands;
  executor: ICommandExecutor;
  isHermes: boolean;
}

interface ExecuteCommandOptions {
  command: string;
  action: string;
  showButtonLoading?: boolean;
  shouldQueryStatus?: boolean;
  timeout?: number;
  callback?: (result?: any) => void | Promise<void>;
  onFailed?: (error?: any) => void | Promise<void>;
}

export const useGatewayCommand = ({ scriptCommands, executor, isHermes }: UseGatewayCommandOptions) => {
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [currentAction, setCurrentAction] = useState('');
  const [status, setStatus] = useState<string>(GATEWAY_STATUS.UNKNOWN);

  // 查询网关状态
  const queryGatewayStatus = async () => {
    if (!executor || !scriptCommands) return;
    try {
      setGatewayLoading(true);

      const result = await executor.run({
        command: isHermes
          ? scriptCommands.hermes.gateway.getStatusCommand()
          : scriptCommands.openclaw.gateway.STATUS_COMMAND,
      });

      if (result.output) {
        const gatewayStatus = result.output === 'active' ? GATEWAY_STATUS.RUNNING : GATEWAY_STATUS.STOPPED;
        setStatus(gatewayStatus);
      } else {
        setStatus(GATEWAY_STATUS.UNKNOWN);
      }
      setGatewayLoading(false);
    } catch (error) {
      setStatus(GATEWAY_STATUS.UNKNOWN);
      setGatewayLoading(false);
    }
  };

  // 通用的执行命令函数
  const executeGatewayCommand = async (options: ExecuteCommandOptions) => {
    if (!executor) return;

    const {
      command,
      action,
      showButtonLoading = true,
      shouldQueryStatus = true,
      timeout = 60,
      callback,
      onFailed,
    } = options;

    if (showButtonLoading) {
      setCurrentAction(action);
    }

    try {
      const result = await executor.run({ command, timeout });

      if (result.success) {
        if (callback && typeof callback === 'function') {
          await callback(result.output);
        }
        // 查询网关状态
        if (shouldQueryStatus) {
          await queryGatewayStatus();
        }
      } else {
        if (onFailed && typeof onFailed === 'function') {
          await onFailed(result.output);
        }
      }

      if (showButtonLoading) {
        setCurrentAction('');
      }
    } catch (error) {
      if (showButtonLoading) {
        setCurrentAction('');
      }
      if (onFailed && typeof onFailed === 'function') {
        await onFailed(getKnownSafeExecutorErrorOutput(error) || t('命令执行失败'));
      }
    }
  };

  // 重启 Gateway
  const restartGateway = async (showButtonLoading = true) => {
    if (!scriptCommands) return;
    await executeGatewayCommand({
      command: isHermes
        ? scriptCommands.hermes.gateway.getRestartCommand()
        : scriptCommands.openclaw.gateway.RESTART_COMMAND,
      action: 'restart',
      showButtonLoading,
      shouldQueryStatus: true,
    });
  };

  return {
    gatewayLoading,
    currentAction,
    status,
    setCurrentAction,
    executeGatewayCommand,
    queryGatewayStatus,
    restartGateway,
  };
};
