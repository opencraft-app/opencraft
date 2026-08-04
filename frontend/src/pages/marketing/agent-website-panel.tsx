import { ExternalLink, Globe, Loader2, Plus, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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

interface ApiResponse<T> {
  code: string;
  message: string;
  data: T;
  request_id?: string;
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

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const apiBase = resolveConfiguredAuthApiBaseUrl();
      if (!apiBase) {
        setDeleteError("API not configured");
        return;
      }
      const headers = buildAuthHeaders();
      const res = await fetch(`${apiBase}/v1/websites/${deleteTarget.SiteID}`, {
        method: "DELETE",
        credentials: "include",
        headers,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDeleteError(body.message || `删除失败 (${res.status})`);
        return;
      }
      setDeleteTarget(null);
      await fetchData();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, fetchData]);

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
        title={t("我的网站")}
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
          <p className="text-xs text-black/45">{t("站点数")}</p>
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

      {/* 网站列表 */}
      <motion.div
        variants={fadeIn}
        initial="hidden"
        animate="visible"
        className="overflow-hidden rounded-xl border border-black/[0.06] bg-white"
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
          <h3 className="text-base font-semibold text-black/90">{t("网站列表")}</h3>
          <span className="text-sm text-black/40">{t("共")} {sites.length} {t("个")}</span>
        </div>
        {sites.length === 0 ? (
          <div className="py-12 text-center">
            <Globe className="mx-auto h-10 w-10 text-black/20" />
            <p className="mt-4 text-sm text-black/45">{t("还没有创建任何网站")}</p>
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
              return (
                <div key={site.SiteID} className="flex items-center justify-between px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-black/90">{site.Name}</span>
                      {site.Status === "active" ? (
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
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    {site.Status === "active" && siteURL && (
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
            <p className="text-sm font-medium text-black/80">{t("如何创建网站？")}</p>
            <p className="mt-1 text-xs leading-relaxed text-black/50">
              {t("打开 Agent 对话页面，输入")}「{t("帮我建个网站")}」{t("，AI 会自动完成创建、上传和部署，几秒钟后你就能在这里看到你的网站。")}
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
                    {t("删除网站")}
                  </h3>
                </div>
                <p className="text-sm leading-relaxed" style={{ margin: "12px 0 16px 0", color: "#666" }}>
                  {t("删除后，网站将立即下线，COS 上的文件也会同步清理。此操作不可撤销。")}
                </p>
                <p className="text-sm font-medium" style={{ margin: "0 0 24px 0", color: "#333" }}>
                  {t("网站名称")}：{deleteTarget.Name}
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
