import { AlertIcon as CircleAlert } from "@opencraft/design-system-web/action-icons";


/** Controlled copy for durable Bot failures. Never render provider stderr. */
export function botExecutionErrorCopy(code: string | undefined): string {
  switch (code) {
    case "BOT_PROVIDER_QUOTA_LIMIT":
      return "Model provider quota or balance is exhausted.";
    case "BOT_MODEL_NOT_CONFIGURED":
      return "This Bot's model provider is not configured.";
    case "BOT_PROVIDER_AUTH_REQUIRED":
      return "This Bot's model credentials need attention.";
    case "BOT_RESPONSE_TIMEOUT":
      return "This Bot took too long to respond.";
    default:
      return "This Bot could not complete its reply.";
  }
}

export function BotExecutionError({
  code,
  participantName,
}: {
  readonly code?: string;
  readonly participantName: string;
}) {
  return (
    <div className="bot-chat-execution-error" role="status">
      <CircleAlert aria-hidden="true" size={16} />
      <span>
        <strong>{participantName} couldn't reply</strong>
        <small>{botExecutionErrorCopy(code)}</small>
      </span>
    </div>
  );
}
