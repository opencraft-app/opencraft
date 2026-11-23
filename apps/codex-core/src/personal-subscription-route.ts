/**
 * The personal subscription route the Core forwards to its model upstream:
 * `/personal/<64 hex>/v1/responses` or `/personal/<64 hex>/v1/models`, nothing else.
 *
 * The forwarded URL is rebuilt from the validated parts on the fixed upstream origin,
 * never resolved from the request target, so a request can choose neither the host
 * nor any other path.
 */
const PERSONAL_ROUTE = /^\/personal\/([a-f0-9]{64})\/v1\/(responses|models)$/u;

/** The request's subscription and endpoint, or null when it is not the personal route. */
export function personalSubscriptionRoute(
  requestUrl: string | undefined,
): { readonly subscription: string; readonly endpoint: "responses" | "models" } | null {
  const match = PERSONAL_ROUTE.exec(requestUrl ?? "");
  if (!match) return null;
  return { subscription: match[1]!, endpoint: match[2] === "models" ? "models" : "responses" };
}

/** The upstream URL for a validated route; refuses anything that would leave the upstream origin. */
export function personalSubscriptionTarget(
  upstream: string | URL,
  route: NonNullable<ReturnType<typeof personalSubscriptionRoute>>,
): URL {
  const origin = new URL(upstream).origin;
  if (!/^[a-f0-9]{64}$/u.test(route.subscription)) throw new Error("Invalid personal subscription");
  // The request-derived part only follows the fixed path prefix, after the upstream's own origin.
  const target = new URL(`${origin}/personal/${route.subscription}/v1/${route.endpoint}`);
  if (target.origin !== origin) throw new Error("Personal subscription target left its upstream");
  return target;
}
