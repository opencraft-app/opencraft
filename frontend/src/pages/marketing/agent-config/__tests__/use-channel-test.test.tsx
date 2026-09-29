import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentScriptCommands } from '@/pages/marketing/agent-config/hermes-command-builder';
import { useChannelOperations } from '@/pages/marketing/agent-config/hooks/useChannelOperations';
import type { IUseChannelOperationsParams } from '@/pages/marketing/agent-config/hooks/useChannelOperations';

const { run, restartAndRefresh, setCurrentAction } = vi.hoisted(() => ({
  run: vi.fn(),
  restartAndRefresh: vi.fn(),
  setCurrentAction: vi.fn(),
}));

vi.mock('@/i18n/t', () => ({ t: (value: string) => value }));

vi.mock('@/pages/marketing/agent-config/hooks/useAgentConfig', () => ({
  useAgentConfig: () => ({
    configData: {
      channels: [
        { value: 'feishu', channel: 'feishu', channel_name: '飞书', enabled: true },
        { value: 'dingtalk', channel: 'dingtalk', channel_name: '钉钉', enabled: false },
      ],
    },
    loading: false,
    restartAndRefresh,
    currentAction: '',
    setCurrentAction,
    refresh: vi.fn(),
    currentChannelList: [
      { value: 'feishu', channel: 'feishu', channel_name: '飞书' },
      { value: 'dingtalk', channel: 'dingtalk', channel_name: '钉钉' },
    ],
  }),
}));

vi.mock('@/pages/marketing/agent-config/hooks/useAgentInternals', () => ({
  useAgentInternals: () => ({
    scriptCommands: createAgentScriptCommands('secondary'),
    executor: { run },
    productConfig: { isI18n: false },
  }),
}));

describe('connected channel test send', () => {
  beforeEach(() => {
    run.mockReset();
    restartAndRefresh.mockReset();
    setCurrentAction.mockReset();
  });

  const renderOperations = () => renderHook(() => useChannelOperations({} as IUseChannelOperationsParams));

  it('sends through the selected platform and Bot profile, locking channel mutations until completion', async () => {
    let finishSend: (value: { success: boolean; output: string }) => void = () => undefined;
    run.mockImplementationOnce(() => new Promise((resolve) => { finishSend = resolve; }))
      .mockResolvedValue({ success: true, output: '' });
    const { result } = renderOperations();

    let sendPromise: Promise<boolean> = Promise.resolve(false);
    act(() => { sendPromise = result.current.testChannel('feishu'); });

    expect(result.current.testingChannel).toBe('feishu');
    expect(run).toHaveBeenCalledWith({
      command: "printf '%s' '叮咚！收到一条来自 LightVela 的测试消息。' "
        + "| hermes -p 'secondary' send --to 'feishu' --json --file -",
    });
    expect(await result.current.deleteChannel('feishu')).toBe(false);
    expect(await result.current.configureChannel({
      channelValue: 'dingtalk', channelIdValue: 'id', channelKeyValue: 'secret',
    })).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishSend({ success: true, output: '{"success":true,"platform":"feishu"}' });
      expect(await sendPromise).toBe(true);
    });
    expect(result.current.testingChannel).toBeNull();
  });

  it('rejects an unsuccessful send payload and never treats a configured channel as delivery proof', async () => {
    run.mockResolvedValue({ success: true, output: '{"success":false,"platform":"feishu"}' });
    const { result } = renderOperations();
    let succeeded = true;
    await act(async () => { succeeded = await result.current.testChannel('feishu'); });
    expect(succeeded).toBe(false);
  });

  it('rejects a successful payload when command execution fails', async () => {
    run.mockResolvedValue({ success: false, output: '{"success":true}' });
    const { result } = renderOperations();
    let succeeded = true;
    await act(async () => { succeeded = await result.current.testChannel('feishu'); });
    expect(succeeded).toBe(false);
  });

  it.each(['configure', 'delete'] as const)('keeps %s locked until restart completes', async (operation) => {
    run.mockResolvedValue({ success: true, output: '' });
    let finishRestart: () => void = () => undefined;
    restartAndRefresh.mockImplementation(() => new Promise<void>((resolve) => { finishRestart = resolve; }));
    const { result } = renderOperations();

    let operationPromise: Promise<boolean> = Promise.resolve(false);
    act(() => {
      operationPromise = operation === 'configure'
        ? result.current.configureChannel({ channelValue: 'dingtalk', channelIdValue: 'id', channelKeyValue: 'secret' })
        : result.current.deleteChannel('feishu');
    });
    await waitFor(() => expect(restartAndRefresh).toHaveBeenCalledTimes(1));
    expect(operation === 'configure' ? result.current.configuring : result.current.deletingChannel).toBeTruthy();
    expect(await result.current.testChannel('feishu')).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRestart();
      expect(await operationPromise).toBe(true);
    });
    expect(result.current.configuring).toBe(false);
    expect(result.current.deletingChannel).toBeNull();
  });
});
