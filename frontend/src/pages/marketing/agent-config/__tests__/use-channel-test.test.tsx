import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentScriptCommands } from '@/pages/marketing/agent-config/hermes-command-builder';
import { useChannelOperations } from '@/pages/marketing/agent-config/hooks/useChannelOperations';
import type { IUseChannelOperationsParams } from '@/pages/marketing/agent-config/hooks/useChannelOperations';

const { run, setCurrentAction } = vi.hoisted(() => ({
  run: vi.fn(),
  setCurrentAction: vi.fn(),
}));

vi.mock('@/i18n/t', () => ({ t: (value: string) => value }));

vi.mock('@/pages/marketing/agent-config/hooks/useAgentConfig', () => ({
  useAgentConfig: () => ({
    configData: {
      channels: [{ value: 'feishu', channel: 'feishu', channel_name: '飞书', enabled: true }],
    },
    loading: false,
    restartAndRefresh: vi.fn(),
    currentAction: '',
    setCurrentAction,
    refresh: vi.fn(),
    currentChannelList: [{ value: 'feishu', channel: 'feishu', channel_name: '飞书' }],
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
    setCurrentAction.mockReset();
  });

  const renderOperations = () => renderHook(() => useChannelOperations({} as IUseChannelOperationsParams));

  it('sends through the selected platform and Bot profile, locking channel mutations until completion', async () => {
    let finishSend: (value: { success: boolean; output: string }) => void = () => undefined;
    run.mockImplementation(() => new Promise((resolve) => { finishSend = resolve; }));
    const { result } = renderOperations();

    let sendPromise: Promise<boolean> = Promise.resolve(false);
    act(() => { sendPromise = result.current.testChannel('feishu'); });

    expect(result.current.testingChannel).toBe('feishu');
    expect(run).toHaveBeenCalledWith({
      command: "printf '%s' '叮咚！收到一条来自 LightVela 的测试消息。' "
        + "| hermes -p 'secondary' send --to 'feishu' --json --file -",
    });
    expect(await result.current.deleteChannel('feishu')).toBe(false);
    expect(await result.current.configureChannel({ channelValue: 'feishu', channelIdValue: 'new-id' })).toBe(false);
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
});
