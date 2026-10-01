'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useOpenClaw } from '@/contexts/agent-context';
import { useSession } from '@/contexts/session-context';
import { journeyHref, resolvePostLoginRoute } from '@/lib/cta-journey';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';

/** 权益快照解析超时：保留当前页并提示重试，不能把未知状态当作未订阅。 */
const ENTITLEMENT_RESOLVE_TIMEOUT_MS = 2500;

/**
 * OAuth 登录是整页跳转（provider → 回跳 → 全新页面加载），回跳后 LoginModal 已关闭，
 * 其「检测到已登录 → onSuccess」的 effect 不会执行，因此不能只靠 onSuccess 分流。
 * 这里用 sessionStorage 把「点登录时希望登录后按订阅状态分流」的意图暂存到回跳之后
 * （与 login-modal 暂存 provider 是同一套思路），回跳后由本 hook 的 effect 消费。
 *
 * 手机验证码登录是在弹窗内完成、不整页跳转的，仍走 onSuccess → redirectAfterLogin。
 */
const POST_LOGIN_REDIRECT_KEY = 'lc_post_login_redirect';
export const REOPEN_PRICING_MODAL_EVENT = 'lightvela:reopen-pricing-modal';
type PostLoginIntent = 'subscribe' | 'pricing-modal';

/** 点击登录动作前调用：标记「登录成功后需要按订阅状态分流」。 */
export const armPostLoginRedirect = (intent: PostLoginIntent = 'subscribe') => {
  try {
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, intent);
  } catch {
    /* sessionStorage 不可用时静默降级：退化为仅弹窗内登录（onSuccess）可分流 */
  }
};

/** 主动关闭登录弹窗、未登录成功时调用：清除分流意图，避免下次误触发。 */
export const disarmPostLoginRedirect = () => {
  try {
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
  } catch {
    /* ignore */
  }
};

const readPostLoginIntent = (): PostLoginIntent | null => {
  try {
    const stored = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
    if (stored === 'pricing-modal') return stored;
    if (stored === 'subscribe' || stored === '1') return 'subscribe';
    return null;
  } catch {
    return null;
  }
};

type PostLoginRedirectOptions = {
  locale: PublicSiteLocale;
  onEntitlementUnavailable?: () => void;
};

/**
 * 登录成功后的统一分流：已订阅 → /agents；未订阅时，普通登录去 /subscribe，
 * 从定价弹窗发起的登录回到原页弹窗。
 *
 * 两条登录路径都覆盖：
 * - 弹窗内登录（手机验证码，不整页跳转）：调用方把返回的 `redirectAfterLogin` 接到
 *   LoginModal 的 `onSuccess` 上，登录成功即触发；
 * - OAuth 整页跳转登录（微信 / QQ / Google 等）：调用方在点登录前调用
 *   `armPostLoginRedirect()`，回跳后由本 hook 在「已登录 + armed」时自动消费分流。
 *
 * 分流前会主动刷新权益快照（GET /v1/passes）并等待其就绪，避免把已订阅用户
 * 误判为未订阅带去再次购买；查询失败或超时保留当前页，由调用方提示重试。
 */
export function usePostLoginRedirect({ locale, onEntitlementUnavailable }: PostLoginRedirectOptions) {
  const router = useRouter();
  const { authReady, isAuthenticated } = useSession();
  const {
    bots,
    hasResolvedPasses,
    isSubscribed,
    passesError,
    passesLoading,
    refreshPasses,
  } = useOpenClaw();
  const [pending, setPending] = useState(false);
  const [refreshFinished, setRefreshFinished] = useState(false);
  const pendingRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshGenerationRef = useRef(0);
  const intentRef = useRef<PostLoginIntent>('subscribe');
  const onEntitlementUnavailableRef = useRef(onEntitlementUnavailable);
  onEntitlementUnavailableRef.current = onEntitlementUnavailable;

  const stopPending = useCallback(() => {
    if (!pendingRef.current) return false;
    pendingRef.current = false;
    setPending(false);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    return true;
  }, []);

  const fail = useCallback(() => {
    if (!stopPending()) return;
    onEntitlementUnavailableRef.current?.();
  }, [stopPending]);

  const complete = useCallback(
    (hasBots: boolean, subscribed: boolean) => {
      if (!stopPending()) return;
      if (!subscribed && intentRef.current === 'pricing-modal') {
        const event = new CustomEvent(REOPEN_PRICING_MODAL_EVENT, { detail: { handled: false } });
        window.dispatchEvent(event);
        if (event.detail.handled) return;
      }
      router.push(
        journeyHref(
          resolvePostLoginRoute({
            isSubscribed: subscribed,
            hasBots,
          }),
          locale,
          {
            localized: isGlobal,
          },
        ),
      );
    },
    [locale, router, stopPending],
  );

  /** 刷新权益快照并进入等待分流态，由下面的 effect 在快照就绪后 complete。 */
  const start = useCallback((intent: PostLoginIntent) => {
    intentRef.current = intent;
    const generation = ++refreshGenerationRef.current;
    setRefreshFinished(false);
    pendingRef.current = true;
    setPending(true);
    void Promise.resolve().then(refreshPasses).then(
      () => { if (generation === refreshGenerationRef.current) setRefreshFinished(true); },
      () => { if (generation === refreshGenerationRef.current) setRefreshFinished(true); },
    );
  }, [refreshPasses]);

  /** 弹窗内登录成功（如手机验证码）回调：消费分流意图并开始分流。 */
  const redirectAfterLogin = useCallback((intent?: PostLoginIntent) => {
    const target = intent ?? readPostLoginIntent() ?? intentRef.current;
    disarmPostLoginRedirect();
    start(target);
  }, [start]);

  /**
   * OAuth 整页跳转回跳后：LoginModal 已关闭、onSuccess 不会触发，
   * 改由这里在「已登录 + 之前 arm 过」时消费一次分流意图。
   * disarm 后 sessionStorage 即被清空，天然保证同一次加载里只有首个实例消费到
   * （订阅页与 Header 可能同时挂载并各自调用本 hook）。
   */
  useEffect(() => {
    if (!authReady || !isAuthenticated) return;
    const intent = readPostLoginIntent();
    if (!intent) return;
    disarmPostLoginRedirect();
    start(intent);
  }, [authReady, isAuthenticated, start]);

  useEffect(() => {
    if (!pending) return;
    // 必须等本次刷新完成，不能用登录前缓存的权益快照分流。
    if (!refreshFinished) return;
    if (passesError) {
      fail();
      return;
    }
    if (passesLoading) return;
    if (!hasResolvedPasses) return;
    complete(bots.length > 0, isSubscribed);
  }, [
    bots.length,
    complete,
    fail,
    hasResolvedPasses,
    isSubscribed,
    passesError,
    passesLoading,
    pending,
    refreshFinished,
  ]);

  useEffect(() => {
    if (!pending) return;
    timeoutRef.current = setTimeout(fail, ENTITLEMENT_RESOLVE_TIMEOUT_MS);
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [fail, pending]);

  return redirectAfterLogin;
}
