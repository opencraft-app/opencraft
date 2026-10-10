import {PlatformError} from "@vela/client-core";

export type ProductErrorCode =
  | "method_not_allowed"
  | "network_unavailable"
  | "permission_denied"
  | "provider_unavailable"
  | "resource_conflict"
  | "unknown"
  | "validation_failed";

export interface ProductError {
  code: ProductErrorCode;
  detail?: string;
  scope: string;
}

export interface ProductErrorPresentation {
  message: string;
  nextStep: string;
}

const copy: Record<ProductErrorCode, ProductErrorPresentation> = {
  method_not_allowed: {
    message: "当前服务版本暂不支持此操作",
    nextStep: "刷新页面；仍失败则联系管理员",
  },
  network_unavailable: {
    message: "网络连接不可用",
    nextStep: "检查网络后重试",
  },
  permission_denied: {
    message: "你没有执行此操作的权限",
    nextStep: "联系 Server 管理员",
  },
  provider_unavailable: {
    message: "服务暂时不可用",
    nextStep: "稍后重试",
  },
  resource_conflict: {
    message: "内容已发生变化",
    nextStep: "刷新后重新操作",
  },
  unknown: {
    message: "操作没有完成",
    nextStep: "重试或查看技术详情",
  },
  validation_failed: {
    message: "部分内容需要修改",
    nextStep: "检查标出的字段",
  },
};

const messagingProviderPattern = /腾讯云|\bIM\b|\bTopic\b/iu;
const infrastructureProviderPattern =
  /\b(?:TAT|PTY|Region|Enrollment|provider)\b/iu;
const methodNotAllowedPattern = /(?:HTTP\s*405|method\s+not\s+allowed)/iu;

export function normalizeProductError(
  error: unknown,
  scope: string,
): ProductError {
  if (error instanceof PlatformError) {
    return {
      code: productCode(error),
      detail: error.message,
      scope,
    };
  }
  if (error instanceof Error) {
    return {
      code: methodNotAllowedPattern.test(error.message)
        ? "method_not_allowed"
        : "unknown",
      detail: error.message,
      scope,
    };
  }
  return {code: "unknown", scope};
}

export function productErrorPresentation(
  error: ProductError,
): ProductErrorPresentation {
  return copy[error.code];
}

export function productErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const normalized = normalizeProductError(error, "application");
    if (normalized.code === "method_not_allowed") {
      return "当前服务版本暂不支持此操作，请刷新页面后重试";
    }
    if (error instanceof PlatformError) {
      const presentation = productErrorPresentation(normalized);
      return `${presentation.message}，${presentation.nextStep}`;
    }
    return productString(error.message);
  }
  return typeof error === "string" ? productString(error) : "操作失败，请稍后再试";
}

function productCode(error: PlatformError): ProductErrorCode {
  if (methodNotAllowedPattern.test(error.message)) return "method_not_allowed";
  if (error.code === "NETWORK") return "network_unavailable";
  if (error.code === "AUTH_FORBIDDEN") return "permission_denied";
  if (error.code === "USAGE") return "validation_failed";
  if (error.code === "CONFLICT") return "resource_conflict";
  if (
    error.code === "REMOTE_UNAVAILABLE" ||
    error.code === "RATE_LIMITED" ||
    error.code.startsWith("IM_")
  ) {
    return "provider_unavailable";
  }
  return "unknown";
}

function productString(message: string): string {
  if (methodNotAllowedPattern.test(message)) {
    return "当前服务版本暂不支持此操作，请刷新页面后重试";
  }
  if (messagingProviderPattern.test(message)) {
    return "消息服务暂时不可用，请稍后重试";
  }
  if (infrastructureProviderPattern.test(message)) {
    return "操作失败，请稍后重试";
  }
  return message;
}
