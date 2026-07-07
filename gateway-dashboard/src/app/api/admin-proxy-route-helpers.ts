import {
  attachAdminSessionCookie,
  createClearedAdminSessionCookie,
  readAdminSessionTokenFromCookieHeader,
} from "../../lib/admin-session";

export type AdminProxyModule =
  | "ai-gateway"
  | "auth"
  | "subscription"
  | "sandbox"
  | "ctl"
  | "ctl-admin"
  | "support-feedback";

interface BuildModuleAdminProxyRequestOptions {
  module: AdminProxyModule;
  path: string[];
  upstreamBaseURL: string;
  upstreamToken?: string;
  forwardBrowserToken?: boolean;
  extraHeaders?: Record<string, string>;
}

interface ProxyModuleAdminRequestOptions {
  module: AdminProxyModule;
  upstreamBaseURL?: string;
  upstreamToken?: string;
  serviceName: string;
  requireAdminTokenValidation?: boolean;
  validationBaseURL?: string;
  forwardBrowserToken?: boolean;
  extraHeaders?: Record<string, string>;
}

const upstreamPathPrefixes: Record<AdminProxyModule, string> = {
  "ai-gateway": "/api/admin",
  auth: "/admin",
  subscription: "/admin",
  sandbox: "/internal",
  ctl: "/internal",
  "ctl-admin": "/admin/api/ctl",
  // ticket 反馈后台：经 supportAgentMiddleware 校验 X-User-Id（白名单），
  // 由 dashboard BFF 注入配置的运营账号 ID，dashboard 本身已 admin 登录。
  "support-feedback": "/support/feedback",
};

interface BuiltAdminProxyRequest {
  url: URL;
  init: RequestInit & {
    headers: Headers;
  };
  browserToken: string;
  usedBrowserToken: boolean;
}

export async function buildModuleAdminProxyRequest(
  req: Request,
  options: BuildModuleAdminProxyRequestOptions
): Promise<BuiltAdminProxyRequest> {
  const pathPrefix = upstreamPathPrefixes[options.module];
  const path = joinURLPath(pathPrefix, options.path);
  const url = new URL(path, options.upstreamBaseURL);
  new URL(req.url).searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  const browserToken = resolveBrowserAdminToken(req);
  const usedBrowserToken = !options.upstreamToken && (options.forwardBrowserToken ?? true) && browserToken.length > 0;
  const token = resolveAdminToken(browserToken, options.upstreamToken, options.forwardBrowserToken ?? true);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (options.extraHeaders) {
    for (const [key, value] of Object.entries(options.extraHeaders)) {
      if (value) {
        headers.set(key, value);
      }
    }
  }

  const init: BuiltAdminProxyRequest["init"] = {
    method: req.method,
    headers,
    cache: "no-store",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.arrayBuffer();
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  return { url, init, browserToken, usedBrowserToken };
}

export async function buildAdminProxyResponse(
  response: Response,
  invalidateSession: boolean = false
): Promise<Response> {
  const contentType =
    response.headers.get("Content-Type") || "application/json";
  const baseHeaders = {
    "Content-Type": contentType,
    "Cache-Control": "no-store, no-cache, must-revalidate",
  };

  if (response.status === 204 || response.status === 205) {
    const built = new Response(null, {
      status: response.status,
      headers: baseHeaders,
    });
    return invalidateSession
      ? attachAdminSessionCookie(built, createClearedAdminSessionCookie(), true)
      : built;
  }

  const built = new Response(response.body, {
    status: response.status,
    headers: baseHeaders,
  });
  return invalidateSession
    ? attachAdminSessionCookie(built, createClearedAdminSessionCookie(), true)
    : built;
}

export async function proxyModuleAdminRequest(
  req: Request,
  params: { path: string[] },
  options: ProxyModuleAdminRequestOptions
): Promise<Response> {
  if (!options.upstreamBaseURL) {
    return Response.json(
      { error: `${options.serviceName} upstream is not configured` },
      { status: 500 }
    );
  }

  try {
    if (options.requireAdminTokenValidation) {
      const validationFailure = await validateDashboardAdminToken(
        req,
        options.validationBaseURL,
        options.serviceName
      );
      if (validationFailure) {
        return validationFailure;
      }
    }

    const built = await buildModuleAdminProxyRequest(req, {
      module: options.module,
      path: params.path,
      upstreamBaseURL: options.upstreamBaseURL,
      upstreamToken: options.upstreamToken,
      forwardBrowserToken: options.forwardBrowserToken,
      extraHeaders: options.extraHeaders,
    });
    const response = await fetch(built.url.toString(), built.init);
    return buildAdminProxyResponse(
      response,
      built.usedBrowserToken && (response.status === 401 || response.status === 403)
    );
  } catch (error) {
    console.error(`${options.serviceName} admin BFF proxy error:`, error);
    return Response.json(
      { error: `${options.serviceName} backend is unreachable` },
      { status: 502 }
    );
  }
}

async function validateDashboardAdminToken(
  req: Request,
  validationBaseURL: string | undefined,
  serviceName: string
): Promise<Response | null> {
  if (!validationBaseURL) {
    return Response.json(
      { error: "GATEWAY_API_URL is not configured" },
      { status: 500 }
    );
  }

  const token = resolveBrowserAdminToken(req);
  if (!token) {
    return attachAdminSessionCookie(
      Response.json({ error: "missing admin token" }, { status: 401 }),
      createClearedAdminSessionCookie(),
      true
    );
  }

  try {
    const response = await fetch(new URL("/api/admin/stats", validationBaseURL), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });

    if (response.ok) {
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      const data = await response.text();
      return attachAdminSessionCookie(
        new Response(data || JSON.stringify({ error: "unauthorized" }), {
          status: response.status,
          headers: {
            "Content-Type": response.headers.get("Content-Type") || "application/json",
          },
        }),
        createClearedAdminSessionCookie(),
        true
      );
    }

    return Response.json(
      { error: "Gateway admin auth check failed" },
      { status: 502 }
    );
  } catch (error) {
    console.error(`${serviceName} admin auth validation error:`, error);
    return Response.json(
      { error: "Gateway backend is unreachable" },
      { status: 502 }
    );
  }
}

function resolveAdminToken(browserToken: string, upstreamToken?: string, forwardBrowserToken: boolean = true): string {
  if (upstreamToken) {
    return upstreamToken;
  }
  if (!forwardBrowserToken) {
    return "";
  }
  return browserToken;
}

function resolveBrowserAdminToken(req: Request): string {
  const sessionToken = readAdminSessionTokenFromCookieHeader(req.headers.get("cookie"));
  if (sessionToken) {
    return sessionToken;
  }
  const forwardedToken = req.headers.get("x-admin-token");
  if (forwardedToken) {
    return forwardedToken;
  }
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

function joinURLPath(prefix: string, pathParts: string[]): string {
  const suffix = pathParts
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!suffix) {
    return normalizedPrefix || "/";
  }
  return `${normalizedPrefix}/${suffix}`;
}
