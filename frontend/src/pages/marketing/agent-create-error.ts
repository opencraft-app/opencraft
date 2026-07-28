type Translate = (message: string) => string;

type ErrorWithCode = {
  code?: unknown;
  message?: unknown;
};

const SANDBOX_CAPACITY_CODES = new Set([
  "SANDBOX_SERVICE_ERROR",
  "SANDBOX_STATUS_CONFLICT",
]);

const identity: Translate = (message) => message;

export const getAgentCreateErrorMessage = (
  error: unknown,
  translate: Translate = identity,
): string => {
  const candidate = error && typeof error === "object" ? error as ErrorWithCode : null;
  const code = typeof candidate?.code === "string" ? candidate.code.trim().toUpperCase() : "";
  const raw = error instanceof Error
    ? error.message
    : typeof candidate?.message === "string"
      ? candidate.message
      : typeof error === "string"
        ? error
        : "";

  if (/quota|limit|exceed/i.test(raw)) {
    return translate("当前套餐的 Agent 配额已满，请升级套餐或删除现有 Agent 后重试。");
  }
  if (
    SANDBOX_CAPACITY_CODES.has(code)
    || /no capacity|no clean instance|all candidate templates failed|resource.*(?:insufficient|sold.?out)|sandbox(?: service| status)? error|sandbox status conflict|pool.*exhaust/i.test(raw)
  ) {
    return translate("当前资源暂时售罄，请稍后再试。");
  }
  if (/timeout|timed?\s*out/i.test(raw)) {
    return translate("创建超时，请稍后重试。");
  }
  if (/network|fetch|connect/i.test(raw)) {
    return translate("网络异常，请检查网络后重试。");
  }
  return raw || translate("创建失败，请稍后重试。");
};
