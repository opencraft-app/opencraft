'use client';

import React, { Suspense } from 'react';

import { AgentSidebarToggle, useAgentSidebarCollapse } from '@/components/site/agent-sidebar';
import { ProductReturnHomeHeader } from '@/components/site/product-chrome';
import type { AgentSectionId, AgentSettingsSectionId } from '@/lib/agent-routes';
import { EmbeddedChatPreparation } from '@/lib/opencraft-embedded-connection';

import { AgentsRouteLoading, AppRouteShell, NextAgentEntitlementGate } from './app-route-shell';

const AgentSettingsPage = React.lazy(() => import('@/pages/marketing/agent-settings-page').then(
  (module) => ({ default: module.AgentSettingsPage }),
));
const AgentsWorkbenchPage = React.lazy(() => import('@/pages/marketing/agents-workbench/AgentsWorkbenchPage').then(
  (module) => ({ default: module.AgentsWorkbenchPage }),
));

export function AgentsPageClient({
  initialSectionSlug,
  sectionId,
}: {
  initialSectionSlug?: string;
  sectionId?: AgentSectionId;
}) {
  const isWorkbench = sectionId === 'workbench';
  const { collapsed, toggle, transitionReady } = useAgentSidebarCollapse();
  const productHeader = (
    <ProductReturnHomeHeader
      beforeUserMenu={isWorkbench ? undefined : <AgentSidebarToggle collapsed={collapsed} onToggle={toggle} />}
      className={isWorkbench ? undefined : `lv-agent-sidebar-header${collapsed ? ' lv-agent-sidebar-header--collapsed' : ''}${transitionReady ? '' : ' lv-agent-sidebar-header--motion-pending'}`}
      reloadLanguageAfterSwitch
      showAccountLanguageSwitcher
      showDesktopUserMenu={isWorkbench}
      showLanguageSwitcher={false}
    />
  );
  const loadingFallback = isWorkbench ? productHeader : <AgentsRouteLoading collapsed={collapsed} onToggle={toggle} isChat={!sectionId || sectionId === 'chat'} />;

  return (
    <AppRouteShell loadingFallback={loadingFallback} showAuthGateFooter={false}>
      <EmbeddedChatPreparation active={sectionId === 'chat'}>
      <NextAgentEntitlementGate loadingFallback={loadingFallback}>
        <Suspense fallback={loadingFallback}>
          {productHeader}
          {isWorkbench ? (
            <AgentsWorkbenchPage />
          ) : (
            <AgentSettingsPage
              initialSectionSlug={initialSectionSlug}
              sectionId={sectionId as AgentSettingsSectionId | undefined}
              showHeader={false}
              sidebarCollapsed={collapsed}
            />
          )}
        </Suspense>
      </NextAgentEntitlementGate>
      </EmbeddedChatPreparation>
    </AppRouteShell>
  );
}
