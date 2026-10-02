import { describe, expect, it } from 'vitest';

import {
  CTA_COPY_BY_LOCALE,
  getCtaCopy,
  journeyHref,
  JOURNEY_ROUTE,
  resolveCtaRoute,
  resolvePostLoginRoute,
} from '@/lib/cta-journey';
import { AGENTS_HOME_PATH, SUBSCRIBE_PATH } from '@/lib/agent-routes';

describe('resolvePostLoginRoute', () => {
  it('sends unsubscribed users to the subscribe page', () => {
    expect(resolvePostLoginRoute({ isSubscribed: false, hasBots: false })).toBe(JOURNEY_ROUTE.SUBSCRIBE);
    expect(resolvePostLoginRoute({ isSubscribed: false, hasBots: true })).toBe(JOURNEY_ROUTE.SUBSCRIBE);
  });

  it('sends subscribed users to the console', () => {
    expect(resolvePostLoginRoute({ isSubscribed: true, hasBots: true })).toBe(JOURNEY_ROUTE.AGENTS);
  });

  it('never leaves a subscribed user without an agent creation entry', () => {
    expect(resolvePostLoginRoute({ isSubscribed: true, hasBots: false })).toBe(JOURNEY_ROUTE.AGENTS_CREATING);
  });

});

describe('resolveCtaRoute', () => {
  it('keeps anonymous visitors on the subscribe journey', () => {
    expect(resolveCtaRoute({ isAuthenticated: false, isSubscribed: false, hasBots: false })).toBe(
      JOURNEY_ROUTE.SUBSCRIBE,
    );
  });

  it('keeps signed-in but unsubscribed visitors on the subscribe journey', () => {
    expect(resolveCtaRoute({ isAuthenticated: true, isSubscribed: false, hasBots: false })).toBe(
      JOURNEY_ROUTE.SUBSCRIBE,
    );
  });

  it('sends subscribed visitors straight to the console', () => {
    expect(resolveCtaRoute({ isAuthenticated: true, isSubscribed: true, hasBots: true })).toBe(
      JOURNEY_ROUTE.AGENTS,
    );
  });

  it('sends any subscribed account without a current Bot to creation', () => {
    expect(resolveCtaRoute({ isAuthenticated: true, isSubscribed: true, hasBots: false })).toBe(
      JOURNEY_ROUTE.AGENTS_CREATING,
    );
  });
});

describe('journeyHref', () => {
  it('maps routes to their canonical paths', () => {
    expect(journeyHref(JOURNEY_ROUTE.SUBSCRIBE, 'zh-CN')).toBe(SUBSCRIBE_PATH);
    expect(journeyHref(JOURNEY_ROUTE.AGENTS, 'zh-CN')).toBe(AGENTS_HOME_PATH);
    expect(journeyHref(JOURNEY_ROUTE.AGENTS_CREATING, 'zh-CN')).toBe('/agents?create=1');
  });

  it('only adds a language prefix for the global site', () => {
    expect(journeyHref(JOURNEY_ROUTE.SUBSCRIBE, 'es', { localized: true })).toBe('/es/subscribe');
    expect(journeyHref(JOURNEY_ROUTE.SUBSCRIBE, 'es', { localized: false })).toBe('/subscribe');
    // 产品壳使用统一路由，创建意图不能丢失或误变成等待已有实例。
    expect(journeyHref(JOURNEY_ROUTE.AGENTS_CREATING, 'es', { localized: true })).toBe('/agents?create=1');
  });
});

describe('CTA copy', () => {
  it('keeps Hero and Footer copy identical for a given state', () => {
    const subscribed = { isAuthenticated: true, isSubscribed: true };
    const guest = { isAuthenticated: false, isSubscribed: false };

    expect(getCtaCopy('zh-CN', subscribed)).toBe('我的智能体伙伴');
    expect(getCtaCopy('zh-CN', guest)).toBe('免费试用');
    expect(getCtaCopy('en-US', subscribed)).toBe('My AI Companion');
    expect(getCtaCopy('en-US', guest)).toBe('Free trial');
  });

  it('uses one English casing for every locale entry', () => {
    expect(CTA_COPY_BY_LOCALE['en-US'].myCompanion).toBe('My AI Companion');
    expect(CTA_COPY_BY_LOCALE['en-US'].startFree).toBe('Free trial');
    for (const copy of Object.values(CTA_COPY_BY_LOCALE)) {
      expect(copy.myCompanion).not.toContain('My AI companion');
    }
  });

  /**
   * 回归防护：非中英文语种的翻译必须原样取自
   * `scripts/import-international-homepage.mjs` 里已经上线的
   * "Free trial"（英文）/ "My AI Companion" 官方译文（首页已有按钮在用），
   * 不能自造或套用旧版「免费试用 / Free Trial」概念的翻译。
   * 曾经踩过这个坑：id-ID / es / ja-JP / ko-KR 的 startFree 一度被错误
   * 写成了旧 "Free Trial" 概念的机翻文案，跟首页实际按钮文案不一致。
   */
  it('matches the official translations already shipped on the international homepage', () => {
    expect(CTA_COPY_BY_LOCALE['id-ID']).toEqual({ startFree: 'Mulai gratis', myCompanion: 'Pendamping AI saya' });
    expect(CTA_COPY_BY_LOCALE.es).toEqual({ startFree: 'Empieza gratis', myCompanion: 'Mi compañero de IA' });
    expect(CTA_COPY_BY_LOCALE['ja-JP']).toEqual({ startFree: '無料で開始', myCompanion: '私のAIパートナー' });
    expect(CTA_COPY_BY_LOCALE['ko-KR']).toEqual({ startFree: '무료 시작', myCompanion: '내 AI 파트너' });
  });

  /**
   * 边界条件（工蜂 AI CR 建议）：Map 对象访问要用可选链 + 兜底，
   * 即使传入非法/未收录的 locale 也必须返回字符串，不能是 undefined。
   */
  it('falls back to en-US copy for an unregistered locale', () => {
    const guest = { isAuthenticated: false, isSubscribed: false };
    expect(getCtaCopy('fr-FR' as never, guest)).toBe(CTA_COPY_BY_LOCALE['en-US'].startFree);
  });
});
