import { javascript, jsonFunctionSource } from "@opencraft/javascript-runtime";
import { parseConversationRef } from "@opencraft/appserver-protocol/collaboration";

export interface RouteEvent {
  readonly id: string;
  readonly channelId: string;
  readonly platform: string;
  readonly chat: {
    readonly id: string;
    readonly type: "direct" | "group";
    readonly threadId?: string;
  };
  readonly sender: { readonly id: string; readonly actorId: string };
  readonly text: string;
}
export type RouteDecision =
  | { key: string[] }
  | { conversationRef: string }
  | { ignore: true };
export { sourceRoute, stewardRoute } from "./templates.js";
export function routeSource(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > 16_384
  )
    throw new Error("invalid_route");
  return value;
}
const invocation = (source: string) =>
  jsonFunctionSource(routeSource(source), 'route');
export async function compileRoute(source: string): Promise<void> {
  await javascript({ compile: true, sources: [invocation(source)] });
}
export function routeDecision(value: unknown): RouteDecision {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  )
    throw new Error("invalid_route_result");
  const r = value as Record<string, unknown>;
  if (r.ignore === true) return { ignore: true };
  if (
    typeof r.conversationRef === "string" &&
    r.conversationRef.length <= 1024 &&
    parseConversationRef(r.conversationRef)
  )
    return { conversationRef: r.conversationRef };
  if (
    Array.isArray(r.key) &&
    r.key.length > 0 &&
    r.key.length <= 8 &&
    r.key.every(
      (v) =>
        typeof v === "string" &&
        v.length > 0 &&
        v.length <= 256 &&
        !/[\x00-\x1f\x7f]/u.test(v),
    )
  )
    return { key: r.key as string[] };
  throw new Error("invalid_route_result");
}
export async function evaluateRoute(
  source: string,
  event: RouteEvent,
): Promise<RouteDecision> {
  return routeDecision(
    await javascript({
      source: invocation(source),
      args: event,
      context: null,
    }),
  );
}
