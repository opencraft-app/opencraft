import { ExternalLink, Globe, Loader2, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";
import { useT } from "@/i18n/t";
import { AgentSectionHeader } from "@/components/domain/agent-section-header";
import { AppLink } from "@/lib/app-navigation";

interface WebsiteCapability {
  max_sites: number;
  used_sites: number;
  monthly_traffic_bytes: number;
  used_traffic_bytes: number;
  storage_bytes: number;
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

/**
 * 删除操作实体。ctl 直接返回 GORM 实体，字段名是 Go 风格大驼峰，
 * 与 WebsiteSite 一致，不要改成 snake_case。
 */
interface WebsiteOperation {
  OperationID: string;
  Status: string;
  ErrorMessage: string;
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

    try {
      const [capRes, sitesRes] = await Promise.all([
        fetch(`${apiBase}/v1/websites/capability`, { credentials: "include", headers }),
        fetch(`${apiBase}/v1/websites`, { credentials: "include", headers }),
      ]);

      if (!capRes.ok || !sitesRes.ok) {
        if (capRes.status === 401 || sitesRes.status === 401) {
          setError("unauthorized");
        } else {
          setError(`请求失败 (${capRes.status}/${sitesRes.status})`);
        }
        setLoading(false);
        return;
      }

      const capJson: ApiResponse<WebsiteCapability> = await capRes.json();
      const sitesJson: ApiResponse<{ sites: WebsiteSite[]; total: number }> = await sitesRes.json();

      if (capJson.code === "OK") setCapability(capJson.data);
      if (sitesJson.code === "OK") setSites(sitesJson.data.sites ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setLoading(false);
    }
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
          const status = json.data?.Status;
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

  const remaining = capability ? capability.max_sites - capability.used_sites : 0;

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
        title={t("我的作品")}
        subtitle={t("使用 AI Agent 对话即可创建和部署静态网站")}
      />

      {/* 建站权益 */}
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <motion.div variants={fadeIn} className="rounded-xl border border-black/[0.06] bg-white p-5">
          <p className="text-xs text-black/45">{t("作品数")}</p>
          <p className="mt-2 text-2xl font-semibold text-black/90">
            {capability?.used_sites ?? 0}<span className="text-sm text-black/40">/{capability?.max_sites ?? 0}</span>
          </p>
          {remaining === 0 && <p className="mt-1 text-xs text-orange-500">{t("已用完")}</p>}
        </motion.div>
        <motion.div variants={fadeIn} className="rounded-xl border border-black/[0.06] bg-white p-5">
          <p className="text-xs text-black/45">{t("月流量")}</p>
          <p className="mt-2 text-2xl font-semibold text-black/90">{formatBytes(capability?.monthly_traffic_bytes ?? 0)}</p>
        </motion.div>
        <motion.div variants={fadeIn} className="rounded-xl border border-black/[0.06] bg-white p-5">
          <p className="text-xs text-black/45">{t("存储空间")}</p>
          <p className="mt-2 text-2xl font-semibold text-black/90">{formatBytes(capability?.storage_bytes ?? 0)}</p>
        </motion.div>
      </motion.div>

      {/* 作品列表 */}
      <motion.div
        variants={fadeIn}
        initial="hidden"
        animate="visible"
        className="overflow-hidden rounded-xl border border-black/[0.06] bg-white"
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
          <h3 className="text-base font-semibold text-black/90">{t("作品列表")}</h3>
          <span className="text-sm text-black/40">{t("共")} {sites.length} {t("个")}</span>
        </div>
        {sites.length === 0 ? (
          <div className="py-12 text-center">
            <Globe className="mx-auto h-10 w-10 text-black/20" />
            <p className="mt-4 text-sm text-black/45">{t("还没有创建任何作品")}</p>
            <p className="mt-1 text-sm text-black/35" style={{ maxWidth: 400, margin: "0 auto" }}>
              {t("在 Agent 对话中发送")} <code className="rounded bg-black/5 px-1.5 py-0.5 text-xs">{t("帮我建个网站")}</code> {t("即可快速创建")}
            </p>
            <AppLink
              to="/agents/chat"
              className="mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ background: "#007AFF" }}
            >
              <Zap className="h-4 w-4" />
              {t("前往对话")}
            </AppLink>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: "rgba(0,0,0,0.05)" }}>
            {sites.map((site) => {
              const siteURL = site.PublicURL;
              const isDeleting = site.Status === "deleting" || pendingDeleteIDs.includes(site.SiteID);
              const notice = deleteNotices[site.SiteID];
              return (
                <div key={site.SiteID} className="flex items-center justify-between px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-black/90">{site.Name}</span>
                      {isDeleting ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-2 py-0.5 text-xs text-orange-600">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t("正在删除")}
                        </span>
                      ) : site.Status === "active" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs text-green-600">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                          {t("已上线")}
                        </span>
                      ) : site.Status === "creating" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-2 py-0.5 text-xs text-orange-600">
                          {t("创建中")}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-xs text-black/40">
                          {site.Status}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-black/40">
                      {t("创建于")} {formatDate(site.CreatedTime)} · {t("站点ID")}: {site.SiteID}
                    </p>
                    {notice && (
                      <p
                        className={`mt-1 text-xs ${notice.tone === "error" ? "text-red-500" : "text-orange-600"}`}
                      >
                        {notice.message}
                      </p>
                    )}
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    {!isDeleting && site.Status === "active" && siteURL && (
                      <a
                        href={siteURL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-xs font-medium text-blue-500 transition-colors hover:bg-black/5"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {t("访问")}
                      </a>
                    )}
                    {!isDeleting && (
                      <button
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget(site);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("删除")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </motion.div>

      {/* 引导卡片 */}
      <motion.div
        variants={fadeIn}
        initial="hidden"
        animate="visible"
        className="rounded-xl border border-blue-500/10 bg-blue-500/5 p-5"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
            <Zap className="h-4 w-4 text-blue-500" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-black/80">{t("如何创建作品？")}</p>
            <p className="mt-1 text-xs leading-relaxed text-black/50">
              {t("打开 Agent 对话页面，输入")}「{t("帮我建个网站")}」{t("，AI 会自动完成创建、上传和部署，几秒钟后你就能在这里看到你的作品。")}
            </p>
          </div>
        </div>
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
                    style={{ background: "rgba(207,61,76,0.08)" }}
                  >
                    <Trash2 className="h-[18px] w-[18px]" style={{ color: "#cf3d4c" }} />
                  </div>
                  <h3 className="m-0 text-[16px] font-bold tracking-[-0.25px]" style={{ color: "#333" }}>
                    {t("删除作品")}
                  </h3>
                </div>
                <p className="text-sm leading-relaxed" style={{ margin: "12px 0 16px 0", color: "#666" }}>
                  {t("删除后，作品将立即下线，COS 上的文件也会同步清理。此操作不可撤销。")}
                </p>
                <p className="text-sm font-medium" style={{ margin: "0 0 24px 0", color: "#333" }}>
                  {t("作品名称")}：{deleteTarget.Name}
                </p>
                {deleteError && (
                  <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
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
                    style={{ background: "#cf3d4c" }}
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
