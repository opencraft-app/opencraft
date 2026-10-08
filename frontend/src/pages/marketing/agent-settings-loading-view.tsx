import { AgentSidebar } from "@/components/site/agent-sidebar";

function AgentSettingsSkeletonBlock({ className }: { className: string }) {
  return <span className={`block animate-pulse bg-black/[0.045] ${className}`} />;
}

const sidebarGroups = [2, 2, 2, 3, 2] as const;

export function AgentSettingsLoadingContent({ multiBotEnabled = false, isChat = false, collapsed = false }: { multiBotEnabled?: boolean; isChat?: boolean; collapsed?: boolean }) {
  return (
    <div
      className={multiBotEnabled
        ? `lv-agent-settings-grid grid items-start gap-6 lg:gap-x-0 ${collapsed ? "lg:grid-cols-[56px_56px_minmax(0,1fr)]" : "lg:grid-cols-[56px_216px_minmax(0,1fr)]"}`
        : `lv-agent-settings-grid grid items-start gap-6 ${collapsed ? "lg:grid-cols-[56px_minmax(0,1fr)]" : "lg:grid-cols-[248px_minmax(0,1fr)]"}`}
      data-testid="agent-settings-loading-content"
      aria-hidden="true"
    >
      {multiBotEnabled && (
        <div className="lv-agent-bot-rail" data-testid="agent-bot-rail-skeleton">
          <div className="lv-agent-bot-rail-list">
            {Array.from({ length: 4 }).map((_, index) => (
              <span key={index} className="flex size-11 shrink-0 items-center justify-center">
                <AgentSettingsSkeletonBlock className="size-[34px] rounded-full" />
              </span>
            ))}
            <span className="flex size-11 shrink-0 items-center justify-center">
              <span className="size-8 rounded-lg border border-dashed border-[#c4cbd5]" />
            </span>
          </div>
          <div className="lv-agent-bot-rail-management">
            <AgentSettingsSkeletonBlock className="size-5 rounded" />
          </div>
        </div>
      )}
      <AgentSidebar>
        <div className={multiBotEnabled ? "lv-agents-sidebar-profile lg:hidden" : "lv-agents-sidebar-profile"}>
          <div className="lv-agent-profile-wrap">
            <div className="lv-agent-profile">
              <AgentSettingsSkeletonBlock className="size-8 shrink-0 rounded-full" />
              <span className="min-w-0 flex-1 space-y-1">
                <AgentSettingsSkeletonBlock className="h-3.5 w-24 rounded" />
                <span className="flex items-center gap-1.5">
                  <AgentSettingsSkeletonBlock className="size-1.5 rounded-full" />
                  <AgentSettingsSkeletonBlock className="h-3 w-12 rounded" />
                </span>
              </span>
              <span className="flex gap-2">
                <AgentSettingsSkeletonBlock className="size-3.5 rounded" />
                <AgentSettingsSkeletonBlock className="size-3.5 rounded" />
              </span>
            </div>
          </div>
        </div>
        <div className="lv-agents-sidebar-controls">
          <div className="lv-agents-sidebar-tabs">
            <span className="h-8 flex-1 rounded-full bg-white shadow-sm" />
            <AgentSettingsSkeletonBlock className="h-8 flex-1 rounded-full" />
          </div>
        </div>
        <div className="lv-agents-sidebar-middle">
          <div className="flow-root">
            <nav className="lv-agents-nav">
              {(multiBotEnabled ? [3, 1] : sidebarGroups).map((itemCount, groupIndex) => (
                <div key={groupIndex} className="lv-agents-nav-group">
                  {(!multiBotEnabled || groupIndex > 0) && <AgentSettingsSkeletonBlock className="ml-3 h-3 w-10 rounded" />}
                  <ul className="lv-agents-nav-group-items">
                    {Array.from({ length: itemCount }).map((_, itemIndex) => (
                      <li key={itemIndex} className="lv-agents-nav-item">
                        <AgentSettingsSkeletonBlock className="size-3.5 shrink-0 rounded" />
                        <AgentSettingsSkeletonBlock
                          className={`h-3.5 rounded ${groupIndex === 4 && itemIndex === 1 ? "w-28" : "w-16"}`}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </div>
        </div>
        <div className="lv-agents-sidebar-footer">
          <div className="lv-agent-account-footer hidden lg:flex">
            <div className="lv-agent-account-menu">
              <div className="lv-agent-account-trigger">
                <AgentSettingsSkeletonBlock className="size-9 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1 space-y-1.5">
                  <AgentSettingsSkeletonBlock className="h-3.5 w-20 rounded" />
                  <AgentSettingsSkeletonBlock className="h-3 w-28 rounded" />
                </span>
                <AgentSettingsSkeletonBlock className="size-3.5 shrink-0 rounded" />
              </div>
            </div>
          </div>
        </div>
      </AgentSidebar>

      <section className={multiBotEnabled
        ? "lv-agent-settings-content min-w-0 lg:col-start-3 lg:pl-6"
        : "lv-agent-settings-content min-w-0 lg:col-start-2"}>
        {isChat ? (
          <div className="mx-auto flex min-h-[60dvh] w-full max-w-[800px] flex-col items-center justify-center lg:min-h-[calc(100dvh-60px)]" data-testid="agent-chat-loading-canvas">
            <AgentSettingsSkeletonBlock className="h-8 w-72 max-w-full rounded" />
            <div className="mt-8 w-full rounded-2xl border border-black/[0.06] bg-white p-4">
              <AgentSettingsSkeletonBlock className="h-4 w-56 max-w-full rounded" />
              <div className="mt-16 flex items-center gap-3">
                <AgentSettingsSkeletonBlock className="size-6 rounded" />
                <AgentSettingsSkeletonBlock className="h-6 w-20 rounded-full" />
                <AgentSettingsSkeletonBlock className="ml-auto size-8 rounded-lg" />
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <AgentSettingsSkeletonBlock className="h-6 w-20 rounded" />
              <AgentSettingsSkeletonBlock className="h-4 w-96 max-w-full rounded" />
            </div>

            <div className="mt-5 overflow-hidden rounded-xl border border-black/[0.08] bg-white">
              <div className="px-5 py-5">
                <AgentSettingsSkeletonBlock className="h-5 w-28 rounded" />
              </div>
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="flex min-h-14 items-center gap-4 border-t border-black/[0.06] px-5 py-4">
                  <AgentSettingsSkeletonBlock className="size-3.5 shrink-0 rounded" />
                  <AgentSettingsSkeletonBlock className={`h-4 rounded ${index === 1 ? "w-52" : "w-36"}`} />
                  {index === 0 ? <AgentSettingsSkeletonBlock className="ml-auto h-6 w-20 rounded-full" /> : null}
                </div>
              ))}
            </div>

            <div className="mt-5 rounded-xl border border-black/[0.08] bg-white p-5">
              <div className="flex gap-6 border-b border-black/[0.06] pb-4">
                <AgentSettingsSkeletonBlock className="h-5 w-28 rounded" />
                <AgentSettingsSkeletonBlock className="h-5 w-20 rounded" />
                <AgentSettingsSkeletonBlock className="h-5 w-24 rounded" />
              </div>
              <AgentSettingsSkeletonBlock className="mt-6 h-14 w-full rounded-lg" />
              <AgentSettingsSkeletonBlock className="mt-4 h-14 w-full rounded-lg" />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
