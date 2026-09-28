import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelPanel } from '@/pages/marketing/agent-channel-panel';
import type { ChannelPanelProps } from '@/pages/marketing/agent-config';

const { useChannelOperations, testChannel, success, error } = vi.hoisted(() => ({
  useChannelOperations: vi.fn(),
  testChannel: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'zh-CN' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/i18n/t', () => ({ t: (value: string) => value }));
vi.mock('@/pages/marketing/agent-config', () => ({
  useChannelOperations,
  message: { success, error },
  HermesQrCodeModal: () => null,
  FeishuIcon: () => null,
  WecomIcon: () => null,
}));

const panelProps = {} as ChannelPanelProps;
const connected = { value: 'feishu', channel: 'feishu', channel_name: '飞书', primaryLabel: '飞书' };
const disconnected = { value: 'qqbot', channel: 'qqbot', channel_name: 'QQ', primaryLabel: 'QQ' };

function setOperations(testingChannel: string | null = null) {
  useChannelOperations.mockReturnValue({
    loading: false,
    productConfig: { isI18n: false },
    configData: { channels: [{ ...connected, enabled: true }] },
    currentChannelList: [connected, disconnected],
    testChannel,
    configureChannel: vi.fn(),
    deleteChannel: vi.fn(),
    deletingChannel: null,
    testingChannel,
    configuring: false,
    scriptCommands: {},
    executor: {},
    instance: {},
    refresh: vi.fn(),
  });
}

describe('channel test action', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    setOperations();
  });

  it('shows Test only on connected channels and asks users to check the chat app after a send', async () => {
    testChannel.mockResolvedValue(true);
    render(<ChannelPanel {...panelProps} />);
    expect(screen.getAllByRole('button', { name: '测试' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '测试' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith({
      content: '测试消息已发送，请前往聊天软件确认是否收到。',
    }));
    expect(testChannel).toHaveBeenCalledWith('feishu');
    expect(error).not.toHaveBeenCalled();
  });

  it('locks test, disconnect, reconnect, and other channel connection while testing', () => {
    setOperations('feishu');
    render(<ChannelPanel {...panelProps} />);

    expect(screen.getByRole('button', { name: '测试中...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '断开' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新连接' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ 连接' })).toBeDisabled();
  });

  it('uses one retry instruction for failures without showing command output', async () => {
    testChannel.mockResolvedValue(false);
    render(<ChannelPanel {...panelProps} />);

    fireEvent.click(screen.getByRole('button', { name: '测试' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith({
      content: '测试消息发送失败。请检查通道连接，或重新连接通道后再次测试。',
    }));
    expect(success).not.toHaveBeenCalled();
  });
});
