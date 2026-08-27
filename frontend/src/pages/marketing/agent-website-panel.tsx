import {
  ArrowRight,
  BarChart3,
  ExternalLink,
  LayoutTemplate,
  Loader2,
  Megaphone,
  Plus,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";
import { useT } from "@/i18n/t";
import { AgentSectionHeader } from "@/components/domain/agent-section-header";
import { AppLink } from "@/lib/app-navigation";
import { savePendingWorkbenchPrompt } from "./workbench-prompt-templates";

interface WebsiteCapability {
  max_sites: number;
  used_sites: number;
  monthly_traffic_bytes: number;
  used_traffic_bytes: number;
  storage_bytes: number;
  used_storage_bytes: number;
  max_artifact_size: number;
  max_files: number;
}

interface WebsiteSite {
  Id: number;
  CreatedTime: string;
  UpdatedTime: string;
  UserID: string;
  SiteID: string;
  PassID: string;
  BundleID: string;
  Name: string;
  Status: string;
  CloudPath: string;
  PublicURL: string;
  DeletedTime: string | null;
}

interface WebsiteOperation {
  operation_id?: string;
  status?: string;
  error_message?: string;
  OperationID?: string;
  Status?: string;
  ErrorMessage?: string;
}

export function readWebsiteOperation(operation?: WebsiteOperation | null) {
  return {
    operationID: operation?.operation_id ?? operation?.OperationID ?? "",
    status: (operation?.status ?? operation?.Status ?? "").trim().toLowerCase(),
    errorMessage: operation?.error_message ?? operation?.ErrorMessage ?? "",
  };
}

interface DeleteSiteResult {
  operation_id: string;
}

interface ApiResponse<T> {
  code: string;
  message: string;
  data: T;
  request_id?: string;
}

/**
 * 删除是异步的：DELETE 只登记 operation，真正清理 COS 由 website-deployer 执行。
 * 前端轮询 operation 状态收敛 UI，2s 起步指数退避到 5s，60s 未收敛就停止轮询
 * （实测通常几秒完成），避免无限轮询。
 */
const DELETE_POLL_INITIAL_INTERVAL_MS = 2000;
const DELETE_POLL_MAX_INTERVAL_MS = 5000;
const DELETE_POLL_TIMEOUT_MS = 60000;

/** 轮询终态：success 从列表移除，failed 给出友好提示，timeout 提示稍后刷新。 */
type DeleteOutcome = { kind: "success" } | { kind: "failed" } | { kind: "timeout" };

/** 行内提示：failed 用告警红，timeout 只是「还在跑」，用中性提示色 */
interface DeleteNotice {
  message: string;
  tone: "error" | "info";
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return iso;
  }
}

function buildAuthHeaders(): HeadersInit {
  const headers = new Headers();
  const token = readStoredAuthToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] as const } },
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

type WorkbenchTemplateVariant = "tool" | "dashboard" | "campaign" | "profile";

function WorkbenchTemplatePreview({
  variant,
  label,
}: {
  variant: WorkbenchTemplateVariant;
  label: string;
}) {
  if (variant === "dashboard") {
    return (
      <div
        role="img"
        aria-label={label}
        className="relative h-28 overflow-hidden rounded-md border border-white/70 bg-[#101828] p-3"
      >
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
          <span className="h-1.5 w-1.5 rounded-full bg-sky-300" />
          <span className="h-1.5 w-1.5 rounded-full bg-white/35" />
        </div>
        <div className="mt-4 grid grid-cols-4 items-end gap-2">
          <span className="h-10 rounded-sm bg-sky-300/90" />
          <span className="h-16 rounded-sm bg-emerald-300/90" />
          <span className="h-7 rounded-sm bg-amber-200/90" />
          <span className="h-20 rounded-sm bg-violet-300/90" />
        </div>
        <div className="absolute bottom-3 left-3 right-3 h-2 rounded-full bg-white/12">
          <span className="block h-2 w-2/3 rounded-full bg-white/45" />
        </div>
      </div>
    );
  }

  if (variant === "campaign") {
    return (
      <div
        role="img"
        aria-label={label}
        className="relative h-28 overflow-hidden rounded-md border border-white/70 bg-[#fff3d8] p-3"
      >
        <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-[#ff6b4a]/25" />
        <div className="relative grid h-full grid-cols-[1fr_0.75fr] gap-2">
          <div className="rounded-md bg-white/85 p-2 shadow-[0_8px_20px_rgba(160,90,40,0.12)]">
            <span className="block h-3 w-2/3 rounded-full bg-[#ff6b4a]/70" />
            <span className="mt-2 block h-8 rounded bg-[#ffd166]/70" />
            <span className="mt-2 block h-2 w-1/2 rounded-full bg-black/12" />
          </div>
          <div className="flex flex-col justify-between rounded-md bg-[#263238] p-2">
            <span className="h-5 rounded bg-white/85" />
            <span className="h-10 rounded bg-[#69db7c]/75" />
          </div>
        </div>
      </div>
    );
  }

  if (variant === "profile") {
    return (
      <div
        role="img"
        aria-label={label}
        className="relative h-28 overflow-hidden rounded-md border border-white/70 bg-[#e9f7f1] p-3"
      >
        <div className="absolute bottom-0 right-0 h-20 w-20 rounded-tl-[48px] bg-[#79c2a6]/35" />
        <div className="relative h-full rounded-md bg-white/80 p-3 shadow-[0_8px_20px_rgba(40,110,90,0.12)]">
          <span className="block h-8 w-8 rounded-full bg-[#3f8f72]/80" />
          <span className="mt-3 block h-2 w-3/4 rounded-full bg-black/18" />
          <span className="mt-2 block h-2 w-1/2 rounded-full bg-black/10" />
          <span className="absolute bottom-3 left-3 h-5 w-16 rounded-full bg-[#2f6f58]/85" />
        </div>
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={label}
      className="relative h-28 overflow-hidden rounded-md border border-white/70 bg-[#edf4ff] p-3"
    >
      <div className="absolute -bottom-10 -right-10 h-28 w-28 rounded-full bg-[#8dd7b8]/35" />
      <div className="relative rounded-md bg-white/90 p-2 shadow-[0_8px_20px_rgba(30,80,150,0.12)]">
        <div className="mb-2 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[#4dabf7]" />
          <span className="h-1.5 w-8 rounded-full bg-black/12" />
        </div>
        <span className="block h-5 rounded bg-[#dbeafe]" />
        <span className="mt-2 block h-5 rounded bg-[#dcfce7]" />
        <span className="mt-2 block h-5 w-2/3 rounded bg-[#e0e7ff]" />
      </div>
    </div>
  );
}

export const AgentWebsitePanel = () => {
  const t = useT();
  const [capability, setCapability] = useState<WebsiteCapability | null>(null);
  const [sites, setSites] = useState<WebsiteSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WebsiteSite | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** 已发起删除、正在轮询收敛的站点，用于在服务端状态回传前就锁住该行 */
  const [pendingDeleteIDs, setPendingDeleteIDs] = useState<string[]>([]);
  /** 删除未成功时的行内提示（siteID -> 用户可读文案 + 语气） */
  const [deleteNotices, setDeleteNotices] = useState<Record<string, DeleteNotice>>({});

  const unmountedRef = useRef(false);
  const pollTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = pollTimersRef.current;
    return () => {
      unmountedRef.current = true;
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  /** 可被卸载中断的 sleep：定时器句柄登记到 ref，卸载时统一清理，避免卸载后 setState */
  const sleep = useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          pollTimersRef.current.delete(timer);
          resolve();
        }, ms);
        pollTimersRef.current.add(timer);
      }),
    [],
  );

  const fetchData = useCallback(async () => {
    const apiBase = resolveConfiguredAuthApiBaseUrl();
    if (apiBase === null) {
      setError("API not configured");
      setLoading(false);
      return;
    }

    const headers = buildAuthHeaders();

    // capability 与 sites 互相独立：各自成功各自渲染，单个接口失败不拖垮另一个，
    // 也不再因为一个 !ok 就整体丢弃（旧逻辑用 Promise.all + 联合判断会让 capability
    // 明明 200 也因为 sites 失败而一起显示「暂不可用」）。
    const [capResult, sitesResult] = await Promise.allSettled([
      fetch(`${apiBase}/v1/websites/capability`, { credentials: "include", headers }),
      fetch(`${apiBase}/v1/websites`, { credentials: "include", headers }),
    ]);

    let unauthorized = false;
    let sitesOk = false;

    if (capResult.status === "fulfilled") {
      const capRes = capResult.value;
      if (capRes.status === 401) {
        unauthorized = true;
      } else if (capRes.ok) {
        try {
          const capJson: ApiResponse<WebsiteCapability> = await capRes.json();
          if (capJson.code === "OK") {
            setCapability(capJson.data);
          }
        } catch {
          // 解析失败按未拿到处理，capability 保持 null → 顶部显示「暂不可用」
        }
      }
    }

    if (sitesResult.status === "fulfilled") {
      const sitesRes = sitesResult.value;
      if (sitesRes.status === 401) {
        unauthorized = true;
      } else if (sitesRes.ok) {
        try {
          const sitesJson: ApiResponse<{ sites: WebsiteSite[]; total: number }> =
            await sitesRes.json();
          if (sitesJson.code === "OK") {
            setSites(sitesJson.data.sites ?? []);
            sitesOk = true;
          }
        } catch {
          // 解析失败按未拿到处理
        }
      }
    }

    // 列表区错误态只依据 sites：401 优先提示登录；sites 没拿到才显示列表不可用。
    // capability 单独失败只会让顶部配额显示「暂不可用」，不影响列表和模板区。
    if (unauthorized) {
      setError("unauthorized");
    } else if (!sitesOk) {
      setError("list_unavailable");
    } else {
      setError(null);
    }

    setLoading(false);
  }, []);

  /**
   * 轮询单个删除 operation 直到终态或超时。
   * created / running 表示 worker 还在跑（失败重试也会回到 created），继续等；
   * 单次查询报错只当作抖动，交给整体超时兜底，不提前判定失败。
   */
  const pollDeleteOperation = useCallback(
    async (siteID: string, operationID: string): Promise<DeleteOutcome> => {
      const apiBase = resolveConfiguredAuthApiBaseUrl();
      if (!apiBase) return { kind: "timeout" };

      const deadline = Date.now() + DELETE_POLL_TIMEOUT_MS;
      let interval = DELETE_POLL_INITIAL_INTERVAL_MS;

      while (Date.now() < deadline) {
        await sleep(interval);
        if (unmountedRef.current) return { kind: "timeout" };
        interval = Math.min(Math.round(interval * 1.5), DELETE_POLL_MAX_INTERVAL_MS);

        try {
          const res = await fetch(`${apiBase}/v1/websites/${siteID}/operations/${operationID}`, {
            credentials: "include",
            headers: buildAuthHeaders(),
          });
          if (!res.ok) continue;
          const json: ApiResponse<WebsiteOperation> = await res.json();
          if (json.code !== "OK") continue;
          const { status } = readWebsiteOperation(json.data);
          if (status === "success") return { kind: "success" };
          if (status === "failed" || status === "dead") return { kind: "failed" };
        } catch {
          // 网络抖动：保持轮询，由 deadline 收口
        }
      }
      return { kind: "timeout" };
    },
    [sleep],
  );

  /** 删除后的收敛流程：成功即从列表消失并刷新配额，失败/超时恢复可操作并给出提示 */
  const awaitDeleteResult = useCallback(
    async (siteID: string, operationID: string) => {
      const outcome: DeleteOutcome = operationID
        ? await pollDeleteOperation(siteID, operationID)
        : { kind: "timeout" };
      if (unmountedRef.current) return;

      setPendingDeleteIDs((prev) => prev.filter((id) => id !== siteID));

      if (outcome.kind === "success") {
        setSites((prev) => prev.filter((item) => item.SiteID !== siteID));
        setDeleteNotices((prev) => {
          const next = { ...prev };
          delete next[siteID];
          return next;
        });
        // 重新拉一次让 used_sites 席位同步回落
        await fetchData();
        return;
      }

      setDeleteNotices((prev) => ({
        ...prev,
        [siteID]:
          outcome.kind === "failed"
            ? { message: t("删除失败，请稍后重试。"), tone: "error" }
            : { message: t("删除仍在进行中，请稍后刷新查看"), tone: "info" },
      }));
      await fetchData();
    },
    [fetchData, pollDeleteOperation, t],
  );

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const siteID = deleteTarget.SiteID;
    setDeleting(true);
    setDeleteError(null);
    try {
      const apiBase = resolveConfiguredAuthApiBaseUrl();
      if (!apiBase) {
        setDeleteError("API not configured");
        return;
      }
      const headers = buildAuthHeaders();
      const res = await fetch(`${apiBase}/v1/websites/${siteID}`, {
        method: "DELETE",
        credentials: "include",
        headers,
      });
      if (!res.ok) {
        setDeleteError(t("删除失败，请稍后重试。"));
        return;
      }
      const body: ApiResponse<DeleteSiteResult> = await res.json();
      const operationID = body.data?.operation_id ?? "";

      setDeleteTarget(null);
      setDeleteNotices((prev) => {
        const next = { ...prev };
        delete next[siteID];
        return next;
      });
      // 先本地锁住该行进入「正在删除」，再异步等待 worker 真正清理完成
      setPendingDeleteIDs((prev) => (prev.includes(siteID) ? prev : [...prev, siteID]));
      void awaitDeleteResult(siteID, operationID);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setDeleting(false);
    }
  }, [awaitDeleteResult, deleteTarget, t]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const usedSites = capability?.used_sites ?? 0;
  const maxSites = capability?.max_sites ?? 0;
  const usedTrafficBytes = capability?.used_traffic_bytes ?? 0;
  const monthlyTrafficBytes = capability?.monthly_traffic_bytes ?? 0;
  const siteQuotaRatio = maxSites > 0 ? usedSites / maxSites : 0;
  const trafficQuotaRatio = monthlyTrafficBytes > 0 ? usedTrafficBytes / monthlyTrafficBytes : 0;
  const showQuotaNotice = siteQuotaRatio >= 0.8 || trafficQuotaRatio >= 0.8;
  const hasLoadError = error !== null;
  const listErrorTitle =
    error === "unauthorized" ? t("请先登录后查看工作台列表") : t("暂时无法加载工作台列表");
  const listErrorDescription =
    error === "unauthorized"
      ? t("登录后会自动展示已托管的工作台和访问地址。")
      : t("托管服务接口暂时不可用，模板和创建入口仍可使用。");
  const workbenchTemplates = [
    {
      title: t("清爽工具台"),
      description: t("表单、查询、小型运营工具"),
      scene: t("适合轻量内部工具"),
      Icon: Wrench,
      variant: "tool" as const,
    },
    {
      title: t("数据看板台"),
      description: t("指标、趋势、业务数据总览"),
      scene: t("适合日报和数据汇总"),
      Icon: BarChart3,
      variant: "dashboard" as const,
    },
    {
      title: t("运营活动台"),
      description: t("活动页、报名页、兑换入口"),
      scene: t("适合增长和活动运营"),
      Icon: Megaphone,
      variant: "campaign" as const,
    },
    {
      title: t("个人展示台"),
      description: t("作品集、主页、服务介绍"),
      scene: t("适合对外展示"),
      Icon: UserRound,
      variant: "profile" as const,
    },
  ];

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-black/30" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-black/[0.06] bg-white p-6 text-sm text-black/60">
        <p>{error === "unauthorized" ? t("请先登录") : error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AgentSectionHeader
        title={t("我的工作台")}
        description={t("让 Agent 帮你构建、发布并持续管理可访问的 Web 工作台")}
        actionsClassName="w-full sm:w-auto"
        actions={
          <div className="grid w-full grid-cols-2 gap-2 sm:w-[360px]">
            <div className="rounded-md border border-black/[0.06] bg-white px-3 py-2.5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
              <p className="text-[11px] font-medium text-black/45">{t("工作台数量")}</p>
              <p className="mt-1 text-lg font-semibold leading-none text-black/90">
                {capability ? (
                  <>
                    {usedSites}<span className="text-xs font-medium text-black/40">/{maxSites}</span>
                  </>
                ) : (
                  <span className="text-black/35">-<span className="text-xs font-medium text-black/40">/-</span></span>
                )}
              </p>
            </div>
            <div className="rounded-md border border-black/[0.06] bg-white px-3 py-2.5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
              <p className="text-[11px] font-medium text-black/45">{t("本月访问流量")}</p>
              <p className="mt-1 truncate text-lg font-semibold leading-none text-black/90">
                {capability ? (
                  <>
                    {formatBytes(usedTrafficBytes)}
                    <span className="text-xs font-medium text-black/40"> / {formatBytes(monthlyTrafficBytes)}</span>
                  </>
                ) : (
                  <span className="text-black/35">-<span className="text-xs font-medium text-black/40"> / -</span></span>
                )}
              </p>
            </div>
          </div>
        }
      />

      {showQuotaNotice ? (
        <div className="rounded-md border border-orange-200/80 bg-orange-50 px-4 py-2.5 text-xs font-medium text-orange-700">
          {t("配额接近上限，可删除不再使用的工作台或升级套餐。")}
        </div>
      ) : null}

      {/* 启动模板 */}
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="rounded-md border border-black/[0.06] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
      >
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-black/[0.04]">
            <LayoutTemplate className="h-4 w-4 text-black/65" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-black/90">{t("启动模板")}</h3>
            <p className="mt-0.5 text-xs text-black/45">{t("选择一种工作台风格，进入对话后继续补充需求。")}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {workbenchTemplates.map((template) => {
            const TemplateIcon = template.Icon;
            return (
              <motion.div key={template.title} variants={fadeIn}>
                <AppLink
                  to="/agents/chat"
                  onClick={() => savePendingWorkbenchPrompt(template.variant)}
                  className="group block h-full rounded-md border border-black/[0.06] bg-black/[0.015] p-3 transition-colors hover:border-black/15 hover:bg-black/[0.025]"
                >
                  <WorkbenchTemplatePreview variant={template.variant} label={template.title} />
                  <div className="mt-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <TemplateIcon className="h-3.5 w-3.5 text-black/55" />
                        <p className="truncate text-sm font-semibold text-black/85">{template.title}</p>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-black/50">{template.description}</p>
                      <p className="mt-2 text-[11px] font-medium text-black/35">{template.scene}</p>
                    </div>
                    <ArrowRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-black/30 transition-transform group-hover:translate-x-0.5 group-hover:text-black/55" />
                  </div>
                </AppLink>
              </motion.div>
            );
          })}
        </div>

        <div className="mt-4 flex justify-start">
          <AppLink
            to="/agents/chat"
            onClick={() => savePendingWorkbenchPrompt("blank")}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-[#007AFF] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#006ee6]"
          >
            <Plus className="h-4 w-4" />
            {t("创建我的工作台")}
          </AppLink>
        </div>
      </motion.div>

      {/* 工作台列表 */}
      <motion.div
        variants={fadeIn}
        initial="hidden"
        animate="visible"
        className="overflow-hidden rounded-md border border-black/[0.06] bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
          <h3 className="text-base font-semibold text-black/90">{t("工作台列表")}</h3>
          <span className="text-sm text-black/40">
            {hasLoadError ? t("暂不可用") : <>{t("共")} {sites.length} {t("个")}</>}
          </span>
        </div>
        {hasLoadError ? (
          <div className="px-5 py-12 text-center">
            <LayoutTemplate className="mx-auto h-10 w-10 text-black/20" />
            <p className="mt-4 text-sm font-medium text-black/60">{listErrorTitle}</p>
            <p className="mx-auto mt-1 max-w-[420px] text-sm text-black/38">
              {listErrorDescription}
            </p>
          </div>
        ) : sites.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <LayoutTemplate className="mx-auto h-10 w-10 text-black/20" />
            <p className="mt-4 text-sm font-medium text-black/60">{t("还没有创建工作台")}</p>
            <p className="mx-auto mt-1 max-w-[280px] text-sm text-black/38 sm:max-w-none sm:whitespace-nowrap">
              {t("从上方模板快速开始，或创建一个空白工作台，让 Agent 帮你搭建。")}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-black/[0.06]">
            <div className="hidden grid-cols-[minmax(0,1fr)_112px_120px] gap-4 px-5 py-3 text-xs font-semibold text-black/45 md:grid">
              <span>{t("工作台访问地址")}</span>
              <span>{t("状态")}</span>
              <span className="text-right">{t("操作")}</span>
            </div>
            {sites.map((site) => {
              const siteURL = site.PublicURL;
              const status = site.Status.trim().toLowerCase();
              const isDeleting = status === "deleting" || pendingDeleteIDs.includes(site.SiteID);
              const statusView = (() => {
                if (isDeleting || status === "deleted" || status === "suspended" || status === "blocked") {
                  return { label: t("已下线"), tone: "muted" as const };
                }
                if (status === "active") return { label: t("已上线"), tone: "success" as const };
                if (status === "creating") return { label: t("构建中"), tone: "warning" as const };
                if (status === "publishing" || status === "pending" || status === "running") {
                  return { label: t("发布中"), tone: "info" as const };
                }
                if (status === "failed" || status === "dead" || status === "error") {
                  return { label: t("更新失败"), tone: "danger" as const };
                }
                return { label: t("发布中"), tone: "info" as const };
              })();
              const statusClassName =
                statusView.tone === "success"
                  ? "bg-emerald-500/10 text-emerald-700"
                  : statusView.tone === "warning"
                    ? "bg-orange-500/10 text-orange-700"
                    : statusView.tone === "danger"
                      ? "bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-[var(--danger)]"
                      : statusView.tone === "info"
                        ? "bg-blue-500/10 text-blue-600"
                        : "bg-black/5 text-black/45";
              const notice = deleteNotices[site.SiteID];
              return (
                <div key={site.SiteID} className="group grid gap-3 px-5 py-4 transition-colors hover:bg-black/[0.015] md:grid-cols-[minmax(0,1fr)_112px_120px] md:items-center md:gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-black/90">
                      {siteURL || t("访问地址生成中")}
                    </p>
                    <p className="mt-1 truncate text-xs text-black/40">
                      {site.Name} · {t("创建于")} {formatDate(site.CreatedTime)}
                    </p>
                    {notice && (
                      <p
                        className={`mt-1 text-xs ${notice.tone === "error" ? "text-[var(--danger)]" : "text-orange-600"}`}
                      >
                        {notice.message}
                      </p>
                    )}
                  </div>
                  <div>
                    <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${statusClassName}`}>
                      {statusView.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 md:justify-end">
                    {status === "active" && siteURL ? (
                      <a
                        href={siteURL}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t("访问")}
                        className="group/btn relative inline-flex h-8 w-8 items-center justify-center rounded-md text-black/40 transition-colors hover:bg-black/[0.05] hover:text-[#007AFF]"
                      >
                        <ExternalLink className="h-4 w-4" />
                        <span className="pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/80 px-2 py-1 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover/btn:opacity-100">
                          {t("访问")}
                        </span>
                      </a>
                    ) : (
                      <span
                        title={t("访问地址生成中")}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-black/20"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </span>
                    )}
                    {!isDeleting && (
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget(site);
                        }}
                        title={t("删除")}
                        className="group/btn relative inline-flex h-8 w-8 items-center justify-center rounded-md text-black/40 transition-colors hover:bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] hover:text-[var(--danger)]"
                      >
                        <Trash2 className="h-4 w-4" />
                        <span className="pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/80 px-2 py-1 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover/btn:opacity-100">
                          {t("删除")}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </motion.div>

      {/* 删除确认弹窗 */}
      <AnimatePresence>
        {deleteTarget && (
          <motion.div
            className="fixed inset-0 z-[100] flex items-center justify-center"
            style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => !deleting && setDeleteTarget(null)}
          >
            <motion.div
              className="relative mx-4 w-full max-w-[420px] overflow-hidden rounded-2xl bg-white"
              style={{ boxShadow: "0 20px 60px -10px rgba(0,0,0,0.2)" }}
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-7 pb-6 pt-7">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-full"
                    style={{ background: "color-mix(in oklab, var(--danger) 8%, transparent)" }}
                  >
                    <Trash2 className="h-[18px] w-[18px]" style={{ color: "var(--danger)" }} />
                  </div>
                  <h3 className="m-0 text-[16px] font-bold tracking-[-0.25px]" style={{ color: "#333" }}>
                    {t("删除工作台")}
                  </h3>
                </div>
                <p className="text-sm leading-relaxed" style={{ margin: "12px 0 16px 0", color: "#666" }}>
                  {t("删除后，工作台将立即下线，相关文件也会同步清理。此操作不可撤销。")}
                </p>
                <p className="text-sm font-medium" style={{ margin: "0 0 24px 0", color: "#333" }}>
                  {t("工作台名称")}：{deleteTarget.Name}
                </p>
                {deleteError && (
                  <p className="mb-4 rounded-lg bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-xs text-[var(--danger)]">
                    {deleteError}
                  </p>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={() => setDeleteTarget(null)}
                    disabled={deleting}
                    className="flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)] disabled:opacity-50"
                    style={{ borderColor: "rgba(0,0,0,0.1)", color: "#333" }}
                  >
                    {t("取消")}
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
                    style={{ background: "var(--danger)" }}
                  >
                    {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
                    {deleting ? t("删除中...") : t("确认删除")}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
