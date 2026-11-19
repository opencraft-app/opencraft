export interface ThreadCommand {
  command: string;
  arguments: Record<string, unknown>;
  idempotencyKey?: string;
}
export function parseThreadCommand(argv: string[]): ThreadCommand;
export function replaceThreadCommandIdempotencyKey(argv: string[], key: string): string[];

export function threadDeliveryIntent(
  delivery?: unknown,
  expectedTurnId?: unknown,
): { mode: "queue" } | { mode: "steer"; expectedTurnId: string };
