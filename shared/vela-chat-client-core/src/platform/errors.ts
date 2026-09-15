export type StableErrorCode =
  | "USAGE"
  | "CONFIG"
  | "AUTH_REQUIRED"
  | "AUTH_FORBIDDEN"
  | "AUTH_BUSY"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_AMBIGUOUS"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "REMOTE_UNAVAILABLE"
  | "IM_NOT_READY"
  | "IM_NOT_MEMBER"
  | "IM_KICKED_OUT"
  | "IM_TIMEOUT"
  | "IM_REJECTED"
  | "NETWORK"
  | "PROTOCOL";

export class PlatformError extends Error {
  public readonly code: StableErrorCode;
  public readonly details: Record<string, unknown> | undefined;
  public readonly platformCode: string | undefined;
  public readonly requestId: string | undefined;
  public readonly retryAfterSeconds: number | undefined;

  public constructor(
    code: StableErrorCode,
    message: string,
    options: {
      details?: Record<string, unknown>;
      platformCode?: string;
      requestId?: string;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
    this.details = options.details;
    this.platformCode = options.platformCode;
    this.requestId = options.requestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export async function responseError(response: Response): Promise<PlatformError> {
  const envelope = await readErrorEnvelope(response);
  const retryAfterSeconds = parseRetryAfter(
    response.headers.get("Retry-After"),
  );
  return new PlatformError(
    codeForStatus(response.status),
    envelope?.message ?? messageForStatus(response.status),
    {
      ...(envelope?.details ? {details: envelope.details} : {}),
      ...(envelope?.code ? {platformCode: envelope.code} : {}),
      ...(envelope?.requestId ? {requestId: envelope.requestId} : {}),
      ...(retryAfterSeconds === undefined ? {} : {retryAfterSeconds}),
    },
  );
}

function codeForStatus(status: number): StableErrorCode {
  if (status === 400 || status === 422) return "USAGE";
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "AUTH_FORBIDDEN";
  if (status === 404) return "RESOURCE_NOT_FOUND";
  if (status === 409 || status === 412) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if ([500, 502, 503, 504].includes(status)) return "REMOTE_UNAVAILABLE";
  return "PROTOCOL";
}

function messageForStatus(status: number): string {
  if (status === 401) return "当前登录态已失效";
  if (status === 403) return "当前账号无权执行此操作";
  if (status === 404) return "请求的资源不存在";
  if (status === 429) return "请求过于频繁";
  if (status >= 500) return "平台服务暂不可用";
  return `平台返回了未预期的 HTTP ${status}`;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  return Number.parseInt(value, 10);
}

async function readErrorEnvelope(response: Response): Promise<
  | {
      code?: string;
      details?: Record<string, unknown>;
      message: string;
      requestId?: string;
    }
  | undefined
> {
  try {
    const body: unknown = await response.clone().json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("error" in body) ||
      typeof body.error !== "object" ||
      body.error === null
    ) {
      return undefined;
    }
    const error = body.error as Record<string, unknown>;
    if (typeof error.message !== "string") return undefined;
    return {
      message: error.message,
      ...(typeof error.code === "string" ? {code: error.code} : {}),
      ...(typeof error.requestId === "string"
        ? {requestId: error.requestId}
        : {}),
      ...(isRecord(error.details) ? {details: error.details} : {}),
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
