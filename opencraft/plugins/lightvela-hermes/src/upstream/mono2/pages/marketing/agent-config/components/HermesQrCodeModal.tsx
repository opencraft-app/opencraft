// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * @fileoverview HermesQrCodeModal — Hermes 镜像专用扫码弹窗（acli 流式协议）
 *
 * 受控 Radix Dialog 管理展示和焦点；流式请求和关闭时机仍由本容器管理。
 *
 * 协议：acli `gateway qr-url --platform X --wait true` 以 NDJSON 流式输出，
 * 每行一个 JSON 对象，带 `status: 'pending'|'success'|'failed'` + `url` 字段。
 *
 * 对外暴露 2 个流程入口（语义对齐 tea-app-lighthouse master 的同名函数）：
 *  1. `startQrCodeFlow`：通用扫码（weixin/feishu/qqbot/whatsapp/yuanbao/dingtalk），
 *     走 acli `gateway qr-url`；元宝额外注入 `--bind-id <InstanceId> --ip <PublicAddress>`
 *  2. `startWecomAuthFlow`：企业微信 OAuth 授权流，
 *     走 `useWecomAIBotSDK.openAuth` + `acli configure gateway wecom`；不弹扫码弹窗
 *
 * 调用方按 channel 自行分派：
 *   channel === 'wecom' ? handle.startWecomAuthFlow() : handle.startQrCodeFlow()
 */

import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { HermesQrDialogView } from './hermes-qr-dialog-view';
import { t } from "../../../../i18n/t";
import { message } from '../utils/message';
import { parseHermesQrStream } from "../utils/hermes-parsers";
import { useWecomAIBotSDK } from '../hooks/useWecomAIBotSDK';
import type { AgentScriptCommands } from "../hermes-command-builder";
import type { ICommandExecutor } from '../local-command-executor';
import type { IInstanceInfo } from '../types';

export type HermesQrUiStatus = 'init' | 'loading' | 'ready' | 'expired' | 'failed' | 'success';

export interface IHermesQrCodeModalProps {
  channel: string;
  scriptCommands: AgentScriptCommands;
  executor: ICommandExecutor;
  instance: IInstanceInfo;
  /**
   * 是否国际站，默认 false（国内站）。
   * 仅影响飞书扫码时透传给 acli 的 `--greeting`（中 / 英）。
   */
  isI18n?: boolean;
  onSuccess?: () => Promise<void> | void;
  onStatusChange?: (status: HermesQrUiStatus) => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

export interface IHermesQrCodeModalHandle {
  /**
   * 通用扫码流程：weixin / feishu / qqbot / whatsapp / yuanbao
   *
   * 走 `acli gateway qr-url --platform X --wait true` 流式协议，
   * 元宝额外注入 `--bind-id <InstanceId> --ip <PublicAddress>`。
   */
  startQrCodeFlow: () => Promise<void>;
  /**
   * 企业微信 OAuth 授权流程
   *
   * 不走扫码弹窗：openAuth 弹出原生 OAuth 窗口拿 botId/secret，
   * 然后 `acli configure gateway wecom` 写入配置；语义对齐 tea-app-lighthouse master。
   */
  startWecomAuthFlow: () => Promise<void>;
}

function getWecomAuthErrorMessage(error: any): string {
  switch (error?.code) {
    case 'WINDOW_BLOCKED':
      return t('企业微信授权窗口被浏览器拦截，请允许弹窗后重试');
    case 'INVALID_SOURCE':
      return t('企业微信授权 source 无效，请检查接入配置');
    case 'ACCESS_DENIED':
      return t('企业微信授权被拒绝，请确认后重试');
    case 'AUTH_TIMEOUT':
      return t('企业微信授权超时，请重试');
    default:
      return error?.message || t('企业微信机器人创建失败，请重试');
  }
}

export const HermesQrCodeModal = forwardRef<IHermesQrCodeModalHandle, IHermesQrCodeModalProps>(
  ({ channel, scriptCommands, executor, instance, isI18n, onSuccess, onStatusChange, returnFocusRef }, ref) => {
    const [visible, setVisible] = useState(false);
    const [qrUrl, setQrUrl] = useState('');
    const [status, setStatus] = useState<HermesQrUiStatus>('init');
    const { openAuth: openWecomBotAuth } = useWecomAIBotSDK();

    const qrUrlRef = useRef('');
    const flowIdRef = useRef(0);
    // 同步跟踪最新 status，避免 async 函数闭包捕获旧 state 值
    const statusRef = useRef<HermesQrUiStatus>('init');

    const updateStatus = (next: HermesQrUiStatus) => {
      statusRef.current = next;
      setStatus(next);
      onStatusChange?.(next);
    };

    const resetState = () => {
      qrUrlRef.current = '';
      setQrUrl('');
      updateStatus('init');
    };

    const closeModal = () => {
      setVisible(false);
      resetState();
    };

    const startQrCodeFlow = async () => {
      const SUPPORTED_QR_PLATFORMS = ['weixin', 'feishu', 'qqbot', 'whatsapp', 'yuanbao', 'dingtalk'] as const;
      type SupportedPlatform = (typeof SUPPORTED_QR_PLATFORMS)[number];
      const platform: SupportedPlatform = (SUPPORTED_QR_PLATFORMS as readonly string[]).includes(channel)
        ? (channel as SupportedPlatform)
        : 'weixin';

      flowIdRef.current += 1;
      const currentFlowId = flowIdRef.current;
      const isFlowValid = () => flowIdRef.current === currentFlowId;

      qrUrlRef.current = '';
      setQrUrl('');
      setVisible(true);
      updateStatus('loading');

      try {
        const command = scriptCommands.hermes.channel.getQrUrlCommand({
          platform,
          isI18n,
          // 元宝扫码：bindId 取实例 ID，ip 取实例公网 IP（对齐 lighthouse master）
          bindId: platform === 'yuanbao' ? instance?.InstanceId : undefined,
          ip: platform === 'yuanbao' ? instance?.PublicAddresses?.[0] : undefined,
        });

        const result = await executor.runWithProgress({
          command,
          timeout: 180,
          maxRetries: 180,
          onProgress: (decoded) => {
            if (!isFlowValid()) return;
            // acli 流式协议：每行一个 JSON，parseHermesQrStream 从后往前取最新行
            const line = parseHermesQrStream(decoded);
            if (!line) return;

            if (line.status === 'failed') {
              updateStatus('failed');
              return;
            }
            if (line.status === 'success') {
              // 扫码成功，关闭弹窗
              updateStatus('success');
              setVisible(false);
              resetState();
              onSuccess?.();
              return;
            }
            // status === 'pending'：二维码 URL 就绪
            if (line.url && !qrUrlRef.current) {
              qrUrlRef.current = line.url;
              setQrUrl(line.url);
              updateStatus('ready');
            }
          },
        });

        if (!isFlowValid()) return;

        // acli 流式协议：ready/success/failed 状态已在 onProgress 中处理；
        // 这里只在"还卡在 loading（即始终没收到任何 pending/success/failed 行）"
        // 且 TAT 层也返回失败时，才判定为过期。
        // 必须通过 statusRef 读取最新状态——此处处于 async 函数中，
        // 闭包里的 status state 是函数启动时的快照，onProgress 中的更新不会反映到 status 变量。
        // 不能用"!== success && !== failed"判断：success 分支会调用 resetState()
        // 将 statusRef 重置为 'init'，届时条件仍会命中，导致成功被误标为过期。
        if (!result.success && statusRef.current === 'loading') {
          updateStatus('expired');
        }
      } catch (error) {
        if (!isFlowValid()) return;
        console.error('[HermesQrCodeModal] startQrCodeFlow failed:', error);
        updateStatus('failed');
      }
    };

    /**
     * 企业微信 OAuth 授权流程（对齐 tea-app-lighthouse master 的 startWecomAuthFlow）
     *
     * 与 startQrCodeFlow 平级、独立的流程：不弹扫码弹窗，直接调起企微 OAuth 窗口拿
     * botId/secret，再用 acli `configure gateway wecom` 写入配置。
     */
    const startWecomAuthFlow = async () => {
      flowIdRef.current += 1;
      const currentFlowId = flowIdRef.current;
      const isFlowValid = () => flowIdRef.current === currentFlowId;

      qrUrlRef.current = '';
      setQrUrl('');
      setVisible(false);
      updateStatus('loading');

      try {
        const botInfo = await openWecomBotAuth();
        if (!isFlowValid()) return;

        const normalizedBotInfo = botInfo as { botId?: string; botid?: string; secret?: string };
        const botId = normalizedBotInfo?.botId || normalizedBotInfo?.botid;
        const secret = normalizedBotInfo?.secret;
        if (!botId || !secret) {
          updateStatus('failed');
          message.error({ content: t('企业微信授权结果缺少 botId 或 secret，请重试') });
          return;
        }

        const result = await executor.run({
          command: scriptCommands.hermes.channel.getWecomConfigCommand({
            appId: botId,
            clientSecret: secret,
          }),
        });

        if (!isFlowValid()) return;
        if (result.success) {
          updateStatus('success');
          onSuccess?.();
        } else {
          updateStatus('failed');
          message.error({ content: t('企业微信配置写入失败，请重试') });
        }
      } catch (error) {
        if (!isFlowValid()) return;
        if ((error as { code?: string } | null)?.code === 'CANCELLED') {
          resetState();
          return;
        }
        updateStatus('failed');
        message.error({ content: getWecomAuthErrorMessage(error) });
      }
    };

    useImperativeHandle(ref, () => ({ startQrCodeFlow, startWecomAuthFlow }), [
      channel,
      scriptCommands,
      executor,
      openWecomBotAuth,
    ]);

    const getTitle = () => {
      if (status === 'loading') return t('正在生成二维码...');
      if (status === 'ready') {
        if (channel === 'feishu') return t('请使用飞书扫码完成授权');
        if (channel === 'yuanbao') return t('请使用元宝 App 扫码完成授权');
        if (channel === 'qqbot') return t('请使用 QQ 扫码完成授权');
        if (channel === 'whatsapp') return t('请使用 WhatsApp 扫码完成授权');
        if (channel === 'dingtalk') return t('请使用钉钉扫码完成授权');
        return t('请使用微信扫码完成授权');
      }
      if (status === 'expired') return t('二维码已过期');
      if (status === 'failed') return t('获取二维码失败');
      return '';
    };

    const getDescription = () => {
      if (status === 'ready') {
        if (channel === 'feishu') return t('扫码后请在飞书上确认授权');
        if (channel === 'yuanbao') return t('扫码后请在元宝 App 上点击确认');
        if (channel === 'qqbot') return t('扫码后请在 QQ 上确认授权');
        if (channel === 'whatsapp') return t('扫码后请在 WhatsApp 上确认授权');
        if (channel === 'dingtalk') return t('扫码后请在钉钉上确认授权');
        return t('扫码后请在微信上确认授权');
      }
      if (status === 'expired') return t('二维码已超时失效，请点击重试重新获取');
      if (status === 'failed') return t('配置失败，请重试或检查网络连接');
      return undefined;
    };

    return <HermesQrDialogView open={visible} onOpenChange={(open) => { if (!open) closeModal(); }}
      title={getTitle()} description={getDescription()} status={status} qrUrl={qrUrl}
      closeLabel={t('关闭')} retryLabel={t('重试')} loadingLabel={t('加载中')}
      returnFocusRef={returnFocusRef} onRetry={() => void startQrCodeFlow()} />;
  },
);

export default HermesQrCodeModal;
