import { ADMIN_SESSION_SENTINEL } from "./admin-session-constants";

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, data: unknown) {
    const message = typeof data === "object" && data !== null && "error" in data
      ? String((data as { error: string }).error)
      : typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: string }).message)
        : `API error ${status}`;
    super(message);
    this.status = status;
    this.data = data;
    this.name = "ApiError";
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }

  get isConfigError() {
    return this.status === 500 && this.message === "ADMIN_TOKEN not configured";
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string | number | undefined>;
}

const ADMIN_API_BASE_PATH = "/admin/gateway/api";

export function buildApiURL(
  path: string,
  origin: string,
  params?: Record<string, string | number | undefined>
): URL {
  const url = new URL(`${ADMIN_API_BASE_PATH}/${path}`, origin);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    });
  }
  return url;
}

export async function apiClient<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { method = "GET", body, params } = options;

  const url = buildApiURL(path, window.location.origin, params);

  const fetchOptions: RequestInit = {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
  };

  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), fetchOptions);

  if (!response.ok) {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = { error: response.statusText };
    }
    if ((response.status === 401 || response.status === 403) && response.headers.get("X-Admin-Session-Invalid") === "1") {
      localStorage.removeItem(ADMIN_SESSION_SENTINEL);
      sessionStorage.removeItem(ADMIN_SESSION_SENTINEL);
      window.location.href = "/admin/gateway/login";
    }
    throw new ApiError(response.status, data);
  }

  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    return (await response.text()) as T;
  }

  return response.json() as Promise<T>;
}
