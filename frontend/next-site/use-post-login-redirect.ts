'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useOpenClaw } from '@/contexts/agent-context';
import { useSession } from '@/contexts/session-context';
import { journeyHref, resolvePostLoginRoute } from '@/lib/cta-journey';
import { hasEverCreatedBot } from '@/lib/bot-creation-history';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';

/** 权益快照解析超时兜底：超时按未订阅处理，落订阅页（避免卡在中间态）。 */
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

/** 点击登录动作前调用：标记「登录成功后需要按订阅状态分流」。 */
export const armPostLoginRedirect = () => {
  try {
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '1');
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

const isPostLoginRedirectArmed = (): boolean => {
  try {
    return sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY) === '1';
  } catch {
    return false;
  }
};

type PostLoginRedirectOptions = {
  locale: PublicSiteLocale;
};

/**
 * 登录成功后的统一分流：未订阅 → /subscribe，已订阅 → /agents。
 *
 * 两条登录路径都覆盖：
 * - 弹窗内登录（手机验证码，不整页跳转）：调用方把返回的 `redirectAfterLogin` 接到
 *   LoginModal 的 `onSuccess` 上，登录成功即触发；
 * - OAuth 整页跳转登录（微信 / QQ / Google 等）：调用方在点登录前调用
 *   `armPostLoginRedirect()`，回跳后由本 hook 在「已登录 + armed」时自动消费分流。
 *
 * 分流前会主动刷新权益快照（GET /v1/passes）并等待其就绪，避免把已订阅用户
 * 误判为未订阅带去再次购买；2.5s 超时兜底按未订阅处理，避免卡在中间态。
 */
export function usePostLoginRedirect({ locale }: PostLoginRedirectOptions) {
  const router = useRouter();
  const { authReady, isAuthenticated, session } = useSession();
  const {
    bots,
    hasResolvedPasses,
    isSubscribed,
    passesError,
    passesLoading,
    refreshPasses,
  } = useOpenClaw();
  const [pending, setPending] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const complete = useCallback(
    (hasBots: boolean, subscribed: boolean) => {
      setPending(false);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      router.push(
        journeyHref(
          resolvePostLoginRoute({
            isSubscribed: subscribed,
            hasBots,
            hasCreatedBot: hasEverCreatedBot(session?.user?.id),
          }),
          locale,
          {
            localized: isGlobal,
          },
        ),
      );
    },
    [locale, router, session?.user?.id],
  );

  /** 刷新权益快照并进入等待分流态，由下面的 effect 在快照就绪后 complete。 */
  const start = useCallback(() => {
    setPending(true);
    void refreshPasses();
  }, [refreshPasses]);

  /** 弹窗内登录成功（如手机验证码）回调：消费分流意图并开始分流。 */
  const redirectAfterLogin = useCallback(() => {
    disarmPostLoginRedirect();
    start();
  }, [start]);

  /**
   * OAuth 整页跳转回跳后：LoginModal 已关闭、onSuccess 不会触发，
   * 改由这里在「已登录 + 之前 arm 过」时消费一次分流意图。
   * disarm 后 sessionStorage 即被清空，天然保证同一次加载里只有首个实例消费到
   * （订阅页与 Header 可能同时挂载并各自调用本 hook）。
   */
  useEffect(() => {
    if (!authReady || !isAuthenticated) return;
    if (!isPostLoginRedirectArmed()) return;
    disarmPostLoginRedirect();
    start();
  }, [authReady, isAuthenticated, start]);

  useEffect(() => {
    if (!pending) return;
    // 快照拉取中且未失败：继续等，避免用陈旧状态分流。
    if (passesLoading && !passesError) return;
    if (!hasResolvedPasses) return;
    complete(bots.length > 0, isSubscribed);
  }, [
    bots.length,
    complete,
    hasResolvedPasses,
    isSubscribed,
    passesError,
    passesLoading,
    pending,
    session?.user?.id,
  ]);

  useEffect(() => {
    if (!pending) return;
    timeoutRef.current = setTimeout(() => complete(false, false), ENTITLEMENT_RESOLVE_TIMEOUT_MS);
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [complete, pending]);

  return redirectAfterLogin;
}
