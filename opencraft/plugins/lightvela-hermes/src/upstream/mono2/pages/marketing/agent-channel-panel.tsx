// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * @fileoverview ChannelPanel — Standard 变体通道配置面板
 *
 * 交互设计：
 *  - 顶部标题与提示文案
 *  - 通道卡片平铺（微信/QQ/飞书），每张卡含 icon + 名称 + 描述 + 连接按钮
 *  - 微信/飞书：触发 HermesQrCodeModal 扫码
 *  - QQ：弹出表单 Modal（App ID + App Secret）
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import './agent-config/styles-index.css';
import { t } from "../../i18n/t";
import { resolveAgentConsoleCollectionLabel } from './agent-provider-locale';
import { Info, Eye, EyeOff } from 'lucide-react';
import {
  useChannelOperations,
  message,
  HermesQrCodeModal,
  FeishuIcon,
  WecomIcon,
  type IHermesQrCodeModalHandle,
  type ChannelPanelProps,
} from './agent-config';

const CLS = 'lh-std-channel-panel';

/**
 * LightVela 通道配置教程链接
 *
 * Key 为通道 value（与 HERMES_CHANNEL_LIST 一致），value 为对应的文档地址。
 * 中英文版本由目标站点根据浏览器语言自动切换，故链接共用。
 */
const CHANNEL_GUIDE_LINKS: Record<string, string> = {
  weixin: 'https://lightvela.ai/docs/configuration/channel-wechat',
  qqbot: 'https://lightvela.ai/docs/configuration/channel-qq',
  wecom: 'https://lightvela.ai/docs/configuration/channel-wecom',
  feishu: 'https://lightvela.ai/docs/configuration/channel-lark',
  telegram: 'https://lightvela.ai/docs/configuration/channel-telegram',
  discord: 'https://lightvela.ai/docs/configuration/channel-discord',
  slack: 'https://lightvela.ai/docs/configuration/channel-slack',
  dingtalk: 'https://lightvela.ai/docs/configuration/channel-dingtalk',
  whatsapp: 'https://lightvela.ai/docs/configuration/channel-whatsapp',
};

function getChannelDesc(channelType: string): string {
  if (channelType === 'qqbot') return t('扫码或通过 App ID / Secret 连接');
  if (channelType === 'telegram') return t('通过 Bot Token 连接');
  if (channelType === 'discord') return t('通过 Bot Token 连接');
  if (channelType === 'slack') return t('通过 Bot Token 和 App Token 连接');
  if (channelType === 'dingtalk') return t('扫码或通过 Client ID / Secret 连接');
  if (channelType === 'whatsapp') return t('使用手机 WhatsApp 扫码登录');
  return t('扫码授权连接');
}

function YuanbaoIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 240 240" fill="none" aria-hidden="true">
      <circle cx="120" cy="120" r="94" fill="#08CF6B" />
      <path
        d="M72 71c-21 25-28 64-12 95 20 39 73 56 117 36 36-16 52-52 37-83-14-28-45-42-75-34-28 8-65 1-67-14Z"
        fill="#FFFFFF"
      />
      <rect x="92" y="109" width="18" height="35" rx="9" fill="#050505" />
      <path d="M143 113l-13 18 13 18" stroke="#050505" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Token 类通道（Telegram / Discord / Slack / 钉钉）的展示元数据（懒求值，确保 t() 在 i18n 初始化后执行）
type TokenChannelMeta = {
  name: string;
  tokenLabel: string;
  placeholder: string;
  secondaryTokenLabel?: string;
  secondaryPlaceholder?: string;
  bindButton: string;
  successMsg: string;
};
function getTokenChannelMeta(kind: 'telegram' | 'discord' | 'slack' | 'dingtalk'): TokenChannelMeta {
  switch (kind) {
    case 'telegram':
      return {
        name: 'Telegram',
        tokenLabel: t('Bot Token'),
        placeholder: t('Telegram Bot Token'),
        bindButton: t('绑定 Telegram Bot'),
        successMsg: t('Telegram Bot 已绑定'),
      };
    case 'slack':
      return {
        name: 'Slack',
        tokenLabel: t('Bot Token'),
        placeholder: t('Slack Bot Token'),
        secondaryTokenLabel: t('App Token'),
        secondaryPlaceholder: t('Slack App Token'),
        bindButton: t('绑定 Slack'),
        successMsg: t('Slack 已绑定'),
      };
    case 'dingtalk':
      return {
        name: t('钉钉'),
        tokenLabel: t('Client ID'),
        placeholder: t('钉钉应用的 Client ID'),
        secondaryTokenLabel: t('Client Secret'),
        secondaryPlaceholder: t('钉钉应用的 Client Secret'),
        bindButton: t('绑定钉钉机器人'),
        successMsg: t('钉钉机器人已绑定'),
      };
    case 'discord':
    default:
      return {
        name: 'Discord',
        tokenLabel: t('Bot Token'),
        placeholder: t('Discord Bot Token'),
        bindButton: t('绑定 Discord Bot'),
        successMsg: t('Discord Bot 已绑定'),
      };
  }
}

type LightVelaChannelPanelProps = ChannelPanelProps & {
  afterDescription?: ReactNode;
};

export function ChannelPanel(props: LightVelaChannelPanelProps) {
  const { className, afterDescription, ...baseProps } = props;
  const { i18n } = useTranslation();

  const ops = useChannelOperations(baseProps);

  // ── QQ 表单弹窗状态 ──
  const [qqModalVisible, setQqModalVisible] = useState(false);
  const [qqAppId, setQqAppId] = useState('');
  const [qqSecret, setQqSecret] = useState('');
  const [qqSecretVisible, setQqSecretVisible] = useState(false);

  // ── 连接方式选择弹窗状态（扫码 / 手动绑定；QQ 与钉钉共用） ──
  const [methodPickerChannel, setMethodPickerChannel] = useState<'qqbot' | 'dingtalk' | null>(null);
  const [methodChoice, setMethodChoice] = useState<'qrcode' | 'manual'>('qrcode');

  // ── Token 类通道（Telegram / Discord / Slack / 钉钉）共用表单弹窗 ──
  type TokenChannelKind = 'telegram' | 'discord' | 'slack' | 'dingtalk';
  const [tokenChannelKind, setTokenChannelKind] = useState<TokenChannelKind | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenInputVisible, setTokenInputVisible] = useState(false);
  const [secondaryTokenInput, setSecondaryTokenInput] = useState('');
  const [secondaryTokenInputVisible, setSecondaryTokenInputVisible] = useState(false);

  // ── 扫码弹窗 ──
  const [qrChannel, setQrChannel] = useState<string>('');
  const hermesQrModalRef = useRef<IHermesQrCodeModalHandle>(null);

  // ── 已连接的通道 ──
  const boundChannels = useMemo(() => {
    const set = new Set<string>();
    (ops.configData?.channels ?? []).forEach((ch: any) => {
      if (ch.enabled || ch.value) set.add(ch.value || ch.channel);
    });
    return set;
  }, [ops.configData?.channels]);

  // ── 处理连接 ──
  const handleConnect = useCallback(
    (channelValue: string) => {
      // QQ / 钉钉 提供两种方式（扫码 / 手动填凭据）：先弹方式选择弹窗
      if (channelValue === 'qqbot' || channelValue === 'dingtalk') {
        setMethodChoice('qrcode');
        setMethodPickerChannel(channelValue);
        return;
      }
      if (
        channelValue === 'telegram' ||
        channelValue === 'discord' ||
        channelValue === 'slack'
      ) {
        setTokenChannelKind(channelValue);
        setTokenInput('');
        setTokenInputVisible(false);
        setSecondaryTokenInput('');
        setSecondaryTokenInputVisible(false);
        return;
      }
      // 企业微信走 OAuth 授权流（不弹扫码弹窗）
      // 对齐 tea-app-lighthouse master 的 startWecomAuthFlow
      if (channelValue === 'wecom') {
        setQrChannel(channelValue);
        setTimeout(() => {
          hermesQrModalRef.current?.startWecomAuthFlow();
        }, 0);
        return;
      }
      // 微信 / 飞书 / WhatsApp / 元宝 走扫码：先设置 channel，下一 tick 再触发扫码流程
      // - WhatsApp：baileys 桥接，手机端 WhatsApp 扫码登录
      // - 元宝：acli gateway qr-url 额外注入 --bind-id / --ip
      setQrChannel(channelValue);
      setTimeout(() => {
        hermesQrModalRef.current?.startQrCodeFlow();
      }, 0);
    },
    [],
  );

  // ── 连接方式选择（QQ / 钉钉共用） ──
  const handleMethodSelect = useCallback(
    (method: 'qrcode' | 'manual') => {
      const channelValue = methodPickerChannel;
      if (!channelValue) return;
      setMethodPickerChannel(null);
      if (method === 'manual') {
        if (channelValue === 'qqbot') {
          setQqModalVisible(true);
          return;
        }
        // 钉钉手动：走 Client ID / Client Secret 表单
        setTokenChannelKind('dingtalk');
        setTokenInput('');
        setTokenInputVisible(false);
        setSecondaryTokenInput('');
        setSecondaryTokenInputVisible(false);
        return;
      }
      // 扫码：复用 HermesQrCodeModal 流程（acli gateway qr-url --platform <channel> --wait true）
      setQrChannel(channelValue);
      setTimeout(() => {
        hermesQrModalRef.current?.startQrCodeFlow();
      }, 0);
    },
    [methodPickerChannel],
  );

  // ── QQ 表单保存 ──
  const handleSaveQQ = useCallback(async () => {
    if (!qqAppId.trim() || !qqSecret.trim()) return;
    const success = await ops.configureChannel({
      channelValue: 'qqbot',
      channelIdValue: qqAppId.trim(),
      channelKeyValue: qqSecret.trim(),
    });
    if (success) {
      message.success({ content: t('QQ 机器人已绑定') });
      setQqModalVisible(false);
      setQqAppId('');
      setQqSecret('');
    } else {
      message.error({ content: t('绑定失败') });
    }
  }, [qqAppId, qqSecret, ops]);

  // ── Token 类通道（Telegram / Discord / Slack / 钉钉）保存 ──
  const handleSaveToken = useCallback(async () => {
    if (!tokenChannelKind || !tokenInput.trim()) return;
    const meta = getTokenChannelMeta(tokenChannelKind);
    // 双凭据通道（Slack / 钉钉）：第二凭据必填
    if (meta.secondaryTokenLabel && !secondaryTokenInput.trim()) return;
    const success = await ops.configureChannel({
      channelValue: tokenChannelKind,
      channelIdValue: tokenInput.trim(),
      channelKeyValue: secondaryTokenInput.trim(),
    });
    if (success) {
      message.success({ content: meta.successMsg });
      setTokenChannelKind(null);
      setTokenInput('');
      setSecondaryTokenInput('');
    } else {
      message.error({ content: t('绑定失败') });
    }
  }, [tokenChannelKind, tokenInput, secondaryTokenInput, ops]);

  // ── 断开确认弹窗 ──
  const [pendingDisconnect, setPendingDisconnect] = useState<{ value: string; name: string } | null>(null);

  const handleDisconnect = useCallback(
    (channelValue: string) => {
      const ch = ops.currentChannelList.find((c) => c.value === channelValue);
      setPendingDisconnect({ value: channelValue, name: ch?.channel_name || channelValue });
    },
    [ops.currentChannelList],
  );

  const confirmDisconnect = useCallback(async () => {
    if (!pendingDisconnect) return;
    const success = await ops.deleteChannel(pendingDisconnect.value);
    setPendingDisconnect(null);
    if (success) {
      message.success({ content: t('已断开连接') });
    } else {
      message.error({ content: t('断开失败') });
    }
  }, [pendingDisconnect, ops]);

  if (ops.loading) {
    return (
      <div className={`${CLS} ${CLS}--loading ${className || ''}`}>
        <div className={`${CLS}__loader`}>{t('加载中...')}</div>
      </div>
    );
  }

  return (
    <div
      className={`${CLS} ${ops.productConfig.isI18n ? `${CLS}--i18n` : ''} ${className || ''}`}
    >
      <h2 className={`${CLS}__title`}>
        {resolveAgentConsoleCollectionLabel('channel', i18n.language, t)}
      </h2>

      {/* 提示条 */}
      <div className={`${CLS}__hint-bar`}>
        <span className={`${CLS}__hint-icon`}>
          <Info size={16} />
        </span>
        <span>{t('配置通道后，即可在聊天软件中与你的云端智能体伙伴对话')}</span>
      </div>

      {afterDescription}

      {/* 通道卡片网格 */}
      <div className={`${CLS}__grid`}>
        {ops.currentChannelList
          .filter((ch) => ch.primaryLabel) // 只展示有 primaryLabel 的通道
          .map((channel) => {
            const isBound = boundChannels.has(channel.value);
            return (
              <div key={channel.value} className={`${CLS}__card ${isBound ? `${CLS}__card--bound` : ''}`}>
                <div className={`${CLS}__card-body`}>
                  <div className={`${CLS}__card-icon`}>
                    <ChannelIcon channel={channel.value} />
                  </div>
                  <div className={`${CLS}__card-content`}>
                    <div className={`${CLS}__card-header`}>
                      <h3 className={`${CLS}__card-name`}>{channel.channel_name}</h3>
                      {isBound && <span className={`${CLS}__card-badge`}>{t('已连接')}</span>}
                    </div>
                    <p className={`${CLS}__card-desc`}>{getChannelDesc(channel.channel)}</p>
                  </div>
                </div>
                <div className={`${CLS}__card-action`}>
                  <div className={`${CLS}__card-action-right`}>
                    {ops.productConfig.isI18n && CHANNEL_GUIDE_LINKS[channel.value] && (
                      <a
                        className={`${CLS}__guide-btn`}
                        href={CHANNEL_GUIDE_LINKS[channel.value]}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('配置教程')}
                      </a>
                    )}
                    {isBound && (
                      <button
                        type="button"
                        className={`${CLS}__card-unbind`}
                        onClick={() => handleDisconnect(channel.value)}
                        disabled={ops.deletingChannel === channel.value}
                        aria-label={t('断开')}
                      >
                        {t('断开')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${CLS}__connect-btn ${isBound ? `${CLS}__connect-btn--reconnect` : ''}`}
                      onClick={() => handleConnect(channel.value)}
                    >
                      {isBound ? t('重新连接') : `+ ${t('连接')}`}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
      </div>

      {/* 连接方式选择弹窗（扫码 / 手动绑定；QQ 与钉钉共用） */}
      {methodPickerChannel && (
        (() => {
          const isDingtalk = methodPickerChannel === 'dingtalk';
          const pickerText = isDingtalk
            ? {
                title: t('选择钉钉连接方式'),
                qrDesc: t('使用钉钉扫描二维码快速绑定，推荐'),
                manualTitle: t('Client ID / Secret 绑定'),
                manualDesc: t('填入钉钉机器人的 Client ID 与 Client Secret'),
              }
            : {
                title: t('选择 QQ 连接方式'),
                qrDesc: t('使用 QQ 扫描二维码快速绑定，推荐'),
                manualTitle: t('App ID / Secret 绑定'),
                manualDesc: t('填入 QQ 机器人的 App ID 与 App Secret'),
              };
          return (
            <div
              className={`${CLS}__modal-overlay`}
              onClick={(e) => {
                if (e.target === e.currentTarget) setMethodPickerChannel(null);
              }}
            >
              <div className={`${CLS}__modal`}>
                <div className={`${CLS}__modal-header`}>
                  <h3 className={`${CLS}__modal-title`}>{pickerText.title}</h3>
                  <p className={`${CLS}__modal-desc`}>{t('请选择适合你的连接方式')}</p>
                </div>
                <div className={`${CLS}__method-list`}>
                  <button
                    type="button"
                    className={`${CLS}__method-card${methodChoice === 'qrcode' ? ` ${CLS}__method-card--active` : ''}`}
                    onClick={() => setMethodChoice('qrcode')}
                  >
                    <div className={`${CLS}__method-title`}>{t('扫码连接')}</div>
                    <div className={`${CLS}__method-desc`}>{pickerText.qrDesc}</div>
                  </button>
                  <button
                    type="button"
                    className={`${CLS}__method-card${methodChoice === 'manual' ? ` ${CLS}__method-card--active` : ''}`}
                    onClick={() => setMethodChoice('manual')}
                  >
                    <div className={`${CLS}__method-title`}>{pickerText.manualTitle}</div>
                    <div className={`${CLS}__method-desc`}>{pickerText.manualDesc}</div>
                  </button>
                </div>
                <div className={`${CLS}__modal-actions`}>
                  <button type="button" className={`${CLS}__btn-outline`} onClick={() => setMethodPickerChannel(null)}>
                    {t('取消')}
                  </button>
                  <button
                    type="button"
                    className={`${CLS}__btn-primary`}
                    onClick={() => handleMethodSelect(methodChoice)}
                  >
                    {t('确认')}
                  </button>
                </div>
              </div>
            </div>
          );
        })()
      )}

      {/* QQ 表单弹窗 */}
      {qqModalVisible && (
        <div
          className={`${CLS}__modal-overlay`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setQqModalVisible(false);
          }}
        >
          <div className={`${CLS}__modal`}>
            <div className={`${CLS}__modal-header`}>
              <h3 className={`${CLS}__modal-title`}>{t('连接 QQ')}</h3>
              <p className={`${CLS}__modal-desc`}>{t('填入 QQ 机器人的 App ID 与 App Secret 完成绑定')}</p>
            </div>
            <div className={`${CLS}__modal-body`}>
              <div className={`${CLS}__modal-field`}>
                <label className={`${CLS}__modal-label`}>{t('App ID')}</label>
                <input
                  className={`${CLS}__modal-input`}
                  value={qqAppId}
                  onChange={(e) => setQqAppId(e.target.value)}
                  placeholder={t('QQ 机器人的 App ID')}
                />
              </div>
              <div className={`${CLS}__modal-field`}>
                <label className={`${CLS}__modal-label`}>{t('App Secret')}</label>
                <div className={`${CLS}__secret-wrap`}>
                  <input
                    className={`${CLS}__modal-input`}
                    type={qqSecretVisible ? 'text' : 'password'}
                    value={qqSecret}
                    onChange={(e) => setQqSecret(e.target.value)}
                    placeholder={t('QQ 机器人的 App Secret')}
                  />
                  <button type="button" className={`${CLS}__secret-eye`} onClick={() => setQqSecretVisible((v) => !v)}>
                    {qqSecretVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>
            <div className={`${CLS}__modal-actions`}>
              <button type="button" className={`${CLS}__btn-outline`} onClick={() => setQqModalVisible(false)}>
                {t('取消')}
              </button>
              <button
                type="button"
                className={`${CLS}__btn-primary`}
                disabled={ops.configuring || !qqAppId.trim() || !qqSecret.trim()}
                onClick={handleSaveQQ}
              >
                {ops.configuring ? t('绑定中...') : t('绑定 QQ 机器人')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 通用 Token 表单弹窗（Telegram / Discord / Slack / 钉钉 共用） */}
      {tokenChannelKind &&
        (() => {
          const meta = getTokenChannelMeta(tokenChannelKind);
          const hasSecondaryToken = !!meta.secondaryTokenLabel;
          const submitDisabled =
            ops.configuring || !tokenInput.trim() || (hasSecondaryToken && !secondaryTokenInput.trim());
          return (
            <div
              className={`${CLS}__modal-overlay`}
              onClick={(e) => {
                if (e.target === e.currentTarget) setTokenChannelKind(null);
              }}
            >
              <div className={`${CLS}__modal`}>
                <div className={`${CLS}__modal-header`}>
                  <h3 className={`${CLS}__modal-title`}>{t('连接 {{name}}', { name: meta.name })}</h3>
                  <p className={`${CLS}__modal-desc`}>
                    {hasSecondaryToken
                      ? t('填入 {{name}} 凭据完成绑定', { name: meta.name })
                      : t('填入 {{label}} 完成绑定', { label: meta.tokenLabel })}
                  </p>
                </div>
                <div className={`${CLS}__modal-body`}>
                  <div className={`${CLS}__modal-field`}>
                    <label className={`${CLS}__modal-label`}>{meta.tokenLabel}</label>
                    <div className={`${CLS}__secret-wrap`}>
                      <input
                        className={`${CLS}__modal-input`}
                        type={tokenInputVisible ? 'text' : 'password'}
                        value={tokenInput}
                        onChange={(e) => setTokenInput(e.target.value)}
                        placeholder={meta.placeholder}
                      />
                      <button
                        type="button"
                        className={`${CLS}__secret-eye`}
                        onClick={() => setTokenInputVisible((v) => !v)}
                      >
                        {tokenInputVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                  {hasSecondaryToken && (
                    <div className={`${CLS}__modal-field`}>
                      <label className={`${CLS}__modal-label`}>{meta.secondaryTokenLabel}</label>
                      <div className={`${CLS}__secret-wrap`}>
                        <input
                          className={`${CLS}__modal-input`}
                          type={secondaryTokenInputVisible ? 'text' : 'password'}
                          value={secondaryTokenInput}
                          onChange={(e) => setSecondaryTokenInput(e.target.value)}
                          placeholder={meta.secondaryPlaceholder}
                        />
                        <button
                          type="button"
                          className={`${CLS}__secret-eye`}
                          onClick={() => setSecondaryTokenInputVisible((v) => !v)}
                        >
                          {secondaryTokenInputVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <div className={`${CLS}__modal-actions`}>
                  <button type="button" className={`${CLS}__btn-outline`} onClick={() => setTokenChannelKind(null)}>
                    {t('取消')}
                  </button>
                  <button
                    type="button"
                    className={`${CLS}__btn-primary`}
                    disabled={submitDisabled}
                    onClick={handleSaveToken}
                  >
                    {ops.configuring ? t('绑定中...') : meta.bindButton}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {/* 断开确认弹窗 */}
      {pendingDisconnect && (
        <div
          className={`${CLS}__modal-overlay`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingDisconnect(null);
          }}
        >
          <div className={`${CLS}__modal`}>
            <h3 className={`${CLS}__modal-title`}>{t('确认断开通道？')}</h3>
            <p className={`${CLS}__modal-desc`}>
              {t('确认断开「{{name}}」通道？断开后将无法通过该通道与智能体对话。', { name: pendingDisconnect.name })}
            </p>
            <div className={`${CLS}__modal-actions`}>
              <button type="button" className={`${CLS}__btn-outline`} onClick={() => setPendingDisconnect(null)}>
                {t('取消')}
              </button>
              <button
                type="button"
                className={`${CLS}__btn-primary ${CLS}__btn-danger`}
                disabled={!!ops.deletingChannel}
                onClick={confirmDisconnect}
              >
                {ops.deletingChannel ? t('断开中...') : t('确认断开')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 扫码弹窗（微信/飞书） */}
      <HermesQrCodeModal
        ref={hermesQrModalRef}
        channel={qrChannel}
        scriptCommands={ops.scriptCommands}
        executor={ops.executor}
        instance={ops.instance}
        isI18n={ops.productConfig.isI18n}
        onSuccess={async () => {
          message.success({ content: t('扫码连接成功') });
          await ops.refresh();
        }}
      />
    </div>
  );
}

// ─── 通道图标 ───

function ChannelIcon({ channel }: { channel: string }) {
  switch (channel) {
    case 'wechat':
    case 'weixin':
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: 'rgba(7, 193, 96, 0.08)' }}>
          <svg width="24" height="24" viewBox="0 0 48 48" fill="none">
            <path
              d="M18.4 7C11.2 7 5.4 11.8 5.4 17.7c0 3.4 1.8 6.4 4.7 8.5l-1.2 3.6 4.2-2.1c1.4.4 2.9.7 4.4.8-.3-1-.5-2-.5-3 0-6.3 6.1-11.4 13.7-11.4.5 0 1 0 1.4.1C30.9 10.3 25.2 7 18.4 7zm-5.9 7.2c-.9 0-1.7-.8-1.7-1.7s.8-1.7 1.7-1.7 1.7.8 1.7 1.7-.8 1.7-1.7 1.7zm10.7 0c-.9 0-1.7-.8-1.7-1.7s.8-1.7 1.7-1.7 1.7.8 1.7 1.7-.8 1.7-1.7 1.7z"
              fill="#07C160"
            />
            <path
              d="M42.6 28.7c0-5.5-5.3-10-11.9-10s-11.9 4.5-11.9 10 5.3 10 11.9 10c1.3 0 2.6-.2 3.8-.6l3.7 1.8-1-3.1c2.5-1.8 4.1-4.5 4.1-7.5h1.3zm-16.2-2.4c-.8 0-1.4-.6-1.4-1.4s.6-1.4 1.4-1.4 1.4.6 1.4 1.4-.6 1.4-1.4 1.4zm8.5 0c-.8 0-1.4-.6-1.4-1.4s.6-1.4 1.4-1.4 1.4.6 1.4 1.4-.6 1.4-1.4 1.4z"
              fill="#07C160"
            />
          </svg>
        </div>
      );
    case 'qqbot':
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: 'rgba(18, 183, 245, 0.08)' }}>
          <img
            src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/43adbcec-a954-4809-9310-1237e3981f99.png"
            alt="QQ"
            className="lh-std-channel-panel__icon-img"
          />
        </div>
      );
    case 'yuanbao':
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: 'rgba(0, 200, 102, 0.08)' }}>
          <YuanbaoIcon size={24} />
        </div>
      );
    case 'wecom':
    case 'wecom-bot':
    case 'wecom-bot-long':
      // 原 SDK 使用 @tencent/tea-icons-react 的 LogoWecomIcon，mono2 未引入该图标包，
      // 改用按企业微信官方品牌视觉重绘的 WecomIcon（见 icons/WecomIcon.tsx）。
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: 'rgba(47, 125, 255, 0.08)' }}>
          <WecomIcon size={24} />
        </div>
      );
    case 'feishu':
    case 'lark':
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: 'rgba(51, 112, 255, 0.08)' }}>
          <FeishuIcon size={24} />
        </div>
      );
    case 'telegram':
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: 'rgba(38, 165, 229, 0.08)' }}>
          <svg width="24" height="24" viewBox="0 0 48 48" fill="none">
            <path
              d="M5.8 23.2l8.6 3.2 3.3 10.8c.2.7 1.1.9 1.6.4l4.8-3.9c.4-.4 1.1-.4 1.5 0l8.7 6.3c.6.4 1.4.1 1.5-.6L42.2 7.4c.2-.8-.6-1.4-1.3-1.1L5.7 21.5c-.8.3-.8 1.4.1 1.7zm11.4 1.7l17.1-10.5c.3-.2.6.2.4.4L21.4 27.1c-.4.4-.7.9-.8 1.5l-.4 3c-.1.5-.7.6-.9.1l-2.6-6c-.2-.4 0-.9.5-1.1v.3z"
              fill="#26A5E5"
            />
          </svg>
        </div>
      );
    case 'discord':
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: 'rgba(88, 101, 242, 0.08)' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.1.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.158-1.085-2.158-2.42 0-1.333.956-2.418 2.158-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.335-.955 2.42-2.157 2.42zm7.974 0c-1.183 0-2.157-1.085-2.157-2.42 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.335-.946 2.42-2.157 2.42z"
              fill="#5865F2"
            />
          </svg>
        </div>
      );
    case 'slack':
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: 'rgba(74, 21, 75, 0.08)' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6.04 14.7a1.87 1.87 0 1 1-1.87-1.87h1.87v1.87zm.94 0a1.87 1.87 0 0 1 3.74 0v4.68a1.87 1.87 0 1 1-3.74 0V14.7z"
              fill="#E01E5A"
            />
            <path
              d="M8.85 6.02a1.87 1.87 0 1 1 1.87-1.87v1.87H8.85zm0 .95a1.87 1.87 0 0 1 0 3.74H4.17a1.87 1.87 0 1 1 0-3.74h4.68z"
              fill="#36C5F0"
            />
            <path
              d="M17.52 8.83a1.87 1.87 0 1 1 1.87 1.87h-1.87V8.83zm-.94 0a1.87 1.87 0 0 1-3.74 0V4.15a1.87 1.87 0 1 1 3.74 0v4.68z"
              fill="#2EB67D"
            />
            <path
              d="M14.71 17.5a1.87 1.87 0 1 1-1.87 1.87v-1.87h1.87zm0-.94a1.87 1.87 0 0 1 0-3.74h4.68a1.87 1.87 0 1 1 0 3.74h-4.68z"
              fill="#ECB22E"
            />
          </svg>
        </div>
      );
    case 'dingtalk':
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: 'rgba(0, 137, 255, 0.08)' }}>
          <svg width="52" height="52" viewBox="0 0 600 380" fill="none" aria-hidden="true">
            <g transform="translate(0,380) scale(0.1,-0.1)" fill="#0089FF" stroke="none">
              <path d="M2273 3195 c-14 -10 -28 -42 -44 -97 -32 -116 -32 -264 0 -368 55 -180 161 -298 416 -462 99 -64 367 -208 387 -208 18 0 34 -18 24 -27 -12 -12 -416 186 -554 271 -48 30 -132 86 -186 125 -55 39 -108 71 -118 71 -25 0 -32 -37 -25 -140 14 -220 165 -424 370 -500 78 -29 233 -67 322 -79 79 -11 93 -16 82 -27 -5 -6 -165 9 -232 21 -76 14 -203 47 -271 71 -41 14 -78 22 -84 19 -35 -22 24 -147 111 -234 67 -67 184 -133 267 -150 29 -6 84 -11 122 -11 39 0 70 -2 70 -4 0 -2 -40 -72 -90 -155 -49 -84 -90 -156 -90 -161 0 -6 49 -10 120 -10 66 0 120 -4 120 -9 0 -5 -37 -69 -81 -143 -235 -384 -243 -398 -224 -398 4 0 219 155 620 448 305 223 375 276 375 283 0 5 -53 9 -117 9 l-116 0 175 178 c196 198 214 228 206 326 -6 76 -29 105 -171 216 -129 102 -245 198 -420 350 -60 52 -144 124 -186 160 -42 36 -216 189 -386 340 -290 258 -351 310 -365 310 -3 0 -15 -7 -27 -15z" />
            </g>
          </svg>
        </div>
      );
    case 'whatsapp':
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: 'rgba(37, 211, 102, 0.08)' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413"
              fill="#25D366"
            />
          </svg>
        </div>
      );
    default:
      return (
        <div className="lh-std-channel-panel__icon-wrap" style={{ background: '#f3f4f6' }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="8" stroke="#9CA3AF" strokeWidth="1.5" fill="none" />
            <path d="M10 6v0m0 3v5" stroke="#9CA3AF" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      );
  }
}
