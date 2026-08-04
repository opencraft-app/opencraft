import { motion } from "framer-motion";
import { ExternalLink, Globe, Loader2, Plus, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { useT } from "@/i18n/t";
import { ProductPageShell } from "@/components/site/product-chrome";
import { AppLink } from "@/lib/app-navigation";

/* ─── types ─── */

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

const AUTH_TOKEN_STORAGE_KEY = "lightclaw-auth-token-v1";

function readStoredAuthToken(): string | null {
  try {
    const value = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
    return value ? value : null;
  } catch {
    return null;
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

/* ─── animation variants ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] as const } },
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

/* ─── page component ─── */

export const WebsitePage = () => {
  const t = useT();
  const [capability, setCapability] = useState<WebsiteCapability | null>(null);
  const [sites, setSites] = useState<WebsiteSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const remaining = capability ? capability.max_sites - capability.used_sites : 0;

  return (
    <ProductPageShell>
      <main className="relative z-10 flex-grow pb-8 pt-20 md:pt-24">
        <section className="mx-auto px-6 md:px-8" style={{ maxWidth: 800 }}>
          {/* Page Header */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="mb-6 md:mb-8"
          >
            <h2 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 600, color: "rgba(0,0,0,0.9)", lineHeight: 1.5 }}>
              {t("我的网站")}
            </h2>
            <p className="mt-2 text-sm" style={{ color: "#999" }}>
              {t("使用 AI Agent 对话即可创建和部署静态网站")}
            </p>
          </motion.div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin" style={{ color: "#999" }} />
            </div>
          ) : error === "unauthorized" ? (
            <motion.div variants={fadeIn} initial="hidden" animate="visible" className="text-center py-20">
              <p className="text-sm" style={{ color: "#999" }}>{t("请先登录后查看")}</p>
            </motion.div>
          ) : error ? (
            <motion.div variants={fadeIn} initial="hidden" animate="visible" className="text-center py-20">
              <p className="text-sm" style={{ color: "#e74c3c" }}>{error}</p>
            </motion.div>
          ) : (
            <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="space-y-6">
              {/* Capability Card */}
              {capability && (
                <motion.div
                  variants={fadeIn}
                  className="overflow-hidden bg-white"
                  style={{ border: "1px solid #E6E9EF", borderRadius: 16 }}
                >
                  <div className="px-5 py-6 md:px-8 md:py-8">
                    <div className="flex items-center gap-3 mb-5">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: "rgba(0,122,255,0.08)" }}>
                        <Globe className="h-5 w-5" style={{ color: "#007AFF" }} />
                      </div>
                      <div>
                        <h3 className="text-base font-semibold" style={{ color: "#333" }}>{t("建站权益")}</h3>
                        <p className="text-xs" style={{ color: "#999" }}>{t("当前套餐包含的静态网站配额")}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                      <div className="rounded-xl p-4" style={{ background: "rgba(0,0,0,0.02)" }}>
                        <p className="text-xs" style={{ color: "#999" }}>{t("站点数")}</p>
                        <p className="mt-1 text-xl font-bold" style={{ color: "#333" }}>
                          {capability.used_sites}<span className="text-sm font-normal" style={{ color: "#999" }}>/{capability.max_sites}</span>
                        </p>
                        <p className="mt-0.5 text-xs" style={{ color: remaining > 0 ? "#34c759" : "#ff3b30" }}>
                          {remaining > 0 ? t("剩余") + ` ${remaining}` : t("已用完")}
                        </p>
                      </div>
                      <div className="rounded-xl p-4" style={{ background: "rgba(0,0,0,0.02)" }}>
                        <p className="text-xs" style={{ color: "#999" }}>{t("月流量")}</p>
                        <p className="mt-1 text-xl font-bold" style={{ color: "#333" }}>{formatBytes(capability.monthly_traffic_bytes)}</p>
                      </div>
                      <div className="rounded-xl p-4" style={{ background: "rgba(0,0,0,0.02)" }}>
                        <p className="text-xs" style={{ color: "#999" }}>{t("存储空间")}</p>
                        <p className="mt-1 text-xl font-bold" style={{ color: "#333" }}>{formatBytes(capability.storage_bytes)}</p>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Sites List */}
              <motion.div
                variants={fadeIn}
                className="overflow-hidden bg-white"
                style={{ border: "1px solid #E6E9EF", borderRadius: 16 }}
              >
                <div className="px-5 py-4 md:px-8 md:py-5" style={{ borderBottom: "1px solid #E6E9EF" }}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-semibold" style={{ color: "#333" }}>{t("网站列表")}</h3>
                    {sites.length > 0 && (
                      <span className="text-xs" style={{ color: "#999" }}>{t("共") + ` ${sites.length} ` + t("个")}</span>
                    )}
                  </div>
                </div>

                {sites.length === 0 ? (
                  <div className="px-5 py-16 text-center md:py-20">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "rgba(0,122,255,0.06)" }}>
                      <Plus className="h-7 w-7" style={{ color: "#007AFF" }} />
                    </div>
                    <p className="text-base font-medium" style={{ color: "#333", marginBottom: 8 }}>{t("还没有创建任何网站")}</p>
                    <p className="text-sm leading-relaxed" style={{ color: "#999", maxWidth: 400, margin: "0 auto" }}>
                      {t("在 Agent 对话中发送")} <code style={{ padding: "2px 6px", background: "rgba(0,0,0,0.04)", borderRadius: 4, fontSize: 12 }}>{t("帮我建个网站")}</code> {t("即可快速创建你的第一个网站")}
                    </p>
                    <AppLink
                      to="/agents"
                      className="mt-6 inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium text-white transition-colors"
                      style={{ background: "#007AFF" }}
                    >
                      <Zap className="h-4 w-4" />
                      {t("前往对话")}
                    </AppLink>
                  </div>
                ) : (
                  <div className="divide-y" style={{ borderColor: "#E6E9EF" }}>
                    {sites.map((site) => {
                      const siteURL = site.PublicURL;
                      return (
                        <div key={site.SiteID} className="flex items-center justify-between px-5 py-4 md:px-8 md:py-5" style={{ borderColor: "#E6E9EF" }}>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium" style={{ color: "#333" }}>{site.Name}</span>
                              {site.Status === "active" ? (
                                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs" style={{ background: "rgba(52,199,89,0.1)", color: "#34c759" }}>
                                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#34c759" }} />
                                  {t("已上线")}
                                </span>
                              ) : site.Status === "creating" ? (
                                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs" style={{ background: "rgba(255,161,0,0.1)", color: "#C67B1E" }}>
                                  {t("创建中")}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs" style={{ background: "rgba(0,0,0,0.06)", color: "#999" }}>
                                  {site.Status}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-xs" style={{ color: "#999" }}>
                              {t("创建于")} {formatDate(site.CreatedTime)} · {t("站点ID")}: {site.SiteID}
                            </p>
                          </div>
                          {site.Status === "active" && siteURL && (
                            <a
                              href={siteURL}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="ml-4 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-black/[0.03]"
                              style={{ borderColor: "#E6E9EF", color: "#007AFF" }}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              {t("访问")}
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </motion.div>

              {/* Guide Card */}
              <motion.div
                variants={fadeIn}
                className="rounded-2xl px-5 py-5 md:px-8 md:py-6"
                style={{ background: "rgba(0,122,255,0.03)", border: "1px solid rgba(0,122,255,0.1)" }}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(0,122,255,0.1)" }}>
                    <Zap className="h-4 w-4" style={{ color: "#007AFF" }} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium" style={{ color: "#333", marginBottom: 4 }}>{t("如何创建网站？")}</p>
                    <p className="text-xs leading-relaxed" style={{ color: "#999" }}>
                      {t("打开 Agent 对话页面，输入")}「{t("帮我建个网站")}」{t("，AI 会自动完成创建、上传和部署，几秒钟后你就能在这里看到你的网站。")}
                    </p>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </section>
      </main>
    </ProductPageShell>
  );
};
