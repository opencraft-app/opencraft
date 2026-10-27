export { ComposerAttachedRail } from "./attached-rail";
export { OpenCraftComposer, composerSchema } from "./composer-editor";
export type {
  OpenCraftComposerHandle,
  OpenCraftComposerProps,
  ComposerShortcutCommand,
  ComposerQueuedSubmissionPresentation,
  ComposerEffectiveSelections,
  ComposerExecutionTarget,
  ComposerModelOption,
  ComposerPermissionOption,
  ComposerReasoningEffortOption,
  ComposerSelectionCatalog,
} from "./composer-editor";
export * from "./prosemirror-codec";
export { resolveComposerFooterDensity } from "./responsive-footer";
export type {
  ComposerFooterDensity,
  ComposerFooterMeasurements,
} from "./responsive-footer";
export { contentBlocksToPrompt, createClientId } from "@opencraft/composer-core";
export type {
  AttachmentBlock,
  CommandBlock,
  ContentBlock,
  MentionBlock,
  ResourceBlock,
  TextBlock,
} from "@opencraft/composer-core";

export { groupComposerModels } from "./session-model-picker";

export { ConversationReferenceProvider } from "./conversation-references";
export type { ConversationReferencePort } from "./conversation-references";
