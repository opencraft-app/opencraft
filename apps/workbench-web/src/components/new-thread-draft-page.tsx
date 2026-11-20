import { type WorkspacePlacementControl } from './workspace-placement-picker';
import type { AttachmentResolver } from "@opencraft/composer-editor";
import { useObservedReadiness } from '../runtime/observability-react';
import { ThreadGoalSurface } from "./thread-goal-surface";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { ThreadComposerPresentation } from "./thread-composer-presentation";
import { OpenCraftComposer, type OpenCraftComposerHandle, type ComposerEffectiveSelections, type ComposerSelectionCatalog, type ComposerShortcutCommand } from "@opencraft/composer-editor";
import type { ComposerAttachment, ComposerCatalog, ComposerController, ComposerFollowUpAction, SubmitIntent } from "@opencraft/composer-core";
import { draftSubmissionOwnsNavigation, type MachineResourceLifecycle, type NewThreadDraftSnapshot, type ThreadGoalResource } from "@opencraft/workbench-runtime";
import { type ReactNode, lazy, Suspense, useEffect, useRef } from "react";
import { type DraftWorkspaceOption } from "../runtime/draft-workspace-model";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";

// Only the execution menus suspend; the editor and its controller stay mounted.
const ExecutionUtilityBar = lazy(() => import('./draft-execution-utility-bar').then(module => ({
  default: module.ExecutionUtilityBar,
})));

export interface DraftHostOption {
  readonly id: string;
  readonly hostIds: readonly string[];
  readonly label: string;
  readonly platform: "macos" | "linux" | "windows" | null;
  readonly resource: MachineResourceLifecycle | null;
  readonly cloud: boolean;
  readonly role: "local" | "server" | "cloud";
  readonly connectable: boolean;
}

export interface NewThreadDraftPageProps {
  activeTabId?: string | null;
  composerPresentationEnabled?: boolean;
  readonly placeholder?: string;
  readonly placeholderPending?: boolean;
  readonly heading?: string;
  readonly setupNotice?: ReactNode;
  readonly setupBlocksSubmission?: boolean;
  readonly draft: NewThreadDraftSnapshot;
  readonly controller: ComposerController;
  readonly goals?: ThreadGoalResource;
  readonly onCreateGoal?: (objective: string) => Promise<void>;
  readonly selectionCatalog: ComposerSelectionCatalog;
  readonly resolveAgentCycleShortcut?: (event: KeyboardEvent) => -1 | 0 | 1;
  readonly catalog: ComposerCatalog;
  readonly effectiveSelections?: ComposerEffectiveSelections;
  readonly modelSelectionPolicy?: import("@opencraft/composer-core").ModelSelectionPolicy;
  readonly personalDefaultsPending?: boolean;
  readonly placement?: WorkspacePlacementControl;
  readonly workspaceOptions: readonly DraftWorkspaceOption[];
  readonly workspaceOptionsLoading?: boolean;
  readonly nativeWorkspacePicking?: boolean;
  readonly showExecutionControls?: boolean;
  readonly activeHostId: string;
  readonly hostOptions: readonly DraftHostOption[];
  readonly connectionPhase: string;
  readonly onSelectHost: (hostId: string) => void | Promise<void>;
  readonly onSelectWorkspace: (workspace: DraftWorkspaceOption) => void;
  readonly onBrowseWorkspace: () => void | Promise<void>;
  readonly onResolveAttachment?: AttachmentResolver;
  readonly onRemoveAttachment?: (
    attachment: ComposerAttachment,
  ) => void | Promise<void>;
  readonly composerAddMenuContent?: ReactNode | ((closeMenu: () => void) => ReactNode);
  readonly composerEndActions?: ReactNode;
  readonly composerTrailingActions?: ReactNode;
  readonly shortcutCommands?: readonly ComposerShortcutCommand[];
  readonly onSubmit: (
    intent: SubmitIntent,
    context: { readonly followUpAction: ComposerFollowUpAction | null },
  ) => boolean | void | Promise<boolean | void>;
}

export function NewThreadDraftPage({
  activeTabId = null,
  composerPresentationEnabled = true,
  placeholder,
  placeholderPending,
  heading,
  setupNotice,
  setupBlocksSubmission = false,
  draft,
  controller,
  goals,
  onCreateGoal,
  selectionCatalog,
  catalog,
  effectiveSelections,
  modelSelectionPolicy,
  placement,
  workspaceOptions,
  workspaceOptionsLoading = false,
  nativeWorkspacePicking = false,
  showExecutionControls = true,
  activeHostId,
  hostOptions,
  connectionPhase,
  onSelectHost,
  onSelectWorkspace,
  onBrowseWorkspace,
  onResolveAttachment,
  onRemoveAttachment,
  composerAddMenuContent,
  composerEndActions,
  composerTrailingActions,
  shortcutCommands,
  resolveAgentCycleShortcut,
  personalDefaultsPending = false,
  onSubmit,
}: NewThreadDraftPageProps) {
  const intl = useIntl();
  const composerRef = useRef<OpenCraftComposerHandle>(null);
  useObservedReadiness(draft.scopeId, connectionPhase === 'ready' && !personalDefaultsPending && !setupBlocksSubmission && !draftSubmissionOwnsNavigation(draft.phase));
  const portalContainer = useWorkbenchPresentationRoot();

  if (draft.submission !== null) {
    throw new Error(
      `Conversation ${draft.scopeId} already owns its first Turn and cannot render a Draft Composer`,
    );
  }

  useEffect(() => {
    const animationFrame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(animationFrame);
  }, [draft.id]);


  const composer = (goalMenuItem: ((closeMenu: (afterClose?: () => void) => void) => ReactNode) | null, goalBusy = false, goalContent: ReactNode = null) => <OpenCraftComposer
    attachedContent={goalContent}
    ref={composerRef}
    portalContainer={portalContainer}
    controller={controller}
    chromeHeader={showExecutionControls ? (
      <Suspense fallback={null}><ExecutionUtilityBar
        portalContainer={portalContainer}
        draft={draft}
        placement={placement}
        workspaceOptions={workspaceOptions}
        workspaceOptionsLoading={workspaceOptionsLoading}
        nativeWorkspacePicking={nativeWorkspacePicking}
        activeHostId={activeHostId}
        hostOptions={hostOptions}
        connectionPhase={connectionPhase}
        onSelectHost={onSelectHost}
        onSelectWorkspace={onSelectWorkspace}
        onBrowseWorkspace={onBrowseWorkspace}
        onReturnFocus={() => composerRef.current?.focus()}
      /></Suspense>
    ) : undefined}
    disabled={goalBusy || draftSubmissionOwnsNavigation(draft.phase)}
    submissionDisabled={connectionPhase !== "ready" || personalDefaultsPending || setupBlocksSubmission}
    isStreaming={false}
    isRecovering={placeholderPending === true}
    isUnstable={connectionPhase === "reconnecting"}
    placeholderPending={placeholderPending}
    placeholder={placeholder ?? intl.formatMessage({ id: "chat.companionPlaceholder", defaultMessage: "Share your thoughts, or ask me to help with something" })}
    onResolveAttachment={onResolveAttachment}
    onRemoveAttachment={onRemoveAttachment}
    addMenuContent={goalMenuItem === null ? composerAddMenuContent : closeMenu => <>
      {typeof composerAddMenuContent === "function" ? composerAddMenuContent(closeMenu) : composerAddMenuContent}
      {goalMenuItem(closeMenu)}
    </>}
    shortcutCommands={shortcutCommands}
    navigationActions={composerTrailingActions}
    endActions={composerEndActions}
    selectionCatalog={selectionCatalog}
    resolveAgentCycleShortcut={resolveAgentCycleShortcut}
    catalog={catalog}
    mentionSuggestionsEnabled={false}
    effectiveSelections={effectiveSelections}
    modelSelectionPolicy={modelSelectionPolicy}
    onSubmit={onSubmit}
    onCancel={() => undefined}
  />;

  return (
    <div
      className="new-thread-draft-page"
      data-new-thread-draft-id={draft.id}
      data-new-thread-draft-phase={draft.phase}
    >
      <main className="new-thread-draft-main" aria-label={intl.formatMessage({ id: "draft.mainContent", defaultMessage: "Main content" })}>
        <div className="new-thread-draft-layout">
          <section className="new-thread-draft-hero" aria-labelledby="new-thread-heading">
            <h1 id="new-thread-heading">{heading ?? <FormattedMessage id="draft.heading" defaultMessage="What should we work on?" />}</h1>
          </section>
          {setupNotice}
          <section className="new-thread-draft-composer-zone" aria-label={intl.formatMessage({ id: "draft.startNewTask", defaultMessage: "Start a new task" })}>
            <div className="thread-layout-width new-thread-draft-composer-width">
              <ThreadComposerPresentation controller={controller} scopeId={draft.scopeId} activeTabId={activeTabId} enabled={composerPresentationEnabled} timeline={null}>
              <div className="thread-composer-region" data-thread-find-composer="true">
                {goals ? <ThreadGoalSurface threadId={null} goals={goals} draftScope={draft.target}
                  onCreateGoal={onCreateGoal} disabled={connectionPhase !== "ready" || personalDefaultsPending || setupBlocksSubmission || draftSubmissionOwnsNavigation(draft.phase)}
                  portalContainer={portalContainer}>{composer}</ThreadGoalSurface> : composer(null)}
              </div>
              </ThreadComposerPresentation>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
