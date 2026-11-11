/**
 * ACP dialect registry.
 *
 * The generic dialect covers agents that follow ACP without private steering
 * extensions. Amp and Copilot get small, explicit plans where the installed
 * product differs. Later batches (DSH, CodeBuddy, Cursor, AGY) add a dialect
 * module through `registerAcpDialect`; a dialect may not widen the registered
 * capability declaration, and it must not claim a native path the probe did
 * not establish.
 */

import { agyDialect } from "./agy";
import { codeBuddyDialect } from "./codebuddy";
import type { AcpInitializeResult, AcpNewSessionResult } from "./acp";
import type { AcpDialectId, OpenCraftPermissionMode } from "./profile";

export type PermissionApprovalPolicy = "auto-allow" | "read-only" | "accept-edits" | "route";

export interface AcpPermissionPlan {
  readonly requested: OpenCraftPermissionMode;
  readonly approvalPolicy: PermissionApprovalPolicy;
  readonly nativeModeId?: string;
  readonly configOptions: readonly { readonly id: string; readonly value: string }[];
  /** Short, honest description of what was actually applied. */
  readonly detail: string;
}

export interface AcpNativeToolCall {
  readonly toolCallId?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly locations?: unknown;
}

export interface AcpDialectContext {
  readonly initialize: AcpInitializeResult;
  readonly session: AcpNewSessionResult;
}

export interface AcpDialect {
  readonly id: AcpDialectId;
  /**
   * Only a provider-declared native injection path may be exposed as
   * `native-inject`. A concurrent ACP prompt is not native steering by itself.
   */
  nativeSteering(context: AcpDialectContext): boolean;
  permissionPlan(
    mode: OpenCraftPermissionMode,
    context: AcpDialectContext,
  ): AcpPermissionPlan;
  modelPlan(
    model: string,
    context: AcpDialectContext,
  ): { readonly configOptionId: string; readonly value: string } | null;
  /** Optional dialect-owned inbound client method. */
  handleClientRequest?(method: string, params: Record<string, unknown>): unknown | undefined;
}

function metaFlag(context: AcpDialectContext): boolean {
  const initialize = context.initialize;
  const top = initialize._meta?.midTurnSteering;
  if (top === true) return true;
  return initialize.agentCapabilities?._meta?.midTurnSteering === true;
}

function modes(context: AcpDialectContext) {
  return context.session.modes?.availableModes ?? [];
}

function findMode(context: AcpDialectContext, pattern: RegExp): string | undefined {
  return modes(context).find((mode) => pattern.test(mode.id) || pattern.test(mode.name))?.id;
}

function permissionConfigOption(context: AcpDialectContext) {
  return (context.session.configOptions ?? []).find((option) =>
    option.type === "select"
    && (option.category === "permissions"
      || /permission|approval|allow[-_ ]?all/i.test(option.id)
      || /permission|approval|allow[-_ ]?all/i.test(option.name)));
}

function selectValue(optionId: string, value: string): { id: string; value: string } {
  return { id: optionId, value };
}

function optionValue(option: NonNullable<ReturnType<typeof permissionConfigOption>>, candidates: RegExp): string | undefined {
  return option.options?.find((choice) => candidates.test(choice.value) || candidates.test(choice.name))?.value;
}

function configPermissionValue(
  context: AcpDialectContext,
  mode: OpenCraftPermissionMode,
): { id: string; value: string } | undefined {
  const option = permissionConfigOption(context);
  if (option === undefined) return undefined;
  const value = mode === "full"
    ? optionValue(option, /^(on|true|allow|yes|always)$/i)
    : optionValue(option, /^(off|false|deny|no|never)$/i);
  return value === undefined ? undefined : selectValue(option.id, value);
}

const GENERIC: AcpDialect = {
  id: "generic",
  nativeSteering: metaFlag,
  permissionPlan(mode, context) {
    const config = configPermissionValue(context, mode);
    const options = config === undefined ? [] : [config];
    switch (mode) {
      case "full": {
        const nativeModeId = findMode(context, /full|bypass|danger|yolo|allow[-_ ]?all|autopilot/i);
        return {
          requested: mode,
          approvalPolicy: "auto-allow",
          ...(nativeModeId === undefined ? {} : { nativeModeId }),
          configOptions: options,
          detail: nativeModeId === undefined
            ? "full: approval-boundary auto-allow; the agent owns any wider sandbox"
            : `full: native mode ${nativeModeId} + approval-boundary auto-allow`,
        };
      }
      case "read-only": {
        const nativeModeId = findMode(context, /read[-_ ]?only/i);
        return {
          requested: mode,
          approvalPolicy: "read-only",
          ...(nativeModeId === undefined ? {} : { nativeModeId }),
          configOptions: options,
          detail: nativeModeId === undefined
            ? "read-only: approval-boundary policy only; no native read-only mode was advertised"
            : `read-only: native mode ${nativeModeId}`,
        };
      }
      case "accept-edits": {
        const nativeModeId = findMode(context, /accept[-_ ]?edits?|edit[-_ ]?automatically/i);
        return {
          requested: mode,
          approvalPolicy: "accept-edits",
          ...(nativeModeId === undefined ? {} : { nativeModeId }),
          configOptions: options,
          detail: nativeModeId === undefined
            ? "accept-edits: approval-boundary edit policy only; no native accept-edits mode was advertised"
            : `accept-edits: native mode ${nativeModeId}`,
        };
      }
      case "auto": {
        const nativeModeId = findMode(context, /^auto$|auto[-_ ]?review/i);
        return {
          requested: mode,
          approvalPolicy: "route",
          ...(nativeModeId === undefined ? {} : { nativeModeId }),
          configOptions: options,
          detail: nativeModeId === undefined
            ? "auto: human approval routing; no native auto mode was advertised"
            : `auto: native mode ${nativeModeId} + human approval routing`,
        };
      }
    }
  },
  modelPlan(model, context) {
    const option = (context.session.configOptions ?? []).find((entry) =>
      entry.type === "select" && (entry.category === "model" || /^model$/i.test(entry.id)));
    return option === undefined ? null : { configOptionId: option.id, value: model };
  },
};

const AMP: AcpDialect = {
  id: "amp",
  nativeSteering: metaFlag,
  permissionPlan(mode, context) {
    const option = (context.session.configOptions ?? []).find((entry) =>
      entry.type === "select" && (entry.id === "permission" || entry.category === "permissions"));
    const value = mode === "full" ? "bypass" : "default";
    const config = option === undefined ? undefined : selectValue(option.id, value);
    if (config !== undefined && option?.options !== undefined
      && !option.options.some((choice) => choice.value === value)) {
      throw new Error(`Amp did not advertise permission mode ${value}`);
    }
    return {
      requested: mode,
      approvalPolicy: mode === "full"
        ? "auto-allow"
        : mode === "read-only"
          ? "read-only"
          : mode === "accept-edits" ? "accept-edits" : "route",
      configOptions: config === undefined ? [] : [config],
      detail: mode === "full"
        ? "full: Amp permission=bypass"
        : `Amp permission=default; ${mode} is enforced at the approval boundary when Amp asks`,
    };
  },
  modelPlan(model, context) {
    const option = (context.session.configOptions ?? []).find((entry) =>
      entry.type === "select" && (entry.id === "amp-mode" || entry.category === "model"));
    if (option === undefined) return null;
    if (option.options !== undefined && !option.options.some((choice) => choice.value === model)) {
      throw new Error(`Amp mode ${model} is not available`);
    }
    return { configOptionId: option.id, value: model };
  },
};

const COPILOT: AcpDialect = {
  id: "copilot",
  // Copilot 1.0.102 has no local `_meta.midTurnSteering`; a concurrent
  // `session/prompt` here would cancel-and-resend, which is a different path.
  nativeSteering: () => false,
  permissionPlan(mode, context) {
    const config = configPermissionValue(context, mode);
    return {
      requested: mode,
      approvalPolicy: mode === "full"
        ? "auto-allow"
        : mode === "read-only"
          ? "read-only"
          : mode === "accept-edits" ? "accept-edits" : "route",
      configOptions: config === undefined ? [] : [config],
      detail: config === undefined
        ? `${mode}: no Copilot permission config option was advertised; approval routing applies`
        : `${mode}: Copilot ${config.id}=${config.value}`,
    };
  },
  modelPlan(model, context) {
    const option = (context.session.configOptions ?? []).find((entry) =>
      entry.type === "select" && (entry.category === "model" || entry.id === "model"));
    if (option === undefined) return null;
    return { configOptionId: option.id, value: model };
  },
};

const registry = new Map<string, AcpDialect>([
  [GENERIC.id, GENERIC],
  ["dsh", { ...GENERIC, id: "dsh", nativeSteering: ({ initialize }) => initialize._meta?.midTurnSteering === true }],
  [AMP.id, AMP],
  [COPILOT.id, COPILOT],
  ["codebuddy", codeBuddyDialect(GENERIC)],
  ["agy", agyDialect(GENERIC)],
]);

/**
 * Register a dialect contributed by a pinned adapter build. Re-registering the
 * same id is refused so two modules cannot silently shadow each other.
 */
export function registerAcpDialect(dialect: AcpDialect): void {
  if (registry.has(dialect.id)) throw new Error(`ACP dialect ${dialect.id} is already registered`);
  registry.set(dialect.id, dialect);
}

export function resolveAcpDialect(id: AcpDialectId): AcpDialect {
  const dialect = registry.get(id);
  if (dialect === undefined) throw new Error(`Unknown ACP dialect ${id}`);
  return dialect;
}
