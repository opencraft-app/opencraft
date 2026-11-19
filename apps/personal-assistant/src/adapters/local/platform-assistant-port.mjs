import { assertBotBinding } from "../../domain/bot-binding.mjs";

const operations = new Set([
  "authorize",
  "threads/command",
  "groups/list",
  "groups/history",
  "groups/search",
  "conversations/list",
  "conversations/history",
]);
/** Runtime-only Bot credential. No Human token, alternate owner or server from a model.
 * HTTP is just an adapter; an in-process/IPC client uses the same request contract. */
export function platformAssistantPort({ request }) {
  if (typeof request !== "function") throw Error("Authenticated platform request required");
  return Object.freeze({
    async authorize(binding, signal) {
      const access = await request("opencraft/personal-assistant/authorize", {}, signal);
      if (binding) assertBotBinding(access?.binding, binding);
      return access;
    },
    async request(binding, method, params, signal) {
      const operation = method.replace(/^opencraft\/personal-assistant\//u, "");
      if (!method.startsWith("opencraft/personal-assistant/") || !operations.has(operation))
        throw Error("Unsupported personal assistant operation");
      const access = await request("opencraft/personal-assistant/authorize", {}, signal);
      assertBotBinding(access?.binding, binding);
      return request(method, params, signal);
    },
  });
}
export function httpPlatformAssistantPort({ origin, token, fetch: requestFetch = globalThis.fetch }) {
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
  )
    throw Error("An HTTPS platform origin or explicit local loopback is required");
  if (typeof token !== "string" || !token.startsWith("oc_actor_v1.") || /[\s]/u.test(token))
    throw Error("Bot credential required");
  return platformAssistantPort({
    async request(method, params, signal) {
      const op = method.slice("opencraft/personal-assistant/".length);
      const response = await requestFetch(new URL("/__opencraft_actors/collaboration/personal-assistant/" + op, url), {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(params),
        redirect: "error",
        credentials: "omit",
        signal,
      });
      if (!response.ok)
        throw Object.assign(Error("Platform operation rejected (" + response.status + ")"), {
          status: response.status,
        });
      const result = await response.json();
      return result;
    },
  });
}
