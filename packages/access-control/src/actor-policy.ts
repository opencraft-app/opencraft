import type { Actor } from '@opencraft/identity-core/actors';

/**
 * Installation-wide capabilities decided by an Actor's standing, independently
 * of an exact Actor/Resource/Action grant. Each name maps to existing decision
 * points; adding a capability must not widen another one.
 */
export type ActorCapability =
  /** Read or discover a conversation without an owner record (legacy shared scope). */
  | 'conversation.shared-history'
  /** List the installation's conversation servers. */
  | 'conversation.directory'
  /** Search the installation's conversations. */
  | 'conversation.search'
  /** Be recorded as the creator of a new conversation. */
  | 'conversation.create'
  /** Authorize execution: bounded Thread delegations and queued Actor input. */
  | 'execution.delegate'
  /** Issue automation commands through the collaboration HTTP API. */
  | 'automation.manage'
  /** Create a native group. */
  | 'channel.create'
  /** Search invitation candidates for a native group. */
  | 'channel.invite'
  /** Browse the installation people directory. */
  | 'people.directory'
  /** Wake a bound Session from a native channel message. */
  | 'channel.wake'
  /** Reference native group messages as execution input for another Session. */
  | 'channel.forward-input';

export interface ActorPolicyRequest {
  /** Current, enabled Actor resolved by the identity authority, never a request body. */
  readonly actor: Actor;
  readonly capability: ActorCapability;
  /** Present when the decision concerns one resource. */
  readonly resource?: string;
  /** True only when the caller performs the action now; previews must not spend budgets. */
  readonly use?: boolean;
}

/** Embedders may replace the default with their own decision. Only `true` allows. */
export type ActorPolicy = (request: ActorPolicyRequest) => boolean;

/** The current behavior: every listed capability belongs to admitted humans. */
export const humanActorPolicy: ActorPolicy = ({ actor }) => actor.kind === 'human';

export interface AssistantMemberPolicyOptions {
  /** Maximum assistant-initiated wakes per native group within `windowMs`. Default 6. */
  readonly wakesPerWindow?: number;
  /** Budget window in milliseconds. Default one minute. */
  readonly windowMs?: number;
  /**
   * Let assistants authorize bounded execution themselves, so Threads they spawn are
   * owned by the assistant. Conversation grants still decide each target. Default false.
   */
  readonly delegation?: boolean;
  readonly now?: () => number;
}

/**
 * Opt-in preset: assistants keep every human-only boundary except that, as group
 * members, they may wake other bound Sessions in a group, within a bounded
 * per-group budget so assistant chains cannot wake each other without limit.
 * Exact grants (for example `execution.queue` on the target) still apply.
 */
export function assistantMemberPolicy(options: AssistantMemberPolicyOptions = {}): ActorPolicy {
  const limit = Math.max(0, Math.floor(options.wakesPerWindow ?? 6));
  const windowMs = Math.max(1, options.windowMs ?? 60_000);
  const now = options.now ?? Date.now;
  const spent = new Map<string, number[]>();
  return request => {
    if (humanActorPolicy(request)) return true;
    if (request.actor.kind !== 'session') return false;
    if (request.capability === 'execution.delegate') return options.delegation === true;
    if (request.capability !== 'channel.wake' || !request.resource) return false;
    const at = now(), recent = (spent.get(request.resource) ?? []).filter(time => at - time < windowMs);
    if (recent.length >= limit) { spent.set(request.resource, recent); return false; }
    if (!request.use) return true;
    recent.push(at); spent.set(request.resource, recent);
    return true;
  };
}

/** Environment variable naming the installation preset, read by every process. */
export const ACTOR_POLICY_ENVIRONMENT = 'OPENCRAFT_ACTOR_POLICY';

/**
 * Resolve the installation preset so the Daemon, headless host and Worker processes
 * decide alike. `human` (or unset) keeps the default; `assistant-member` enables
 * group wakes; `assistant-member+delegation` also lets assistants delegate.
 * Unknown values fail closed to the human-only default.
 */
export function actorPolicyFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): ActorPolicy {
  switch ((environment[ACTOR_POLICY_ENVIRONMENT] ?? '').trim()) {
    case 'assistant-member': return assistantMemberPolicy();
    case 'assistant-member+delegation': return assistantMemberPolicy({ delegation: true });
    default: return humanActorPolicy;
  }
}
