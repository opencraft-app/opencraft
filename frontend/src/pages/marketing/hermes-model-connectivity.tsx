import { CheckCircle2, CircleAlert, Loader2, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n/t";

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export interface AcliModelTestItem {
  api?: string;
  base_url?: string;
  error_code?: number;
  error_message?: string;
  model?: string;
  success?: boolean;
  time_ms?: number;
}

export interface AcliModelTestData {
  agent?: string;
  api?: string;
  base_url?: string;
  configured?: boolean;
  error_code?: number;
  error_message?: string;
  message?: string;
  model?: string;
  provider?: string;
  results?: AcliModelTestItem[];
  success?: boolean;
  time_ms?: number;
}

export interface AcliModelTestResponse {
  data?: AcliModelTestData;
  success?: boolean;
}

export interface ModelConnectivityExecResult {
  status: string;
  exitCode: number;
  output: string;
  stdout?: string;
  stderr?: string;
}

export interface ModelConnectivityTestResult extends ModelConnectivityExecResult {
  parsed: AcliModelTestResponse | null;
  success: boolean;
  outcome: "connected" | "configured" | "failed";
}

export interface ModelConnectivityTestButtonProps {
  onTest: () => Promise<ModelConnectivityTestResult>;
  disabled?: boolean;
}

export interface ModelPanelButtonProps {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "primary" | "outline" | "danger";
  onTest?: () => Promise<ModelConnectivityTestResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" ? record[key] as number : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] as boolean : undefined;
}

function parseModelTestData(value: unknown): AcliModelTestData | undefined {
  if (!isRecord(value)) return undefined;

  const results = Array.isArray(value.results)
    ? value.results.filter(isRecord).map((item) => ({
      api: readString(item, "api"),
      base_url: readString(item, "base_url"),
      error_code: readNumber(item, "error_code"),
      error_message: readString(item, "error_message"),
      model: readString(item, "model"),
      success: readBoolean(item, "success"),
      time_ms: readNumber(item, "time_ms"),
    }))
    : undefined;

  return {
    agent: readString(value, "agent"),
    api: readString(value, "api"),
    base_url: readString(value, "base_url"),
    configured: readBoolean(value, "configured"),
    error_code: readNumber(value, "error_code"),
    error_message: readString(value, "error_message"),
    message: readString(value, "message"),
    model: readString(value, "model"),
    provider: readString(value, "provider"),
    results,
    success: readBoolean(value, "success"),
    time_ms: readNumber(value, "time_ms"),
  };
}

function parseJsonCandidate(candidate: string): AcliModelTestResponse | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!isRecord(parsed)) return null;
    const data = parseModelTestData(parsed.data);
    return {
      data,
      success: readBoolean(parsed, "success"),
    };
  } catch {
    return null;
  }
}

/** Extracts ACLI JSON even when envd prefixes it with shell output or ANSI codes. */
export function parseAcliModelTestOutput(output: string): AcliModelTestResponse | null {
  const normalized = output.replace(ANSI_ESCAPE, "").trim();
  if (!normalized) return null;

  for (const line of normalized.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const parsed = parseJsonCandidate(line);
    if (parsed) return parsed;
  }

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return parseJsonCandidate(normalized.slice(firstBrace, lastBrace + 1));
  }
  return null;
}

export function buildModelConnectivityTestResult(
  result: ModelConnectivityExecResult,
): ModelConnectivityTestResult {
  const parsed = parseAcliModelTestOutput(result.stdout || "")
    || parseAcliModelTestOutput(result.output)
    || parseAcliModelTestOutput(result.stderr || "");
  const commandSucceeded = result.exitCode === 0 && parsed?.success === true;
  const hasConnectionResult = parsed?.data?.success === true
    || parsed?.data?.results?.some((item) => item.success === true) === true;
  const outcome = !commandSucceeded
    ? "failed"
    : hasConnectionResult
      ? "connected"
      : parsed?.data?.configured === true
        ? "configured"
        : "failed";
  return {
    ...result,
    parsed,
    success: outcome === "connected",
    outcome,
  };
}

function getModelTestMessage(result: ModelConnectivityTestResult): string {
  return result.parsed?.data?.message
    || result.parsed?.data?.error_message
    || result.stderr?.trim()
    || result.output.trim();
}

function isAddDefaultButton(children: ReactNode): boolean {
  if (typeof children !== "string") return false;
  const label = children.toLowerCase();
  return label.includes("添加为默认") || label.includes("add as default") || label.includes("add to default");
}

export function ModelPanelButton({
  children,
  onClick,
  disabled,
  loading,
  variant,
  onTest,
}: ModelPanelButtonProps) {
  const t = useT();
  const defaultButton = (
    <button
      type="button"
      className={`lh-std-button lh-std-button--${variant || "primary"}`}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {children}
    </button>
  );

  if (!onTest || !isAddDefaultButton(children)) return defaultButton;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ModelConnectivityButton onTest={onTest} disabled={disabled || loading} />
      {defaultButton}
    </div>
  );
}

export function ModelConnectivityButton({ onTest, disabled }: ModelConnectivityTestButtonProps) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ModelConnectivityTestResult | null>(null);

  const handleTest = async () => {
    if (loading || disabled) return;
    setLoading(true);
    try {
      setResult(await onTest());
    } catch (error) {
      const message = error instanceof Error ? error.message : t("检测请求失败");
      setResult({
        status: "FAILED",
        exitCode: -1,
        output: message,
        parsed: null,
        success: false,
        outcome: "failed",
      });
    } finally {
      setLoading(false);
    }
  };

  const isSuccessful = result?.outcome === "connected";
  const isConfigured = result?.outcome === "configured";
  const resultLabel = isSuccessful
    ? t("连接成功")
    : isConfigured
      ? t("API Key 已配置，但未返回模型连通结果")
      : t("连接失败");

  return (
    <>
      <button
        type="button"
        className="lh-std-button lh-std-button--outline inline-flex items-center gap-1.5"
        disabled={disabled || loading}
        onClick={() => void handleTest()}
      >
        {loading ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}
        {loading ? t("检测中...") : t("连通检测")}
      </button>
      <Dialog open={result !== null} onOpenChange={(open) => !open && setResult(null)}>
        <DialogContent className="max-h-[min(80vh,42rem)] overflow-y-auto rounded-md border border-black/[0.08] bg-white p-5 shadow-xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isSuccessful ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
              ) : isConfigured ? (
                <CircleAlert className="h-5 w-5 text-amber-600" aria-hidden="true" />
              ) : (
                <XCircle className="h-5 w-5 text-red-600" aria-hidden="true" />
              )}
              {t("模型连通检测")}
            </DialogTitle>
            <DialogDescription>
              {resultLabel}
              {result ? ` · ${getModelTestMessage(result) || t("没有解析到有效的 ACLI JSON 返回。")}` : ""}
            </DialogDescription>
          </DialogHeader>

          {result && (
            <div className="space-y-4 text-sm">
              {result.parsed?.data && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md bg-black/[0.03] px-3 py-3">
                  <dt className="text-black/45">{t("提供商")}</dt>
                  <dd className="min-w-0 break-all text-black/75">{result.parsed.data.provider || "-"}</dd>
                  <dt className="text-black/45">{t("模型")}</dt>
                  <dd className="min-w-0 break-all text-black/75">{result.parsed.data.model || "-"}</dd>
                  <dt className="text-black/45">{t("响应时间")}</dt>
                  <dd className="text-black/75">{result.parsed.data.time_ms ?? "-"} ms</dd>
                </dl>
              )}
              <div className="flex items-center justify-between text-xs text-black/45">
                <span>{t("退出码")}: {result.exitCode}</span>
                <span>{t("状态")}: {result.status || "-"}</span>
              </div>
              <details className="rounded-md border border-black/[0.08] px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium text-black/60">{t("命令输出")}</summary>
                <div className="mt-2 space-y-2">
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-black/40">stdout</div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-black/60">
                      {result.stdout || result.output || t("没有解析到有效的 ACLI JSON 返回。")}
                    </pre>
                  </div>
                  {result.stderr ? (
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-red-500/70">stderr</div>
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-red-700/70">
                        {result.stderr}
                      </pre>
                    </div>
                  ) : null}
                </div>
              </details>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
