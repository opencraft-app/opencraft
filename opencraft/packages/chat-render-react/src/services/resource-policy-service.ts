import { Context, Service } from "@deepseek-ai/cordis";

import type {
  ChatRenderContext,
  ChatResourceDecision,
  ChatResourcePolicy,
} from "../contracts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    chatResourcePolicies: ChatResourcePolicyService;
  }
}

export class ChatResourcePolicyService extends Service {
  private readonly policies = new Map<string, ChatResourcePolicy>();

  constructor(ctx: Context) {
    super(ctx, "chatResourcePolicies");
    ctx.effect(() => () => this.policies.clear());
  }

  register(policy: ChatResourcePolicy): () => void {
    if (this.policies.has(policy.name)) throw new Error(`Chat resource policy ${policy.name} already exists`);
    this.policies.set(policy.name, policy);
    return () => {
      if (this.policies.get(policy.name) === policy) this.policies.delete(policy.name);
    };
  }

  resolve(target: string, context: ChatRenderContext): ChatResourceDecision {
    const policy = [...this.policies.values()]
      .filter((candidate) => candidate.matches(target, context))
      .sort((left, right) => right.priority - left.priority)[0];
    if (policy !== undefined) return policy.resolve(target, context);
    if (context.externalResourcePolicy === "restricted") {
      return { allowed: false, target: null, reason: "External resources are restricted" };
    }
    return { allowed: true, target };
  }
}
