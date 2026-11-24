// Compatibility entry: the HTTP exchange port moved to the runtime-neutral
// `@opencraft/http-exchange` (gateway-split.md §4.2). This entry fixes the
// request view to `IdentityRequest` for identity and access handlers.
import type * as Port from "@opencraft/http-exchange";
import type { IdentityRequest } from "./identity-request.js";

export type { IdentityRequest };
export type { HttpHeaderList, HttpExchangeResponse, HttpResponseBody, HttpRequestView } from "@opencraft/http-exchange";
export {
  HttpBodyTooLarge,
  HttpExchangeAborted,
  decodeUtf8,
  httpResponse,
  jsonResponse,
  requestUrl,
  setCookies,
} from "@opencraft/http-exchange";

export type HttpExchangeRequest = Port.HttpExchangeRequest<IdentityRequest>;
export type HttpExchangeHandler = Port.HttpExchangeHandler<IdentityRequest>;
