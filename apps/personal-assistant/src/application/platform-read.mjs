import {
  ReceptionQuery,
  RECEPTION_LIMITS,
} from "../domain/reception-query.mjs";

// Only typed host status is evidence of denied access. Model/provider prose is not.
export function platformReadFailure(error) {
  if (error?.code === "PLATFORM_READ_UNAVAILABLE") return "tool_unavailable";
  if (
    error?.status === 403 ||
    error?.statusCode === 403 ||
    error?.code === "FORBIDDEN"
  )
    return "access_denied";
  if (error?.code === "PLATFORM_READ_TOO_LARGE") return "result_too_large";
  return "read_failed";
}
export async function executePlatformRead(
  port,
  request,
  signal,
  now = Date.now,
) {
  const query = ReceptionQuery.parse({ ...request, kind: "query" });
  if (!query.name.startsWith("platform."))
    throw Error("Unsupported platform read");
  signal?.throwIfAborted();
  try {
    if (!port)
      throw Object.assign(Error("Platform reading unavailable"), {
        code: "PLATFORM_READ_UNAVAILABLE",
      });
    const data = await port.query(query.name, query.params, signal);
    signal?.throwIfAborted();
    if (ReceptionQuery.bytes(data) > RECEPTION_LIMITS.resultBytes)
      throw Object.assign(
        Error("Platform read exceeds the output bound; narrow the request"),
        { code: "PLATFORM_READ_TOO_LARGE" },
      );
    // This is one response, never proof of an exhaustive search.
    const coverage = {
      scope: "returned-page",
      source: data?.source ?? null,
      channelId: query.params.channelId ?? null,
      reference: query.params.reference ?? null,
      next:
        data?.next ??
        data?.nextCursor ??
        data?.nextBefore ??
        (data?.hasEarlier === true &&
        Array.isArray(data.messages) &&
        data.messages.length &&
        data.messages.every(
          (m) => Number.isSafeInteger(m.sequence) && m.sequence > 0,
        )
          ? Math.min(...data.messages.map((m) => m.sequence))
          : null),
      hasEarlier: data?.hasEarlier === true,
      hasMore: data?.hasMore === true,
      truncated: data?.truncated === true,
    };
    return {
      query,
      ok: true,
      observedAt: now(),
      coverage,
      data: { ...data, externalContext: true },
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      query,
      ok: false,
      observedAt: now(),
      failure: platformReadFailure(error),
      error: "Platform read did not complete",
      coverage: { scope: "unread" },
    };
  }
}
