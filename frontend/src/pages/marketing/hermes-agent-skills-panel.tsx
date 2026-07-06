import { useEffect, useRef, useState, type CSSProperties, type ComponentType } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/i18n/t";
import { isCN } from "@/lib/region";
import {
  ExpertsPanel,
  type ExpertsExecDebugCommand,
} from "@/pages/marketing/hermes-agent-experts-panel";

type AgentSkillsTab = "skills" | "packages";

function getAgentSkillsTabStyle(isActive: boolean): CSSProperties {
  return {
    color: isActive ? "rgba(0,0,0,0.95)" : "rgba(0,0,0,0.38)",
    fontFamily: "inherit",
    fontSize: "18px",
    fontWeight: 600,
    lineHeight: "24px",
  };
}

function syncInstalledSkillSearchPlaceholder(root: HTMLElement | null, placeholder: string) {
  const input = root?.querySelector<HTMLInputElement>(".lh-std-skill-panel__installed-search-input");
  if (input) {
    input.placeholder = placeholder;
  }
}

export interface HermesAgentSkillsPanelProps<
  TInstance = unknown,
  TFeatureFlags = unknown,
  TProductConfig = unknown,
> {
  botId: string;
  execDebugCommand: ExpertsExecDebugCommand;
  featureFlags: TFeatureFlags;
  initialSectionSlug?: string;
  instance: TInstance;
  productConfig: TProductConfig;
  showSkillPackages?: boolean;
  SkillPanel: ComponentType<{
    instance: TInstance;
    featureFlags: TFeatureFlags;
    productConfig: TProductConfig;
  }>;
}

export function getInitialAgentSkillsTab(
  sectionSlug?: string | null,
  showSkillPackages = isCN,
): AgentSkillsTab {
  if (showSkillPackages && (sectionSlug === "experts" || sectionSlug === "packages")) return "packages";
  return "skills";
}

export function HermesAgentSkillsPanel<
  TInstance,
  TFeatureFlags,
  TProductConfig,
>({
  botId,
  execDebugCommand,
  featureFlags,
  initialSectionSlug,
  instance,
  productConfig,
  showSkillPackages = isCN,
  SkillPanel,
}: HermesAgentSkillsPanelProps<TInstance, TFeatureFlags, TProductConfig>) {
  const t = useT();
  const initialTab = getInitialAgentSkillsTab(initialSectionSlug, showSkillPackages);
  const [activeTab, setActiveTab] = useState<AgentSkillsTab>(initialTab);
  const currentTab: AgentSkillsTab = showSkillPackages ? activeTab : "skills";
  const skillPanelRef = useRef<HTMLDivElement>(null);
  const installedSkillSearchPlaceholder = t("搜索已安装技能名称");

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (currentTab !== "skills") return;
    const root = skillPanelRef.current;
    syncInstalledSkillSearchPlaceholder(root, installedSkillSearchPlaceholder);
    if (!root) return;

    const observer = new MutationObserver(() => {
      syncInstalledSkillSearchPlaceholder(root, installedSkillSearchPlaceholder);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [currentTab, installedSkillSearchPlaceholder]);

  return (
    <Tabs
      value={currentTab}
      onValueChange={(value) => {
        if (value === "skills" || (showSkillPackages && value === "packages")) {
          setActiveTab(value);
        }
      }}
      className="min-w-0"
    >
      <div className="mb-2 flex min-w-0 items-center">
        <TabsList
          aria-label={t("技能页面切换")}
          className="h-auto justify-start gap-8 rounded-none border-0 bg-transparent p-0 text-black/38 shadow-none"
        >
          <TabsTrigger
            value="skills"
            className="min-w-0 rounded-none bg-transparent px-0 py-0 shadow-none transition-colors hover:text-black/70 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            style={getAgentSkillsTabStyle(currentTab === "skills")}
          >
            {t("技能")}
          </TabsTrigger>
          {showSkillPackages ? (
            <TabsTrigger
              value="packages"
              className="min-w-0 rounded-none bg-transparent px-0 py-0 shadow-none transition-colors hover:text-black/70 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              style={getAgentSkillsTabStyle(currentTab === "packages")}
            >
              {t("技能包")}
              <span
                aria-hidden="true"
                className="ml-1.5 inline-flex h-4 items-center rounded-[4px] bg-[#FF4D2E] px-1.5 text-[10px] font-semibold leading-none text-white shadow-[0_3px_8px_rgba(255,77,46,0.22)]"
              >
                NEW
              </span>
            </TabsTrigger>
          ) : null}
        </TabsList>
      </div>

      <TabsContent value="skills" className="mt-0">
        <div ref={skillPanelRef} className="lv-agent-skills-sdk-panel">
          <SkillPanel
            instance={instance}
            featureFlags={featureFlags}
            productConfig={productConfig}
          />
        </div>
      </TabsContent>
      {showSkillPackages ? (
        <TabsContent value="packages" className="mt-0">
          <ExpertsPanel botId={botId} execDebugCommand={execDebugCommand} />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
