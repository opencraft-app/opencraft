export interface CodexUserMessageSemantics {
  readonly message: string;
  readonly goal: boolean;
  readonly referencesPriorConversation: boolean;
  readonly reviewMode: boolean;
  readonly pullRequestFixMode: boolean;
  readonly autoResolveSync: boolean;
}

export const CODEX_USER_REQUEST_MARKER = /## My request(?: for Codex)?:/g;
export const CODEX_REVIEW_MODE_HEADER = "## Code review guidelines:";
export const CODEX_PULL_REQUEST_FIX_HEADER = "## Pull request fix:";
export const CODEX_AUTO_RESOLVE_MERGE_HEADER = "## Auto resolve merge:";
export const CODEX_PRIOR_CONVERSATION_HEADER = "## Prior conversation with Codex:";

/** Source-equivalent `extractLastUserRequest` used by Codex's UserMessage projection. */
export function extractLastCodexUserRequest(promptContext: string): string {
  const sections = promptContext.split(CODEX_USER_REQUEST_MARKER);
  return sections.length <= 1 ? promptContext : (sections.at(-1) ?? "").trim();
}

function contextBeforeUserRequest(promptContext: string): string {
  const match = /## My request(?: for Codex)?:/.exec(promptContext);
  return match === null ? promptContext.trim() : promptContext.slice(0, match.index);
}

/** Source-equivalent leading `/goal` recognition without owning Goal persistence. */
export function stripCodexGoalDirective(message: string): string | null {
  const trimmed = message.trimStart();
  const match = /^\/goal(?=$| )/.exec(trimmed);
  return match === null ? null : trimmed.slice(match[0].length).trimStart();
}

/**
 * Renderer-neutral recovery of the semantics Codex derives before rendering a
 * UserMessage. Product-only attachment parsing stays outside this function.
 */
export function deriveCodexUserMessageSemantics(rawMessage: string): CodexUserMessageSemantics {
  const context = contextBeforeUserRequest(rawMessage);
  const reviewMode = context.includes(CODEX_REVIEW_MODE_HEADER);
  const pullRequestFixMode = context.includes(CODEX_PULL_REQUEST_FIX_HEADER);
  const request = extractLastCodexUserRequest(rawMessage);
  const goalMessage = stripCodexGoalDirective(request);
  return {
    message: goalMessage ?? request,
    goal: goalMessage !== null,
    referencesPriorConversation: !reviewMode
      && !pullRequestFixMode
      && context.includes(CODEX_PRIOR_CONVERSATION_HEADER),
    reviewMode,
    pullRequestFixMode,
    autoResolveSync: context.includes(CODEX_AUTO_RESOLVE_MERGE_HEADER),
  };
}
