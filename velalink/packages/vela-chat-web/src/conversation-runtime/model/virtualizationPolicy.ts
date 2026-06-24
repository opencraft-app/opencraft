export interface ConversationRuntimePolicy {
  partialVirtualizationEnabled: boolean;
  maxLiveHeadItemCount: number;
  virtualizeAfterItemCount: number;
  mountedRecentItemCount: number;
}

export type ConversationRuntimeHostKind = "mobile_web" | "desktop_web" | "desktop_shell";

export type ConversationRuntimeProfileName =
  | "desktop_full_preload"
  | "web_partial_virtualized"
  | "mobile_incremental_window";

export type ConversationRuntimeScrollbarExtent =
  | "full_content"
  | "mounted_and_estimated_content";

export interface ConversationRuntimeProfile {
  name: ConversationRuntimeProfileName;
  policy: ConversationRuntimePolicy;
  scrollbarExtent: ConversationRuntimeScrollbarExtent;
}

export const DEFAULT_CONVERSATION_RUNTIME_POLICY: ConversationRuntimePolicy =
  Object.freeze({
    partialVirtualizationEnabled: true,
    maxLiveHeadItemCount: 50,
    virtualizeAfterItemCount: 100,
    mountedRecentItemCount: 50,
  });

type ConversationRuntimeE2EGlobals = typeof globalThis & {
  __VELA_E2E_CONVERSATION_MAX_LIVE_HEAD_ITEM_COUNT?: unknown;
  __VELA_E2E_CONVERSATION_MOUNTED_RECENT_ITEM_COUNT?: unknown;
  __VELA_E2E_CONVERSATION_VIRTUALIZE_AFTER_ITEM_COUNT?: unknown;
};

export function normalizeConversationRuntimePolicy(
  policy: Partial<ConversationRuntimePolicy> = {},
): ConversationRuntimePolicy {
  const defaultPolicy = getConversationRuntimeDefaultPolicy();
  return {
    partialVirtualizationEnabled:
      typeof policy.partialVirtualizationEnabled === "boolean"
        ? policy.partialVirtualizationEnabled
        : defaultPolicy.partialVirtualizationEnabled,
    maxLiveHeadItemCount: positiveInteger(
      policy.maxLiveHeadItemCount,
      defaultPolicy.maxLiveHeadItemCount,
    ),
    virtualizeAfterItemCount: positiveInteger(
      policy.virtualizeAfterItemCount,
      defaultPolicy.virtualizeAfterItemCount,
    ),
    mountedRecentItemCount: positiveInteger(
      policy.mountedRecentItemCount,
      defaultPolicy.mountedRecentItemCount,
    ),
  };
}

export function conversationRuntimePolicyForHost(
  hostKind: ConversationRuntimeHostKind,
  policy: Partial<ConversationRuntimePolicy> = {},
): ConversationRuntimePolicy {
  return conversationRuntimeProfileForHost(hostKind, policy).policy;
}

export function conversationRuntimeProfileForHost(
  hostKind: ConversationRuntimeHostKind,
  policy: Partial<ConversationRuntimePolicy> = {},
): ConversationRuntimeProfile {
  const profile = defaultConversationRuntimeProfileForHost(hostKind);
  return {
    ...profile,
    policy: normalizeConversationRuntimePolicy({
      ...profile.policy,
      ...policy,
    }),
  };
}

function defaultConversationRuntimeProfileForHost(
  hostKind: ConversationRuntimeHostKind,
): ConversationRuntimeProfile {
  const defaultPolicy = getConversationRuntimeDefaultPolicy();
  if (hostKind === "desktop_shell") {
    return {
      name: "desktop_full_preload",
      policy: {
        ...defaultPolicy,
        partialVirtualizationEnabled: false,
      },
      scrollbarExtent: "full_content",
    };
  }

  if (hostKind === "mobile_web") {
    return {
      name: "mobile_incremental_window",
      policy: {
        ...defaultPolicy,
        partialVirtualizationEnabled: true,
        maxLiveHeadItemCount: Math.min(defaultPolicy.maxLiveHeadItemCount, 30),
        mountedRecentItemCount: Math.min(defaultPolicy.mountedRecentItemCount, 30),
        virtualizeAfterItemCount: Math.min(defaultPolicy.virtualizeAfterItemCount, 60),
      },
      scrollbarExtent: "mounted_and_estimated_content",
    };
  }

  return {
    name: "web_partial_virtualized",
    policy: {
      ...defaultPolicy,
      partialVirtualizationEnabled: true,
    },
    scrollbarExtent: "mounted_and_estimated_content",
  };
}

function getConversationRuntimeDefaultPolicy(): ConversationRuntimePolicy {
  const globals = globalThis as ConversationRuntimeE2EGlobals;
  return {
    partialVirtualizationEnabled:
      DEFAULT_CONVERSATION_RUNTIME_POLICY.partialVirtualizationEnabled,
    maxLiveHeadItemCount:
      readPositiveIntegerOverride(
        globals.__VELA_E2E_CONVERSATION_MAX_LIVE_HEAD_ITEM_COUNT,
      ) ?? DEFAULT_CONVERSATION_RUNTIME_POLICY.maxLiveHeadItemCount,
    virtualizeAfterItemCount:
      readPositiveIntegerOverride(
        globals.__VELA_E2E_CONVERSATION_VIRTUALIZE_AFTER_ITEM_COUNT,
      ) ?? DEFAULT_CONVERSATION_RUNTIME_POLICY.virtualizeAfterItemCount,
    mountedRecentItemCount:
      readPositiveIntegerOverride(
        globals.__VELA_E2E_CONVERSATION_MOUNTED_RECENT_ITEM_COUNT,
      ) ?? DEFAULT_CONVERSATION_RUNTIME_POLICY.mountedRecentItemCount,
  };
}

function readPositiveIntegerOverride(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function positiveInteger(value: number | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}
