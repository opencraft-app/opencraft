// Semantically adapted from the recovered Codex Composer/editor, queue tray,
// and responsive footer boundaries. AppServer state remains externally owned.
import { baseKeymap, newlineInCode, splitBlock } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
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
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { reasoningCapability, resolveReasoningEffort } from "@opencraft/composer-core";
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  CircleStop,
  FileCode2,
  FileText,
  Image,
  Paperclip,
  Plus,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
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
import { ComposerQueueTray } from "./queue-tray";
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
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly defaultEffort: string | null;
  readonly efforts: readonly ComposerReasoningEffortOption[];
}

export interface ComposerAgentOption {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly engineKind: string;
  readonly isDefault: boolean;
  readonly defaultModel: string | null;
  readonly modelIds: readonly string[];
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

export interface ComposerPermissionOption {
  readonly id: string;
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
  readonly disabled: boolean;
}

export interface ComposerSelectionCatalog {
  readonly agents?: readonly ComposerAgentOption[];
  readonly models: readonly ComposerModelOption[];
  readonly permissionProfiles: readonly ComposerPermissionOption[];
  readonly isFetching?: boolean;
  readonly modelError?: string | null;
  readonly permissionProfileError?: string | null;
  readonly onModelMenuOpen?: () => void;
  readonly retryModels?: () => void;
}

export interface ComposerEffectiveSelections {
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

function compactModelLabel(label: string): string {
  return label.replace(/^GPT-/iu, "").replace(/-(?=[\p{L}])/gu, " ");
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
          className="codex-composer-selection-menu__leading"
          aria-hidden="true"
        >
          {leading}
        </span>
      )}
      <span className="codex-composer-selection-menu__copy">
        <span className="codex-composer-selection-menu__label">{label}</span>
        {description ? (
          <span className="codex-composer-selection-menu__description">
            {description}
          </span>
        ) : null}
      </span>
      {selected ? (
        <span
          className="codex-composer-selection-menu__trailing"
          aria-hidden="true"
        >
          <Check size={16} strokeWidth={1.75} />
        </span>
      ) : null}
    </>
  );
}

function permissionMenuLeadingIcon(permissionValue: string | null): ReactNode {
  if (permissionValue === null) {
    return <ShieldCheck size={18} strokeWidth={1.65} />;
  }
  if (permissionValue === ":danger-full-access") {
    return <Zap size={18} strokeWidth={1.65} />;
  }
  if (/read[-_ ]?only|readonly/iu.test(permissionValue)) {
    return <FileText size={18} strokeWidth={1.65} />;
  }
  return <FileCode2 size={18} strokeWidth={1.65} />;
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

function permissionLabel(value: string): string {
  switch (value) {
    case ":read-only":
      return "Read only";
    case ":workspace":
    case ":workspace_roots":
      return "Workspace";
    case ":danger-full-access":
      return "Full access";
    default:
      return formatSelectionLabel(value);
  }
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

const suggestionPluginKey = new PluginKey("codex-composer-suggestions");
const transientTextPluginKey = new PluginKey<TransientTextDecorationState | null>(
  "codex-composer-transient-text",
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
            span.className = "codex-composer-transient-text";
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
        "data-label": node.attrs.label,
        ...(node.attrs.payload === null
          ? {}
          : { "data-payload": JSON.stringify(node.attrs.payload) }),
        class: `codex-composer-token codex-composer-token--${node.attrs.kind}`,
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

function createPlaceholderPlugin(placeholder: string): Plugin {
  return new Plugin({
    key: new PluginKey("codex-composer-placeholder"),
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
        const widget = Decoration.widget(
          1,
          () => {
            const span = document.createElement("span");
            span.className = "codex-composer-placeholder";
            span.textContent = placeholder;
            return span;
          },
          { side: -1 },
        );
        return DecorationSet.create(state.doc, [widget]);
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
    key: new PluginKey("codex-composer-stable-list-item-ids"),
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

export interface CodexComposerHandle {
  focus(): void;
  clear(): void;
  getDocument(): ComposerDocument;
  createSubmitIntent(): SubmitIntent;
}

export interface ComposerQueuedSubmissionPresentation {
  readonly id: string;
  readonly preview: string;
  readonly state: "submitting" | "queued" | "failed";
  readonly operation: "idle" | "updating" | "deleting" | "starting";
  readonly actionable: boolean;
  /** Whether this runtime permits changing authoritative queue order. */
  readonly reorderable?: boolean;
  readonly editableContent: ComposerQueuedSubmissionContent;
  readonly pausedReason?: string | null;
  readonly error?: string | null;
}

export interface ComposerQueuedSubmissionContent {
  readonly document: ComposerDocument;
  readonly attachments: readonly ComposerAttachment[];
  readonly context: readonly ComposerContextReference[];
}

export interface CodexComposerProps {
  controller: ComposerController;
  /** Composer-owned chrome rendered above attachments and the editor. */
  chromeHeader?: ReactNode;
  /** Host-owned trusted extension actions placed before built-in end actions. */
  endActions?: ReactNode;
  catalog?: ComposerCatalog;
  /** Whether this surface can resolve `@` references through its Host. */
  mentionSuggestionsEnabled?: boolean;
  isStreaming: boolean;
  disabled?: boolean;
  /**
   * Blocks command admission without taking ownership of the editable Draft.
   * Use this for a temporarily unavailable execution Host: the user may keep
   * composing while the immutable intent must not cross the transport seam.
   */
  submissionDisabled?: boolean;
  placeholder?: string;
  selectionCatalog?: ComposerSelectionCatalog;
  effectiveSelections?: ComposerEffectiveSelections;
  executionTarget?: ComposerExecutionTarget;
  defaultFollowUpAction?: ComposerFollowUpAction;
  /** Thread-owned queue projection. The Composer only renders this state. */
  queuedSubmissions?: readonly ComposerQueuedSubmissionPresentation[];
  onUpdateQueuedSubmission?: (
    id: string,
    intent: SubmitIntent,
  ) => Promise<void>;
  onDeleteQueuedSubmission?: (id: string) => Promise<void>;
  onReorderQueuedSubmissions?: (ids: readonly string[]) => Promise<void>;
  onSteerQueuedSubmission?: (id: string) => Promise<void>;
  onResumeQueuedSubmissions?: () => Promise<void>;
  onResolveAttachment?: (
    file: File,
    pending: ComposerAttachment,
    signal?: AbortSignal,
  ) => ComposerAttachment | Promise<ComposerAttachment>;
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
  onCancel(): void;
}

export const CodexComposer = forwardRef<
  CodexComposerHandle,
  CodexComposerProps
>(function CodexComposer(
  {
    controller,
    chromeHeader,
    endActions,
    catalog,
    mentionSuggestionsEnabled = true,
    isStreaming,
    disabled = false,
    submissionDisabled = false,
    placeholder = "Ask for follow-up changes",
    selectionCatalog,
    effectiveSelections,
    executionTarget,
    defaultFollowUpAction = "queue",
    queuedSubmissions = [],
    onUpdateQueuedSubmission,
    onDeleteQueuedSubmission,
    onReorderQueuedSubmissions,
    onSteerQueuedSubmission,
    onResumeQueuedSubmissions,
    onResolveAttachment,
    onSubmit,
    onCancel,
  },
  forwardedRef,
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const attachmentJobs = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const cancelRemoved = () => {
      const ids = new Set(controller.getSnapshot().draft.attachments.map(attachment => attachment.id));
      for (const [id, job] of attachmentJobs.current) if (!ids.has(id)) { job.abort(); attachmentJobs.current.delete(id); }
    };
    const unsubscribe = controller.subscribe(cancelRemoved);
    return () => { unsubscribe(); for (const job of attachmentJobs.current.values()) job.abort(); attachmentJobs.current.clear(); };
  }, [controller]);
  const editorViewRef = useRef<EditorView | null>(null);
  const editorControllerRef = useRef<ComposerController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A native picker may outlive the Composer that opened it.
  const attachmentPickerOwnerRef = useRef<EditorView | null>(null);
  const suggestionQueryRef = useRef<SuggestionQuery | null>(null);
  const filteredSuggestionsRef = useRef<readonly Suggestion[]>([]);
  const suggestionLoadingRef = useRef(false);
  const selectedSuggestionRef = useRef(0);
  const pendingSubmissionRef = useRef<{
    readonly controller: ComposerController;
    readonly token: symbol;
  } | null>(null);
  const queueEditOriginRef = useRef<ComposerQueuedSubmissionContent | null>(
    null,
  );
  const refocusEditorAfterIntelligenceMenuRef = useRef(false);
  const isStreamingRef = useRef(isStreaming);
  const defaultFollowUpActionRef = useRef(defaultFollowUpAction);
  const disabledRef = useRef(disabled);
  isStreamingRef.current = isStreaming;
  defaultFollowUpActionRef.current = defaultFollowUpAction;
  disabledRef.current = disabled;
  const [suggestionQuery, setSuggestionQuery] =
    useState<SuggestionQuery | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [catalogSuggestions, setCatalogSuggestions] = useState<
    readonly Suggestion[]
  >([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [openPicker, setOpenPicker] = useState<SelectionPicker | null>(null);
  const [editingQueuedSubmissionId, setEditingQueuedSubmissionId] = useState<
    string | null
  >(null);
  const footerLayout = useMeasuredComposerFooterLayout();

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
  const catalogAgents = selectionCatalog?.agents ?? [];
  const catalogDefaultAgent =
    catalogAgents.find((agent) => agent.isDefault) ?? catalogAgents[0] ?? null;
  const selectedAgentId =
    composerSnapshot.draft.selections.agentId ??
    effectiveSelections?.agentId ??
    catalogDefaultAgent?.id ??
    null;
  const selectedAgent = selectedAgentId === null
    ? null
    : (catalogAgents.find((agent) => agent.id === selectedAgentId) ?? null);
  const allCatalogModels = selectionCatalog?.models ?? [];
  const catalogModels = selectedAgent === null
    ? allCatalogModels
    : allCatalogModels.filter((model) =>
        selectedAgent.modelIds.includes(model.id) || selectedAgent.modelIds.includes(model.value));
  const catalogPermissions = selectionCatalog?.permissionProfiles ?? [];
  const catalogDefaultModel =
    catalogModels.find((model) => model.isDefault) ?? catalogModels[0] ?? null;
  const selectedModelValue =
    composerSnapshot.draft.selections.model ??
    effectiveSelections?.model ??
    catalogDefaultModel?.value ??
    null;
  const selectedModel =
    selectedModelValue === null
      ? catalogDefaultModel
      : (catalogModels.find(
          (model) =>
            model.value === selectedModelValue ||
            model.id === selectedModelValue,
        ) ?? null);
  const selectedEffortValue = selectedModel ? resolveReasoningEffort(
    reasoningCapability(selectedModel.efforts.map(e=>e.value),selectedModel.defaultEffort),
    composerSnapshot.draft.selections.effort ?? effectiveSelections?.effort,
  ) ?? null : null;
  // Null means inherit, including drafts saved by the former default option.
  // Display the resolved policy without writing it back as an explicit choice.
  const selectedPermissionValue =
    composerSnapshot.draft.selections.permissionProfile ??
    effectiveSelections?.permissionProfile ?? null;
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
  const filteredSuggestions =
    suggestionQuery == null
      ? []
      : suggestionQuery.kind === "command"
        ? localCommandSuggestions.filter((suggestion) =>
            suggestion.label
              .toLowerCase()
              .includes(suggestionQuery.query.toLowerCase()),
          )
        : catalogQueryText.length === 0
          ? []
          : catalogSuggestions;
  filteredSuggestionsRef.current = filteredSuggestions;
  suggestionLoadingRef.current = catalogLoading;

  const catalogTargetKey = encodeComposerTarget(composerSnapshot.draft.target);
  useEffect(() => {
    if (
      catalog === undefined ||
      catalogQueryKind === null ||
      catalogQueryText.length === 0
    ) {
      setCatalogSuggestions((current) => (current.length === 0 ? current : []));
      setCatalogLoading(false);
      setCatalogError(null);
      return;
    }
    const abortController = new AbortController();
    let active = true;
    setCatalogSuggestions([]);
    setCatalogLoading(true);
    setCatalogError(null);
    void catalog
      .search(
        {
          kind: catalogQueryKind,
          query: catalogQueryText,
          target: composerSnapshot.draft.target,
          limit: 50,
        },
        abortController.signal,
      )
      .then(
        (entries) => {
          if (!active) return;
          setCatalogSuggestions(entries.map(catalogSuggestion));
          setCatalogLoading(false);
        },
        (error: unknown) => {
          if (!active || abortController.signal.aborted) return;
          setCatalogSuggestions([]);
          setCatalogLoading(false);
          setCatalogError(
            error instanceof Error ? error.message : String(error),
          );
        },
      );
    return () => {
      active = false;
      abortController.abort();
    };
  }, [catalog, catalogQueryKind, catalogQueryText, catalogTargetKey]);

  const syncSuggestions = useCallback((state: EditorState) => {
    const candidate = querySuggestion(state);
    const next = candidate?.kind === "mention" && !mentionSuggestionsEnabled
      ? null
      : candidate;
    suggestionQueryRef.current = next;
    selectedSuggestionRef.current = 0;
    setSuggestionQuery(next);
    setSelectedSuggestion(0);
  }, [mentionSuggestionsEnabled]);

  const appendFiles = useCallback(
    (files: File[]) => {
      const view = editorViewRef.current;
      if (files.length === 0 || disabledRef.current || view === null ||
        view.isDestroyed || !view.dom.isConnected || editorControllerRef.current !== controller) return;
      for (const file of files) {
        const pending: ComposerAttachment = {
          id: createClientId(),
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          uri: null,
          lifecycle: onResolveAttachment === undefined ? "failed" : "pending",
          error:
            onResolveAttachment === undefined
              ? "No browser-to-AppServer attachment bridge is configured"
              : null,
        };
        controller.dispatch({ type: "add-attachment", attachment: pending });
        if (onResolveAttachment === undefined) continue;
        const job = new AbortController();
        attachmentJobs.current.set(pending.id, job);
        void Promise.resolve().then(() => onResolveAttachment(file, pending, job.signal))
          .then(
            (resolved) => {
              if (job.signal.aborted) return;
              const { id: _resolvedId, ...patch } = resolved;
              controller.dispatch({
                type: "update-attachment",
                id: pending.id,
                patch,
              });
            },
            (error: unknown) => {
              if (job.signal.aborted) return;
              controller.dispatch({
                type: "update-attachment",
                id: pending.id,
                patch: {
                  lifecycle: "failed",
                  error: error instanceof Error ? error.message : String(error),
                },
              });
            },
          )
          .catch(() => {
            // The owning Conversation View may have been evicted while the host
            // attachment resolver was still completing. Its disposed Controller
            // deliberately rejects late writes.
          }).finally(() => attachmentJobs.current.delete(pending.id));
      }
      // Focus belongs to the initiating interaction, not upload completion.
      // Keep ProseMirror's selection; do not move the caret or schedule a late focus.
      if (editorViewRef.current === view && !view.isDestroyed && view.dom.isConnected) {
        view.focus();
      }
    },
    [controller, onResolveAttachment],
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
    async (followUpActionOverride?: ComposerFollowUpAction) => {
      const view = editorViewRef.current;
      if (
        view == null ||
        view.isDestroyed ||
        editorControllerRef.current !== controller ||
        disabled ||
        submissionDisabled ||
        !composerSnapshot.canSubmit ||
        pendingSubmissionRef.current?.controller === controller
      )
        return;
      controller.dispatch({
        type: "set-document",
        document: proseMirrorToComposerDocument(view.state.doc),
      });
      let intent: SubmitIntent;
      try {
        intent = controller.createSubmitIntent();
        if (selectedModel && !isStreaming && editingQueuedSubmissionId === null) {
          intent = { ...intent, selections: { ...intent.selections,
            model: selectedModel.value,
            effort: resolveReasoningEffort(reasoningCapability(selectedModel.efforts.map(e=>e.value),selectedModel.defaultEffort),intent.selections.effort ?? effectiveSelections?.effort),
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
          view.setProps({ editable: () => !disabledRef.current });
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
      disabled,
      submissionDisabled,
      isStreaming,
      onSubmit,
      onUpdateQueuedSubmission,
      editingQueuedSubmissionId,
      selectedModel,
      effectiveSelections?.effort,
    ],
  );
  const submitActionRef = useRef(submit);
  submitActionRef.current = submit;

  const insertSuggestion = useCallback((suggestion: Suggestion) => {
    const view = editorViewRef.current;
    const query = suggestionQueryRef.current;
    if (view == null || query == null) return;
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
            : { uri: suggestion.uri, metadata: suggestion.metadata },
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

  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (mount == null) return;

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
          ArrowUp: () => {
            const query = suggestionQueryRef.current;
            if (query == null) return false;
            selectedSuggestionRef.current = Math.max(
              0,
              selectedSuggestionRef.current - 1,
            );
            setSelectedSuggestion(selectedSuggestionRef.current);
            return true;
          },
          ArrowDown: () => {
            const query = suggestionQueryRef.current;
            if (query == null) return false;
            const count = filteredSuggestionsRef.current.length;
            selectedSuggestionRef.current = Math.min(
              Math.max(0, count - 1),
              selectedSuggestionRef.current + 1,
            );
            setSelectedSuggestion(selectedSuggestionRef.current);
            return true;
          },
          Escape: () => {
            if (suggestionQueryRef.current == null) return false;
            suggestionQueryRef.current = null;
            setSuggestionQuery(null);
            return true;
          },
          Enter: (state, dispatch, view) => {
            const query = suggestionQueryRef.current;
            if (query != null) {
              const items = filteredSuggestionsRef.current;
              const item = items[selectedSuggestionRef.current];
              if (item != null) {
                insertSuggestion(item);
                return true;
              }
              if (suggestionLoadingRef.current) return true;
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
          "Mod-Enter": () => {
            submitActionRef.current(
              isStreamingRef.current
                ? invertComposerFollowUpAction(defaultFollowUpActionRef.current)
                : undefined,
            );
            return true;
          },
          "Mod-z": undo,
          "Mod-y": redo,
          "Mod-Shift-z": redo,
          Tab: sinkListItem(composerSchema.nodes.list_item),
          "Shift-Tab": liftListItem(composerSchema.nodes.list_item),
          "Alt-Enter": (state, dispatch) => splitBlock(state, dispatch),
        }),
        keymap(composerBaseKeymap),
        createPlaceholderPlugin(placeholder),
        new Plugin({
          key: suggestionPluginKey,
          props: {
            handlePaste(_view, event) {
              const files = filesFromTransfer(event.clipboardData);
              if (files.length > 0) {
                appendFiles(files);
                return true;
              }
              const text = event.clipboardData?.getData("text/plain") ?? "";
              if (text.length >= 5000) {
                appendFiles([
                  new File([text], "pasted-text.txt", { type: "text/plain" }),
                ]);
                return true;
              }
              return false;
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
        !disabledRef.current &&
        pendingSubmissionRef.current?.controller !== controller,
      attributes: {
        "aria-label": placeholder,
        "aria-multiline": "true",
        class: "codex-composer-editor",
        dir: "auto",
        role: "textbox",
        spellcheck: "true",
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
  }, [appendFiles, controller, insertSuggestion, placeholder, syncSuggestions]);

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
        !disabledRef.current &&
        pendingSubmissionRef.current?.controller !== controller,
    });
  }, [controller, disabled]);

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
        beginTransientTextInput: () => {
          const view = editorViewRef.current;
          if (view === null || view.isDestroyed) return null;
          const generation = ++transientGeneration;
          const { from, to } = view.state.selection;
          view.dispatch(
            view.state.tr.setMeta(transientTextPluginKey, {
              type: "begin",
              from,
              to,
            } satisfies TransientTextTransaction),
          );
          view.focus();
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
            commit(text: string) {
              if (!ownsSession()) return;
              const transient = transientTextPluginKey.getState(view.state);
              if (!clear() || transient == null || text.length === 0) return;
              view.dispatch(
                view.state.tr
                  .insertText(text, transient.from, transient.to)
                  .scrollIntoView(),
              );
              view.focus();
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
    controller.dispatch({ type: "remove-attachment", id });
  };

  const insertTrigger = (trigger: "@" | "/" | "$") => {
    if (disabled) return;
    controller.insertText(trigger);
  };

  const selectModel = (model: ComposerModelOption) => {
    const supportsCurrentEffort =
      selectedEffortValue !== null &&
      model.efforts.some((effort) => effort.value === selectedEffortValue);
    controller.dispatch({
      type: "set-selections",
      patch: {
        model: model.value,
        effort: resolveReasoningEffort(reasoningCapability(model.efforts.map(e=>e.value),model.defaultEffort),supportsCurrentEffort ? selectedEffortValue : undefined),
      },
    });
    refocusEditorAfterIntelligenceMenuRef.current = true;
    setOpenPicker(null);
  };

  const selectAgent = (agent: ComposerAgentOption) => {
    if (!agent.available) return;
    controller.dispatch({
      type: "set-selections",
      patch: {
        agentId: agent.id,
        model: agent.defaultModel ?? undefined,
        effort: undefined,
      },
    });
    refocusEditorAfterIntelligenceMenuRef.current = true;
    setOpenPicker(null);
  };

  const selectEffort = (effort: ComposerReasoningEffortOption) => {
    controller.dispatch({
      type: "set-selections",
      patch: { effort: effort.value },
    });
    refocusEditorAfterIntelligenceMenuRef.current = true;
    setOpenPicker(null);
  };

  const selectPermission = (permissionProfile: string | null) => {
    controller.dispatch({
      type: "set-selections",
      patch: { permissionProfile },
    });
    setOpenPicker(null);
  };

  const handleIntelligenceMenuCloseAutoFocus = useCallback((event: Event) => {
    if (!refocusEditorAfterIntelligenceMenuRef.current) return;
    refocusEditorAfterIntelligenceMenuRef.current = false;
    event.preventDefault();
    editorViewRef.current?.focus();
  }, []);

  const handleIntelligenceMenuEscape = useCallback(() => {
    refocusEditorAfterIntelligenceMenuRef.current = true;
  }, []);

  const modelLabel =
    selectedModel?.label ??
    (selectedModelValue === null
      ? "Model"
      : formatSelectionLabel(selectedModelValue));
  const compactSelectedModelLabel = compactModelLabel(modelLabel);
  const selectedEffort =
    selectedModel?.efforts.find(
      (effort) => effort.value === selectedEffortValue,
    ) ?? null;
  const effortLabel =
    selectedEffort === null
      ? selectedEffortValue === null
        ? "Effort"
        : formatSelectionLabel(selectedEffortValue)
      : displayReasoningEffort(selectedEffort);
  const permissionTriggerLabel =
    selectedPermission?.label ??
    (selectedPermissionValue === null
      ? "Permissions"
      : permissionLabel(selectedPermissionValue));
  const modelPickerDisabled = disabled || catalogModels.length === 0;

  const primaryAction = resolveComposerPrimaryAction({
    isResponseInProgress: isStreaming,
    canSubmit: !disabled && !submissionDisabled && composerSnapshot.canSubmit,
    defaultFollowUpAction,
  });
  const primaryActionLabel =
    editingQueuedSubmissionId !== null
      ? "Save queued message"
      : primaryAction === "stop"
        ? "Stop response"
        : primaryAction === "queue"
          ? "Queue follow-up"
          : primaryAction === "steer"
            ? "Steer active response"
            : "Send message";
  const inverseFollowUpAction = invertComposerFollowUpAction(
    defaultFollowUpAction,
  );
  const primaryActionTitle = submissionDisabled && primaryAction !== "stop"
    ? "Waiting for execution host"
    : isStreaming && primaryAction !== "stop"
      ? `${primaryActionLabel} (⌘/Ctrl+Enter to ${inverseFollowUpAction})`
      : primaryActionLabel;
  return (
    <div
      className="codex-composer-stack"
      data-composer-layout="auto-single-line"
      data-composer-phase={composerSnapshot.draft.lifecycle.phase}
      data-composer-has-top-tray={
        queuedSubmissions.length > 0 ? "true" : undefined
      }
      aria-busy={composerSnapshot.draft.lifecycle.phase === "submitting"}
    >
      <ComposerQueueTray
        items={queuedSubmissions.map((item) => ({
          ...item,
          actionable:
            item.actionable &&
            (editingQueuedSubmissionId === null ||
              item.id === editingQueuedSubmissionId),
          editing: item.id === editingQueuedSubmissionId,
        }))}
        isResponseInProgress={isStreaming}
        onEdit={beginQueueEdit}
        onCancelEdit={cancelQueueEdit}
        onDelete={async (id) => {
          await onDeleteQueuedSubmission?.(id);
          if (id === editingQueuedSubmissionId) cancelQueueEdit();
        }}
        onReorder={onReorderQueuedSubmissions}
        onSteer={async (id) => {
          await onSteerQueuedSubmission?.(id);
          if (id === editingQueuedSubmissionId) cancelQueueEdit();
        }}
        onResume={onResumeQueuedSubmissions}
      />
      <div className="codex-composer-shell">
        {chromeHeader === undefined ? null : (
          <div className="codex-composer-chrome-header">{chromeHeader}</div>
        )}
        {composerSnapshot.draft.lifecycle.phase === "failed" && (
          <div className="codex-composer-error" role="alert">
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
          <div className="codex-composer-attachments" aria-label="Attachments">
            {attachments.map((attachment) => (
              <div className="codex-composer-attachment" key={attachment.id}>
                <span className="codex-composer-attachment__icon">
                  {attachment.mimeType.startsWith("image/") ? (
                    <Image size={15} />
                  ) : (
                    <FileText size={15} />
                  )}
                </span>
                <span className="codex-composer-attachment__copy">
                  <strong>{attachment.name}</strong>
                  <small>
                    {Math.max(1, Math.ceil(attachment.size / 1024))} KB
                  </small>
                  {attachment.error ? <small>{attachment.error}</small> : null}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => removeAttachment(attachment.id)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        {suggestionQuery != null &&
          (filteredSuggestions.length > 0 ||
            suggestionQuery.kind === "mention" ||
            (suggestionQuery.kind === "skill" &&
              catalogQueryText.length > 0 &&
              (catalogLoading || catalogError !== null))) && (
            <div
              className="codex-composer-suggestions"
              role="listbox"
              aria-label={`${suggestionQuery.kind} suggestions`}
            >
              <div className="codex-composer-suggestions__label">
                {suggestionQuery.kind === "command"
                  ? "Commands"
                  : suggestionQuery.kind === "skill"
                    ? "Skills"
                    : "Files and context"}
              </div>
              {suggestionQuery.kind === "mention" &&
              catalogQueryText.length === 0 ? (
                <div
                  className="codex-composer-suggestions__status"
                  role="status"
                >
                  Type to search for files
                </div>
              ) : null}
              {catalogLoading && filteredSuggestions.length === 0 ? (
                <div
                  className="codex-composer-suggestions__status"
                  role="status"
                >
                  {suggestionQuery.kind === "mention"
                    ? "Searching files…"
                    : "Loading skills…"}
                </div>
              ) : null}
              {catalogError !== null ? (
                <div
                  className="codex-composer-suggestions__status is-error"
                  role="status"
                >
                  {suggestionQuery.kind === "mention"
                    ? "File search unavailable"
                    : "Skills unavailable"}
                </div>
              ) : null}
              {filteredSuggestions.map((suggestion, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selectedSuggestion}
                  className={
                    index === selectedSuggestion ? "is-selected" : undefined
                  }
                  key={suggestion.id}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertSuggestion(suggestion);
                  }}
                >
                  <span>
                    {suggestion.kind === "command" ? (
                      <Zap size={15} />
                    ) : suggestion.kind === "skill" ? (
                      <Sparkles size={15} />
                    ) : (
                      <FileCode2 size={15} />
                    )}
                  </span>
                  <span>
                    <strong>
                      {suggestion.kind === "command"
                        ? "/"
                        : suggestion.kind === "skill"
                          ? "$"
                          : "@"}
                      {suggestion.label}
                    </strong>
                    <small>{suggestion.detail}</small>
                  </span>
                </button>
              ))}
            </div>
          )}

        <div className="codex-composer-input-row">
          <div ref={mountRef} className="codex-composer-editor-mount" />
        </div>

        <div
          ref={footerLayout.footerRef}
          className="codex-composer-footer"
          data-footer-density={footerLayout.density}
        >
          <div
            ref={footerLayout.attachmentRef}
            className="codex-composer-footer__attachment"
          >
            <button
              className="codex-composer-icon-button"
              type="button"
              aria-label="Add attachment"
              onClick={openAttachmentPicker}
            >
              <Plus size={16} />
            </button>
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
          </div>
          <div
            ref={footerLayout.controlsRef}
            className="codex-composer-footer__controls"
          >
            {executionTarget === undefined ? null : (
              <span
                className="codex-composer-mode codex-composer-mode--static"
                title={`Execution node: ${executionTarget.hostLabel}`}
              >
                {executionTarget.hostLabel}
              </span>
            )}
            <div className="codex-composer-picker-region">
              <DropdownMenu.Root
                modal={false}
                open={openPicker === "intelligence"}
                onOpenChange={(isOpen) => {
                  if (isOpen) selectionCatalog?.onModelMenuOpen?.();
                  if (isOpen)
                    refocusEditorAfterIntelligenceMenuRef.current = false;
                  setOpenPicker((current) =>
                    isOpen
                      ? "intelligence"
                      : current === "intelligence"
                        ? null
                        : current,
                  );
                }}
              >
                <div className="codex-composer-picker codex-composer-picker--intelligence">
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="codex-composer-mode codex-composer-mode--intelligence"
                      type="button"
                      disabled={modelPickerDisabled}
                      title={
                        selectionCatalog?.modelError ??
                        `${modelLabel} · ${effortLabel}`
                      }
                    >
                      <span className="codex-composer-mode__model-label">
                        {compactSelectedModelLabel}
                      </span>
                      {selectedModel?.efforts.length ? (
                        <span className="codex-composer-mode__effort-label">
                          {effortLabel}
                        </span>
                      ) : null}
                      <ChevronDown
                        className="codex-composer-mode__chevron"
                        size={12}
                      />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="codex-composer-selection-menu codex-composer-selection-menu--intelligence"
                      aria-label="Model and reasoning"
                      align="start"
                      sideOffset={6}
                      collisionPadding={6}
                      onCloseAutoFocus={handleIntelligenceMenuCloseAutoFocus}
                      onEscapeKeyDown={handleIntelligenceMenuEscape}
                    >
                      <div className="codex-composer-intelligence-view">
                        {catalogAgents.length > 1 ? (
                          <>
                            <DropdownMenu.Label className="codex-composer-selection-menu__heading">
                              Agent
                            </DropdownMenu.Label>
                            {catalogAgents.map((agent) => {
                              const isSelected = agent.id === selectedAgentId;
                              return (
                                <DropdownMenu.Item
                                  key={agent.id}
                                  className="codex-composer-selection-menu__item"
                                  data-selected={isSelected ? "true" : undefined}
                                  disabled={!agent.available}
                                  onSelect={() => selectAgent(agent)}
                                >
                                  <SelectionMenuItemContent
                                    description={agent.unavailableReason ?? agent.description}
                                    label={agent.label}
                                    selected={isSelected}
                                  />
                                </DropdownMenu.Item>
                              );
                            })}
                            <DropdownMenu.Separator className="codex-composer-selection-menu__separator" />
                          </>
                        ) : null}
                        <DropdownMenu.Label className="codex-composer-selection-menu__heading">
                          Model
                        </DropdownMenu.Label>
                        {catalogModels.map((model) => {
                          const isSelected =
                            model.value === selectedModelValue ||
                            model.id === selectedModelValue;
                          return (
                            <DropdownMenu.Item
                              key={model.id}
                              className="codex-composer-selection-menu__item"
                              data-selected={isSelected ? "true" : undefined}
                              onSelect={() => selectModel(model)}
                            >
                              <SelectionMenuItemContent
                                description={model.description}
                                label={model.label}
                                selected={isSelected}
                              />
                            </DropdownMenu.Item>
                          );
                        })}
                        {selectionCatalog?.isFetching &&
                        catalogModels.length === 0 ? (
                          <div className="codex-composer-selection-menu__status">
                            Loading models…
                          </div>
                        ) : null}
                        {selectionCatalog?.modelError ? (
                          <div className="codex-composer-selection-menu__status is-error">
                            {selectionCatalog.modelError}
                            {selectionCatalog.retryModels ? <DropdownMenu.Item className="codex-composer-selection-menu__item" onSelect={event => { event.preventDefault(); selectionCatalog.retryModels?.(); }}>重试</DropdownMenu.Item> : null}
                          </div>
                        ) : null}
                        {!selectionCatalog?.isFetching && selectedModelValue !== null && selectedModel === null ? <div className="codex-composer-selection-menu__status is-error">当前选择的模型不可用，请重新选择。</div> : null}
                        {selectedModel?.efforts.length ? (
                          <>
                            <DropdownMenu.Separator className="codex-composer-selection-menu__separator" />
                            <DropdownMenu.Label className="codex-composer-selection-menu__heading">
                              Reasoning
                            </DropdownMenu.Label>
                            {selectedModel.efforts.map((effort) => {
                              const isSelected =
                                effort.value === selectedEffortValue;
                              return (
                                <DropdownMenu.Item
                                  key={effort.value}
                                  className="codex-composer-selection-menu__item"
                                  data-selected={isSelected ? "true" : undefined}
                                  onSelect={() => selectEffort(effort)}
                                >
                                  <SelectionMenuItemContent
                                    description={effort.description}
                                    label={displayReasoningEffort(effort)}
                                    selected={isSelected}
                                  />
                                </DropdownMenu.Item>
                              );
                            })}
                          </>
                        ) : null}
                      </div>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </div>
              </DropdownMenu.Root>

              <DropdownMenu.Root
                modal={false}
                open={openPicker === "permissions"}
                onOpenChange={(isOpen) => {
                  setOpenPicker((current) =>
                    isOpen
                      ? "permissions"
                      : current === "permissions"
                        ? null
                        : current,
                  );
                }}
              >
                <div className="codex-composer-picker codex-composer-picker--permissions">
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="codex-composer-mode codex-composer-mode--permissions"
                      type="button"
                      disabled={disabled}
                      title={
                        selectionCatalog?.permissionProfileError ??
                        permissionTriggerLabel
                      }
                    >
                      <ShieldCheck size={14} />
                      <span className="codex-composer-mode__permission-label">
                        {permissionTriggerLabel}
                      </span>
                      <ChevronDown size={12} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="codex-composer-selection-menu codex-composer-selection-menu--permissions"
                      aria-label="Permissions"
                      align="start"
                      sideOffset={1}
                      collisionPadding={6}
                    >
                      {catalogPermissions.map((permission) => {
                        const isSelected =
                          permission.value === selectedPermissionValue;
                        return (
                          <DropdownMenu.Item
                            key={permission.id}
                            className={[
                              "codex-composer-selection-menu__item",
                              "has-leading",
                              permission.value === ":danger-full-access"
                                ? "is-dangerous"
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            data-selected={isSelected ? "true" : undefined}
                            disabled={permission.disabled}
                            title={
                              permission.disabled
                                ? "Disabled by AppServer requirements"
                                : undefined
                            }
                            onSelect={() => selectPermission(permission.value)}
                          >
                            <SelectionMenuItemContent
                              description={permission.description}
                              label={permission.label}
                              leading={permissionMenuLeadingIcon(
                                permission.value,
                              )}
                              selected={isSelected}
                            />
                          </DropdownMenu.Item>
                        );
                      })}
                      {selectionCatalog?.isFetching &&
                      catalogPermissions.length === 0 ? (
                        <div className="codex-composer-selection-menu__status">
                          Loading permission profiles…
                        </div>
                      ) : null}
                      {selectionCatalog?.permissionProfileError ? (
                        <div className="codex-composer-selection-menu__status is-error">
                          Permission profiles are unavailable on this host.
                          Current permissions remain unchanged.
                        </div>
                      ) : null}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </div>
              </DropdownMenu.Root>
            </div>
          </div>
          <div ref={footerLayout.endRef} className="codex-composer-footer__end">
            {endActions}
            {mentionSuggestionsEnabled ? (
              <button
                className="codex-composer-icon-button codex-composer-icon-button--context"
                type="button"
                title="Mention files and context"
                onClick={() => insertTrigger("@")}
              >
                <AtSign size={15} />
              </button>
            ) : null}
            <button
              className="codex-composer-icon-button codex-composer-icon-button--context"
              type="button"
              title="Attach files"
              onClick={openAttachmentPicker}
            >
              <Paperclip size={15} />
            </button>
            {primaryAction === "stop" ? (
              <button
                className="codex-composer-submit is-stop"
                type="button"
                aria-label={primaryActionLabel}
                title={primaryActionTitle}
                data-composer-primary-action={primaryAction}
                onPointerDown={(event) => {
                  if (event.button === 0) event.preventDefault();
                }}
                onClick={onCancel}
              >
                <CircleStop size={17} />
              </button>
            ) : (
              <button
                className="codex-composer-submit"
                type="button"
                aria-label={primaryActionLabel}
                title={primaryActionTitle}
                data-composer-primary-action={primaryAction}
                disabled={disabled || submissionDisabled || !composerSnapshot.canSubmit}
                onPointerDown={(event) => {
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
    </div>
  );
});
