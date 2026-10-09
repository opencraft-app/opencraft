import { describe, expect, it } from 'vitest';
import { t } from '@tencent/agentchat-lightvela-panel/i18n';
import sdk from 'agentchat-i18next';
import { prepareAgentChatLocale } from '../agentchat-locale';

describe('Malay SDK locale bridge', () => {
  it('loads Malay into the SDK runtime before use and restores English on switch', async () => {
    await prepareAgentChatLocale('ms-MY');
    expect(sdk.language).toBe('ms-MY');
    expect(t('删除')).toBe('Padam');
    expect(t('重新连接')).not.toMatch(/[\u4e00-\u9fff]/);
    expect(t('重新连接')).not.toBe('Reconnect');
    await prepareAgentChatLocale('en-US');
    expect(sdk.language).toBe('en-US');
    expect(t('删除')).toBe('Delete');
  });

  it('keeps the latest language when switches overlap with loading a dictionary', async () => {
    await Promise.all([prepareAgentChatLocale('ms-MY'), prepareAgentChatLocale('en-US')]);
    expect(sdk.language).toBe('en-US');
    expect(t('删除')).toBe('Delete');
  });
});
