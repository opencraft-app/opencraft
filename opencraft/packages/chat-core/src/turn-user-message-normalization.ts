import type { TimelineSourceItem, TimelineSourceTurn } from "./projection";

type RecordValue = Readonly<Record<string, unknown>>;

interface UserMessageCompareKey {
  readonly rawText: string;
  readonly imageCount: number;
}

const NON_RENDERABLE_COMPOSER_PREFIX_ITEMS = new Set([
  "automaticApprovalReview",
  "contextCompaction",
  "forkedFromConversation",
  "modelChanged",
  "modelRerouted",
  "personalityChanged",
  "remoteTaskCreated",
  "worktreeInit",
]);

function record(value: unknown): RecordValue {
  return typeof value === "object" && value !== null ? value as RecordValue : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function inputEntries(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

/** Codex compares the exact text stream and image count when client IDs are unavailable. */
export function codexUserMessageCompareKey(value: unknown): UserMessageCompareKey {
  const entries = inputEntries(value);
  return {
    rawText: entries.flatMap((entry): string[] => {
      if (typeof entry === "string") return [entry];
      const source = record(entry);
      return source.type === "text" && typeof source.text === "string" ? [source.text] : [];
    }).join("\n"),
    imageCount: entries.filter((entry) => {
      const source = record(entry);
      return source.type === "image" || source.type === "localImage";
    }).length,
  };
}

function compareKeysEqual(left: UserMessageCompareKey, right: UserMessageCompareKey): boolean {
  return left.rawText === right.rawText && left.imageCount === right.imageCount;
}

function itemInput(item: TimelineSourceItem): unknown {
  const source = record(item.payload);
  return item.type === "steeringUserMessage"
    ? source.input ?? source.content
    : source.content ?? source.input;
}

function itemClientId(item: TimelineSourceItem): string | null {
  const source = record(item.payload);
  return string(source.clientId) ?? string(source.clientUserMessageId);
}

/** The Host may enrich Codex input after Turn.params was captured. In that
 * case the acknowledged UserMessage is the only source of the UI-only span. */
function hasStagedFileDisplaySpan(value: unknown): boolean {
  const entries = inputEntries(value);
  return entries.some((entry, index) => {
    const source = record(entry);
    if (source.type !== "text") return false;
    const elements = source.text_elements ?? source.textElements;
    if (!Array.isArray(elements)) return false;
    const following = record(entries[index + 1]);
    const legacyLocator = following.type === "mention" && typeof source.text === "string"
      && typeof following.name === "string" && typeof following.path === "string"
      && source.text === `The user attached a file named ${JSON.stringify(following.name)}. Its readable path on this Host is ${JSON.stringify(following.path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
    return elements.some((element) => {
      const display = record(element);
      const range = record(display.byteRange ?? display.byte_range);
      const fullSpan = range.start === 0 && range.end === new TextEncoder().encode(String(source.text)).length;
      return fullSpan && (display.placeholder === "opencraft:staged-file:v1"
        || (display.placeholder === "" && legacyLocator));
    });
  });
}

/** Reconcile one client-authored message with its matching AppServer receipt.
 * Delivery mode (new Turn or steer) does not change attachment presentation. */
function acknowledgedDisplayInput(
  localInput: unknown,
  localAttachments: unknown,
  serverItem: TimelineSourceItem | null | undefined,
): { readonly input: unknown; readonly attachments: unknown } {
  const server = record(serverItem?.payload);
  return {
    input: serverItem != null && hasStagedFileDisplaySpan(server.content)
      ? server.content
      : localInput,
    attachments: localAttachments ?? server.attachments,
  };
}

function sourceIds(item: TimelineSourceItem, additionalId?: string): readonly string[] {
  const source = record(item.payload);
  const existing = Array.isArray(source.__velaSourceItemIds)
    ? source.__velaSourceItemIds.filter((value): value is string => typeof value === "string")
    : [];
  return [...new Set([item.id, ...existing, ...(additionalId === undefined ? [] : [additionalId])])];
}

function withProjectionMetadata(
  item: TimelineSourceItem,
  metadata: Readonly<Record<string, unknown>>,
): TimelineSourceItem {
  return { ...item, payload: { ...record(item.payload), ...metadata } };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/**
 * `anyItemFails` in Codex runs against normalized display Items. At this
 * boundary we only need its user-message ownership invariant: before the
 * first assistant display Item, server UserMessages belong to the primary
 * history stream; afterwards a client-identified UserMessage is accepted
 * steering. This predicate concerns protocol ownership only: the projector
 * later places primary input in the user lane and steering/hook feedback in
 * the assistant Activity lane, matching Codex's visual ownership.
 */
function isNonAssistantOwnershipItem(item: TimelineSourceItem): boolean {
  return item.type === "userMessage"
    || item.type === "steeringUserMessage"
    || item.type === "hookPrompt"
    || item.type === "worktreeInit";
}

function isLeadingComposerServerItem(
  items: readonly TimelineSourceItem[],
  index: number,
  paramsInput: unknown,
  paramsClientId: string | null,
): boolean {
  const item = items[index];
  if (item === undefined || item.type !== "userMessage") return false;
  const clientId = itemClientId(item);
  const identityMatches = clientId !== null && paramsClientId !== null && clientId === paramsClientId;
  const contentMatches = compareKeysEqual(
    codexUserMessageCompareKey(itemInput(item)),
    codexUserMessageCompareKey(paramsInput),
  );
  if (!identityMatches && !contentMatches) return false;
  return items.slice(0, index).every((candidate) => NON_RENDERABLE_COMPOSER_PREFIX_ITEMS.has(candidate.type));
}

function matchingSteeringIndex(
  items: readonly TimelineSourceItem[],
  serverIndex: number,
): number | null {
  const server = items[serverIndex];
  if (server === undefined || server.type !== "userMessage") return null;
  const serverClientId = itemClientId(server);
  const serverKey = codexUserMessageCompareKey(itemInput(server));
  for (let index = 0; index < serverIndex; index += 1) {
    const candidate = items[index];
    if (candidate === undefined || candidate.type !== "steeringUserMessage") continue;
    const source = record(candidate.payload);
    const status = string(source.status);
    if (status !== null && status !== "pending" && status !== "accepted") continue;
    if (string(source.serverUserMessageId) === server.id) return index;
    const steeringClientId = itemClientId(candidate);
    if (steeringClientId !== null && serverClientId !== null && steeringClientId === serverClientId) return index;
    if (compareKeysEqual(codexUserMessageCompareKey(itemInput(candidate)), serverKey)) return index;
  }
  return null;
}

/**
 * Codex renders one canonical Composer message from Turn.params and treats the
 * matching AppServer userMessage Item as acknowledgement/provenance. Steering
 * messages use the same ownership rule. This normalization must happen before
 * item projectors so Web, Electron, and Native consume the same display truth.
 */
export function normalizeCodexTurnUserMessages(turn: TimelineSourceTurn): TimelineSourceTurn {
  const params = record(turn.params);
  const paramsInput = params.input;
  const hasComposerInput = inputEntries(paramsInput).length > 0;
  const paramsClientId = string(params.clientUserMessageId) ?? string(params.clientId);
  const preserveServerUserMessages = turn.preserveServerUserMessages === true;
  const composerServerIndex = hasComposerInput
    ? turn.items.findIndex((_item, index) => isLeadingComposerServerItem(
        turn.items,
        index,
        paramsInput,
        paramsClientId,
      ))
    : -1;
  const steeringOwnerByServerIndex = new Map<number, number>();
  const steeringServerByOwnerIndex = new Map<number, TimelineSourceItem>();
  for (let index = 0; index < turn.items.length; index += 1) {
    if (index === composerServerIndex) continue;
    const ownerIndex = matchingSteeringIndex(turn.items, index);
    if (ownerIndex === null) continue;
    const server = turn.items[index];
    if (server === undefined) continue;
    steeringOwnerByServerIndex.set(index, ownerIndex);
    steeringServerByOwnerIndex.set(ownerIndex, server);
  }

  const normalized: TimelineSourceItem[] = [];
  const nonVisualItemIds = [...(turn.nonVisualItemIds ?? [])];
  if (hasComposerInput) {
    const serverItem = composerServerIndex < 0 ? null : turn.items[composerServerIndex] ?? null;
    const serverSource = record(serverItem?.payload);
    const syntheticId = serverItem?.id ?? `${turn.id}:composer-user-message`;
    const display = acknowledgedDisplayInput(paramsInput, params.attachments, serverItem);
    const commentAttachments = params.commentAttachments ?? serverSource.commentAttachments;
    normalized.push({
      id: syntheticId,
      type: "userMessage",
      payload: {
        ...serverSource,
        id: syntheticId,
        type: "userMessage",
        content: display.input,
        clientId: paramsClientId ?? itemClientId(serverItem ?? { id: syntheticId, type: "userMessage", payload: serverSource }),
        attachments: display.attachments,
        sender: serverSource.sender ?? params.sender ?? null,
        commentAttachments,
        mcpAppModelContextAttachments: turn.mcpAppModelContextAttachments,
        __velaMessageKind: "user",
        __velaSourceItemIds: serverItem === null ? [syntheticId] : sourceIds(serverItem),
        __velaTurnParamsMessage: true,
      },
    });
  }

  // This mirrors Codex's `anyItemFails(normalizedDisplayItems)` boundary. The
  // name intentionally includes non-visual `steered`: it is not assistant UI,
  // but it still closes the leading-user ownership segment.
  let hasDisplayOwnershipBoundary = false;
  for (let index = 0; index < turn.items.length; index += 1) {
    const item = turn.items[index];
    if (item === undefined) continue;
    if (item.type === "steered") {
      nonVisualItemIds.push(item.id);
      hasDisplayOwnershipBoundary = true;
      continue;
    }
    if (index === composerServerIndex) {
      // Its identity is already owned by the synthetic Composer projection.
      continue;
    }
    if (steeringOwnerByServerIndex.has(index)) {
      // Its identity is already attached to the local steering owner.
      continue;
    }
    if (item.type === "steeringUserMessage") {
      const server = steeringServerByOwnerIndex.get(index);
      const steeringSource = record(item.payload);
      const display = acknowledgedDisplayInput(
        steeringSource.input ?? steeringSource.content,
        steeringSource.attachments,
        server,
      );
      normalized.push(withProjectionMetadata(item, {
        input: display.input,
        attachments: display.attachments,
        sender: record(server?.payload).sender ?? steeringSource.sender ?? null,
        __velaMessageKind: "steering",
        __velaSourceItemIds: sourceIds(item, server?.id),
        serverUserMessageId: string(steeringSource.serverUserMessageId) ?? server?.id ?? null,
      }));
      continue;
    }
    if (item.type === "userMessage" && index !== composerServerIndex) {
      const clientId = itemClientId(item);
      const followsOwnedComposer = hasComposerInput;
      const followsAssistantOutput = !hasComposerInput && hasDisplayOwnershipBoundary;
      if (preserveServerUserMessages) {
        normalized.push(withProjectionMetadata(item, {
          __velaMessageKind: "steering",
          __velaSteeringStatus: "accepted",
        }));
        continue;
      }
      if (followsOwnedComposer || followsAssistantOutput) {
        if (clientId !== null && clientId !== paramsClientId) {
          normalized.push(withProjectionMetadata(item, {
            __velaMessageKind: "steering",
            __velaSteeringStatus: "accepted",
          }));
        } else {
          // Source-equivalent `steered`: it is a real display-stream boundary
          // but has no visible React node of its own.
          nonVisualItemIds.push(item.id);
        }
        continue;
      }
      normalized.push(withProjectionMetadata(item, { __velaMessageKind: "user" }));
      continue;
    }
    normalized.push(item);
    if (!isNonAssistantOwnershipItem(item)) hasDisplayOwnershipBoundary = true;
  }

  const nextNonVisualItemIds = uniqueStrings(nonVisualItemIds);
  return normalized.length === turn.items.length
    && normalized.every((item, index) => item === turn.items[index])
    && nextNonVisualItemIds.length === (turn.nonVisualItemIds?.length ?? 0)
    ? turn
    : {
        ...turn,
        items: normalized,
        ...(nextNonVisualItemIds.length === 0 ? {} : { nonVisualItemIds: nextNonVisualItemIds }),
      };
}
