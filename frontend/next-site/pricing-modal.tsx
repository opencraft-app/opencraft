'use client';

import React from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n/t';
import { SubscribePage } from '@next-site/subscribe-page';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

export type PricingModalProps = {
  open: boolean;
  locale?: PublicSiteLocale;
  localized?: boolean;
  /** 宿主页收到支付回跳时置 true：由弹窗内的实例接棒等发货、建实例、跳控制台。 */
  resumePayReturn?: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * 定价弹窗：除顶部导航「价格」以外的转化入口（首页 CTA / 页脚试用 / 登录回跳等）
 * 在当前页面打开，用户可直接关闭并留在原页面。
 *
 * 内容复用订阅页的套餐区（单一真源，不复制第二套价表）；下单仍沿用订阅页既有链路。
 */
export function PricingModal({ open, locale, localized, resumePayReturn, onOpenChange }: PricingModalProps) {
  const t = useT();
  return (
    <Dialog open={open} modal={false} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t('关闭')}
        className="z-[70] overflow-hidden p-0 md:w-[min(56rem,calc(100vw-2rem))] [&>button]:right-2 [&>button]:top-2 [&>button]:size-11"
        nonModalOverlay
        onInteractOutside={(event) => event.preventDefault()}
        overlayClassName="z-[70]"
        data-testid="pricing-modal"
      >
        <DialogTitle className="sr-only">{t('选择适合你的套餐')}</DialogTitle>
        <div className="max-h-[90dvh] overflow-y-auto overscroll-contain">
          <SubscribePage
            embedded
            resumePayReturn={resumePayReturn}
            publicLocale={locale}
            publicLocalized={localized}
            onClose={() => onOpenChange(false)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
