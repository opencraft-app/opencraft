import { AlertTriangle, Check, Loader2, PackageCheck, RefreshCw, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { useT } from "@/i18n/t";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAsyncResource } from "@/services/use-async-resource";
import {
  fetchSkillSetDetail,
  fetchSkillSets,
  type SkillHubSkillSet,
  type SkillHubSkillSetScene,
} from "@/lib/skillhub-api";

type ExpertId = "finance" | "tech" | "design" | "marketing" | "legal" | "academic" | "education" | "hr" | "ecommerce";
type ExpertFilterId = "all" | ExpertId;

interface ExpertDefinition {
  id: ExpertId;
  scene: SkillHubSkillSetScene;
  avatarClassName: string;
}

export interface ExecDebugCommandResult {
  status: string;
  exitCode: number;
  output: string;
}

export type ExpertsExecDebugCommand = (botId: string, command: string) => Promise<ExecDebugCommandResult>;

interface ExpertSkillSetGroup {
  expert: ExpertDefinition;
  packages: SkillHubSkillSet[];
}

interface ExpertPackageCard {
  expert: ExpertDefinition;
  pkg: SkillHubSkillSet;
}

const EXPERTS: ExpertDefinition[] = [
  {
    id: "finance",
    scene: "finance",
    avatarClassName: "bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100",
  },
  {
    id: "tech",
    scene: "tech",
    avatarClassName: "bg-sky-50 text-sky-600 ring-1 ring-sky-100",
  },
  {
    id: "design",
    scene: "design",
    avatarClassName: "bg-rose-50 text-rose-600 ring-1 ring-rose-100",
  },
  {
    id: "marketing",
    scene: "marketing",
    avatarClassName: "bg-amber-50 text-amber-600 ring-1 ring-amber-100",
  },
  {
    id: "legal",
    scene: "legal",
    avatarClassName: "bg-stone-100 text-stone-600 ring-1 ring-stone-200",
  },
  {
    id: "academic",
    scene: "academic",
    avatarClassName: "bg-lime-50 text-lime-700 ring-1 ring-lime-100",
  },
  {
    id: "education",
    scene: "education",
    avatarClassName: "bg-blue-50 text-blue-600 ring-1 ring-blue-100",
  },
  {
    id: "hr",
    scene: "hr",
    avatarClassName: "bg-fuchsia-50 text-fuchsia-600 ring-1 ring-fuchsia-100",
  },
  {
    id: "ecommerce",
    scene: "ecommerce",
    avatarClassName: "bg-teal-50 text-teal-600 ring-1 ring-teal-100",
  },
];

const SKILL_PACKAGE_PAGE_SIZE = 3;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function getUniqueSkillSlugs(skillSlugs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const slug of skillSlugs) {
    const normalized = slug.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function getExpertTitle(id: ExpertId, t: ReturnType<typeof useT>): string {
  switch (id) {
    case "finance":
      return t("金融专家");
    case "tech":
      return t("科技专家");
    case "design":
      return t("设计专家");
    case "marketing":
      return t("营销专家");
    case "legal":
      return t("法律专家");
    case "academic":
      return t("学术专家");
    case "education":
      return t("教育专家");
    case "hr":
      return t("人力专家");
    case "ecommerce":
      return t("电商专家");
  }
}

function getExpertDescription(id: ExpertId, t: ReturnType<typeof useT>): string {
  switch (id) {
    case "finance":
      return t("适合投研整理、财报解读、风险信息汇总和市场资料归档。");
    case "tech":
      return t("适合研发排查、技术资料检索、代码辅助和工程工作流沉淀。");
    case "design":
      return t("适合设计调研、素材整理、体验评审和视觉方案探索。");
    case "marketing":
      return t("适合活动策划、社媒内容、竞品观察和增长素材生成。");
    case "legal":
      return t("适合法律检索、合同审阅、合规资料整理和风险提示。");
    case "academic":
      return t("适合论文阅读、资料综述、研究计划和学术写作辅助。");
    case "education":
      return t("适合课程设计、教案整理、题目生成和学习反馈。");
    case "hr":
      return t("适合招聘筛选、面试设计、绩效材料和组织流程整理。");
    case "ecommerce":
      return t("适合商品运营、店铺分析、转化优化和客服素材沉淀。");
  }
}

function getExpertFilterLabel(id: ExpertFilterId, t: ReturnType<typeof useT>): string {
  if (id === "all") return t("全部");
  switch (id) {
    case "finance":
      return t("金融");
    case "tech":
      return t("技术");
    case "design":
      return t("设计");
    case "marketing":
      return t("营销");
    case "legal":
      return t("法律");
    case "academic":
      return t("学术");
    case "education":
      return t("教育");
    case "hr":
      return t("人力");
    case "ecommerce":
      return t("电商");
  }
}

function getExpertInitial(id: ExpertId): string {
  switch (id) {
    case "finance":
      return "F";
    case "tech":
      return "T";
    case "design":
      return "D";
    case "marketing":
      return "M";
    case "legal":
      return "L";
    case "academic":
      return "A";
    case "education":
      return "E";
    case "hr":
      return "H";
    case "ecommerce":
      return "S";
  }
}

export function getSkillPackageTags(pkg: Pick<SkillHubSkillSet, "displayName" | "skillCount" | "skillSlugs">): string[] {
  const count = pkg.skillSlugs?.length ?? pkg.skillCount ?? 0;
  return [pkg.displayName.trim(), count > 0 ? `${count} skills` : "SkillHub"].filter(Boolean).slice(0, 3);
}

export function buildInstallSkillPackageCommand(skillSlugs: string[]): string {
  const uniqueSlugs = getUniqueSkillSlugs(skillSlugs);
  if (uniqueSlugs.length === 0) {
    return "echo 'No skills to install.'";
  }

  return `acli skills install ${uniqueSlugs.map(shellQuote).join(" ")}`;
}

export function stripMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "").trim();
}

export function getSkillHubErrorMessage(error: string | Error, t: ReturnType<typeof useT>): string {
  const message = typeof error === "string" ? error : error.message;
  if (/failed to fetch/i.test(message)) {
    return t("无法连接 SkillHub，请稍后重试");
  }
  return message;
}

function isExecSucceeded(result: ExecDebugCommandResult): boolean {
  const status = result.status.toLowerCase();
  return result.exitCode === 0 && status !== "failed" && status !== "error";
}

async function fetchExpertSkillSetGroups(): Promise<ExpertSkillSetGroup[]> {
  const groups = await Promise.all(
    EXPERTS.map(async (expert) => {
      const response = await fetchSkillSets({
        scene: expert.scene,
        page: 1,
        pageSize: SKILL_PACKAGE_PAGE_SIZE,
      });
      return {
        expert,
        packages: response.skillSets ?? [],
      };
    }),
  );
  return groups;
}

export function ExpertsPanel({
  botId,
  execDebugCommand,
}: {
  botId: string;
  execDebugCommand: ExpertsExecDebugCommand;
}) {
  const t = useT();
  const [activeFilter, setActiveFilter] = useState<ExpertFilterId>("all");
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(() => new Set());
  const [previewCard, setPreviewCard] = useState<ExpertPackageCard | null>(null);
  const groupsFetcher = useCallback(() => fetchExpertSkillSetGroups(), []);
  const resource = useAsyncResource(groupsFetcher, []);

  const visibleCards = useMemo<ExpertPackageCard[]>(() => {
    return (resource.data ?? []).flatMap((group) => {
      if (activeFilter !== "all" && group.expert.id !== activeFilter) return [];
      return group.packages.map((pkg) => ({ expert: group.expert, pkg }));
    });
  }, [resource.data, activeFilter]);

  const handleInstall = useCallback(async (pkg: SkillHubSkillSet) => {
    if (installingSlug) return;
    setInstallingSlug(pkg.slug);
    try {
      const detail = await fetchSkillSetDetail(pkg.slug);
      const skillSlugs = getUniqueSkillSlugs(detail.skillSlugs ?? []);
      if (skillSlugs.length === 0) {
        toast.error(t("该技能包暂未包含可安装的 skills"));
        return;
      }

      const result = await execDebugCommand(botId, buildInstallSkillPackageCommand(skillSlugs));
      if (!isExecSucceeded(result)) {
        toast.error(t("技能包安装失败"));
        return;
      }

      setInstalledSlugs((current) => {
        const next = new Set(current);
        next.add(pkg.slug);
        return next;
      });
      toast.success(t("技能包安装成功"));
    } catch (error) {
      toast.error(error instanceof Error ? getSkillHubErrorMessage(error, t) : t("技能包安装失败"));
    } finally {
      setInstallingSlug(null);
    }
  }, [botId, execDebugCommand, installingSlug, t]);

  const handleOpenDetail = useCallback((card: ExpertPackageCard) => {
    setPreviewCard(card);
  }, []);

  if (resource.loading && !resource.data) {
    return (
      <div className="flex min-h-[360px] items-center justify-center rounded-md bg-white">
        <Loader2 className="h-5 w-5 animate-spin text-black/35" />
        <span className="ml-2 text-sm text-black/45">{t("正在加载专家技能包...")}</span>
      </div>
    );
  }

  if (resource.error) {
    return (
      <div className="rounded-md border border-red-500/15 bg-white p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-black/90">{t("专家技能包加载失败")}</h2>
            <p className="mt-1 text-sm leading-6 text-black/50">{getSkillHubErrorMessage(resource.error, t)}</p>
            <button
              type="button"
              onClick={() => void resource.reload()}
              className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-black px-3 text-sm font-medium text-white transition-colors hover:bg-black/85"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("重试")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-semibold text-black/95">{t("专家")}</h2>

        <div className="-mx-1 flex min-w-0 gap-3 overflow-x-auto px-1 pb-1">
            {(["all", ...EXPERTS.map((expert) => expert.id)] as ExpertFilterId[]).map((filterId) => (
              <button
                key={filterId}
                type="button"
                onClick={() => setActiveFilter(filterId)}
                className={cn(
                  "h-9 flex-shrink-0 rounded-md px-4 text-sm font-semibold transition-colors",
                  activeFilter === filterId
                    ? "bg-white text-black shadow-[0_8px_24px_rgba(15,23,42,0.06)]"
                    : "text-black/58 hover:bg-white/70 hover:text-black/85",
                )}
              >
                {getExpertFilterLabel(filterId, t)}
              </button>
            ))}
        </div>
      </div>

      {visibleCards.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {visibleCards.map(({ expert, pkg }) => {
            const isInstalled = installedSlugs.has(pkg.slug);
            const isInstalling = installingSlug === pkg.slug;
            const tags = getSkillPackageTags(pkg);
            return (
              <article
                key={pkg.slug}
                role="button"
                tabIndex={0}
                onClick={() => handleOpenDetail({ expert, pkg })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleOpenDetail({ expert, pkg });
                  }
                }}
                className="flex min-h-[184px] cursor-pointer flex-col justify-between rounded-md bg-white px-5 py-5 shadow-[0_10px_28px_rgba(15,23,42,0.045)] transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/40"
              >
                <div>
                  <div className="flex items-start gap-4">
                    <div
                      className={cn(
                        "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                        expert.avatarClassName,
                      )}
                    >
                      {getExpertInitial(expert.id)}
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold leading-6 text-black/90">{pkg.displayName}</h3>
                      <p className="mt-1 text-sm font-medium text-black/52">{getExpertTitle(expert.id, t)}</p>
                    </div>
                  </div>
                  <p className="mt-5 line-clamp-2 min-h-12 text-sm leading-6 text-black/58">
                    {pkg.summary || pkg.remark || getExpertDescription(expert.id, t)}
                  </p>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-2">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleOpenDetail({ expert, pkg });
                      }}
                      className="inline-flex h-6 cursor-pointer items-center rounded-md bg-black/[0.035] px-3 text-xs font-semibold leading-none text-black/48 transition-colors hover:bg-black/[0.055] hover:text-black/62"
                    >
                      {tag}
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleInstall(pkg);
                    }}
                    disabled={Boolean(installingSlug) || isInstalled}
                    className={cn(
                      "ml-auto inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-semibold leading-none transition-colors",
                      isInstalled
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-black text-white hover:bg-black/85 active:bg-black/95",
                      (installingSlug && !isInstalling) || isInstalled ? "cursor-not-allowed opacity-55" : "",
                    )}
                  >
                    {isInstalling ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : isInstalled ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <PackageCheck className="h-3 w-3" />
                    )}
                    {isInstalling ? t("安装中...") : isInstalled ? t("已安装") : t("安装")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md bg-white px-5 py-10 text-center text-sm text-black/40">
          {t("该场景暂未返回技能包")}
        </div>
      )}
      {previewCard ? (
        <SkillPackageDetailModal
          card={previewCard}
          onClose={() => setPreviewCard(null)}
        />
      ) : null}
    </div>
  );
}

function SkillPackageDetailModal({
  card,
  onClose,
}: {
  card: ExpertPackageCard;
  onClose: () => void;
}) {
  const t = useT();
  const detailFetcher = useCallback(() => fetchSkillSetDetail(card.pkg.slug), [card.pkg.slug]);
  const { data, loading, error } = useAsyncResource(detailFetcher, [card.pkg.slug]);
  const skillSlugs = getUniqueSkillSlugs(data?.skillSlugs ?? card.pkg.skillSlugs ?? []);
  const body = stripMarkdownFrontmatter(data?.content || data?.summary || data?.remark || card.pkg.summary || card.pkg.remark);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-package-detail-title"
      onClick={onClose}
    >
      <div
        className="max-h-[86vh] w-full max-w-2xl overflow-hidden rounded-md bg-white shadow-[0_24px_80px_rgba(15,23,42,0.24)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-black/5 px-6 py-5">
          <div className="min-w-0">
            <h2 id="skill-package-detail-title" className="text-xl font-semibold leading-7 text-black/90">
              {data?.displayName ?? card.pkg.displayName}
            </h2>
            <p className="mt-1 text-sm font-medium text-black/52">{getExpertTitle(card.expert.id, t)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-black/40 transition-colors hover:bg-black/[0.04] hover:text-black/75"
            aria-label={t("关闭")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[calc(86vh-88px)] overflow-y-auto px-6 py-5">
          {loading && !data ? (
            <div className="flex min-h-40 items-center justify-center text-sm text-black/45">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("正在加载技能包详情...")}
            </div>
          ) : error ? (
            <div className="rounded-md border border-red-500/15 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">
              {getSkillHubErrorMessage(error, t)}
            </div>
          ) : (
            <div className="space-y-5">
              {body ? (
                <SkillPackageMarkdown content={body} />
              ) : (
                <p className="text-sm text-black/40">{t("该技能包暂未返回详情说明")}</p>
              )}

              <div>
                <h3 className="text-sm font-semibold text-black/78">{t("包含 skills")}</h3>
                {skillSlugs.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {skillSlugs.map((slug) => (
                      <span key={slug} className="rounded-md bg-black/[0.04] px-2.5 py-1 text-xs font-semibold text-black/52">
                        {slug}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-black/40">{t("暂无可安装 skill")}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SkillPackageMarkdown({ content }: { content: string }) {
  const components: Components = {
    h1({ children }) {
      return <h3 className="mt-6 text-lg font-semibold leading-7 text-black/88 first:mt-0">{children}</h3>;
    },
    h2({ children }) {
      return <h3 className="mt-6 text-base font-semibold leading-7 text-black/82 first:mt-0">{children}</h3>;
    },
    h3({ children }) {
      return <h4 className="mt-5 text-sm font-semibold leading-6 text-black/78 first:mt-0">{children}</h4>;
    },
    p({ children }) {
      return <p className="my-3 text-sm leading-7 text-black/60">{children}</p>;
    },
    ul({ children }) {
      return <ul className="my-3 list-disc space-y-1.5 pl-5 text-sm leading-7 text-black/60">{children}</ul>;
    },
    ol({ children }) {
      return <ol className="my-3 list-decimal space-y-1.5 pl-5 text-sm leading-7 text-black/60">{children}</ol>;
    },
    li({ children }) {
      return <li className="pl-1">{children}</li>;
    },
    strong({ children }) {
      return <strong className="font-semibold text-black/78">{children}</strong>;
    },
    code({ className, children }) {
      if (className) {
        return (
          <code className="block overflow-x-auto rounded-md bg-black/[0.04] px-3 py-2 font-mono text-xs leading-6 text-black/62">
            {children}
          </code>
        );
      }
      return (
        <code className="rounded bg-black/[0.05] px-1 py-0.5 font-mono text-xs text-black/62">
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <pre className="my-4 overflow-x-auto rounded-md bg-black/[0.04] p-0">{children}</pre>;
    },
    table({ children }) {
      return (
        <div className="my-4 overflow-x-auto rounded-md border border-black/8">
          <table className="min-w-full border-collapse text-sm text-black/62">{children}</table>
        </div>
      );
    },
    th({ children }) {
      return <th className="border-b border-black/8 bg-black/[0.025] px-3 py-2 text-left font-semibold text-black/72">{children}</th>;
    },
    td({ children }) {
      return <td className="border-t border-black/6 px-3 py-2 align-top">{children}</td>;
    },
  };

  return (
    <div>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
