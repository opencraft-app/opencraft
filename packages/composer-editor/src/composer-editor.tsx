import { DisclosureButton, IconButton } from "@opencraft/design-system-web/button";
import { parseConversationRef, encodeConversationRef } from "@opencraft/appserver-protocol/collaboration";
import { useConversationReferences } from "./conversation-references";
import { ComposerModelPicker } from "./composer-model-picker";
import { ModelCatalogStatus } from "./model-catalog-status";
import { ModelIcon as BrainCircuit, CheckIcon as Check, ChevronDownIcon as ChevronDown, AttachmentIcon as Paperclip, AddIcon as Plus, CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import { LoadingRingIcon, ResetIcon, LightningIcon, PermissionDocumentIcon, PermissionShieldIcon, StopCircleIcon } from "@opencraft/design-system-web/action-icons";
import { SessionModelPicker, groupComposerModels } from "./session-model-picker";
import { useInputAuxiliaryMenuFocus } from "./use-input-auxiliary-menu-focus";
import { ComposerRecoveryScan } from "./recovery-scan";
import { ComposerAttachedRail } from "./attached-rail";
// AppServer state remains externally owned.
import { baseKeymap, newlineInCode, splitBlock } from "prosemirror-commands";
import { defineMessages, type IntlShape } from "@opencraft/i18n";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { DictationFooter } from "./dictation-footer";
import { ImageAttachmentPreview, type ComposerPreviewImage } from "./image-attachment-preview";
import { attachmentPreviewSession } from "./attachment-preview-session";
import { SkillIcon } from "./skill-icon";
import { resolveDictationKeyAction } from "./dictation-keyboard";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { type NodeSpec, Schema } from "prosemirror-model";
import {
  bulletList,
  liftListItem,
  orderedList,
  sinkListItem,
  splitListItem,
} from "prosemirror-schema-list";
import {
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
} from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { reasoningCapability, resolveReasoningEffort, resolveModelSelection, composerDocumentToPlainText } from "@opencraft/composer-core";
import { ArrowUpIcon as ArrowUp, AtSignIcon as AtSign, AlertIcon as CircleAlert, CodeFileIcon as FileCode2, TextFileIcon as FileText, ImageIcon as Image, SparklesIcon as Sparkles } from "@opencraft/design-system-web/action-icons";
import {
  Fragment,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createClientId,
  encodeComposerTarget,
  invertComposerFollowUpAction,
  resolveComposerPrimaryAction,
  resolveComposerFollowUpAction,
  shouldSearchComposerCatalog,
  type ComposerAttachment,
  type ComposerCatalog,
  type ComposerCatalogEntry,
  type ComposerContextReference,
  type ComposerController,
  type ComposerDocument,
  type ComposerFollowUpAction,
  type SubmitIntent,
} from "@opencraft/composer-core";

import {
  composerDocumentToProseMirror,
  proseMirrorToComposerDocument,
} from "./prosemirror-codec";
import { canSteerQueueItem, ComposerQueueTray, type ComposerQueueSender } from "./queue-tray";
import { useMeasuredComposerFooterLayout } from "./responsive-footer";

type SuggestionKind = "mention" | "skill" | "command";

interface Suggestion {
  id: string;
  kind: SuggestionKind;
  label: string;
  detail: string;
  uri?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ComposerShortcutCommand {
  readonly name: string;
  readonly description: string;
}

interface SuggestionQuery {
  kind: SuggestionKind;
  query: string;
  from: number;
  to: number;
}

export interface ComposerReasoningEffortOption {
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
}

export interface ComposerModelOption {
  readonly id: string;
  /** Concrete AppServer `model` override, which is distinct from catalog id. */
  readonly value: string;
  readonly label: string;
  readonly groupKey?: string | null;
  readonly groupLabel?: string | null;
  readonly configuredRole?: "primary" | "fallback" | null;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly inputModalities?: readonly ("text" | "image" | "audio")[];
  readonly contextWindow?: number | null;
  readonly maxTokens?: number | null;
  readonly source?: "builtin" | "custom" | null;
  readonly defaultEffort: string | null;
  readonly efforts: readonly ComposerReasoningEffortOption[];
  readonly serviceTiers?: readonly { readonly id: string; readonly name: string; readonly description: string }[];
}

export interface ComposerPermissionOption {
  readonly id: string;
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
  readonly disabled: boolean;
  /** Host-verified portable policy; null means an engine-native profile. */
  readonly mode?: "read-only" | "accept-edits" | "auto" | "full" | null;
  readonly nativeProfileId?: string | null;
}

export function hasPermissionProfileChoices(
  permissionProfiles: readonly ComposerPermissionOption[],
): boolean {
  return permissionProfiles.length > 0;
}

export interface ComposerAgentModelGroup {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
  readonly models: readonly ComposerModelOption[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly retry?: () => void;
  readonly select: (model: ComposerModelOption) => void | Promise<void>;
  readonly manage?: () => void;
}

export interface ComposerSelectionCatalog {
  readonly agentGroups?: readonly ComposerAgentModelGroup[];
  readonly models: readonly ComposerModelOption[];
  /** Cached names/capabilities for the selected model only; never selectable choices. */
  readonly displayModels?: readonly ComposerModelOption[];
  readonly permissionProfiles: readonly ComposerPermissionOption[];
  readonly isFetching?: boolean;
  readonly modelError?: string | null;
  readonly permissionProfileError?: string | null;
  readonly onModelMenuOpen?: () => void;
  readonly onConfigureModels?: () => void;
  readonly onRememberModelDefaults?: (defaults: {
    readonly model: string;
    readonly effort: string | null;
    readonly serviceTier?: string | null;
  }) => void;
  readonly retryModels?: () => void;
}

export interface ComposerEffectiveSelections {
  readonly serviceTier?: string | null;
  readonly agentId?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly permissionProfile?: string | null;
}

export interface ComposerExecutionTarget {
  readonly hostId: string;
  readonly hostLabel: string;
}

type SelectionPicker = "intelligence" | "permissions";

function modelIdentifierLabel(value: string): string {
  return value.replace(/^:/, "").split(/[-_\s]+/u).filter(Boolean)
    .map(part => /^gpt$/iu.test(part) ? "GPT" : `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function compactModelLabel(label: string): string {
  return label.replace(/^GPT[-\s]+/iu, "").replace(/-(?=[\p{L}])/gu, " ");
}

function displayReasoningEffort(effort: ComposerReasoningEffortOption): string {
  switch (effort.value.toLowerCase()) {
    case "low":
      return "Light";
    case "xhigh":
      return "Extra High";
    default:
      return effort.label;
  }
}

interface SelectionMenuItemContentProps {
  readonly description?: string | null;
  readonly label: ReactNode;
  readonly leading?: ReactNode;
  readonly selected: boolean;
}

function SelectionMenuItemContent({
  description,
  label,
  leading,
  selected,
}: SelectionMenuItemContentProps) {
  return (
    <>
      {leading === undefined ? null : (
        <span
          className="opencraft-composer-selection-menu__leading"
          aria-hidden="true"
        >
          {leading}
        </span>
      )}
      <span className="opencraft-composer-selection-menu__copy">
        <span className="opencraft-composer-selection-menu__label">{label}</span>
        {description ? (
          <span className="opencraft-composer-selection-menu__description">
            {description}
          </span>
        ) : null}
      </span>
      {selected ? (
        <span
          className="opencraft-composer-selection-menu__trailing"
          aria-hidden="true"
        >
          <Check size={16} />
        </span>
      ) : null}
    </>
  );
}

function permissionMenuLeadingIcon(mode: ComposerPermissionOption["mode"]): ReactNode {
  if (mode === "full") {
    return <LightningIcon size={18} />;
  }
  if (mode === "read-only") {
    return <PermissionDocumentIcon size={18} />;
  }
  if (mode == null) return <PermissionShieldIcon size={18} />;
  return <PermissionDocumentIcon size={18} editable />;
}

function formatSelectionLabel(value: string): string {
  return value
    .replace(/^:/, "")
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) =>
      part.length <= 3
        ? part.toUpperCase()
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

const permissionModeMessages = defineMessages({
  "read-only": { id: "composer.permissions.readOnly", defaultMessage: "Read only" },
  "accept-edits": { id: "composer.permissions.acceptEdits", defaultMessage: "Accept edits" },
  auto: { id: "composer.permissions.auto", defaultMessage: "Auto review" },
  full: { id: "composer.permissions.full", defaultMessage: "Full access" },
});
const permissionDescriptionMessages = defineMessages({
  "read-only": { id: "composer.permissions.readOnly.description", defaultMessage: "Read-only access to files." },
  "accept-edits": { id: "composer.permissions.acceptEdits.description", defaultMessage: "Allow editing files in the workspace." },
  auto: { id: "composer.permissions.auto.description", defaultMessage: "Automatically review permission requests." },
  full: { id: "composer.permissions.full.description", defaultMessage: "Full access to files and the execution environment." },
});

function displayPermissionLabel(permission: ComposerPermissionOption, intl: IntlShape): string {
  return permission.mode == null ? permission.label : intl.formatMessage(permissionModeMessages[permission.mode]);
}

function displayPermissionDescription(permission: ComposerPermissionOption, intl: IntlShape): string | null {
  // Engine-owned custom profiles retain their supplied policy description.
  return permission.mode == null || !permission.description || !intl.locale.startsWith("zh")
    ? permission.description : intl.formatMessage(permissionDescriptionMessages[permission.mode]);
}

const localCommandSuggestions: Suggestion[] = [
  {
    id: "cmd-plan",
    kind: "command",
    label: "plan",
    detail: "Create an implementation plan",
  },
  {
    id: "cmd-review",
    kind: "command",
    label: "review",
    detail: "Review working tree changes",
  },
  {
    id: "cmd-test",
    kind: "command",
    label: "tests",
    detail: "Run relevant tests",
  },
  {
    id: "cmd-explain",
    kind: "command",
    label: "explain",
    detail: "Explain selected code",
  },
];

const suggestionPluginKey = new PluginKey("opencraft-composer-suggestions");
const transientTextPluginKey = new PluginKey<TransientTextDecorationState | null>(
  "opencraft-composer-transient-text",
);

interface TransientTextDecorationState {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

type TransientTextTransaction =
  | { readonly type: "begin"; readonly from: number; readonly to: number }
  | { readonly type: "update"; readonly text: string }
  | { readonly type: "clear" };

function createTransientTextPlugin(): Plugin<TransientTextDecorationState | null> {
  return new Plugin<TransientTextDecorationState | null>({
    key: transientTextPluginKey,
    state: {
      init: () => null,
      apply(transaction, previous) {
        const command = transaction.getMeta(transientTextPluginKey) as
          | TransientTextTransaction
          | undefined;
        if (command?.type === "clear") return null;
        if (command?.type === "begin") {
          return { from: command.from, to: command.to, text: "" };
        }
        if (command?.type === "update") {
          return previous === null ? null : { ...previous, text: command.text };
        }
        if (previous === null || !transaction.docChanged) return previous;
        return {
          ...previous,
          from: transaction.mapping.map(previous.from, -1),
          to: transaction.mapping.map(previous.to, 1),
        };
      },
    },
    props: {
      decorations(state) {
        const transient = transientTextPluginKey.getState(state);
        if (transient == null || transient.text.length === 0) {
          return DecorationSet.empty;
        }
        const widget = Decoration.widget(
          transient.from,
          () => {
            const span = document.createElement("span");
            span.className = "opencraft-composer-transient-text";
            span.dataset.transientText = "true";
            span.textContent = transient.text;
            return span;
          },
          { side: -1 },
        );
        return DecorationSet.create(state.doc, [widget]);
      },
    },
  });
}
const { Enter: _baseEnter, ...composerBaseKeymap } = baseKeymap;

const tokenNode: NodeSpec = {
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  attrs: {
    id: { default: "" },
    kind: { default: "mention" },
    label: { default: "" },
    payload: { default: null },
  },
  parseDOM: [
    {
      tag: "span[data-composer-token]",
      getAttrs: (element) => {
        const htmlElement = element as HTMLElement;
        return {
          id: htmlElement.dataset.id ?? "",
          kind: htmlElement.dataset.kind ?? "mention",
          label: htmlElement.dataset.label ?? htmlElement.textContent ?? "",
          payload: (() => {
            const payload = htmlElement.dataset.payload;
            if (payload === undefined) return null;
            try {
              return JSON.parse(payload) as unknown;
            } catch {
              return null;
            }
          })(),
        };
      },
    },
  ],
  toDOM(node) {
    const prefix =
      node.attrs.kind === "command"
        ? "/"
        : node.attrs.kind === "skill"
          ? "$"
          : "@";
    return [
      "span",
      {
        "data-composer-token": "true",
        "data-id": node.attrs.id,
        "data-kind": node.attrs.kind,
        ...(node.attrs.payload?.mentionKind === "thread" && typeof node.attrs.payload?.uri === "string" && parseConversationRef(node.attrs.payload.uri) ? {role:"button",tabindex:"0","data-conversation-reference":node.attrs.payload.uri} : {}),
        "data-label": node.attrs.label,
        ...(node.attrs.payload === null
          ? {}
          : { "data-payload": JSON.stringify(node.attrs.payload) }),
        class: `opencraft-composer-token opencraft-composer-token--${node.attrs.kind}`,
      },
      `${prefix}${node.attrs.label}`,
    ];
  },
};

const composerListItem: NodeSpec = {
  content: "paragraph block*",
  defining: true,
  attrs: { id: { default: "" } },
  parseDOM: [
    {
      tag: "li",
      getAttrs: (element) => ({
        id: (element as HTMLElement).dataset.composerListItemId ?? "",
      }),
    },
  ],
  toDOM: (node) => ["li", { "data-composer-list-item-id": node.attrs.id }, 0],
};

export const composerSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    blockquote: {
      content: "block+",
      group: "block",
      defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0],
    },
    code_block: {
      content: "text*",
      marks: "",
      group: "block",
      code: true,
      defining: true,
      attrs: { language: { default: null } },
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      toDOM: (node) => [
        "pre",
        { "data-language": node.attrs.language ?? "" },
        ["code", 0],
      ],
    },
    horizontal_rule: {
      group: "block",
      parseDOM: [{ tag: "hr" }],
      toDOM: () => ["hr"],
    },
    ordered_list: { ...orderedList, content: "list_item+", group: "block" },
    bullet_list: { ...bulletList, content: "list_item+", group: "block" },
    list_item: composerListItem,
    text: { group: "inline" },
    token: tokenNode,
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
  },
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (element) => ({
            href: (element as HTMLAnchorElement).href,
          }),
        },
      ],
      toDOM: (mark) => [
        "a",
        { href: mark.attrs.href, title: mark.attrs.title },
        0,
      ],
    },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
      toDOM: () => ["strong", 0],
    },
    code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
  },
});

function createPlaceholderPlugin(placeholder: () => string): Plugin {
  return new Plugin({
    key: new PluginKey("opencraft-composer-placeholder"),
    props: {
      decorations(state) {
        const transient = transientTextPluginKey.getState(state);
        if (transient != null && transient.text.length > 0) {
          return DecorationSet.empty;
        }
        const first = state.doc.firstChild;
        if (
          state.doc.childCount !== 1 ||
          first?.type.name !== "paragraph" ||
          first.content.size !== 0
        ) {
          return DecorationSet.empty;
        }
        // Keep the empty paragraph natively editable. An inline noneditable
        // widget adds a caret boundary where iOS needs its empty editing target.
        return DecorationSet.create(state.doc, [Decoration.node(0, first.nodeSize, {
          class: "opencraft-composer-placeholder",
          "data-placeholder": placeholder(),
        })]);
      },
    },
  });
}

function createInputRulePlugins(): Plugin[] {
  const codeFence = textblockTypeInputRule(
    /^```([\w-]+)?\s$/,
    composerSchema.nodes.code_block,
    (match) => ({
      language: match[1] ?? null,
    }),
  );
  const horizontalRule = new InputRule(
    /^(?:---|___)\s$/,
    (state, _match, start, end) => {
      const transaction = state.tr.replaceWith(
        start - 1,
        end,
        composerSchema.nodes.horizontal_rule.create(),
      );
      return transaction.insert(start, composerSchema.nodes.paragraph.create());
    },
  );
  return [
    inputRules({
      rules: [
        codeFence,
        horizontalRule,
        wrappingInputRule(/^\s*([-+*])\s$/, composerSchema.nodes.bullet_list),
        wrappingInputRule(
          /^(\d+)\.\s$/,
          composerSchema.nodes.ordered_list,
          (match) => ({ order: Number(match[1]) }),
        ),
      ],
    }),
  ];
}

function querySuggestion(state: EditorState): SuggestionQuery | null {
  const { $from, empty } = state.selection;
  if (
    !empty ||
    !$from.parent.isTextblock ||
    $from.parent.type.name === "code_block"
  )
    return null;
  const beforeCursor = $from.parent.textBetween(
    0,
    $from.parentOffset,
    "\0",
    "\0",
  );
  const matches: SuggestionQuery[] = [];
  const append = (match: RegExpExecArray | null, kind: SuggestionKind) => {
    if (match === null) return;
    const query = match[1] ?? "";
    matches.push({
      kind,
      query,
      from: $from.pos - query.length - 1,
      to: $from.pos,
    });
  };
  append(/(?:^|[\s([{])\$([^$]*)$/u.exec(beforeCursor), "skill");
  append(/(?:^|[\s([{])@([^@]*)$/u.exec(beforeCursor), "mention");
  append(
    /(?:^|\s)\/([\p{L}\p{N}\p{M}.:_/\\-]*)$/u.exec(beforeCursor),
    "command",
  );
  return matches.sort((left, right) => right.from - left.from)[0] ?? null;
}

function catalogSuggestion(entry: ComposerCatalogEntry): Suggestion {
  return {
    id: entry.id,
    kind:
      entry.kind === "skill" || entry.kind === "command"
        ? entry.kind
        : "mention",
    label: entry.label,
    detail: entry.detail ?? "",
    uri: entry.uri,
    metadata: entry.metadata,
  };
}

function filesFromTransfer(dataTransfer: DataTransfer | null): File[] {
  return dataTransfer == null ? [] : Array.from(dataTransfer.files);
}

function createStableListItemIdPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("opencraft-composer-stable-list-item-ids"),
    appendTransaction(_transactions, _oldState, newState) {
      let transaction = newState.tr;
      let changed = false;
      newState.doc.descendants((node, position) => {
        if (
          node.type.name !== "list_item" ||
          (typeof node.attrs.id === "string" && node.attrs.id.length > 0)
        )
          return;
        transaction = transaction.setNodeMarkup(position, undefined, {
          ...node.attrs,
          id: createClientId(),
        });
        changed = true;
      });
      return changed ? transaction : null;
    },
  });
}

export interface OpenCraftComposerHandle {
  focus(): void;
  clear(): void;
  getDocument(): ComposerDocument;
  createSubmitIntent(): SubmitIntent;
}

export interface ComposerQueuedSubmissionPresentation {
  readonly sender?: ComposerQueueSender | null;
  /** Stable message identity across local admission and the server queue ID. */
  readonly renderKey?: string;
  readonly id: string;
  readonly preview: string;
  readonly state: "submitting" | "queued" | "failed" | "unknown";
  readonly operation: "idle" | "updating" | "deleting" | "starting";
  readonly actionable: boolean;
  readonly dismissible?: boolean;
  /** Whether this runtime permits changing authoritative queue order. */
  readonly reorderable?: boolean;
  readonly editableContent: ComposerQueuedSubmissionContent;
  readonly pausedReason?: string | null;
  readonly error?: string | null;
  readonly unconfirmedTargetTurnId?: string;
}

export interface ComposerQueuedSubmissionContent {
  readonly document: ComposerDocument;
  readonly attachments: readonly ComposerAttachment[];
  readonly context: readonly ComposerContextReference[];
}

export interface OpenCraftComposerProps {
  controller: ComposerController;
  /** Composer-owned chrome rendered above attachments and the editor. */
  chromeHeader?: ReactNode;
  /** Host projection rendered after the queue in the shared attached rail. */
  attachedContent?: ReactNode;
  /** Independent host projection above the attached rail and editor. */
  floatingContent?: ReactNode;
  /** Host-owned Add items. An optional continuation opens the next surface after menu focus cleanup. */
  addMenuContent?: ReactNode | ((closeMenu: (afterClose?: () => void) => void) => ReactNode);
  /** Host-scoped slash commands discovered inline in the editor. */
  shortcutCommands?: readonly ComposerShortcutCommand[];
  /** Host-owned actions immediately after the shortcut command menu. */
  entryActions?: ReactNode;
  /** Host-owned trusted extension actions placed before built-in end actions. */
  endActions?: ReactNode;
  catalog?: ComposerCatalog;
  /** Whether this surface can resolve `@` references through its Host. */
  mentionSuggestionsEnabled?: boolean;
  isStreaming: boolean;
  /** Read-only projection of current conversation recovery, independent of execution. */
  isRecovering?: boolean;
  /** Read-only connection/recovery warning; independent of normal AI execution. */
  isUnstable?: boolean;
  /** Thread-owned interrupt acknowledgement; does not imply the Turn has ended. */
  isStopping?: boolean;
  disabled?: boolean;
  /** Embedded surfaces keep menu focus, styling and stacking in their owner. */
  portalContainer?: HTMLElement | null;
  /**
   * Blocks command admission without taking ownership of the editable Draft.
   * Use this for a temporarily unavailable execution Host: the user may keep
   * composing while the immutable intent must not cross the transport seam.
   */
  submissionDisabled?: boolean;
  placeholder?: string;
  selectionCatalog?: ComposerSelectionCatalog;
  /** user remembers defaults; session overrides only this conversation; host-default offers no override. */
  modelSelectionPolicy?: import("@opencraft/composer-core").ModelSelectionPolicy;
  /** Show inherited execution settings without offering or submitting model overrides. */
  modelDisplayOnly?: boolean;
  effectiveSelections?: ComposerEffectiveSelections;
  executionTarget?: ComposerExecutionTarget;
  defaultFollowUpAction?: ComposerFollowUpAction;
  availableFollowUpActions?: readonly ComposerFollowUpAction[];
  /** Thread-owned queue projection. The Composer only renders this state. */
  queuedSubmissions?: readonly ComposerQueuedSubmissionPresentation[];
  /** Local custody can fail before acceptance; keep the draft until it settles. */
  awaitSubmission?: boolean;
  supportsQueuedSteer?: boolean;
  onUpdateQueuedSubmission?: (
    id: string,
    intent: SubmitIntent,
  ) => Promise<void>;
  onDeleteQueuedSubmission?: (id: string) => Promise<void>;
  onDiscardUnconfirmedSteer?: (id: string, expectedTurnId: string) => Promise<void>;
  onReorderQueuedSubmissions?: (ids: readonly string[]) => Promise<void>;
  onSteerQueuedSubmission?: (id: string) => Promise<void>;
  onResumeQueuedSubmissions?: () => Promise<void>;
  onResolveAttachment?: (
    file: File,
    pending: ComposerAttachment,
    signal?: AbortSignal,
  ) => ComposerAttachment | Promise<ComposerAttachment>;
  onRemoveAttachment?: (
    attachment: ComposerAttachment,
  ) => void | Promise<void>;
  /**
   * Hands an immutable intent to its command owner. A synchronous non-false
   * result means ownership was adopted locally and the draft can be consumed;
   * a Promise keeps the draft until that acceptance boundary settles. Later
   * transport failure belongs to the adopting runtime, never to this editor.
   */
  onSubmit(
    intent: SubmitIntent,
    context: { readonly followUpAction: ComposerFollowUpAction | null },
  ): boolean | void | Promise<boolean | void>;
  onCancel(context: {
    readonly trigger: "pointer" | "keyboard";
    readonly isTrusted: boolean;
    readonly occurredAt: number;
  }): void;
}

export const OpenCraftComposer = forwardRef<
  OpenCraftComposerHandle,
  OpenCraftComposerProps
>(function OpenCraftComposer(
  {
    controller,
    chromeHeader,
    attachedContent,
    floatingContent,
    addMenuContent,
    shortcutCommands,
    entryActions,
    endActions,
    catalog,
    mentionSuggestionsEnabled = true,
    isStreaming,
    isRecovering = false,
    isUnstable = false,
    isStopping = false,
    disabled = false,
    portalContainer,
    submissionDisabled = false,
    placeholder: suppliedPlaceholder,
    selectionCatalog,
    modelSelectionPolicy = "user",
    modelDisplayOnly = false,
    effectiveSelections,
    executionTarget,
    defaultFollowUpAction: preferredFollowUpAction = "queue",
    availableFollowUpActions,
    queuedSubmissions = [],
    awaitSubmission = false,
    supportsQueuedSteer = false,
    onUpdateQueuedSubmission,
    onDeleteQueuedSubmission,
    onDiscardUnconfirmedSteer,
    onReorderQueuedSubmissions,
    onSteerQueuedSubmission,
    onResumeQueuedSubmissions,
    onResolveAttachment,
    onRemoveAttachment,
    onSubmit,
    onCancel,
  },
  forwardedRef,
) {
  const admittedFollowUpAction = resolveComposerFollowUpAction(preferredFollowUpAction, availableFollowUpActions);
  const defaultFollowUpAction = admittedFollowUpAction ?? preferredFollowUpAction;
  const intl = useIntl();
  const placeholder = suppliedPlaceholder ?? intl.formatMessage({ id: "chat.companionFollowupPlaceholder", defaultMessage: "Tell me what you'd like to do next", description: "Follow-up composer placeholder" });
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  const mountRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const attachmentSession = attachmentPreviewSession(controller);
  useSyncExternalStore(attachmentSession.subscribe, attachmentSession.getVersion, attachmentSession.getVersion);
  const editorViewRef = useRef<EditorView | null>(null);
  const editorControllerRef = useRef<ComposerController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A native picker may outlive the Composer that opened it.
  const attachmentPickerOwnerRef = useRef<EditorView | null>(null);
  const conversationReferences = useConversationReferences();
  const conversationReferencesRef = useRef(conversationReferences);
  conversationReferencesRef.current = conversationReferences;
  const suggestionQueryRef = useRef<SuggestionQuery | null>(null);
  const dismissedSuggestionRef = useRef<SuggestionQuery | null>(null);
  const suggestionListId = useId();
  const suggestionListRef = useRef<HTMLDivElement | null>(null);
  const filteredSuggestionsRef = useRef<readonly Suggestion[]>([]);
  const suggestionLoadingRef = useRef(false);
  const selectedSuggestionRef = useRef(0);
  const pendingSubmissionRef = useRef<{
    readonly controller: ComposerController;
    readonly token: symbol;
  } | null>(null);
  const pendingQueueSteerRef = useRef<{
    readonly controller: ComposerController;
    readonly token: symbol;
  } | null>(null);
  const queueEditOriginRef = useRef<ComposerQueuedSubmissionContent | null>(
    null,
  );
  const isStreamingRef = useRef(isStreaming);
  const defaultFollowUpActionRef = useRef(defaultFollowUpAction);
  const availableFollowUpActionsRef = useRef(availableFollowUpActions);
  const disabledRef = useRef(disabled);
  isStreamingRef.current = isStreaming;
  defaultFollowUpActionRef.current = defaultFollowUpAction;
  availableFollowUpActionsRef.current = availableFollowUpActions;
  disabledRef.current = disabled;
  const [suggestionQuery, setSuggestionQuery] =
    useState<SuggestionQuery | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [catalogRevision, setCatalogRevision] = useState(0);
  useEffect(() => catalog?.subscribeSkillsChanged?.(() => {
    if (suggestionQueryRef.current?.kind === "skill") {
      filteredSuggestionsRef.current = [];
      suggestionLoadingRef.current = true;
      selectedSuggestionRef.current = 0;
      setSelectedSuggestion(0);
    }
    setCatalogRevision(value => value + 1);
  }), [catalog]);
  const [catalogResult, setCatalogResult] = useState<{
    readonly key: string;
    readonly catalog: ComposerCatalog;
    readonly controller: ComposerController;
    readonly items: readonly Suggestion[];
    readonly phase: "loading" | "ready" | "error";
    readonly error: string | null;
  } | null>(null);
  const [openPicker, setOpenPicker] = useState<SelectionPicker | null>(null);
  const changePicker = (picker: SelectionPicker) => (open: boolean) => {
    if (open) setAddMenuOpen(false);
    if (open && picker === "intelligence") selectionCatalog?.onModelMenuOpen?.();
    setOpenPicker(current => open ? picker : current === picker ? null : current);
  };
  const settleEditingFocusRef = useRef<() => void>(() => {});
  const menuFocusPending = useRef(false);
  const afterMenuCloseFocus = () => {
    // FocusScope restores its trigger after this event returns. Keep the
    // presentation lease until that synchronous cleanup has completed.
    queueMicrotask(() => {
      if (editorControllerRef.current !== controller) return;
      menuFocusPending.current = false;
      settleEditingFocusRef.current();
    });
  };
  const intelligenceFocus = useInputAuxiliaryMenuFocus({ open: openPicker === "intelligence", onOpenChange: changePicker("intelligence"), getEditor: () => editorViewRef.current?.dom ?? null, onCloseFocusSettling: afterMenuCloseFocus });
  const permissionsFocus = useInputAuxiliaryMenuFocus({ open: openPicker === "permissions", onOpenChange: changePicker("permissions"), getEditor: () => editorViewRef.current?.dom ?? null, onCloseFocusSettling: afterMenuCloseFocus });
  const agentSelectionEpoch = useRef(0);
  const [switchingAgentId, setSwitchingAgentId] = useState<string | null>(null);
  const [agentSelectionError, setAgentSelectionError] = useState<{ id: string; message: string } | null>(null);
  const selectAgentModel = async (group: ComposerAgentModelGroup, model: ComposerModelOption) => {
    const epoch = ++agentSelectionEpoch.current;
    setSwitchingAgentId(group.id);
    setAgentSelectionError(null);
    try { await group.select(model); }
    catch (error) { if (epoch === agentSelectionEpoch.current) setAgentSelectionError({ id: group.id, message: error instanceof Error ? error.message : String(error) }); }
    finally { if (epoch === agentSelectionEpoch.current) setSwitchingAgentId(null); }
  };
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const afterAddMenuClose = useRef<(() => void) | null>(null);
  const changeAddMenu = (open: boolean) => {
    if (open) { afterAddMenuClose.current = null; setOpenPicker(null); }
    setAddMenuOpen(open);
  };
  const addFocus = useInputAuxiliaryMenuFocus({ open: addMenuOpen, onOpenChange: changeAddMenu, getEditor: () => editorViewRef.current?.dom ?? null });
  const [editingQueuedSubmissionId, setEditingQueuedSubmissionId] = useState<
    string | null
  >(null);
  // Presentation follows an editing session, not whether the draft has text.
  // Toolbar/owned menus retain that session; only editor focus starts one.
  const [editingController, setEditingController] = useState<ComposerController | null>(null);
  const editingActive = editingController === controller;
  const auxiliaryMenuOpen = openPicker !== null || addMenuOpen;
  useLayoutEffect(() => {
    if (auxiliaryMenuOpen) { menuFocusPending.current = true; return; }
    if (!editingActive) return;
    const root = stackRef.current;
    if (!root) return;
    const doc = root.ownerDocument;
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!menuFocusPending.current && !root.contains(doc.activeElement)) {
          setEditingController(current => current === controller ? null : current);
        }
      });
    };
    doc.addEventListener("focusin", settle);
    doc.addEventListener("focusout", settle);
    // Do not settle on open=false: Radix restores focus later in its own
    // close cleanup. Its callback starts this check after that boundary.
    settleEditingFocusRef.current = settle;
    return () => {
      settleEditingFocusRef.current = () => {};
      cancelAnimationFrame(frame);
      doc.removeEventListener("focusin", settle);
      doc.removeEventListener("focusout", settle);
    };
  }, [controller, editingActive, auxiliaryMenuOpen]);
  const footerLayout = useMeasuredComposerFooterLayout();
  const inputInteraction = useSyncExternalStore(controller.subscribeInputInteraction, controller.getInputInteractionSnapshot, controller.getInputInteractionSnapshot);
  const voiceActive = inputInteraction !== null;
  const voiceActiveRef = useRef(voiceActive);
  voiceActiveRef.current = voiceActive;
  const inputPointerEntrance = useRef<HTMLElement | null>(null);
  const inputFocusEntrance = useRef<{ controller: ComposerController; draftId: string; element: HTMLElement } | null>(null);
  const [pendingInputFocus, setPendingInputFocus] = useState<{ controller: ComposerController; draftId: string; element: HTMLElement; afterCommit?: boolean } | null>(null);
  const cancelInputInteraction = () => {
    if (inputFocusEntrance.current?.controller === controller) setPendingInputFocus(inputFocusEntrance.current);
    inputInteraction?.cancel();
  };
  useLayoutEffect(() => { if (voiceActive) setOpenPicker(null); }, [voiceActive]);
  useEffect(() => {
    if (inputInteraction === null) return;
    const handleDictationKey = (event: KeyboardEvent) => {
      const editor = editorViewRef.current;
      const fromEditor = editor !== null && event.target instanceof Node && editor.dom.contains(event.target);
      const action = resolveDictationKeyAction(event, fromEditor);
      if (action === null) return;
      event.preventDefault(); event.stopPropagation();
      if (action === "cancel") cancelInputInteraction();
      else { void submitActionRef.current(isStreamingRef.current && (event.metaKey || event.ctrlKey)
        ? resolveComposerFollowUpAction(invertComposerFollowUpAction(defaultFollowUpActionRef.current), availableFollowUpActionsRef.current) ?? undefined : undefined); }
    };
    window.addEventListener("keydown", handleDictationKey, true);
    return () => window.removeEventListener("keydown", handleDictationKey, true);
  }, [controller, inputInteraction]);

  useEffect(() => {
    if (openPicker === null) return;
    const dismissOnWindowBlur = () => setOpenPicker(null);
    window.addEventListener("blur", dismissOnWindowBlur);
    return () => window.removeEventListener("blur", dismissOnWindowBlur);
  }, [openPicker]);
  const composerSnapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const attachments = composerSnapshot.draft.attachments;
  const draftId = composerSnapshot.draft.id;
  const [imagePreview, setImagePreview] = useState<{ draftId: string; attachmentId: string; returnFocus: HTMLElement | null } | null>(null);
  const previewFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => { setImagePreview(null); }, [controller, draftId]);
  const previewImages: ComposerPreviewImage[] = attachments.flatMap(attachment => {
    if (!attachment.mimeType.startsWith("image/")) return [];
    const source = attachmentSession.previewUrl(draftId, attachment.id)
      ?? (attachment.uri !== null && /^data:image\//iu.test(attachment.uri) ? attachment.uri : null);
    return source === null ? [] : [{ id: attachment.id, name: attachment.name, source }];
  });
  const selectedPreview = imagePreview?.draftId === draftId && previewImages.some(image => image.id === imagePreview.attachmentId)
    ? imagePreview : null;

  const catalogModels = selectionCatalog?.models ?? [];
  const catalogPermissions = selectionCatalog?.permissionProfiles ?? [];
  const showPermissionPicker = hasPermissionProfileChoices(catalogPermissions);
  const newThreadDefaultPermission = catalogPermissions.find(permission =>
    permission.mode === "full" && !permission.disabled)?.value;
  useLayoutEffect(() => {
    const draft = controller.getSnapshot().draft;
    if (draft.target.type !== "new-thread"
      || draft.selections.permissionProfile !== undefined
      || newThreadDefaultPermission === undefined) return;
    controller.dispatch({
      type: "set-selections",
      patch: { permissionProfile: newThreadDefaultPermission },
    });
  }, [controller, composerSnapshot.draft.id, composerSnapshot.draft.target.type, newThreadDefaultPermission]);
  const catalogDefaultModel = resolveModelSelection(catalogModels, undefined);
  const existingConversation = composerSnapshot.draft.target.type !== "new-thread";
  const selectedModelValue = modelDisplayOnly ? effectiveSelections?.model ?? null : modelSelectionPolicy === "host-default" ? catalogDefaultModel?.value ?? null :
    composerSnapshot.draft.selections.model ??
    effectiveSelections?.model ??
    (existingConversation ? null : catalogDefaultModel?.value) ??
    null;
  const selectedModel = selectedModelValue === null && existingConversation ? null : resolveModelSelection(catalogModels, selectedModelValue);
  // Execution snapshots and retained Composer intent paint without waiting for
  // the complete selectable catalog. Cached metadata cannot grant capabilities.
  const displayModel = selectedModel ?? (selectedModelValue === null ? null
    : resolveModelSelection(selectionCatalog?.displayModels ?? [], selectedModelValue));
  const effectiveEffort = composerSnapshot.draft.selections.model === undefined
    || composerSnapshot.draft.selections.model === effectiveSelections?.model
    ? effectiveSelections?.effort : undefined;
  const requestedEffort = composerSnapshot.draft.selections.effort ?? effectiveEffort;
  const displayEffortValue = existingConversation ? requestedEffort ?? null : undefined;
  const selectedEffortValue = existingConversation && requestedEffort == null ? null : selectedModel ? resolveReasoningEffort(
    reasoningCapability(selectedModel.efforts.map(e=>e.value),selectedModel.defaultEffort),
    requestedEffort,
  ) ?? null : null;
  const requestedServiceTier = composerSnapshot.draft.selections.serviceTier !== undefined
    ? composerSnapshot.draft.selections.serviceTier : effectiveSelections?.serviceTier;
  const displayServiceTier = modelDisplayOnly ? effectiveSelections?.serviceTier : requestedServiceTier;
  const displayFast = modelDisplayOnly || existingConversation
    ? displayServiceTier === "fast" || !!displayModel?.serviceTiers?.some(tier => tier.id === displayServiceTier && tier.name.toLowerCase() === "fast")
    : undefined;
  const selectedServiceTier = selectedModel?.serviceTiers?.some(tier => tier.id === requestedServiceTier)
    ? requestedServiceTier ?? null : null;
  // Null means inherit, including drafts saved by the former default option.
  // Display the resolved policy without writing it back as an explicit choice.
  const effectivePermissionValue = effectiveSelections?.permissionProfile ?? null;
  const effectiveDisplayPermissionValue = effectivePermissionValue === null ? null
    : catalogPermissions.find(permission => permission.nativeProfileId === effectivePermissionValue)?.value
      ?? effectivePermissionValue;
  const requestedPermissionValue = composerSnapshot.draft.selections.permissionProfile
    ?? effectivePermissionValue;
  const selectedPermissionValue = requestedPermissionValue === null ? null
    : catalogPermissions.find(permission => permission.nativeProfileId === requestedPermissionValue)?.value
      ?? requestedPermissionValue;
  const selectedPermission =
    catalogPermissions.find(
      (permission) => permission.value === selectedPermissionValue,
    ) ?? null;

  const catalogQueryKind =
    suggestionQuery?.kind === "skill" || suggestionQuery?.kind === "mention"
      ? suggestionQuery.kind
      : null;
  const catalogQueryText =
    catalogQueryKind === null ? "" : (suggestionQuery?.query.trim() ?? "");
  const catalogTargetKey = encodeComposerTarget(composerSnapshot.draft.target);
  const catalogModel = catalogQueryKind === "skill" && !existingConversation ? selectedModelValue ?? undefined : undefined;
  const catalogSearchActive = catalogQueryKind !== null && shouldSearchComposerCatalog(catalogQueryKind, catalogQueryText);
  const catalogRequestKey = JSON.stringify([catalogTargetKey, catalogModel, catalogQueryKind, catalogQueryText, catalogRetry, catalogQueryKind === "skill" ? catalogRevision : 0]);
  const currentCatalogResult = catalogResult?.key === catalogRequestKey
    && catalogResult.catalog === catalog && catalogResult.controller === controller ? catalogResult : null;
  const catalogSuggestions = currentCatalogResult?.phase === "ready" ? currentCatalogResult.items : [];
  const catalogLoading = catalogSearchActive && catalog !== undefined
    && (currentCatalogResult === null || currentCatalogResult.phase === "loading");
  const catalogError = !catalogSearchActive ? null : catalog === undefined
    ? "No catalog is available for this Host"
    : currentCatalogResult?.error ?? null;
  const commandSuggestions: readonly Suggestion[] = shortcutCommands?.map((command) => ({
    id: `cmd-${command.name}`,
    kind: "command",
    label: command.name,
    detail: command.description,
  })) ?? localCommandSuggestions;
  const filteredSuggestions =
    suggestionQuery == null
      ? []
      : suggestionQuery.kind === "command"
        ? commandSuggestions.filter((suggestion) =>
            suggestion.label
              .toLowerCase()
              .includes(suggestionQuery.query.toLowerCase()),
          )
        : !catalogSearchActive
          ? []
          : catalogSuggestions;
  filteredSuggestionsRef.current = filteredSuggestions;
  suggestionLoadingRef.current = catalogLoading;

  useEffect(() => {
    if (
      catalog === undefined ||
      catalogQueryKind === null ||
      !catalogSearchActive
    ) {
      setCatalogResult(null);
      return;
    }
    const abortController = new AbortController();
    let active = true;
    const owner = { key: catalogRequestKey, catalog, controller };
    setCatalogResult({ ...owner, items: [], phase: "loading", error: null });
    void Promise.resolve().then(async () => {
      const results = await Promise.allSettled([catalog.search(
        {
          kind: catalogQueryKind,
          query: catalogQueryText,
          target: composerSnapshot.draft.target,
          model: catalogModel,
          // skills/list already returns the complete directory. Do not hide
          // entries after an arbitrary first page; file search stays bounded.
          limit: catalogQueryKind === "skill" ? Number.MAX_SAFE_INTEGER : 50,
        },
        abortController.signal,
      ), ...(catalogQueryKind === "mention" && conversationReferences ? [conversationReferences.search({kind:"mention",query:catalogQueryText,target:composerSnapshot.draft.target,limit:30},abortController.signal)] : [])]);
      const entries = results.flatMap(r=>r.status === "fulfilled" ? [...r.value] : []);
      if (!entries.length && results.every(r=>r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
      return entries;
    })
      .then(
        (entries) => {
          if (!active) return;
          setCatalogResult({ ...owner, items: entries.map(catalogSuggestion), phase: "ready", error: null });
        },
        (error: unknown) => {
          if (!active || abortController.signal.aborted) return;
          setCatalogResult({ ...owner, items: [], phase: "error", error: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      active = false;
      abortController.abort();
    };
  }, [catalog, controller, catalogQueryKind, catalogQueryText, catalogTargetKey, catalogModel, catalogSearchActive, catalogRequestKey, conversationReferences]);

  const dismissSuggestions = useCallback(() => {
    dismissedSuggestionRef.current = suggestionQueryRef.current;
    suggestionQueryRef.current = null;
    filteredSuggestionsRef.current = [];
    setSuggestionQuery(null);
  }, []);

  const syncSuggestions = useCallback((state: EditorState) => {
    const candidate = querySuggestion(state);
    const dismissed = dismissedSuggestionRef.current;
    const isDismissed = candidate !== null && dismissed !== null && candidate.kind === dismissed.kind
      && candidate.from === dismissed.from && candidate.to === dismissed.to && candidate.query === dismissed.query;
    if (!isDismissed) dismissedSuggestionRef.current = null;
    const next = isDismissed || (candidate?.kind === "mention" && !mentionSuggestionsEnabled && !conversationReferencesRef.current)
      ? null
      : candidate;
    const previous = suggestionQueryRef.current;
    if (next?.kind === previous?.kind && next?.query === previous?.query && next?.from === previous?.from && next?.to === previous?.to) return;
    // Clear keyboard-visible results immediately, before React/effects run.
    filteredSuggestionsRef.current = [];
    suggestionLoadingRef.current = next?.kind === "skill";
    suggestionQueryRef.current = next;
    selectedSuggestionRef.current = 0;
    setSuggestionQuery(next);
    setSelectedSuggestion(0);
  }, [mentionSuggestionsEnabled]);

  const showSuggestions = !voiceActive && suggestionQuery !== null
    && (filteredSuggestions.length > 0 || suggestionQuery.kind === "mention" || suggestionQuery.kind === "skill");

  useEffect(() => {
    if (suggestionQuery?.kind === "skill" && catalogSearchActive && !catalogLoading
      && catalogError === null && filteredSuggestions.length === 0
      && suggestionQuery.query.trim().length > 0 && /\s/u.test(suggestionQuery.query)) dismissSuggestions();
  }, [suggestionQuery, catalogSearchActive, catalogLoading, catalogError, filteredSuggestions.length, dismissSuggestions]);

  useLayoutEffect(() => {
    const editor = editorViewRef.current?.dom;
    if (!editor) return;
    editor.setAttribute("aria-autocomplete", "list");
    editor.setAttribute("aria-expanded", String(showSuggestions));
    if (showSuggestions) editor.setAttribute("aria-controls", suggestionListId);
    else editor.removeAttribute("aria-controls");
    if (showSuggestions && filteredSuggestions[selectedSuggestion]) {
      const id = `${suggestionListId}-${selectedSuggestion}`;
      editor.setAttribute("aria-activedescendant", id);
      document.getElementById(id)?.scrollIntoView({ block: "nearest" });
    } else editor.removeAttribute("aria-activedescendant");
  }, [controller, showSuggestions, selectedSuggestion, filteredSuggestions, suggestionListId]);

  const appendFiles = useCallback(
    (files: File[]) => {
      const view = editorViewRef.current;
      if (files.length === 0 || disabledRef.current || view === null ||
        view.isDestroyed || !view.dom.isConnected || editorControllerRef.current !== controller) return;
      attachmentSession.addFiles(files, onResolveAttachment);
      // Focus belongs to the initiating interaction, not upload completion.
      // Keep ProseMirror's selection; do not move the caret or schedule a late focus.
      if (editorViewRef.current === view && !view.isDestroyed && view.dom.isConnected) {
        view.focus();
      }
    },
    [attachmentSession, controller, onResolveAttachment],
  );

  const openAttachmentPicker = () => {
    if (disabledRef.current) return;
    attachmentPickerOwnerRef.current = editorViewRef.current;
    fileInputRef.current?.click();
  };

  const replaceComposerContent = useCallback(
    (content: ComposerQueuedSubmissionContent) => {
      controller.dispatch({ type: "replace-content", ...content });
    },
    [controller],
  );

  const finishQueueEdit = useCallback(() => {
    queueEditOriginRef.current = null;
    setEditingQueuedSubmissionId(null);
  }, []);

  const cancelQueueEdit = useCallback(() => {
    const origin = queueEditOriginRef.current;
    if (origin !== null) replaceComposerContent(origin);
    finishQueueEdit();
    queueMicrotask(() => controller.focus());
  }, [controller, finishQueueEdit, replaceComposerContent]);

  const beginQueueEdit = useCallback(
    (id: string) => {
      const item = queuedSubmissions.find((submission) => submission.id === id);
      if (item === undefined) return;
      if (
        editingQueuedSubmissionId !== null &&
        editingQueuedSubmissionId !== id
      )
        return;
      if (
        !item.actionable ||
        pendingSubmissionRef.current?.controller === controller
      )
        return;
      if (editingQueuedSubmissionId === null) {
        const current = controller.getSnapshot().draft;
        queueEditOriginRef.current = {
          document: current.document,
          attachments: current.attachments,
          context: current.context,
        };
      }
      replaceComposerContent(item.editableContent);
      setEditingQueuedSubmissionId(item.id);
      queueMicrotask(() => controller.focus());
    },
    [
      controller,
      editingQueuedSubmissionId,
      queuedSubmissions,
      replaceComposerContent,
    ],
  );

  useEffect(() => {
    if (
      editingQueuedSubmissionId !== null &&
      !queuedSubmissions.some((item) => item.id === editingQueuedSubmissionId)
    ) {
      cancelQueueEdit();
    }
  }, [cancelQueueEdit, editingQueuedSubmissionId, queuedSubmissions]);

  const clear = useCallback(() => {
    controller.dispatch({ type: "clear" });
    finishQueueEdit();
  }, [controller, finishQueueEdit]);

  const submit = useCallback(
    async (followUpActionOverride?: ComposerFollowUpAction, dictationFinished = false) => {
      const view = editorViewRef.current;
      const dictation = controller.getInputInteractionSnapshot();
      if (!dictationFinished && dictation !== null) {
        if (dictation.phase !== "listening" || disabled || submissionDisabled || (!modelDisplayOnly && modelSelectionPolicy === "user" && selectedModelValue === null) || composerSnapshot.hasProcessingAssets) return;
        const draftId = controller.getSnapshot().draft.id;
        const committed = await dictation.finish();
        if (committed && editorViewRef.current === view && editorControllerRef.current === controller
          && controller.getSnapshot().draft.id === draftId && controller.getInputInteractionSnapshot() === null) {
          await submitActionRef.current(followUpActionOverride, true);
        }
        return;
      }
      if (
        view == null ||
        view.isDestroyed ||
        editorControllerRef.current !== controller ||
        disabled ||
        submissionDisabled ||
        !controller.getSnapshot().canSubmit ||
        pendingSubmissionRef.current?.controller === controller
      )
        return;
      controller.dispatch({
        type: "set-document",
        document: proseMirrorToComposerDocument(view.state.doc),
      });
      if (isStreaming && (admittedFollowUpAction === null
        || (followUpActionOverride !== undefined && availableFollowUpActions?.includes(followUpActionOverride) === false))) return;
      let intent: SubmitIntent;
      try {
        intent = controller.createSubmitIntent();
        if (modelDisplayOnly) {
          const { model: _model, effort: _effort, serviceTier: _tier, ...selections } = intent.selections;
          intent = { ...intent, selections };
        }
        if (!modelDisplayOnly && selectedModelValue !== null && !isStreaming && editingQueuedSubmissionId === null
          && (modelSelectionPolicy !== "session" || intent.selections.model !== undefined)) {
          intent = { ...intent, selections: { ...intent.selections,
            // Preserve an unavailable explicit choice so Runtime rejects it instead
            // of silently resolving the Host default model.
            model: selectedModel?.value ?? selectedModelValue,
            ...(modelSelectionPolicy === "user" && requestedServiceTier !== undefined ? { serviceTier: selectedModel ? selectedServiceTier : requestedServiceTier } : {}),
            ...(selectedModel && (!existingConversation || requestedEffort != null) ? { effort: resolveReasoningEffort(reasoningCapability(selectedModel.efforts.map(e=>e.value),selectedModel.defaultEffort),intent.selections.effort ?? effectiveEffort) } : {}),
          } };
        }
      } catch {
        return;
      }
      const submissionToken = Symbol("composer-submission");
      pendingSubmissionRef.current = { controller, token: submissionToken };
      view.setProps({ editable: () => false });
      controller.dispatch({ type: "set-lifecycle", phase: "submitting" });
      try {
        if (
          editingQueuedSubmissionId !== null &&
          onUpdateQueuedSubmission === undefined
        ) {
          throw new Error("Queued message editing is unavailable");
        }
        const followUpAction = isStreaming
          ? (followUpActionOverride ?? defaultFollowUpAction)
          : null;
        const submission =
          editingQueuedSubmissionId === null
            ? onSubmit(intent, { followUpAction })
            : onUpdateQueuedSubmission?.(editingQueuedSubmissionId, intent);

        // An active Thread's Conversation Runtime accepts the immutable
        // command synchronously and immediately publishes its optimistic queue
        // projection. From that point the draft has been consumed: transport
        // acknowledgement, failure, and ordering belong to the Runtime, not to
        // the Composer. Awaiting a remote Host here duplicates the message in
        // both the editor and queue and unnecessarily freezes the EditorView.
        if (
          editingQueuedSubmissionId === null &&
          followUpAction !== null &&
          !awaitSubmission &&
          submission !== false
        ) {
          if (
            encodeComposerTarget(controller.getSnapshot().draft.target) ===
            encodeComposerTarget(intent.target)
          )
            clear();
          else controller.dispatch({ type: "set-lifecycle", phase: "editing" });
          void Promise.resolve(submission).catch(() => {
            // The owning Conversation Runtime projects a failed queue entry.
            // A later draft must never be overwritten by this old command.
          });
          return;
        }

        const accepted = await submission;
        if (
          accepted !== false &&
          encodeComposerTarget(controller.getSnapshot().draft.target) ===
            encodeComposerTarget(intent.target)
        )
          clear();
        else controller.dispatch({ type: "set-lifecycle", phase: "editing" });
      } catch (error) {
        controller.dispatch({
          type: "set-lifecycle",
          phase: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        const stillOwnsSubmission =
          pendingSubmissionRef.current?.controller === controller &&
          pendingSubmissionRef.current.token === submissionToken;
        if (stillOwnsSubmission) pendingSubmissionRef.current = null;
        // The awaited submission may have outlived this Conversation View.
        // Only the current physical EditorView generation may be mutated.
        if (
          stillOwnsSubmission &&
          editorViewRef.current === view &&
          editorControllerRef.current === controller &&
          !view.isDestroyed
        ) {
          view.setProps({ editable: () => !disabledRef.current && !voiceActiveRef.current });
        }
        if (stillOwnsSubmission) {
          // Submission focus is presentation state owned by this Conversation
          // View. Defer until React has committed a possible Send -> Stop
          // action swap, then route through the controller so Draft promotion
          // can focus the replacement EditorView without reviving this one.
          requestAnimationFrame(() => {
            if (disabledRef.current) return;
            controller.focus();
          });
        }
      }
    },
    [
      clear,
      composerSnapshot.canSubmit,
      controller,
      defaultFollowUpAction,
      admittedFollowUpAction,
      availableFollowUpActions,
      disabled,
      submissionDisabled,
      isStreaming,
      onSubmit,
      onUpdateQueuedSubmission,
      awaitSubmission,
      editingQueuedSubmissionId,
      selectedModel,
      selectedModelValue,
      requestedServiceTier,
      requestedEffort,
      effectiveEffort,
      existingConversation,
      selectedServiceTier,
      modelSelectionPolicy,
      modelDisplayOnly,
      effectiveSelections?.effort,
    ],
  );
  const submitActionRef = useRef(submit);
  submitActionRef.current = submit;

  const steerQueueItem = useCallback(async (id: string) => {
    if (!onSteerQueuedSubmission || pendingQueueSteerRef.current?.controller === controller) return;
    const token = Symbol("queue-steer");
    pendingQueueSteerRef.current = { controller, token };
    try {
      await onSteerQueuedSubmission(id);
      if (editorControllerRef.current === controller && id === editingQueuedSubmissionId) cancelQueueEdit();
    } finally {
      if (pendingQueueSteerRef.current?.token === token) pendingQueueSteerRef.current = null;
    }
  }, [controller, onSteerQueuedSubmission, editingQueuedSubmissionId, cancelQueueEdit]);

  const modifiedEnterActionRef = useRef<() => void>(() => {});
  modifiedEnterActionRef.current = () => {
    // Content, including attachments/provisional text, always keeps the existing
    // draft-submit path. An unsendable draft is not permission to consume a queue.
    if (controller.getSnapshot().hasContent || editingQueuedSubmissionId !== null
      || controller.getInputInteractionSnapshot() !== null) {
      void submitActionRef.current(isStreaming
        ? resolveComposerFollowUpAction(invertComposerFollowUpAction(defaultFollowUpAction), availableFollowUpActions) ?? undefined
        : undefined);
      return;
    }
    const head = queuedSubmissions[0];
    if (defaultFollowUpAction !== "queue" || disabled || submissionDisabled || !head
      || !onSteerQueuedSubmission || editorControllerRef.current !== controller
      || pendingSubmissionRef.current?.controller === controller
      || !canSteerQueueItem(head, isStreaming, supportsQueuedSteer,
        queuedSubmissions.some(item => item.unconfirmedTargetTurnId !== undefined))) return;
    // Never skip a blocked head, clear a draft, or replay a failed queue action.
    void steerQueueItem(head.id).catch(() => undefined);
  };

  const insertSuggestion = useCallback((suggestion: Suggestion) => {
    const view = editorViewRef.current;
    const query = suggestionQueryRef.current;
    const isCurrentSuggestion = suggestion.kind === "command"
      ? filteredSuggestionsRef.current.some((entry) => entry.kind === "command" && entry.id === suggestion.id && entry.label === suggestion.label)
      : filteredSuggestionsRef.current.includes(suggestion);
    if (view == null || query == null || view.composing || !isCurrentSuggestion) return;
    const actualQuery = querySuggestion(view.state);
    if (actualQuery?.kind !== query.kind || actualQuery.from !== query.from || actualQuery.to !== query.to || actualQuery.query !== query.query) return;
    const token = composerSchema.nodes.token.create({
      id: suggestion.id,
      kind: suggestion.kind,
      label: suggestion.label,
      payload:
        suggestion.kind === "skill"
          ? {
              uri: suggestion.uri,
              resourceKind: "skill",
              metadata: suggestion.metadata,
            }
          : suggestion.uri === undefined && suggestion.metadata === undefined
            ? null
            : { uri: suggestion.uri, metadata: suggestion.metadata, ...(suggestion.metadata?.mentionKind === "thread" ? {mentionKind:"thread"} : {}) },
    });
    const transaction = view.state.tr.replaceWith(query.from, query.to, token);
    transaction.insertText(" ", query.from + token.nodeSize);
    transaction.setSelection(
      TextSelection.near(
        transaction.doc.resolve(query.from + token.nodeSize + 1),
      ),
    );
    view.dispatch(transaction.scrollIntoView());
    view.focus();
  }, []);

  const moveSuggestion = useCallback((delta: number) => {
    if (suggestionQueryRef.current === null || editorViewRef.current?.composing) return false;
    const count = filteredSuggestionsRef.current.length;
    if (count === 0) return false;
    selectedSuggestionRef.current = (selectedSuggestionRef.current + delta + count) % count;
    setSelectedSuggestion(selectedSuggestionRef.current);
    return true;
  }, []);

  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (mount == null) return;
    dismissedSuggestionRef.current = null;

    const editorState = EditorState.create({
      schema: composerSchema,
      doc: composerDocumentToProseMirror(
        controller.getSnapshot().draft.document,
        composerSchema,
      ),
      plugins: [
        history(),
        createTransientTextPlugin(),
        createStableListItemIdPlugin(),
        ...createInputRulePlugins(),
        keymap({
          ArrowUp: () => moveSuggestion(-1),
          ArrowDown: () => moveSuggestion(1),
          "Ctrl-p": () => /Mac|iPhone|iPad/u.test(navigator.platform) && moveSuggestion(-1),
          "Ctrl-n": () => /Mac|iPhone|iPad/u.test(navigator.platform) && moveSuggestion(1),
          Escape: () => {
            if (suggestionQueryRef.current == null) return false;
            dismissSuggestions();
            return true;
          },
          Enter: (state, dispatch, view) => {
            if (view?.composing) return false;
            const query = suggestionQueryRef.current;
            if (query != null) {
              const items = filteredSuggestionsRef.current;
              const item = items[selectedSuggestionRef.current];
              if (item != null) {
                insertSuggestion(item);
                return true;
              }
              if (suggestionLoadingRef.current || query.kind === "skill") return true;
            }
            // Let the browser/IME finish composition. The base Enter binding
            // is deliberately removed below so it cannot split the document.
            if (view?.composing) return false;
            if (state.selection.$from.parent.type.name === "code_block") {
              return (
                newlineInCode(state, dispatch) || splitBlock(state, dispatch)
              );
            }
            if (
              state.selection.$from.depth > 1 &&
              state.selection.$from.node(-1).type ===
                composerSchema.nodes.list_item
            ) {
              return splitListItem(composerSchema.nodes.list_item)(
                state,
                dispatch,
              );
            }
            // Software keyboards expose Return as a newline. iOS may also
            // route a native paragraph insertion through this Enter command.
            if (view?.dom.ownerDocument.defaultView?.matchMedia("(pointer: coarse)").matches) {
              return splitBlock(state, dispatch);
            }
            submitActionRef.current();
            return true;
          },
          "Shift-Enter": (state, dispatch) => {
            if (dispatch != null) {
              dispatch(
                state.tr
                  .replaceSelectionWith(
                    composerSchema.nodes.hard_break.create(),
                  )
                  .scrollIntoView(),
              );
            }
            return true;
          },
          "Mod-Enter": (_state, _dispatch, view) => {
            if (view?.composing) return false;
            modifiedEnterActionRef.current();
            return true;
          },
          "Mod-z": undo,
          "Mod-y": redo,
          "Mod-Shift-z": redo,
          Tab: (state, dispatch, view) => {
            if (view?.composing) return false;
            if (suggestionQueryRef.current?.kind === "skill") {
              const item = filteredSuggestionsRef.current[selectedSuggestionRef.current];
              if (item) insertSuggestion(item);
              return true;
            }
            return sinkListItem(composerSchema.nodes.list_item)(state, dispatch);
          },
          "Shift-Tab": liftListItem(composerSchema.nodes.list_item),
          "Alt-Enter": (state, dispatch) => splitBlock(state, dispatch),
        }),
        keymap(composerBaseKeymap),
        createPlaceholderPlugin(() => placeholderRef.current),
        new Plugin({
          key: suggestionPluginKey,
          props: {
            handleDOMEvents: {keydown(_view,event) {
              const uri=(event.target as HTMLElement).dataset?.conversationReference;
              if(!uri||!["Enter"," "].includes(event.key)||!conversationReferencesRef.current)return false;
              event.preventDefault();conversationReferencesRef.current.open(uri);return true;
            }},
            handlePaste(_view, event) {
              const files = filesFromTransfer(event.clipboardData);
              if (files.length > 0) {
                appendFiles(files);
                return true;
              }
              const text = event.clipboardData?.getData("text/plain") ?? "";
              const ref = parseConversationRef(text);
              if (ref) {
                event.preventDefault();
                let label = ref.threadId;
                try { label = new URL(text).searchParams.get("title")?.slice(0,120) || label; } catch { /* Canonical reference has no display hint. */ }
                const uri = encodeConversationRef(ref);
                const token = composerSchema.nodes.token.create({id:uri,kind:"mention",label,payload:{mentionKind:"thread",uri,metadata:{mentionKind:"thread"}}});
                _view.dispatch(_view.state.tr.replaceSelectionWith(token).scrollIntoView());
                return true;
              }
              if (text.length >= 5000) {
                appendFiles([
                  new File([text], "pasted-text.txt", { type: "text/plain" }),
                ]);
                return true;
              }
              return false;
            },
            handleClickOn(_view, _pos, node, _nodePos, event, direct) {
              if (!direct || node.type.name !== "token" || node.attrs.payload?.mentionKind !== "thread") return false;
              const uri = node.attrs.payload?.uri;
              if (typeof uri !== "string" || !parseConversationRef(uri) || !conversationReferencesRef.current) return false;
              event.preventDefault(); conversationReferencesRef.current.open(uri); return true;
            },
            handleDrop(_view, event) {
              const files = filesFromTransfer(event.dataTransfer);
              if (files.length === 0) return false;
              appendFiles(files);
              return true;
            },
            handleKeyDown(view, event) {
              if (event.isComposing || view.composing) return false;
              return false;
            },
          },
        }),
      ],
    });

    const view = new EditorView(mount, {
      state: editorState,
      editable: () =>
        !disabledRef.current && !voiceActiveRef.current &&
        pendingSubmissionRef.current?.controller !== controller,
      attributes: {
        "aria-label": placeholderRef.current,
        "aria-multiline": "true",
        class: "opencraft-composer-editor",
        dir: "auto",
        role: "textbox",
        spellcheck: "true",
      },
      handleDOMEvents: {
        blur: () => { dismissSuggestions(); return false; },
        keydown: (_view, event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)
            && !event.altKey && !event.shiftKey && event.repeat && !event.isComposing) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        syncSuggestions(nextState);
        if (transaction.docChanged) {
          controller.dispatch({
            type: "set-document",
            document: proseMirrorToComposerDocument(nextState.doc),
          });
        }
      },
    });
    editorViewRef.current = view;
    editorControllerRef.current = controller;
    syncSuggestions(editorState);
    return () => {
      if (editorViewRef.current === view) editorViewRef.current = null;
      if (editorControllerRef.current === controller)
        editorControllerRef.current = null;
      // Layout-effect cleanup is the sole physical owner. Destroy before a
      // replacement View is mounted so one mount never contains two editors.
      view.destroy();
    };
  }, [appendFiles, controller, dismissSuggestions, insertSuggestion, moveSuggestion, syncSuggestions]);

  useLayoutEffect(() => {
    const view = editorViewRef.current;
    if (view) view.setProps({ attributes: { ...view.props.attributes, "aria-label": placeholder } });
  }, [placeholder]);

  useLayoutEffect(() => {
    const view = editorViewRef.current;
    if (
      view === null ||
      view.isDestroyed ||
      editorControllerRef.current !== controller
    )
      return;
    view.setProps({
      editable: () =>
        !disabledRef.current && !voiceActiveRef.current &&
        pendingSubmissionRef.current?.controller !== controller,
    });
    view.dom.setAttribute("aria-readonly", String(voiceActive || disabled));
    view.dom.tabIndex = voiceActive ? -1 : 0;
  }, [controller, disabled, voiceActive]);

  useLayoutEffect(() => {
    const target = pendingInputFocus;
    if (voiceActive || target === null || (target.afterCommit && !composerSnapshot.hasContent)) return;
    // The external Store and imperative View can publish during React's layout
    // effects. Restore after the final DOM/inert projection, not midway through
    // those commits; cleanup cancels a superseded entrance or draft.
    const frame = requestAnimationFrame(() => {
      setPendingInputFocus(null);
      if (target.controller !== controller || editorControllerRef.current !== controller
        || controller.getSnapshot().draft.id !== target.draftId
        || controller.getInputInteractionSnapshot() !== null
        || !target.element.isConnected || target.element.closest("[inert]")) return;
      if (target.element === editorViewRef.current?.dom) editorViewRef.current.focus();
      else target.element.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [controller, voiceActive, pendingInputFocus, composerSnapshot.hasContent, composerSnapshot.draft.id]);

  useLayoutEffect(() => {
    const view = editorViewRef.current;
    if (
      view === null ||
      view.isDestroyed ||
      editorControllerRef.current !== controller
    )
      return;
    const desired = composerDocumentToProseMirror(
      composerSnapshot.draft.document,
      composerSchema,
    );
    if (!view.state.doc.eq(desired)) {
      const nextState = EditorState.create({
        schema: composerSchema,
        doc: desired,
        plugins: view.state.plugins,
      });
      view.updateState(nextState);
      syncSuggestions(nextState);
    }
    // Continuous View producers (voice, handwriting, IME adapters) may only
    // claim their next provisional segment after the physical EditorView has
    // acknowledged the Store's post-submit document.
    controller.settleTransientTextContinuation();
  }, [
    composerSnapshot.draft.document,
    composerSnapshot.draft.lifecycle.phase,
    controller,
    syncSuggestions,
  ]);

  useLayoutEffect(
    () => {
      let transientGeneration = 0;
      return controller.registerView({
        focus: () => editorViewRef.current?.focus(),
        blur: () => editorViewRef.current?.dom.blur(),
        insertText: (text) => {
          const view = editorViewRef.current;
          if (view === null || text.length === 0) return;
          view.dispatch(view.state.tr.insertText(text).scrollIntoView());
          view.focus();
        },
        appendQuote: (text) => {
          const view = editorViewRef.current;
          if (view === null || view.isDestroyed || !view.editable || view.composing) return false;
          const { schema } = view.state;
          // Literal text cannot introduce mentions, commands or Markdown syntax.
          const paragraphs = text.replace(/\r\n?/g, "\n").split("\n").map(line =>
            schema.nodes.paragraph.create(null, line ? schema.text(line) : null));
          const quote = schema.nodes.blockquote.create(null, paragraphs);
          const empty = view.state.doc.childCount === 1 && view.state.doc.firstChild?.type === schema.nodes.paragraph
            && view.state.doc.firstChild.content.size === 0;
          const transaction = closeHistory(view.state.tr).replaceWith(
            empty ? 0 : view.state.doc.content.size, view.state.doc.content.size,
            [quote, schema.nodes.paragraph.create()]);
          transaction.setSelection(TextSelection.atEnd(transaction.doc));
          view.dispatch(transaction.scrollIntoView());
          view.focus();
          return true;
        },
        beginTransientTextInput: () => {
          const view = editorViewRef.current;
          if (view === null || view.isDestroyed) return null;
          const generation = ++transientGeneration;
          const { from, to } = view.state.selection;
          const active = view.dom.ownerDocument.activeElement;
          const pointerEntrance = inputPointerEntrance.current;
          inputPointerEntrance.current = null;
          inputFocusEntrance.current = { controller, draftId: controller.getSnapshot().draft.id,
            element: pointerEntrance?.isConnected && stackRef.current?.contains(pointerEntrance) ? pointerEntrance
              : active instanceof HTMLElement && stackRef.current?.contains(active) ? active : view.dom };
          view.dispatch(
            view.state.tr.setMeta(transientTextPluginKey, {
              type: "begin",
              from,
              to,
            } satisfies TransientTextTransaction),
          );
          // Reserving a selection does not enter text editing or open the soft
          // keyboard. A successful final commit still focuses this same view.
          let closed = false;
          const ownsSession = () =>
            !closed &&
            transientGeneration === generation &&
            editorViewRef.current === view &&
            !view.isDestroyed;
          const clear = () => {
            if (!ownsSession()) return false;
            closed = true;
            view.dispatch(
              view.state.tr.setMeta(transientTextPluginKey, {
                type: "clear",
              } satisfies TransientTextTransaction),
            );
            return true;
          };
          return {
            update(text: string) {
              if (!ownsSession()) return;
              view.dispatch(
                view.state.tr.setMeta(transientTextPluginKey, {
                  type: "update",
                  text,
                } satisfies TransientTextTransaction),
              );
            },
            commit(text: string, policy: "selection" | "append" = "selection") {
              if (!ownsSession()) return false;
              const transient = transientTextPluginKey.getState(view.state);
              if (transient == null || text.length === 0 || !clear()) return false;
              const transaction = view.state.tr;
              if (policy === "append") {
                const normalized = text.trim();
                if (normalized.length === 0) return false;
                const previous = composerDocumentToPlainText(proseMirrorToComposerDocument(view.state.doc));
                transaction.setSelection(TextSelection.atEnd(transaction.doc));
                transaction.insertText(previous.length > 0 && !/\s$/.test(previous) ? ` ${normalized}` : normalized);
                transaction.setSelection(TextSelection.atEnd(transaction.doc));
              } else transaction.insertText(text, transient.from, transient.to);
              view.dispatch(transaction.scrollIntoView());
              const applied = editorViewRef.current === view && !view.isDestroyed && transientGeneration === generation && view.state.doc.eq(transaction.doc);
              if (!applied) return false;
              setPendingInputFocus({ controller, draftId: controller.getSnapshot().draft.id, element: view.dom, afterCommit: true });
              return true;
            },
            cancel() {
              clear();
            },
          };
        },
        undo: () => {
          const view = editorViewRef.current;
          if (view !== null) undo(view.state, view.dispatch);
        },
        redo: () => {
          const view = editorViewRef.current;
          if (view !== null) redo(view.state, view.dispatch);
        },
      });
    },
    [controller],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => editorViewRef.current?.focus(),
      clear,
      getDocument: () =>
        editorViewRef.current === null
          ? controller.getSnapshot().draft.document
          : proseMirrorToComposerDocument(editorViewRef.current.state.doc),
      createSubmitIntent: () => controller.createSubmitIntent(),
    }),
    [clear, controller],
  );

  const removeAttachment = (id: string) => {
    const attachment = controller.getSnapshot().draft.attachments.find(
      (candidate) => candidate.id === id,
    );
    attachmentSession.remove(controller.getSnapshot().draft.id, id);
    controller.dispatch({ type: "remove-attachment", id });
    if (attachment !== undefined) {
      void Promise.resolve(onRemoveAttachment?.(attachment)).catch(() => {
        // The draft removal already owns the UI transaction. Host cleanup is
        // best-effort and may be retried by its retention policy.
      });
    }
  };

  const insertTrigger = (trigger: "@" | "/" | "$") => {
    if (disabled) return;
    controller.insertText(trigger);
  };

  const selectModel = (model: ComposerModelOption) => {
    if (modelSelectionPolicy === "session") {
      controller.dispatch({ type: "set-selections", patch: { model: model.value, effort: undefined } });
      return;
    }
    const supportsCurrentEffort =
      selectedEffortValue !== null &&
      model.efforts.some((effort) => effort.value === selectedEffortValue);
    const effort = resolveReasoningEffort(
      reasoningCapability(
        model.efforts.map((candidate) => candidate.value),
        model.defaultEffort,
      ),
      supportsCurrentEffort ? selectedEffortValue : undefined,
    );
    const serviceTier = model.serviceTiers?.some(tier => tier.id === requestedServiceTier) ? requestedServiceTier ?? null : null;
    controller.dispatch({
      type: "set-selections",
      patch: {
        model: model.value,
        effort,
        ...(modelSelectionPolicy === "user" ? { serviceTier } : {}),
      },
    });
    selectionCatalog?.onRememberModelDefaults?.({
      model: model.value,
      effort: effort ?? null,
      serviceTier,
    });
  };

  const selectEffort = (effort: ComposerReasoningEffortOption) => {
    controller.dispatch({
      type: "set-selections",
      patch: { effort: effort.value, ...(modelSelectionPolicy === "user" && selectedModel !== null
        ? { model: selectedModel.value, serviceTier: selectedServiceTier } : {}) },
    });
    if (selectedModel !== null) {
      selectionCatalog?.onRememberModelDefaults?.({
        model: selectedModel.value,
        effort: effort.value,
        serviceTier: selectedServiceTier,
      });
    }
  };

  const selectServiceTier = (serviceTier: string | null) => {
    if (selectedModel === null) return;
    controller.dispatch({ type: "set-selections", patch: {
      model: selectedModel.value, effort: selectedEffortValue ?? undefined, serviceTier,
    } });
    selectionCatalog?.onRememberModelDefaults?.({
      model: selectedModel.value, effort: selectedEffortValue, serviceTier,
    });
  };

  const selectPermission = (permissionProfile: string | null) => {
    controller.dispatch({
      type: "set-selections",
      patch: { permissionProfile },
    });
    setOpenPicker(null);
  };

  const modelLabel =
    displayModel?.label ??
    (selectedModelValue === null
      ? intl.formatMessage({ id: "chat.model", defaultMessage: "Model" })
      : modelIdentifierLabel(selectedModelValue));
  const compactSelectedModelLabel = compactModelLabel(modelLabel);
  const manageModels = selectionCatalog?.agentGroups?.find(group => group.active)?.manage ?? selectionCatalog?.onConfigureModels;
  const visibleEffortValue = modelDisplayOnly ? effectiveSelections?.effort ?? null
    : existingConversation ? displayEffortValue : selectedEffortValue;
  const selectedEffort = displayModel?.efforts.find(effort => effort.value === visibleEffortValue)
    ?? (visibleEffortValue == null ? null : { value: visibleEffortValue, label: formatSelectionLabel(visibleEffortValue), description: null });
  const effortLabel =
    selectedEffort === null
      ? visibleEffortValue == null
        ? intl.formatMessage({
            id: "chat.reasoning",
            defaultMessage: "Reasoning",
          })
        : formatSelectionLabel(visibleEffortValue)
      : displayReasoningEffort(selectedEffort);
  const reasoningLabel = intl.formatMessage({
    id: "chat.reasoning",
    defaultMessage: "Reasoning",
  });
  const intelligenceLabel = visibleEffortValue != null
    ? `${modelLabel}, ${reasoningLabel}: ${effortLabel}`
    : modelLabel;
  const permissionsLabel = intl.formatMessage({ id: "composer.permissions", defaultMessage: "Permissions" });
  const permissionSelectionLabel = selectedPermission != null
    ? displayPermissionLabel(selectedPermission, intl)
    : selectedPermissionValue === null ? permissionsLabel : formatSelectionLabel(selectedPermissionValue);
  const permissionChangePending = composerSnapshot.draft.selections.permissionProfile != null
    && selectedPermissionValue !== effectiveDisplayPermissionValue;
  const permissionTriggerTitle = permissionChangePending
    ? intl.formatMessage(composerSnapshot.draft.target.type === "new-thread"
      ? { id: "composer.permissions.onSend", defaultMessage: "{profile} · on send" }
      : { id: "composer.permissions.nextTurn", defaultMessage: "{profile} · next turn" }, { profile: permissionSelectionLabel })
    : permissionSelectionLabel;

  const primaryAction = resolveComposerPrimaryAction({
    isResponseInProgress: isStreaming,
    canSubmit: !disabled && !submissionDisabled && composerSnapshot.canSubmit,
    defaultFollowUpAction,
    availableFollowUpActions,
  });
  const primaryActionLabel =
    editingQueuedSubmissionId !== null
      ? intl.formatMessage({ id: "chat.saveQueuedMessage", defaultMessage: "Save queued message" })
      : primaryAction === "stop"
        ? intl.formatMessage(isStopping ? { id: "chat.stop.pending", defaultMessage: "Stopping response…" } : { id: "chat.stopResponse", defaultMessage: "Stop response" })
        : primaryAction === "queue"
          ? intl.formatMessage({ id: "chat.queueFollowUp", defaultMessage: "Queue follow-up" })
          : primaryAction === "steer"
            ? intl.formatMessage({ id: "chat.steerActiveResponse", defaultMessage: "Steer active response" })
            : intl.formatMessage({ id: "chat.send", defaultMessage: "Send message" });
  const inverseFollowUpAction = resolveComposerFollowUpAction(invertComposerFollowUpAction(defaultFollowUpAction), availableFollowUpActions);
  // Typed content that cannot be sent yet explains why, instead of a silently grey button.
  const waitingForHostWithContent = submissionDisabled && !disabled && primaryAction !== "stop"
    && composerSnapshot.canSubmit;
  const primaryActionTitle = submissionDisabled && primaryAction !== "stop"
    ? intl.formatMessage({ id: "chat.waitingForHost", defaultMessage: "Waiting for execution host" })
    : isStreaming && primaryAction !== "stop" && inverseFollowUpAction !== null && inverseFollowUpAction !== defaultFollowUpAction
      ? `${primaryActionLabel} (⌘/Ctrl+Enter to ${inverseFollowUpAction})`
      : primaryActionLabel;
  return (
    <div
      ref={stackRef}
      onPointerDownCapture={event => {
        // Touch browsers need not focus tapped buttons. Capture the actual
        // entrance before a voice extension reserves input on press or click.
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button, .opencraft-composer-editor") : null;
        inputPointerEntrance.current = target && event.currentTarget.contains(target) ? target : null;
      }}
      onKeyDownCapture={() => { inputPointerEntrance.current = null; }}
      className="opencraft-composer-stack"
      onFocusCapture={event => {
        if (event.target === editorViewRef.current?.dom) setEditingController(controller);
      }}
      data-composer-editing={editingActive ? "true" : "false"}
      data-composer-layout={chromeHeader != null ? "stacked" : "auto-single-line"}
      data-composer-empty={!composerSnapshot.hasContent && !showSuggestions
        && composerSnapshot.draft.attachments.length === 0
        && composerSnapshot.draft.lifecycle.phase === "editing" ? "true" : "false"}
      data-composer-has-header={chromeHeader != null ? "true" : "false"}
      data-composer-phase={composerSnapshot.draft.lifecycle.phase}
      data-composer-has-top-tray={
        queuedSubmissions.length > 0 ? "true" : undefined
      }
      aria-busy={composerSnapshot.draft.lifecycle.phase === "submitting"}
    >
      {floatingContent}
      <ComposerAttachedRail>
        <ComposerQueueTray
          portalContainer={portalContainer}
          items={queuedSubmissions.map((item) => ({
            ...item,
            actionable:
              item.actionable &&
              (editingQueuedSubmissionId === null ||
                item.id === editingQueuedSubmissionId),
            dismissible:
              item.dismissible &&
              (editingQueuedSubmissionId === null ||
                item.id === editingQueuedSubmissionId),
            editing: item.id === editingQueuedSubmissionId,
          }))}
          isResponseInProgress={isStreaming}
          atomicSteer={supportsQueuedSteer}
          onEdit={beginQueueEdit}
          onCancelEdit={cancelQueueEdit}
          onDelete={async (id) => {
            await onDeleteQueuedSubmission?.(id);
            if (id === editingQueuedSubmissionId) cancelQueueEdit();
          }}
          onDiscardUnconfirmed={onDiscardUnconfirmedSteer}
          onReorder={onReorderQueuedSubmissions}
          onSteer={steerQueueItem}
          onResume={onResumeQueuedSubmissions}
        />
        {attachedContent}
      </ComposerAttachedRail>
      <div className="opencraft-composer-shell"
        data-loading={isRecovering && !isUnstable ? "true" : undefined}
        data-warning={isUnstable ? "true" : undefined}>
        <ComposerRecoveryScan active={isRecovering} />
        {chromeHeader === undefined ? null : (
          <div className="opencraft-composer-chrome-header">{chromeHeader}</div>
        )}
        {composerSnapshot.draft.lifecycle.phase === "failed" && (
          <div className="opencraft-composer-error" role="alert">
            <span>
              {composerSnapshot.draft.lifecycle.error ??
                "Message could not be sent"}
            </span>
            <button
              type="button"
              aria-label="Dismiss send error"
              onClick={() =>
                controller.dispatch({ type: "set-lifecycle", phase: "editing" })
              }
            >
              <X size={13} />
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="opencraft-composer-attachments" aria-label="Attachments" inert={voiceActive ? true : undefined}>
            {attachments.map((attachment) => {
              const image = attachment.mimeType.startsWith("image/");
              const workInError = attachment.metadata?.workInAttachmentError === "interrupted"
                ? intl.formatMessage({ id: "workIn.attachmentInterrupted", defaultMessage: "Attachment processing was interrupted. Add it again." })
                : attachment.metadata?.workInAttachmentError === "machine-changed"
                  ? intl.formatMessage({ id: "workIn.attachmentOtherMachine", defaultMessage: "This file is on the previous machine. Add it on this machine." })
                  : null;
              const previewUrl = attachmentSession.previewUrl(composerSnapshot.draft.id, attachment.id)
                ?? (attachment.uri !== null && /^data:image\//iu.test(attachment.uri) ? attachment.uri : null);
              if (image) return (
                <div aria-label={attachment.name} className="opencraft-composer-image-attachment" data-state={attachment.lifecycle} key={attachment.id} role="group" title={attachment.error ?? attachment.name}>
                  <button
                    aria-label={intl.formatMessage({ id: "chat.image.open", defaultMessage: "Open attached image" })}
                    className="opencraft-composer-image-attachment__preview"
                    disabled={previewUrl === null}
                    onPointerDown={() => { previewFocusRef.current = editorViewRef.current?.hasFocus() ? editorViewRef.current.dom : null; }}
                    onKeyDown={() => { previewFocusRef.current = null; }}
                    onClick={event => setImagePreview({ draftId, attachmentId: attachment.id, returnFocus: previewFocusRef.current ?? event.currentTarget })}
                    type="button"
                  >
                    {previewUrl === null
                      ? <Image aria-hidden="true" className="opencraft-composer-image-attachment__fallback" size={24} />
                      : <img alt="" draggable={false} src={previewUrl} />}
                  </button>
                  {attachment.lifecycle === "pending" || attachment.lifecycle === "processing" || attachment.lifecycle === "uploading" ? (
                    <span aria-label={`Preparing ${attachment.name}`} className="opencraft-composer-image-attachment__status" role="status">
                      <LoadingRingIcon aria-hidden="true" size={22} />
                    </span>
                  ) : null}
                  {attachment.lifecycle === "failed" ? (
                    <span className="opencraft-composer-image-attachment__status is-failed">
                      {attachmentSession.canRetry(composerSnapshot.draft.id, attachment.id) && onResolveAttachment !== undefined ? (
                        <button aria-label={`Retry ${attachment.name}: ${attachment.error ?? "Image preparation failed"}`} onClick={() => attachmentSession.retry(composerSnapshot.draft.id, attachment.id, onResolveAttachment)} type="button">
                          <ResetIcon aria-hidden="true" size={20} />
                        </button>
                      ) : <CircleAlert aria-label={attachment.error ?? "Image preparation failed"} role="img" size={20} />}
                    </span>
                  ) : null}
                  {attachment.lifecycle === "failed" ? (
                    <span className="opencraft-composer-image-attachment__error" role="alert">
                      {workInError ?? attachment.error ?? "Image preparation failed"}
                    </span>
                  ) : workInError !== null ? <span className="opencraft-composer-image-attachment__error" role="alert">{workInError}</span> : null}
                  <button className="opencraft-composer-image-attachment__remove" type="button" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}>
                    <X aria-hidden="true" size={14} />
                  </button>
                </div>
              );
              const preparing = attachment.lifecycle === "pending" || attachment.lifecycle === "processing" || attachment.lifecycle === "uploading";
              return (
                <div aria-busy={preparing} className="opencraft-composer-attachment" data-state={attachment.lifecycle} key={attachment.id}>
                  <span className="opencraft-composer-attachment__icon"><FileText size={15} /></span>
                  <span className="opencraft-composer-attachment__copy">
                    <strong>{attachment.name}</strong>
                    <small>{Math.max(1, Math.ceil(attachment.size / 1024))} KB</small>
                    {preparing ? <small role="status">Adding file…</small> : null}
                    {workInError !== null ? <small role="alert">{workInError}</small>
                      : attachment.lifecycle === "failed" ? <small role="alert">{attachment.error ?? "Could not add file"}</small> : null}
                  </span>
                  <span className="opencraft-composer-attachment__actions">
                    {attachment.lifecycle === "failed" && attachmentSession.canRetry(composerSnapshot.draft.id, attachment.id) && onResolveAttachment !== undefined ? (
                      <button type="button" aria-label={`Retry ${attachment.name}`} onClick={() => attachmentSession.retry(composerSnapshot.draft.id, attachment.id, onResolveAttachment)}><ResetIcon size={13} /></button>
                    ) : null}
                    <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}><X size={13} /></button>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {selectedPreview !== null && <ImageAttachmentPreview
          images={previewImages}
          selectedId={selectedPreview.attachmentId}
          onSelect={attachmentId => setImagePreview({ ...selectedPreview, attachmentId })}
          onClose={() => setImagePreview(null)}
          onEditComplete={disabled || onResolveAttachment === undefined ? undefined : (id, source, file) => {
            if (disabledRef.current || editorControllerRef.current !== controller) return false;
            const replaced = attachmentSession.replaceImage(selectedPreview.draftId, id, source, file, onResolveAttachment);
            if (replaced) setImagePreview(null);
            return replaced;
          }}
          onReturnFocus={() => {
            if (editorControllerRef.current !== controller || controller.getSnapshot().draft.id !== selectedPreview.draftId) return;
            const target = selectedPreview.returnFocus;
            if (target?.isConnected && !target.closest("[inert]")) {
              if (target === editorViewRef.current?.dom) editorViewRef.current.focus();
              else target.focus({ preventScroll: true });
            }
          }}
          portalContainer={portalContainer}
        />}

        {showSuggestions && suggestionQuery != null && (
            <div
              ref={suggestionListRef}
              id={suggestionListId}
              className="opencraft-composer-suggestions"
              data-kind={suggestionQuery.kind}
              role="listbox"
              aria-label={`${suggestionQuery.kind} suggestions`}
            >
              <div className="opencraft-composer-suggestions__label">
                {suggestionQuery.kind === "command"
                  ? "Commands"
                  : suggestionQuery.kind === "skill"
                    ? <FormattedMessage id="composer.skills.title" defaultMessage="Skills" />
                    : "Files and context"}
              </div>
              {suggestionQuery.kind === "mention" &&
              catalogQueryText.length === 0 ? (
                <div
                  className="opencraft-composer-suggestions__status"
                  role="status"
                >
                  Type to search for files
                </div>
              ) : null}
              {catalogLoading && filteredSuggestions.length === 0 ? (
                <div
                  className="opencraft-composer-suggestions__status"
                  role="status"
                >
                  {suggestionQuery.kind === "mention"
                    ? "Searching files…"
                    : <FormattedMessage id="composer.skills.loading" defaultMessage="Loading skills…" />}
                </div>
              ) : null}
              {catalogError !== null ? (
                <div
                  className="opencraft-composer-suggestions__status is-error"
                  role="status"
                >
                  {suggestionQuery.kind === "mention"
                    ? "File search unavailable"
                    : <FormattedMessage id="composer.skills.unavailable" defaultMessage="Skills unavailable" />}
                  {catalog !== undefined ? <button type="button"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => { selectedSuggestionRef.current = 0; setSelectedSuggestion(0); setCatalogRetry(value => value + 1); }}>
                    <FormattedMessage id="composer.skills.retry" defaultMessage="Retry" />
                  </button> : null}
                </div>
              ) : null}
              {suggestionQuery.kind === "skill" && !catalogLoading && catalogError === null && filteredSuggestions.length === 0 ? (
                <div className="opencraft-composer-suggestions__status" role="status"><FormattedMessage id="composer.skills.empty" defaultMessage="No skills found" /></div>
              ) : null}
              {filteredSuggestions.map((suggestion, index) => (
                <button
                  type="button"
                  role="option"
                  id={`${suggestionListId}-${index}`}
                  tabIndex={-1}
                  title={suggestion.uri ?? undefined}
                  aria-selected={index === selectedSuggestion}
                  className={
                    index === selectedSuggestion ? "is-selected" : undefined
                  }
                  key={suggestion.id}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onPointerEnter={(event) => {
                    if (event.pointerType !== "mouse") return;
                    selectedSuggestionRef.current = index;
                    setSelectedSuggestion(index);
                  }}
                  onClick={() => insertSuggestion(suggestion)}
                >
                  <span>
                    {suggestion.kind === "command" ? (
                      <LightningIcon size={15} />
                    ) : suggestion.kind === "skill" ? (
                      <SkillIcon source={suggestion.metadata?.iconSmallUrl ?? suggestion.metadata?.iconSmall} />
                    ) : (
                      <FileCode2 size={15} />
                    )}
                  </span>
                  <span>
                    <strong>
                      {suggestion.kind === "command"
                        ? "/"
                        : suggestion.kind === "skill"
                          ? ""
                          : "@"}
                      {suggestion.label}
                    </strong>
                    <small>{suggestion.kind === "skill" && typeof suggestion.metadata?.scope === "string"
                      ? <>{suggestion.metadata.scope === "repo" ? <FormattedMessage id="composer.skills.scope.project" defaultMessage="Project" />
                        : suggestion.metadata.scope === "user" ? <FormattedMessage id="composer.skills.scope.user" defaultMessage="User" />
                        : suggestion.metadata.scope === "system" ? <FormattedMessage id="composer.skills.scope.system" defaultMessage="Built-in" />
                        : suggestion.metadata.scope === "admin" ? <FormattedMessage id="composer.skills.scope.admin" defaultMessage="Admin" /> : suggestion.metadata.scope} · {suggestion.detail}</>
                      : suggestion.detail}</small>
                  </span>
                </button>
              ))}
            </div>
          )}

        <div className="opencraft-composer-input-row" inert={voiceActive ? true : undefined} aria-hidden={voiceActive ? true : undefined}>
          <div ref={mountRef} className="opencraft-composer-editor-mount" />
        </div>

        <div
          ref={footerLayout.footerRef}
          className="opencraft-composer-footer"
          data-footer-density={footerLayout.density}
          data-model-selection-policy={modelSelectionPolicy}
          data-input-mode={voiceActive ? "dictation" : "standard"}
        >
          {inputInteraction === null ? null : <DictationFooter interaction={inputInteraction}
            canSend={!disabled && !submissionDisabled && !composerSnapshot.hasUnavailableAssets && (modelDisplayOnly || modelSelectionPolicy !== "user" || selectedModelValue !== null)}
            onSend={() => { void submit(); }} onCancel={cancelInputInteraction} />}
          <div
            ref={footerLayout.attachmentRef}
            className="opencraft-composer-footer__attachment"
            inert={voiceActive ? true : undefined} aria-hidden={voiceActive ? true : undefined}
          >
            {addMenuContent === undefined || addMenuContent === null ? (
              <IconButton size="accessory"
                className="opencraft-composer-icon-button"
                type="button"
                aria-label={intl.formatMessage({ id: "composer.add", defaultMessage: "Add" })}
                onClick={openAttachmentPicker}
              >
                <Plus size={20} />
              </IconButton>
            ) : (
              <DropdownMenu.Root open={addMenuOpen} onOpenChange={changeAddMenu} dismissOnWindowBlur={false}>
                <DropdownMenu.Trigger asChild>
                  <IconButton size="accessory"
                    {...addFocus.triggerProps}
                    className="opencraft-composer-icon-button"
                    type="button"
                    aria-label={intl.formatMessage({ id: "composer.add", defaultMessage: "Add" })}
                  >
                    <Plus size={20} />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal container={portalContainer}>
                  <DropdownMenu.Content
                    {...addFocus.contentProps}
                    className="opencraft-composer-selection-menu opencraft-composer-add-menu"
                    align="start"
                    sideOffset={6}
                    collisionPadding={6}
                    onCloseAutoFocus={(event) => {
                      afterMenuCloseFocus();
                      addFocus.contentProps.onCloseAutoFocus(event);
                      const afterClose = afterAddMenuClose.current;
                      afterAddMenuClose.current = null;
                      if (afterClose !== null) {
                        event.preventDefault();
                        afterClose();
                      }
                    }}
                  >
                    <DropdownMenu.Item
                      className="opencraft-composer-selection-menu__item opencraft-composer-add-menu__item"
                      onSelect={openAttachmentPicker}
                    >
                      <Paperclip size={15} aria-hidden="true" />
                      <FormattedMessage id="chat.attach" defaultMessage="Attach files" />
                    </DropdownMenu.Item>
                    {typeof addMenuContent === "function"
                      ? addMenuContent((afterClose) => {
                          afterAddMenuClose.current = afterClose ?? null;
                          setAddMenuOpen(false);
                        })
                      : addMenuContent}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
            <input
              ref={fileInputRef}
              hidden
              multiple
              type="file"
              onChange={(event) => {
                const owner = attachmentPickerOwnerRef.current;
                attachmentPickerOwnerRef.current = null;
                if (owner !== null && owner === editorViewRef.current) {
                  appendFiles(Array.from(event.currentTarget.files ?? []));
                }
                event.currentTarget.value = "";
              }}
            />
            {entryActions}
          </div>
          <div
            ref={footerLayout.controlsRef}
            className="opencraft-composer-footer__controls"
            inert={voiceActive ? true : undefined} aria-hidden={voiceActive ? true : undefined}
          >
            {executionTarget === undefined ? null : (
              <span
                className="opencraft-composer-readonly-label opencraft-composer-mode--static"
                title={`Execution node: ${executionTarget.hostLabel}`}
              >
                {executionTarget.hostLabel}
              </span>
            )}
            <div className="opencraft-composer-picker-region">
              {modelDisplayOnly ? <span className="opencraft-composer-readonly-label opencraft-composer-mode--inherited" title={intelligenceLabel}>
                <span className="opencraft-composer-mode__model-label">{compactSelectedModelLabel}</span>
                {visibleEffortValue != null ? <span className="opencraft-composer-mode__effort-label">{effortLabel}</span> : null}
                {displayFast ? <LightningIcon className="opencraft-composer-mode__fast" size={14} filled aria-label="Fast" /> : null}
              </span> : null}
              {!modelDisplayOnly && modelSelectionPolicy === "session" ? <SessionModelPicker catalog={selectionCatalog} label={modelLabel}
                selected={selectedModelValue} disabled={disabled} open={openPicker === "intelligence"}
                onOpenChange={changePicker("intelligence")} onSelect={selectModel} portalContainer={portalContainer}
                focus={intelligenceFocus} /> : null}
              {!modelDisplayOnly && modelSelectionPolicy === "user" ? <ComposerModelPicker
                hasSelectedModel={selectedModel !== null}
                label={compactSelectedModelLabel} modelLabel={modelLabel} fullLabel={intelligenceLabel} effortLabel={visibleEffortValue != null ? effortLabel : undefined}
                disabled={disabled} open={openPicker === "intelligence"} onOpenChange={changePicker("intelligence")}
                portalContainer={portalContainer} focus={intelligenceFocus}
                efforts={selectedModel?.efforts.map(effort => ({ value: effort.value, label: displayReasoningEffort(effort) })) ?? []}
                serviceTiers={selectedModel?.serviceTiers ?? []} serviceTier={selectedServiceTier} displayFast={displayFast}
                onServiceTierChange={selectServiceTier}
                effort={existingConversation ? displayEffortValue ?? null : selectedEffortValue} defaultEffort={selectedModel?.defaultEffort ?? null} onEffortChange={value => {
                  const effort = selectedModel?.efforts.find(candidate => candidate.value === value);
                  if (effort) selectEffort(effort);
                }}>
                      <div className="opencraft-composer-intelligence-view">
                        <div className="opencraft-composer-intelligence-models">
                          <DropdownMenu.Label className="opencraft-composer-selection-menu__heading">
                            <FormattedMessage id="chat.model" defaultMessage="Model" />
                          </DropdownMenu.Label>
                          {(selectionCatalog?.agentGroups?.length ? selectionCatalog.agentGroups : [{ id: "active", label: "", active: true, models: catalogModels, select: selectModel }]).map(group => (
                            <DropdownMenu.Group key={group.id}>
                              {group.label ? <DropdownMenu.Label className="opencraft-composer-selection-menu__heading">{group.label}</DropdownMenu.Label> : null}
                              {groupComposerModels(group.models, true).map(modelGroup => <Fragment key={modelGroup.key}>
                                {modelGroup.label ? <DropdownMenu.Label className="opencraft-composer-model-group__label">{modelGroup.label}</DropdownMenu.Label> : null}
                                {modelGroup.models.map(model => (
                                <DropdownMenu.Item key={model.id} className="opencraft-composer-selection-menu__item"
                                  data-selected={group.active && (model.value === selectedModelValue || model.id === selectedModelValue) ? "true" : undefined}
                                  onSelect={event => { event.preventDefault(); if (group.active) { if (selectionCatalog?.agentGroups) void selectAgentModel(group, model); selectModel(model); } else void selectAgentModel(group, model); }}>
                                  <SelectionMenuItemContent description={null} label={model.label}
                                    selected={group.active && (model.value === selectedModelValue || model.id === selectedModelValue)} />
                                </DropdownMenu.Item>
                                ))}
                              </Fragment>)}
                              {switchingAgentId === group.id ? <div className="opencraft-composer-selection-menu__status"><FormattedMessage id="workIn.switchingAgent" defaultMessage="Switching Agent…" /></div> : null}
                              {agentSelectionError?.id === group.id ? <div className="opencraft-composer-selection-menu__status is-error" role="alert">{agentSelectionError.message}</div> : null}
                              {selectionCatalog?.agentGroups?.length && (group.loading || group.error || group.models.length === 0) ? <ModelCatalogStatus
                                error={!!group.error} loading={group.loading} retry={group.retry} /> : null}
                            </DropdownMenu.Group>
                          ))}
                          {!selectionCatalog?.agentGroups?.length && selectionCatalog?.isFetching &&
                          catalogModels.length === 0 ? (
                            <ModelCatalogStatus loading retry={selectionCatalog.retryModels} />
                          ) : null}
                          {!selectionCatalog?.agentGroups?.length && selectionCatalog?.modelError && !selectionCatalog.isFetching ? (
                            <ModelCatalogStatus error retry={selectionCatalog.retryModels} />
                          ) : null}
                          {!selectionCatalog?.agentGroups?.length && !selectionCatalog?.isFetching && !selectionCatalog?.modelError && catalogModels.length === 0 ? <ModelCatalogStatus /> : null}
                          {manageModels ? <>
                            <DropdownMenu.Separator className="opencraft-composer-selection-menu__separator" />
                            <DropdownMenu.Item className="opencraft-composer-selection-menu__item" onSelect={manageModels}>
                              <Plus size={16} aria-hidden="true" />
                              {catalogModels.length === 0 ? <FormattedMessage id="composer.model.add" defaultMessage="Add a model…" /> : <FormattedMessage id="workIn.manageModels" defaultMessage="Manage models…" />}
                            </DropdownMenu.Item>
                          </> : null}
                          {!selectionCatalog?.isFetching &&
                          selectedModelValue !== null &&
                          selectedModel === null ? (
                            <div className="opencraft-composer-selection-menu__status is-error">
                              <FormattedMessage id="composer.model.unavailable" defaultMessage="The selected model is unavailable. Choose another model." />
                            </div>
                          ) : null}
                        </div>
                      </div>
              </ComposerModelPicker> : null}

              {showPermissionPicker ? <DropdownMenu.Root

                open={openPicker === "permissions"}
                onOpenChange={changePicker("permissions")}
              >
                <div className="opencraft-composer-picker opencraft-composer-picker--permissions">
                  <DropdownMenu.Trigger asChild>
                    <DisclosureButton
                      {...permissionsFocus.triggerProps}
                      className="opencraft-composer-mode opencraft-composer-mode--permissions"
                      type="button"
                      disabled={disabled}
                      title={
                        selectionCatalog?.permissionProfileError ??
                        permissionTriggerTitle
                      }
                    >
                      <PermissionShieldIcon size={18} />
                      <span className="opencraft-composer-mode__permission-label">
                        {permissionSelectionLabel}
                      </span>
                      <ChevronDown size={14} />
                    </DisclosureButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal container={portalContainer}>
                    <DropdownMenu.Content
                      {...permissionsFocus.contentProps}
                      className="opencraft-composer-selection-menu opencraft-composer-selection-menu--permissions"
                      aria-label={permissionsLabel}
                      align="start"
                      sideOffset={1}
                      collisionPadding={6}
                    >
                      <DropdownMenu.Group className="opencraft-composer-selection-menu__items">
                      {catalogPermissions.map((permission, index) => {
                        const isSelected =
                          permission.value === selectedPermissionValue;
                        return (
                          <Fragment key={permission.id}>
                          {permission.mode == null && (index === 0 || catalogPermissions[index - 1]?.mode != null) ? (
                            <div className="opencraft-composer-selection-menu__status">{intl.formatMessage({ id: "composer.permissions.engineProfiles", defaultMessage: "Engine profiles" })}</div>
                          ) : null}
                          <DropdownMenu.Item
                            className={[
                              "opencraft-composer-selection-menu__item",
                              "has-leading",
                              permission.mode === "full"
                                ? "is-dangerous"
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            data-selected={isSelected ? "true" : undefined}
                            data-permission-kind={permission.mode == null ? "native" : "standard"}
                            disabled={permission.disabled}
                            title={
                              permission.disabled
                                ? intl.formatMessage({ id: "composer.permissions.disabled", defaultMessage: "Disabled by AppServer requirements" })
                                : undefined
                            }
                            onSelect={() => selectPermission(permission.value)}
                          >
                            <SelectionMenuItemContent
                              description={displayPermissionDescription(permission, intl)}
                              label={displayPermissionLabel(permission, intl)}
                              leading={permissionMenuLeadingIcon(
                                permission.mode,
                              )}
                              selected={isSelected}
                            />
                          </DropdownMenu.Item>
                          </Fragment>
                        );
                      })}
                      </DropdownMenu.Group>
                      {selectionCatalog?.isFetching &&
                      catalogPermissions.length === 0 ? (
                        <div className="opencraft-composer-selection-menu__status">
                          {intl.formatMessage({ id: "composer.permissions.loading", defaultMessage: "Loading permission profiles…" })}
                        </div>
                      ) : null}
                      {selectionCatalog?.permissionProfileError ? (
                        <div className="opencraft-composer-selection-menu__status is-error">
                          {intl.formatMessage({ id: "composer.permissions.refreshError", defaultMessage: "Could not refresh permission profiles. Try again when connected. Current permissions remain unchanged." })}
                        </div>
                      ) : null}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </div>
              </DropdownMenu.Root> : null}
            </div>
          </div>
          <div ref={footerLayout.endRef} className="opencraft-composer-footer__end" inert={voiceActive ? true : undefined} aria-hidden={voiceActive ? true : undefined}>
            {(displayFast ?? selectedModel?.serviceTiers?.some(tier => tier.id === selectedServiceTier && (tier.id === "fast" || tier.name.toLowerCase() === "fast"))) ? (
              <span className="opencraft-composer-collapsed-fast" role="img" aria-label="Fast">
                <LightningIcon size={15} filled aria-hidden="true" />
              </span>
            ) : null}
            {endActions}
            {mentionSuggestionsEnabled ? (
              <IconButton size="accessory"
                className="opencraft-composer-icon-button opencraft-composer-icon-button--context"
                type="button"
                aria-label={intl.formatMessage({ id: "composer.mentionContext", defaultMessage: "Mention files and context" })}
                title={intl.formatMessage({ id: "composer.mentionContext", defaultMessage: "Mention files and context" })}
                onClick={() => insertTrigger("@")}
              >
                <AtSign size={15} />
              </IconButton>
            ) : null}
            {addMenuContent === undefined || addMenuContent === null ? (
              <IconButton size="accessory"
                className="opencraft-composer-icon-button opencraft-composer-icon-button--context opencraft-composer-icon-button--attachment"
                type="button"
                aria-label={intl.formatMessage({ id: "chat.attach", defaultMessage: "Attach files" })}
                title={intl.formatMessage({ id: "chat.attach", defaultMessage: "Attach files" })}
                onClick={openAttachmentPicker}
              >
                <Paperclip size={15} />
              </IconButton>
            ) : null}
            {primaryAction === "stop" ? (
              <button
                className="opencraft-composer-submit is-stop"
                type="button"
                disabled={isStopping}
                aria-busy={isStopping || undefined}
                aria-label={primaryActionLabel}
                title={primaryActionTitle}
                data-composer-primary-action={primaryAction}
                onMouseDown={(event) => {
                  // Prevent mouse focus transfer without cancelling touch click synthesis.
                  if (event.button === 0) event.preventDefault();
                }}
                onClick={(event) => onCancel({
                  trigger: event.detail === 0 ? "keyboard" : "pointer",
                  isTrusted: event.isTrusted,
                  occurredAt: Date.now(),
                })}
              >
                {isStopping ? <LoadingRingIcon className="opencraft-composer-stop-spinner" size={17} /> : <StopCircleIcon size={17} />}
              </button>
            ) : (
              <button
                className="opencraft-composer-submit"
                type="button"
                aria-label={primaryActionLabel}
                title={primaryActionTitle}
                data-composer-primary-action={primaryAction}
                disabled={disabled || submissionDisabled || !composerSnapshot.canSubmit}
                onMouseDown={(event) => {
                  // Prevent mouse focus transfer without cancelling touch click synthesis.
                  if (event.button === 0) event.preventDefault();
                }}
                onClick={() => {
                  void submit(
                    primaryAction === "send" ? undefined : primaryAction,
                  );
                }}
              >
                <ArrowUp size={18} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
      {waitingForHostWithContent ? (
        <p className="opencraft-composer-connection-hint" role="status">
          {intl.formatMessage({ id: "chat.waitingForHostToSend", defaultMessage: "Connecting. You can send once connected." })}
        </p>
      ) : null}
    </div>
  );
});
