import { keepPreviousData, useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CirclePause,
  CircleDashed,
  DatabaseZap,
  Download,
  Gauge,
  KeyRound,
  Layers3,
  ListChecks,
  Loader2,
  LogOut,
  Menu,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Route,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Upload,
  type LucideIcon,
  UsersRound,
  WalletCards,
  Zap,
} from "lucide-react"
import { type ChangeEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react"

import {
  LLMGatewayAPI,
  type BYOKSyncQueueStats,
  type ChannelBundleDeliveryStatus,
  type ChannelBundleDeliverySetStatus,
  type ChannelBundleReleaseRun,
  type ChannelBundleRevision,
  type ChannelBundlePlan,
  type ChannelBundleSpec,
  type ChannelBundleSyncState,
  type ChatCompletionProbeResult,
  type CreateExternalKeyResult,
  type DesiredConfig,
  type GatewaySet,
  type EntitlementPlan,
  type OperationalOverview,
  type ResourceDefinition,
  type ResourceRow,
  type ResourceRowsResult,
  type SetCapacityResult,
  type SetPlanState,
  type SetDecommissionJob,
  type SetDecommissionPreview,
  type SetUpgradeRun,
  type ShardDetail,
  type ShardExpansion,
  type TenantDeletionJob,
  type TenantDetail,
  type TenantObservation,
  type TenantObservationQueueStats,
  type TenantSummary,
  type TrafficProbeMode,
  type UserState,
  type WorkerJob,
} from "./api"
import { Badge } from "./components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog"
import { Button } from "./components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./components/ui/breadcrumb"
import { Input } from "./components/ui/input"
import { Label } from "./components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import { consoleFrameURL } from "./console-url"
import { cn } from "./lib/utils"

type ConsoleView = "overview" | "sets" | "shards" | "versions" | "channels" | "plans" | "jobs" | "tenants" | "resources" | "traffic"
type NavItem =
  | { id: ConsoleView; icon: LucideIcon; label: string; detail: string; activeViews?: ConsoleView[] }
  | { type: "separator" }
type SetConsoleLink = { path: string; label: string; ariaLabel: (title: string) => string; icon: LucideIcon }

const navItems: NavItem[] = [
  { id: "overview", icon: Activity, label: "总览", detail: "值班第一屏" },
  { id: "tenants", icon: UsersRound, label: "租户", detail: "用户与权益" },
  { id: "channels", icon: SlidersHorizontal, label: "发布管理", detail: "模型配置与订阅权益", activeViews: ["channels", "plans"] },
  { id: "sets", icon: Layers3, label: "基础设施", detail: "服务集群、版本与数据分片", activeViews: ["sets", "versions", "shards"] },
  { id: "jobs", icon: ListChecks, label: "运维", detail: "异常任务与服务诊断", activeViews: ["jobs", "traffic", "resources"] },
]

const consoleRoutes: Record<ConsoleView, string> = {
  overview: "/admin/overview",
  tenants: "/admin/tenants",
  plans: "/admin/entitlements",
  channels: "/admin/model-configs",
  sets: "/admin/infrastructure/sets",
  shards: "/admin/infrastructure/shards",
	versions: "/admin/infrastructure/versions",
  jobs: "/admin/operations/jobs",
  traffic: "/admin/diagnostics/traffic",
  resources: "/admin/diagnostics/data",
}

export function consoleRouteForView(view: ConsoleView) {
  return consoleRoutes[view]
}

export function consoleViewFromPath(pathname: string): ConsoleView {
  if (pathname.startsWith("/admin/tenants")) return "tenants"
  if (pathname.startsWith("/admin/entitlements")) return "plans"
  if (pathname.startsWith("/admin/model-configs")) return "channels"
  if (pathname.startsWith("/admin/infrastructure/shards")) return "shards"
	if (pathname.startsWith("/admin/infrastructure/versions")) return "versions"
  if (pathname.startsWith("/admin/infrastructure")) return "sets"
  if (pathname.startsWith("/admin/operations")) return "jobs"
  if (pathname.startsWith("/admin/diagnostics/traffic")) return "traffic"
  if (pathname.startsWith("/admin/diagnostics")) return "resources"
  return "overview"
}

export function consoleTenantIDFromPath(pathname: string) {
  const prefix = "/admin/tenants/"
  if (!pathname.startsWith(prefix)) return ""
  const value = pathname.slice(prefix.length).split("/")[0]
  if (!value) return ""
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function consoleRouteForAlert(kind: string) {
  if (kind.includes("channel") || kind.includes("bundle")) return consoleRouteForView("channels")
  if (kind.includes("job") || kind.includes("worker") || kind.includes("byok")) return consoleRouteForView("jobs")
  if (kind.includes("traffic") || kind.includes("upstream")) return consoleRouteForView("traffic")
  return consoleRouteForView("sets")
}
const setConsoleLinks: SetConsoleLink[] = [
  { path: "/dashboard", label: "打开原生控制台", ariaLabel: (title) => `打开 ${title} 的 new-api 首页`, icon: Activity },
]

export function App() {
  const api = useMemo(() => new LLMGatewayAPI(fetch), [])

  return <ConsoleShell api={api} />
}

function ConsoleNavigation({
  activeView,
  collapsed = false,
  onNavigate,
}: {
  activeView: ConsoleView
  collapsed?: boolean
  onNavigate: (view: ConsoleView) => void
}) {
  return (
    <nav className={cn("flex flex-1 flex-col gap-1", collapsed ? "items-center p-2" : "p-3")}>
      {navItems.map((item, index) => {
        if ("type" in item) {
          return <div key={`separator-${index}`} className={cn("my-2 h-px bg-border", collapsed ? "w-8" : "w-full")} />
        }
        const selected = (item.activeViews || [item.id]).includes(activeView)
        return (
          <a
            key={item.id}
            href={consoleRouteForView(item.id)}
            aria-current={selected ? "page" : undefined}
            aria-label={collapsed ? item.label : undefined}
            title={collapsed ? `${item.label} · ${item.detail}` : undefined}
            onClick={(event) => {
              event.preventDefault()
              onNavigate(item.id)
            }}
            className={cn(
              "flex items-center rounded-md text-left transition-colors",
              collapsed ? "size-10 justify-center" : "gap-3 px-3 py-2",
              selected
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <item.icon className="size-4 shrink-0" />
            {collapsed ? null : (
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{item.label}</span>
                <span className="block truncate text-xs opacity-70">{item.detail}</span>
              </span>
            )}
          </a>
        )
      })}
    </nav>
  )
}

export function ConsoleShell({
  api,
  initialSidebarCollapsed = false,
  initialView,
}: {
  api: LLMGatewayAPI
  initialSidebarCollapsed?: boolean
  initialView?: ConsoleView
}) {
  const queryClient = useQueryClient()
  const activeFetches = useIsFetching()
  const [selectedSetID, setSelectedSetID] = useState("")
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [activeView, setActiveView] = useState<ConsoleView>(() =>
    initialView || (typeof window === "undefined" ? "overview" : consoleViewFromPath(window.location.pathname)),
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed)
  const setsQuery = useQuery({
    queryKey: ["sets"],
    queryFn: () => api.listSets(),
  })
  const sets = setsQuery.data || []
  const selectedSet = sets.find((set) => set.id === selectedSetID) || sets[0]

  function invalidateSets() {
    return queryClient.invalidateQueries({ queryKey: ["sets"] })
  }
  const header = viewHeader(activeView, selectedSet)
  const sidebarToggleLabel = sidebarCollapsed ? "展开侧栏" : "折叠侧栏"
  const logoutMutation = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      if (typeof window !== "undefined") window.location.replace("/admin/login")
    },
  })

  useEffect(() => {
    if (initialView || typeof window === "undefined") return
    const handlePopState = () => setActiveView(consoleViewFromPath(window.location.pathname))
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [initialView])

  function navigate(view: ConsoleView) {
    if (typeof window !== "undefined") {
      window.history.pushState({}, "", consoleRouteForView(view))
    }
    setActiveView(view)
    setMobileNavigationOpen(false)
  }

  return (
    <main className="h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-screen">
        <aside
          id="llmgateway-sidebar"
          data-collapsed={sidebarCollapsed}
          className={cn(
            "hidden shrink-0 flex-col border-r border-border bg-background transition-[width] duration-200 ease-out lg:flex",
            sidebarCollapsed ? "w-16" : "w-60",
          )}
        >
          <div
            className={cn(
              "flex h-14 items-center border-b border-border",
              sidebarCollapsed ? "justify-center px-2" : "gap-3 px-3",
            )}
          >
            {sidebarCollapsed ? null : (
              <>
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Zap className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">LLM 平台</div>
                  <div className="truncate text-xs text-muted-foreground">多集群运营台</div>
                </div>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={sidebarToggleLabel}
              aria-expanded={!sidebarCollapsed}
              aria-controls="llmgateway-sidebar"
              title={sidebarToggleLabel}
              className={cn(sidebarCollapsed ? "mx-auto" : "ml-auto")}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            >
              {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          </div>
          <ConsoleNavigation activeView={activeView} collapsed={sidebarCollapsed} onNavigate={navigate} />
        </aside>

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Sheet open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen}>
                <SheetTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" aria-label="打开导航" className="lg:hidden">
                    <Menu />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-72 gap-0 p-0" showCloseButton={false}>
                  <SheetHeader className="flex h-16 flex-row items-center gap-3 border-b px-4 py-0 text-left">
                    <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                      <Zap className="size-4" />
                    </div>
                    <div>
                      <SheetTitle className="text-sm">LLM 平台</SheetTitle>
                      <SheetDescription className="text-xs">多集群运营台</SheetDescription>
                    </div>
                  </SheetHeader>
                  <ConsoleNavigation activeView={activeView} onNavigate={navigate} />
                </SheetContent>
              </Sheet>
              <div className="min-w-0">
                <Breadcrumb className="hidden md:block">
                  <BreadcrumbList className="gap-1 text-xs sm:gap-1">
                    <BreadcrumbItem>
                      <BreadcrumbLink href={consoleRouteForView("overview")} onClick={(event) => { event.preventDefault(); navigate("overview") }}>
                        LLM 平台
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem><BreadcrumbPage>{header.title}</BreadcrumbPage></BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
                <h1 className="truncate text-base font-semibold md:text-lg">{header.title}</h1>
                <p className="hidden truncate text-xs text-muted-foreground sm:block">{header.detail}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries()}>
                <RefreshCw className={cn(activeFetches > 0 && "animate-spin")} />
                刷新
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="退出登录"
                title={logoutMutation.isError ? "退出失败，请重试" : "退出登录"}
                disabled={logoutMutation.isPending}
                onClick={() => logoutMutation.mutate()}
              >
                {logoutMutation.isPending ? <Loader2 className="animate-spin" /> : <LogOut />}
                <span className="hidden sm:inline">退出</span>
              </Button>
            </div>
          </header>

          <ConsoleSectionTabs activeView={activeView} onNavigate={navigate} />

          {activeView === "tenants" ? (
            <TenantManagementPage
              api={api}
              sets={sets}
              initialUserID={typeof window === "undefined" ? "" : consoleTenantIDFromPath(window.location.pathname)}
            />
          ) : activeView === "jobs" ? (
            <BackgroundJobsPage api={api} />
          ) : activeView === "plans" ? (
            <PlanManagementPage api={api} sets={sets} />
          ) : activeView === "shards" ? (
            <ShardManagementPage api={api} />
		  ) : activeView === "versions" ? (
			<ReleaseManagementPage api={api} sets={sets} />
          ) : activeView === "resources" ? (
            <ResourceAdminPage api={api} />
          ) : activeView === "channels" ? (
            <ChannelManagementPage api={api} sets={sets} />
          ) : activeView === "traffic" ? (
            <TrafficProbePage api={api} />
          ) : activeView === "overview" ? (
            <OperatorOverviewPage api={api} />
          ) : (
            <SetControlPage
              api={api}
              sets={sets}
              setsQuery={setsQuery}
              selectedSet={selectedSet}
              selectedSetID={selectedSet?.id || ""}
              onSelectSet={setSelectedSetID}
              onChanged={invalidateSets}
            />
          )}
        </section>
      </div>
    </main>
  )
}

function ConsoleSectionTabs({ activeView, onNavigate }: { activeView: ConsoleView; onNavigate: (view: ConsoleView) => void }) {
  const items = (["channels", "plans"] as ConsoleView[]).includes(activeView)
    ? ([
        ["channels", "模型配置"],
        ["plans", "订阅权益"],
      ] as const)
    : (["sets", "versions", "shards"] as ConsoleView[]).includes(activeView)
      ? ([
          ["sets", "服务集群"],
		  ["versions", "版本发布"],
          ["shards", "数据分片"],
        ] as const)
      : (["jobs", "traffic", "resources"] as ConsoleView[]).includes(activeView)
        ? ([
            ["jobs", "异常任务"],
            ["traffic", "服务验证"],
            ["resources", "高级数据"],
          ] as const)
        : []

  if (items.length === 0) return null
  return (
    <nav aria-label="当前模块" className="flex shrink-0 items-center gap-1 border-b bg-background px-4 py-2 md:px-6">
      {items.map(([view, label]) => (
        <a
          key={view}
          href={consoleRouteForView(view)}
          aria-current={activeView === view ? "page" : undefined}
          onClick={(event) => {
            event.preventDefault()
            onNavigate(view)
          }}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm transition-colors",
            activeView === view ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </a>
      ))}
    </nav>
  )
}

function viewHeader(activeView: ConsoleView, selectedSet?: GatewaySet) {
  if (activeView === "overview") {
    return {
      title: "运营总览",
      detail: "值班第一屏，集中查看集群、渠道和告警",
    }
  }
  if (activeView === "tenants") {
    return {
      title: "租户与权益",
      detail: "查看用户归属、套餐、积分和密钥",
    }
  }
  if (activeView === "plans") {
    return {
      title: "订阅权益",
      detail: "查看权益模板及其在各服务集群的下发状态",
    }
  }
  if (activeView === "jobs") {
    return {
      title: "自动任务",
      detail: "查看自动化运行状态和需要重试的失败任务",
    }
  }
  if (activeView === "channels") {
    return {
      title: "模型配置",
      detail: "维护生产配置、版本和集群发布状态",
    }
  }
  if (activeView === "shards") {
    return {
      title: "容量与集群",
      detail: "查看数据分片容量和服务集群归属",
    }
  }
	if (activeView === "versions") {
		return {
			title: "版本发布",
			detail: "按发布环逐个升级服务集群",
		}
	}
  if (activeView === "traffic") {
    return {
      title: "服务验证",
      detail: "用平台入口发起一次真实模型请求",
    }
  }
  if (activeView === "resources") {
    return {
      title: "故障排查",
      detail: "面向高级排障的受控数据维护",
    }
  }
  return {
    title: "容量与集群",
    detail: selectedSet ? `${selectedSet.name || selectedSet.id} · ${selectedSet.base_url}` : "请选择一个集群",
  }
}

function DashboardSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}

export function OperatorOverviewPage({ api }: { api: LLMGatewayAPI }) {
  const overviewQuery = useQuery({
    queryKey: ["operator-overview"],
    queryFn: () => api.getOverview(),
  })
  const overview = overviewQuery.data
  const totals = overview?.totals
  const readySets = totals?.ready_sets ?? (overview?.sets || []).filter((set) => set.ready).length
  const unavailableSets = Math.max(0, (totals?.sets || 0) - readySets)
  const alerts = overview?.alerts || []

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-auto bg-muted/20 p-4 md:p-6">
      <Card className="shadow-none">
        <CardContent className="grid p-0 sm:grid-cols-2 xl:grid-cols-4">
          {overviewQuery.isLoading ? (
            Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-24 animate-pulse border-b bg-muted/40 sm:border-r xl:border-b-0" />)
          ) : (
            <>
              <OverviewStat icon={<Layers3 />} label="服务集群" value={`${readySets} / ${totals?.sets || 0} 可用`} attention={unavailableSets > 0} />
              <OverviewStat icon={<UsersRound />} label="可用用户容量" value={formatNumber(totals?.available_user_slots ?? 0)} />
              <OverviewStat icon={<SlidersHorizontal />} label="配置漂移" value={String(totals?.channel_drifts ?? 0)} attention={(totals?.channel_drifts ?? 0) > 0} />
              <OverviewStat icon={<ListChecks />} label="待处理" value={String(alerts.length)} attention={alerts.length > 0} last />
            </>
          )}
        </CardContent>
      </Card>

      {overviewQuery.error ? (
        <Card>
          <CardHeader>
            <CardTitle>无法加载运营总览</CardTitle>
            <CardDescription>{overviewQuery.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <OperationalAlertsCard overview={overview} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <OperationalSetsCard overview={overview} loading={overviewQuery.isLoading} />
        <OperationalChannelBundlesCard overview={overview} />
      </div>
    </div>
  )
}

function OverviewStat({ icon, label, value, attention = false, last = false }: { icon: ReactNode; label: string; value: string; attention?: boolean; last?: boolean }) {
  return (
    <div className={cn("flex min-h-24 items-center gap-4 border-b px-5 py-4 sm:border-r xl:border-b-0", last && "sm:border-r-0")}>
      <div className="text-primary [&_svg]:size-7">{icon}</div>
      <div className="min-w-0">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className={cn("mt-1 truncate text-2xl font-semibold", attention && "text-destructive")}>{value}</div>
      </div>
    </div>
  )
}

type BackgroundJobsTab = "scheduled" | "queues" | "cleanup"

export function BackgroundJobsPage({
  api,
  initialTab = "scheduled",
}: {
  api: LLMGatewayAPI
  initialTab?: BackgroundJobsTab
}) {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<BackgroundJobsTab>(initialTab)
  const jobsQuery = useQuery({
    queryKey: ["background-jobs"],
    queryFn: () => api.getBackgroundJobs(),
  })
  const runJob = useMutation({
    mutationFn: (name: string) => api.runJob(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["background-jobs"] }),
  })
  const retryBYOK = useMutation({
    mutationFn: () => api.retryFailedBYOKSync(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["background-jobs"] }),
  })
  const tenantDeletionsQuery = useQuery({
    queryKey: ["tenant-deletions"],
    queryFn: () => api.listTenantDeletions(),
  })
  const setDecommissionsQuery = useQuery({
    queryKey: ["set-decommissions"],
    queryFn: () => api.listSetDecommissions(),
  })
  const overview = jobsQuery.data
  const scheduledFailures = (overview?.jobs || []).filter((job) => Boolean(job.last_error)).length
  const queueOpen =
    (overview?.byok_sync?.total_open || 0) +
    (overview?.observations?.due || 0) +
    (overview?.observations?.running || 0) +
    (overview?.observations?.error || 0)
  const cleanupOpen =
    (tenantDeletionsQuery.data || []).filter((job) => !["succeeded", "cancelled"].includes(job.status)).length +
    (setDecommissionsQuery.data || []).filter((job) => !["succeeded", "cancelled"].includes(job.status)).length

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-muted/20 p-4 md:p-6">
      <DashboardSection title="自动任务" description="按任务类型查看运行状态、积压和失败重试">
        {jobsQuery.error ? (
          <Card>
            <CardHeader>
              <CardTitle>无法加载任务状态</CardTitle>
              <CardDescription>{jobsQuery.error.message}</CardDescription>
            </CardHeader>
          </Card>
        ) : null}
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as BackgroundJobsTab)}
          className="min-w-0 gap-4"
        >
          <TabsList className="w-full justify-start overflow-x-auto sm:w-fit">
            <TabsTrigger value="scheduled">
              调度任务
              {scheduledFailures > 0 ? <Badge variant="destructive">{scheduledFailures}</Badge> : null}
            </TabsTrigger>
            <TabsTrigger value="queues">
              同步队列
              {queueOpen > 0 ? <Badge variant="secondary">{formatNumber(queueOpen)}</Badge> : null}
            </TabsTrigger>
            <TabsTrigger value="cleanup">
              清理任务
              {cleanupOpen > 0 ? <Badge variant="secondary">{formatNumber(cleanupOpen)}</Badge> : null}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="scheduled" className="min-w-0">
            {activeTab === "scheduled" ? (
              <OperationalJobsCard
                jobs={overview?.jobs || []}
                loading={jobsQuery.isLoading}
                generatedAt={overview?.generated_at}
                pendingJobName={runJob.variables}
                pending={runJob.isPending}
                error={runJob.error?.message}
                onRun={(name) => runJob.mutate(name)}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="queues" className="min-w-0">
            {activeTab === "queues" ? (
              <div className="grid gap-4 xl:grid-cols-2">
                <OperationalBYOKSyncCard
                  stats={overview?.byok_sync}
                  pending={retryBYOK.isPending}
                  error={retryBYOK.error?.message}
                  onRetry={() => retryBYOK.mutate()}
                />
                <OperationalObservationCard stats={overview?.observations} />
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="cleanup" className="min-w-0">
            {activeTab === "cleanup" ? (
              <DeletionOperationsCard
                tenantJobs={tenantDeletionsQuery.data || []}
                setJobs={setDecommissionsQuery.data || []}
                loading={tenantDeletionsQuery.isLoading || setDecommissionsQuery.isLoading}
                error={tenantDeletionsQuery.error?.message || setDecommissionsQuery.error?.message}
              />
            ) : null}
          </TabsContent>
        </Tabs>
      </DashboardSection>
    </div>
  )
}

function DeletionOperationsCard({
  tenantJobs,
  setJobs,
  loading,
  error,
}: {
  tenantJobs: TenantDeletionJob[]
  setJobs: SetDecommissionJob[]
  loading: boolean
  error?: string
}) {
  const openTenantJobs = tenantJobs.filter((job) => !["succeeded", "cancelled"].includes(job.status))
  const openSetJobs = setJobs.filter((job) => !["succeeded", "cancelled"].includes(job.status))
  return (
    <DashboardSection title="清理任务" description="查看用户删除和空集群注销的执行进度">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="border-b">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>用户删除任务</CardTitle>
                <CardDescription>先冻结用户写入，再清理密钥、权益和本地投影</CardDescription>
              </div>
              <Badge variant="secondary">{openTenantJobs.length} 个待处理</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? <div className="h-24 bg-muted" /> : openTenantJobs.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">没有待处理的用户删除任务。</div>
            ) : (
              <div className="divide-y">
                {openTenantJobs.slice(0, 20).map((job) => (
                  <div key={job.id} className="flex items-start justify-between gap-3 p-4 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{job.id}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        已完成 {formatNumber(job.success_count || 0)} / {formatNumber(job.target_count || 0)}
                        {job.failure_count ? ` · 失败 ${formatNumber(job.failure_count)}` : ""}
                      </div>
                      {job.last_error ? <div className="mt-1 truncate text-xs text-destructive">{job.last_error}</div> : null}
                    </div>
                    <DeletionStatusBadge status={job.status} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="border-b">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>空集群注销任务</CardTitle>
                <CardDescription>移除运行时后再清理专属 MySQL 数据库和 Redis DB</CardDescription>
              </div>
              <Badge variant="secondary">{openSetJobs.length} 个待处理</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? <div className="h-24 bg-muted" /> : openSetJobs.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">没有待处理的集群注销任务。</div>
            ) : (
              <div className="divide-y">
                {openSetJobs.slice(0, 20).map((job) => (
                  <div key={job.id} className="flex items-start justify-between gap-3 p-4 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{job.set_id}</div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">{job.id}</div>
                      {job.last_error ? <div className="mt-1 truncate text-xs text-destructive">{job.last_error}</div> : null}
                    </div>
                    <DeletionStatusBadge status={job.status} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </DashboardSection>
  )
}

function OperationalObservationCard({ stats }: { stats?: TenantObservationQueueStats }) {
  const due = stats?.due ?? 0
  const running = stats?.running ?? 0
  const error = stats?.error ?? 0
  const blocked = stats?.blocked ?? 0
  const unsettled = due + running + error
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>租户观测队列</CardTitle>
            <CardDescription>后台刷新余额、订阅和当前套餐投影</CardDescription>
          </div>
          <Badge variant={error > 0 ? "destructive" : unsettled > 0 ? "secondary" : "outline"}>
            {unsettled > 0 ? `${formatNumber(unsettled)} 个待收敛` : "已收敛"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="grid grid-cols-4 gap-2 text-xs">
          <StateField label="到期" value={formatNumber(due)} />
          <StateField label="处理中" value={formatNumber(running)} />
          <StateField label="失败" value={formatNumber(error)} />
          <StateField label="暂缓" value={formatNumber(blocked)} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <StateField label="最老等待" value={formatDurationSeconds(stats?.oldest_due_age_seconds || 0)} />
          <StateField label="过期租约" value={formatNumber(stats?.expired_running_leases || 0)} />
          <StateField label="最近一次观测成功" value={formatDateTime(stats?.last_success_at)} />
          <StateField label="最近一次观测失败" value={formatDateTime(stats?.last_failure_at)} />
        </div>
      </CardContent>
    </Card>
  )
}

function OperationalBYOKSyncCard({
  stats,
  pending,
  error,
  onRetry,
}: {
  stats?: BYOKSyncQueueStats
  pending: boolean
  error?: string
  onRetry: () => void
}) {
  const pendingCount = stats?.pending ?? 0
  const runningCount = stats?.running ?? 0
  const errorCount = stats?.error ?? 0
  const totalOpen = stats?.total_open ?? pendingCount + runningCount + errorCount
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>BYOK 同步队列</CardTitle>
            <CardDescription>用户自带 Key 的异步下发状态</CardDescription>
          </div>
          <Badge variant={errorCount > 0 ? "destructive" : totalOpen > 0 ? "secondary" : "outline"}>
            {totalOpen > 0 ? `${formatNumber(totalOpen)} 个待收敛` : "已收敛"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <StateField label="待处理" value={formatNumber(pendingCount)} />
          <StateField label="处理中" value={formatNumber(runningCount)} />
          <StateField label="失败" value={formatNumber(errorCount)} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <StateField label="最老等待" value={formatDurationSeconds(stats?.oldest_pending_age_seconds || 0)} />
          <StateField label="过期租约" value={formatNumber(stats?.expired_running_leases || 0)} />
          <StateField label="最近一次同步成功" value={formatDateTime(stats?.last_success_at)} />
          <StateField label="最近一次同步失败" value={formatDateTime(stats?.last_failure_at)} />
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={pending || errorCount === 0}>
          {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          重试失败项
        </Button>
      </CardContent>
    </Card>
  )
}

function OperationalSetsCard({ overview, loading }: { overview?: OperationalOverview; loading: boolean }) {
  const sets = overview?.sets || []
  const attentionSets = sets.filter((set) =>
    !set.ready ||
    Boolean(set.last_error || set.admission_error || set.runtime_ha_error) ||
    (set.runtime_ha_desired_replicas || 0) > 0 && set.runtime_ha_status !== "healthy" ||
    ["warning", "warn", "full", "critical"].includes(set.capacity_status || "") ||
    set.accepting_new_users === false,
  )
  const healthyCount = Math.max(0, sets.length - attentionSets.length)
  return (
    <Card className="min-w-0 shadow-none">
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>容量水位</CardTitle>
            <CardDescription>只展开不可用、不可接入或接近水位的服务集群</CardDescription>
          </div>
          <Badge variant="outline">{sets.length} 个服务集群</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="flex flex-col gap-2 p-4">
            <div className="h-12 rounded-lg bg-muted" />
            <div className="h-12 rounded-lg bg-muted" />
          </div>
        ) : sets.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">暂无集群状态。</div>
        ) : attentionSets.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">全部 {sets.length} 个服务集群运行正常</div>
        ) : (
          <>
            <Table className="min-w-[620px]">
              <TableHeader className="text-xs text-muted-foreground">
                <TableRow>
                  <TableHead className="px-4">服务集群</TableHead>
                  <TableHead className="px-4">用户</TableHead>
                  <TableHead className="px-4">水位</TableHead>
                  <TableHead className="px-4">状态</TableHead>
                  <TableHead className="px-4">最近问题</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attentionSets.map((set) => (
                  <TableRow key={set.id}>
                    <TableCell className="px-4 py-3">
                      <div className="font-medium">{set.name || set.id}</div>
                      <div className="text-xs text-muted-foreground">{set.id}</div>
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      {formatNumber(set.user_count)}{set.max_users ? ` / ${formatNumber(set.max_users)}` : ""}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      {set.max_users ? formatPercent(set.user_count / set.max_users) : "-"}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <StatusBadge status={set.status} setup={set.setup} />
                        <RuntimeHAStatusBadge
                          status={set.runtime_ha_status}
                          ready={set.runtime_ha_ready_replicas}
                          desired={set.runtime_ha_desired_replicas}
                        />
                        <CapacityStatusBadge status={set.capacity_status} accepting={set.accepting_new_users} />
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[260px] px-4 py-3">
                      <span className={cn("block truncate", set.last_error ? "text-destructive" : "text-muted-foreground")}>
                        {set.runtime_ha_error || set.last_error || set.admission_error || "-"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {healthyCount > 0 ? <div className="border-t px-4 py-3 text-center text-sm text-muted-foreground">其余 {healthyCount} 个服务集群运行正常</div> : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function OperationalChannelBundlesCard({ overview }: { overview?: OperationalOverview }) {
  const bundles = overview?.channel_bundles || []
  const attentionBundles = bundles.filter((bundle) => bundle.pending_sets > 0 || bundle.drift_sets > 0 || bundle.error_sets > 0)
  return (
    <Card className="min-w-0 shadow-none">
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>配置状态</CardTitle>
            <CardDescription>仅展示待发布、漂移或失败的配置</CardDescription>
          </div>
          <Badge variant="secondary">{bundles.length} 个模板</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-4">
        {bundles.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无模型配置。</div>
        ) : attentionBundles.length === 0 ? (
          <div className="text-sm text-muted-foreground">全部配置已同步到目标集群。</div>
        ) : (
          attentionBundles.map((bundle) => (
            <div key={bundle.bundle_id} className="border-b py-3 last:border-b-0">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <a href={consoleRouteForView("channels")} className="truncate text-sm font-medium hover:underline">{bundle.name}</a>
                  <div className="truncate text-xs text-muted-foreground">{bundle.bundle_id}</div>
                </div>
                <ChannelSyncBadge status={bundle.error_sets > 0 ? "error" : bundle.drift_sets > 0 ? "drift" : "synced"} />
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                <StateField label="已一致" value={String(bundle.synced_sets || 0)} />
                <StateField label="待发布" value={String(bundle.pending_sets || 0)} />
                <StateField label="有漂移" value={String(bundle.drift_sets || 0)} />
                <StateField label="失败" value={String(bundle.error_sets || 0)} />
              </div>
              {bundle.last_error ? <p className="mt-2 text-xs text-destructive">{bundle.last_error}</p> : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function OperationalAlertsCard({ overview }: { overview?: OperationalOverview }) {
  const alerts = overview?.alerts || []
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b">
        <CardTitle>需要处理</CardTitle>
        <CardDescription>只保留当前仍需要人工判断或干预的问题</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-4">
        {alerts.length === 0 ? (
          <div className="py-2 text-sm text-muted-foreground">没有需要处理的问题。</div>
        ) : (
          alerts.slice(0, 8).map((alert, index) => (
            <a
              key={`${alert.kind}:${alert.set_id || alert.bundle_id || alert.job_name || index}`}
              href={consoleRouteForAlert(alert.kind)}
              className="block"
            >
              <Alert variant={alert.severity === "critical" ? "destructive" : "default"} className="transition-colors hover:bg-muted/40">
                <TriangleAlert />
                <AlertTitle className="flex items-center justify-between gap-2">
                  <span>{friendlyAlertKind(alert.kind)}</span>
                  <Badge variant={alert.severity === "critical" ? "destructive" : "secondary"}>{friendlySeverity(alert.severity)}</Badge>
                </AlertTitle>
                <AlertDescription>
                  <p>{alert.message}</p>
                  <span className="text-xs">{alert.set_id || alert.bundle_id || alert.job_name || "-"}</span>
                </AlertDescription>
              </Alert>
            </a>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function OperationalJobsCard({
  jobs,
  loading,
  generatedAt,
  pendingJobName,
  pending,
  error,
  onRun,
}: {
  jobs: WorkerJob[]
  loading: boolean
  generatedAt?: string
  pendingJobName?: string
  pending: boolean
  error?: string
  onRun: (name: string) => void
}) {
  const actionableJobs = jobs.filter((job) => Boolean(job.last_error) || ["error", "running"].includes(job.status || ""))
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>异常任务</CardTitle>
            <CardDescription>健康任务已折叠，只展示失败或仍在运行的任务</CardDescription>
          </div>
          <span className="text-xs text-muted-foreground">更新于 {formatDateTime(generatedAt)}</span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="flex flex-col gap-2 p-4">
            <div className="h-10 rounded-lg bg-muted" />
            <div className="h-10 rounded-lg bg-muted" />
          </div>
        ) : actionableJobs.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">全部 {jobs.length} 个调度任务运行正常</div>
        ) : (
          <Table className="min-w-[680px]">
              <TableHeader className="text-xs text-muted-foreground">
                <TableRow>
                  <TableHead className="px-4">任务</TableHead>
                  <TableHead className="px-4">状态</TableHead>
                  <TableHead className="px-4">最近成功</TableHead>
                  <TableHead className="px-4">当前问题</TableHead>
                  <TableHead className="px-4 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {actionableJobs.map((job) => (
                  <TableRow key={job.name}>
                    <TableCell className="max-w-[260px] px-4 py-3">
                      <div className="truncate font-medium">{friendlyJobName(job.name)}</div>
                      <div className="truncate text-xs text-muted-foreground">{job.name}</div>
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <Badge variant={job.last_error ? "destructive" : "secondary"}>{friendlyJobStatus(job.status)}</Badge>
                    </TableCell>
                    <TableCell className="px-4 py-3 text-xs text-muted-foreground">{formatDateTime(job.last_success_at)}</TableCell>
                    <TableCell className="max-w-[260px] px-4 py-3">
                      <div className={cn("truncate text-xs", job.last_error ? "text-destructive" : "text-muted-foreground")} title={job.last_error}>
                        {job.last_error || "任务仍在执行"}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onRun(job.name)}
                        disabled={pending && pendingJobName === job.name}
                      >
                        {pending && pendingJobName === job.name ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        {job.last_error || job.status === "error" ? "重试" : "重新运行"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
        )}
        {error ? <p className="p-4 text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  )
}

function SetControlPage({
  api,
  sets,
  setsQuery,
  selectedSet,
  selectedSetID,
  onSelectSet,
  onChanged,
}: {
  api: LLMGatewayAPI
  sets: GatewaySet[]
  setsQuery: ReturnType<typeof useQuery<GatewaySet[]>>
  selectedSet?: GatewaySet
  selectedSetID: string
  onSelectSet: (id: string) => void
  onChanged: () => Promise<unknown>
}) {
  return (
    <div className="flex flex-1 flex-col gap-5 overflow-auto bg-muted/20 p-4 md:p-6">
      <details className="rounded-md border bg-background">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">容量策略</summary>
        <div className="border-t p-4"><CapacityWatermarkPanel api={api} sets={sets} /></div>
      </details>

      {setsQuery.error ? (
        <Card>
          <CardHeader>
            <CardTitle>无法加载集群</CardTitle>
            <CardDescription>{setsQuery.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <DashboardSection title="集群工作台" description="查看自动管理的存量 Set，并打开对应的原生控制台">
        <div className="grid min-h-[720px] gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
          <div className="order-2 min-w-0 xl:order-1">
            <SetList
              api={api}
              sets={sets}
              loading={setsQuery.isLoading}
              selectedSetID={selectedSetID}
              onSelect={onSelectSet}
              onChanged={onChanged}
            />
          </div>

          <div className="order-1 min-w-0 xl:order-2">
            {selectedSet ? (
              <SetWorkspace api={api} set={selectedSet} />
            ) : (
              <EmptyWorkspace />
            )}
          </div>
        </div>
      </DashboardSection>
    </div>
  )
}

function CapacityWatermarkPanel({ api, sets }: { api: LLMGatewayAPI; sets: GatewaySet[] }) {
  const [source, setSource] = useState("kro")
  const [namespace, setNamespace] = useState("llmgateway-kro-demo")
  const [fleet, setFleet] = useState("fleet-demo")
  const [maxUsersPerSet, setMaxUsersPerSet] = useState("10000")
  const [targetPercent, setTargetPercent] = useState("70")
  const [minReadyFreeUsers, setMinReadyFreeUsers] = useState("3000")
  const [maxScaleUpPerCycle, setMaxScaleUpPerCycle] = useState("1")
  const canReconcile = namespace.trim() !== "" && fleet.trim() !== ""
  const capacityCheck = useMutation<SetCapacityResult>({
    mutationFn: () =>
      api.reconcileSetCapacity({
        source: source.trim() || "kro",
        namespace: namespace.trim(),
        fleet: fleet.trim(),
        max_users_per_set: numberInput(maxUsersPerSet, 10000),
        target_utilization: percentInput(targetPercent, 70),
        min_ready_free_users: numberInput(minReadyFreeUsers, 3000),
        max_scale_up_per_cycle: numberInput(maxScaleUpPerCycle, 1),
      }),
  })
  const result = capacityCheck.data

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="size-4" />
              用户容量策略
            </CardTitle>
            <CardDescription>水线低于预期时只写入扩容意图，由 set-manager 后续创建新 Set</CardDescription>
          </div>
          <Badge variant="secondary">{sets.length} 个服务集群</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 pt-4 xl:grid-cols-[420px_minmax(0,1fr)]">
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (canReconcile) {
              capacityCheck.mutate()
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="编排来源">
              <Input value={source} onChange={(event) => setSource(event.target.value)} />
            </Field>
            <Field label="集群组">
              <Input value={fleet} onChange={(event) => setFleet(event.target.value)} />
            </Field>
          </div>
          <Field label="命名空间">
            <Input value={namespace} onChange={(event) => setNamespace(event.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="单 Set 用户上限">
              <Input
                inputMode="numeric"
                value={maxUsersPerSet}
                onChange={(event) => setMaxUsersPerSet(event.target.value)}
              />
            </Field>
            <Field label="目标使用率">
              <Input
                inputMode="decimal"
                value={targetPercent}
                onChange={(event) => setTargetPercent(event.target.value)}
              />
            </Field>
            <Field label="最低预留用户位">
              <Input
                inputMode="numeric"
                value={minReadyFreeUsers}
                onChange={(event) => setMinReadyFreeUsers(event.target.value)}
              />
            </Field>
            <Field label="单轮最多扩容">
              <Input
                inputMode="numeric"
                value={maxScaleUpPerCycle}
                onChange={(event) => setMaxScaleUpPerCycle(event.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            扩容不会搬迁存量用户，只影响后续新用户分配；目标使用率按百分数填写。
          </p>
          <Button type="submit" disabled={!canReconcile || capacityCheck.isPending}>
            {capacityCheck.isPending ? <Loader2 className="animate-spin" /> : <Gauge />}
            检查并生成扩容意图
          </Button>
          {capacityCheck.error ? <p className="text-sm text-destructive">{capacityCheck.error.message}</p> : null}
        </form>

        <CapacityWatermarkResult result={result} />
      </CardContent>
    </Card>
  )
}

function CapacityWatermarkResult({ result }: { result?: SetCapacityResult }) {
  if (!result) {
    return (
      <div className="grid min-h-64 place-items-center rounded-lg border border-dashed">
        <div className="max-w-sm px-6 text-center">
          <Gauge className="mx-auto size-8 text-muted-foreground" />
          <div className="mt-3 text-sm font-medium">等待检查</div>
          <p className="mt-1 text-sm text-muted-foreground">提交后会看到当前空位、缺口和本轮新增的扩容意图。</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
        <StateField label="规划空位" value={formatNumber(result.capacity_free_users ?? result.ready_free_users)} />
        <StateField label="目标空位" value={formatNumber(result.required_free_users)} />
        <StateField label="缺口" value={formatNumber(Math.max(result.deficit_users, 0))} />
        <StateField label="新增意图" value={`${formatNumber(result.created_requests)} 个`} />
      </div>
      <div className="overflow-auto rounded-lg border">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="border-b text-xs text-muted-foreground">
            <tr>
              <th className="h-10 px-4 font-medium">Set</th>
              <th className="h-10 px-4 font-medium">状态</th>
              <th className="h-10 px-4 font-medium">准入</th>
              <th className="h-10 px-4 font-medium">用户数</th>
              <th className="h-10 px-4 font-medium">可用用户位</th>
              <th className="h-10 px-4 font-medium">使用率</th>
            </tr>
          </thead>
          <tbody>
            {result.sets.map((set) => (
              <tr key={set.set_id} className="border-b last:border-0">
                <td className="px-4 py-3 font-mono text-xs">{set.set_id}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={set.status} setup={set.ready} />
                </td>
                <td className="px-4 py-3">
                  <CapacityStatusBadge status={set.capacity_status} accepting={set.accepting_new_users} />
                </td>
                <td className="px-4 py-3">
                  {formatNumber(set.user_count)} / {formatNumber(set.max_users)}
                </td>
                <td className="px-4 py-3">{formatNumber(set.free_users)}</td>
                <td className="px-4 py-3">{formatUtilizationValue(set.utilization)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.requests.length > 0 ? (
        <div className="rounded-lg border bg-muted/30 p-3 text-xs">
          <div className="font-medium">本轮扩容意图</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {result.requests.map((request) => (
              <Badge key={request.id} variant="secondary">
                {request.set_id}
              </Badge>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">当前空位满足水线，没有新增扩容意图。</p>
      )}
    </div>
  )
}

function numberInput(value: string, fallback: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.floor(parsed)
}

function percentInput(value: string, fallbackPercent: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackPercent / 100
  }
  if (parsed > 1) {
    return parsed / 100
  }
  return parsed
}

function formatUtilizationValue(value: string) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return value || "-"
  }
  return `${Math.round(parsed * 1000) / 10}%`
}

export function ReleaseManagementPage({ api, sets }: { api: LLMGatewayAPI; sets: GatewaySet[] }) {
  const queryClient = useQueryClient()
  const releasesQuery = useQuery({ queryKey: ["newapi-releases"], queryFn: () => api.listNewAPIReleases() })
  const ringsQuery = useQuery({ queryKey: ["release-rings"], queryFn: () => api.listReleaseRings(), refetchInterval: 5000 })
  const rolloutsQuery = useQuery({ queryKey: ["release-rollouts"], queryFn: () => api.listReleaseRollouts(), refetchInterval: 5000 })
  const campaignsQuery = useQuery({ queryKey: ["release-campaigns"], queryFn: () => api.listReleaseCampaigns(), refetchInterval: 5000 })
  const releases = releasesQuery.data || []
  const rings = ringsQuery.data || []
  const rollouts = rolloutsQuery.data || []
  const campaigns = campaignsQuery.data || []
  const [releaseID, setReleaseID] = useState("")
  const [releaseVersion, setReleaseVersion] = useState("")
  const [releaseImage, setReleaseImage] = useState("")
  const [ringID, setRingID] = useState("stable")
  const [ringName, setRingName] = useState("Stable")
  const [ringReleaseID, setRingReleaseID] = useState("")
  const [ringSetIDs, setRingSetIDs] = useState<string[]>([])
  const [rolloutRingID, setRolloutRingID] = useState("")
  const [rolloutReleaseID, setRolloutReleaseID] = useState("")
  const [campaignReleaseID, setCampaignReleaseID] = useState("")
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["newapi-releases"] }),
      queryClient.invalidateQueries({ queryKey: ["release-rings"] }),
      queryClient.invalidateQueries({ queryKey: ["release-rollouts"] }),
      queryClient.invalidateQueries({ queryKey: ["release-campaigns"] }),
      queryClient.invalidateQueries({ queryKey: ["sets"] }),
    ])
  }
  const createRelease = useMutation({
    mutationFn: () => api.createNewAPIRelease({ id: releaseID.trim(), version: releaseVersion.trim(), image: releaseImage.trim() }),
    onSuccess: async (release) => {
      setReleaseID("")
      setReleaseVersion("")
      setReleaseImage("")
      setRingReleaseID((current) => current || release.id)
      setRolloutReleaseID((current) => current || release.id)
      setCampaignReleaseID((current) => current || release.id)
      await refresh()
    },
  })
  const saveRing = useMutation({
    mutationFn: () => api.upsertReleaseRing({
      id: ringID.trim(), name: ringName.trim(), ordinal: ringID === "canary" ? 0 : ringID === "early" ? 10 : 20,
      serving_release_id: ringReleaseID, admission_enabled: ringID === "stable", set_ids: ringSetIDs,
    }),
    onSuccess: refresh,
  })
  const createRollout = useMutation({
    mutationFn: () => api.createReleaseRollout({ ring_id: rolloutRingID, target_release_id: rolloutReleaseID }),
    onSuccess: refresh,
  })
  const createCampaign = useMutation({
    mutationFn: () => api.createReleaseCampaign({ target_release_id: campaignReleaseID }),
    onSuccess: refresh,
  })
  const pauseCampaign = useMutation({
    mutationFn: (campaignID: string) => api.pauseReleaseCampaign(campaignID),
    onSuccess: refresh,
  })
  const resumeCampaign = useMutation({
    mutationFn: (campaignID: string) => api.resumeReleaseCampaign(campaignID),
    onSuccess: refresh,
  })
  const error = releasesQuery.error?.message || ringsQuery.error?.message || rolloutsQuery.error?.message || campaignsQuery.error?.message ||
    createRelease.error?.message || saveRing.error?.message || createRollout.error?.message || createCampaign.error?.message ||
    pauseCampaign.error?.message || resumeCampaign.error?.message

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-muted/20 p-4 md:p-6">
      <DashboardSection title="全量发布" description="Canary → Early → Stable；每个发布环完成完整观察期并通过健康门禁后，才进入下一环">
        <Card>
          <CardContent className="flex flex-col gap-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <Field label="目标版本">
                <select className="h-9 min-w-72 rounded-md border bg-background px-3 text-sm" value={campaignReleaseID} onChange={(event) => setCampaignReleaseID(event.target.value)}>
                  <option value="">请选择已验证版本</option>
                  {releases.filter((release) => ["verified", "stable"].includes(release.status)).map((release) => <option key={release.id} value={release.id}>{release.version} · {release.id}</option>)}
                </select>
              </Field>
              <Button onClick={() => createCampaign.mutate()} disabled={!campaignReleaseID || createCampaign.isPending}>
                <Route />启动全量发布
              </Button>
            </div>
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader><TableRow><TableHead className="px-4">目标版本</TableHead><TableHead className="px-4">发布进度</TableHead><TableHead className="px-4">当前发布环</TableHead><TableHead className="px-4">状态</TableHead><TableHead className="px-4 text-right">操作</TableHead></TableRow></TableHeader>
                <TableBody>
                  {campaigns.map((campaign) => (
                    <TableRow key={campaign.id}>
                      <TableCell className="px-4"><div className="font-medium">{campaign.target_release_id}</div><div className="font-mono text-xs text-muted-foreground">{campaign.id}</div></TableCell>
                      <TableCell className="px-4"><div>{campaign.completed_rings} / {campaign.total_rings} 个发布环</div><div className="text-xs text-muted-foreground">{campaign.rings.map((ring) => ring.ring_id).join(" → ")}</div></TableCell>
                      <TableCell className="px-4">{campaign.current_ring_id || "-"}</TableCell>
                      <TableCell className="max-w-80 px-4"><ReleaseStatusBadge status={campaign.status} />{campaign.last_error ? <div className="mt-1 truncate text-xs text-destructive" title={campaign.last_error}>{campaign.last_error}</div> : null}</TableCell>
                      <TableCell className="px-4 text-right">
                        {campaign.status === "paused" ? <Button variant="outline" size="sm" onClick={() => resumeCampaign.mutate(campaign.id)} disabled={resumeCampaign.isPending}><Play />恢复发布</Button> : null}
                        {["pending", "running", "soaking"].includes(campaign.status) ? <Button variant="outline" size="sm" onClick={() => pauseCampaign.mutate(campaign.id)} disabled={pauseCampaign.isPending}><CirclePause />暂停</Button> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!campaignsQuery.isLoading && campaigns.length === 0 ? <TableRow><TableCell colSpan={5} className="h-20 text-center text-muted-foreground">暂无全量发布任务</TableCell></TableRow> : null}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </DashboardSection>

      <DashboardSection title="发布环" description="不同发布环可以同时运行不同版本；每个发布环内部逐个升级集群">
        <div className="overflow-hidden rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4">发布环</TableHead>
                <TableHead className="px-4">当前版本</TableHead>
                <TableHead className="px-4">目标版本</TableHead>
                <TableHead className="px-4">集群</TableHead>
                <TableHead className="px-4">状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rings.map((ring) => (
                <TableRow key={ring.id}>
                  <TableCell className="px-4"><div className="font-medium">{ring.name}</div><div className="text-xs text-muted-foreground">{ring.id}</div></TableCell>
                  <TableCell className="px-4 font-mono text-xs">{ring.serving_release_id}</TableCell>
                  <TableCell className="px-4 font-mono text-xs">{ring.target_release_id || "-"}</TableCell>
                  <TableCell className="px-4">{formatNumber(ring.set_count)}</TableCell>
                  <TableCell className="px-4"><ReleaseStatusBadge status={ring.status} /></TableCell>
                </TableRow>
              ))}
              {!ringsQuery.isLoading && rings.length === 0 ? <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">尚未建立发布环</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </div>
      </DashboardSection>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>登记版本</CardTitle><CardDescription>镜像必须固定到不可变 digest</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Field label="版本 ID"><Input value={releaseID} onChange={(event) => setReleaseID(event.target.value)} placeholder="newapi-20260716" /></Field>
            <Field label="版本号"><Input value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} placeholder="v0.9.8" /></Field>
            <Field label="镜像 digest"><Input value={releaseImage} onChange={(event) => setReleaseImage(event.target.value)} placeholder="registry/new-api@sha256:..." /></Field>
            <Button onClick={() => createRelease.mutate()} disabled={!releaseID.trim() || !releaseVersion.trim() || !releaseImage.trim() || createRelease.isPending}><Plus />登记版本</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>建立发布环</CardTitle><CardDescription>选择固定服务集群组成长期发布波次</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Field label="发布环"><select className="h-9 rounded-md border bg-background px-3 text-sm" value={ringID} onChange={(event) => { setRingID(event.target.value); setRingName(event.target.selectedOptions[0]?.text || event.target.value) }}><option value="canary">Canary</option><option value="early">Early</option><option value="stable">Stable</option></select></Field>
            <Field label="当前版本"><select className="h-9 rounded-md border bg-background px-3 text-sm" value={ringReleaseID} onChange={(event) => setRingReleaseID(event.target.value)}><option value="">请选择版本</option>{releases.map((release) => <option key={release.id} value={release.id}>{release.version} · {release.id}</option>)}</select></Field>
            <div className="max-h-40 overflow-auto rounded-md border p-2">
              {sets.map((set) => <label key={set.id} className="flex items-center gap-2 px-2 py-1.5 text-sm"><input type="checkbox" checked={ringSetIDs.includes(set.id)} onChange={(event) => setRingSetIDs((current) => event.target.checked ? [...current, set.id] : current.filter((id) => id !== set.id))} /><span className="truncate">{set.name || set.id}</span></label>)}
              {sets.length === 0 ? <div className="p-2 text-sm text-muted-foreground">暂无服务集群</div> : null}
            </div>
            <Button onClick={() => saveRing.mutate()} disabled={!ringReleaseID || ringSetIDs.length === 0 || saveRing.isPending}><Layers3 />保存发布环</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>单环发布</CardTitle><CardDescription>排障或定向发布时使用；常规升级请使用全量发布</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Field label="目标发布环"><select className="h-9 rounded-md border bg-background px-3 text-sm" value={rolloutRingID} onChange={(event) => setRolloutRingID(event.target.value)}><option value="">请选择发布环</option>{rings.map((ring) => <option key={ring.id} value={ring.id}>{ring.name} · {ring.set_count} 个集群</option>)}</select></Field>
            <Field label="目标版本"><select className="h-9 rounded-md border bg-background px-3 text-sm" value={rolloutReleaseID} onChange={(event) => setRolloutReleaseID(event.target.value)}><option value="">请选择版本</option>{releases.filter((release) => ["verified", "stable"].includes(release.status)).map((release) => <option key={release.id} value={release.id}>{release.version} · {release.id}</option>)}</select></Field>
            <Button onClick={() => createRollout.mutate()} disabled={!rolloutRingID || !rolloutReleaseID || createRollout.isPending}><Route />开始逐个发布</Button>
          </CardContent>
        </Card>
      </div>

      <DashboardSection title="最近发布" description="查看当前集群、完成进度和失败停止状态">
        <div className="overflow-hidden rounded-md border bg-card">
          <Table><TableHeader><TableRow><TableHead className="px-4">发布</TableHead><TableHead className="px-4">发布环</TableHead><TableHead className="px-4">目标版本</TableHead><TableHead className="px-4">进度</TableHead><TableHead className="px-4">当前集群</TableHead><TableHead className="px-4">状态</TableHead></TableRow></TableHeader>
          <TableBody>{rollouts.map((rollout) => <TableRow key={rollout.id}><TableCell className="px-4 font-mono text-xs">{rollout.id}</TableCell><TableCell className="px-4">{rollout.ring_id}</TableCell><TableCell className="px-4 font-mono text-xs">{rollout.target_release_id}</TableCell><TableCell className="px-4">{rollout.completed_sets} / {rollout.total_sets}{rollout.failed_sets ? ` · ${rollout.failed_sets} 失败` : ""}</TableCell><TableCell className="px-4">{rollout.current_set_id || "-"}</TableCell><TableCell className="px-4"><ReleaseStatusBadge status={rollout.status} /></TableCell></TableRow>)}
          {!rolloutsQuery.isLoading && rollouts.length === 0 ? <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">暂无版本发布</TableCell></TableRow> : null}</TableBody></Table>
        </div>
      </DashboardSection>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}

function ReleaseStatusBadge({ status }: { status: string }) {
  if (["failed", "degraded"].includes(status)) return <Badge variant="destructive">失败</Badge>
  if (["paused", "blocked"].includes(status)) return <Badge variant="secondary">已暂停</Badge>
  if (["rolling", "running", "soaking"].includes(status)) return <Badge variant="secondary">进行中</Badge>
  if (["completed", "steady", "stable", "verified"].includes(status)) return <Badge variant="outline">{status === "steady" ? "稳定" : status === "completed" ? "已完成" : "可用"}</Badge>
  return <Badge variant="outline">{status || "未知"}</Badge>
}

export function ShardManagementPage({ api }: { api: LLMGatewayAPI }) {
  const queryClient = useQueryClient()
  const [selectedShardID, setSelectedShardID] = useState("")
  const shardsQuery = useQuery({
    queryKey: ["shards"],
    queryFn: () => api.listShards(),
  })
  const shards = shardsQuery.data || []
	const expansionsQuery = useQuery({
		queryKey: ["shard-expansions"],
		queryFn: () => api.listShardExpansions(),
	})
	const expansions = expansionsQuery.data || []
  const selectedShard = shards.find((item) => item.shard.id === selectedShardID) || shards[0]

  useEffect(() => {
    if (!selectedShardID && shards[0]?.shard.id) {
      setSelectedShardID(shards[0].shard.id)
    }
  }, [selectedShardID, shards])

  async function invalidateShards() {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["shards"] }),
			queryClient.invalidateQueries({ queryKey: ["shard-expansions"] }),
		])
  }

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-auto bg-muted/20 p-4 md:p-6">
      {shardsQuery.error ? (
        <Card>
          <CardHeader>
            <CardTitle>无法加载数据分片</CardTitle>
            <CardDescription>{shardsQuery.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <DashboardSection title="数据分片" description="查看连接容量和每个服务集群的归属">
        <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <ShardList
              shards={shards}
              loading={shardsQuery.isLoading}
              selectedShardID={selectedShard?.shard.id || selectedShardID}
              onSelect={setSelectedShardID}
            />
			<ShardExpansionCard api={api} expansions={expansions} loading={expansionsQuery.isLoading} onChanged={invalidateShards} />
          </div>
          <ShardDetailPanel detail={selectedShard} />
        </div>
      </DashboardSection>
    </div>
  )
}

function ShardList({
  shards,
  loading,
  selectedShardID,
  onSelect,
}: {
  shards: ShardDetail[]
  loading: boolean
  selectedShardID: string
  onSelect: (id: string) => void
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>分片列表</CardTitle>
            <CardDescription>{shards.length} 个数据库分片</CardDescription>
          </div>
          <Badge variant="secondary">预算</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {loading ? (
          <>
            <div className="h-16 rounded-md bg-muted" />
            <div className="h-16 rounded-md bg-muted" />
          </>
        ) : null}
        {!loading && shards.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            还没有登记数据分片。
          </div>
        ) : null}
        {shards.map((detail) => {
          const shard = detail.shard
          const connectionDataKnown = shardConnectionDataKnown(detail)
          return (
            <button
              key={shard.id}
              type="button"
              className={cn(
                "rounded-md border bg-card p-3 text-left transition-colors hover:bg-accent",
                selectedShardID === shard.id && "border-primary bg-accent",
              )}
              onClick={() => onSelect(shard.id)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{shard.name || shard.id}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{shard.endpoint || shard.id}</div>
                </div>
                {connectionDataKnown ? <ShardCapacityBadge status={detail.capacity_status} /> : <Badge variant="secondary">待刷新</Badge>}
              </div>
              {connectionDataKnown ? (
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${Math.min(100, Math.round(detail.utilization * 100))}%` }} />
                </div>
              ) : (
                <div className="mt-3 border-t border-dashed" />
              )}
              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>{connectionDataKnown ? `${formatPercent(detail.utilization)} 已用` : "连接数据待刷新"}</span>
                <span>{(detail.sets || []).length} 个服务集群</span>
              </div>
            </button>
          )
        })}
      </CardContent>
    </Card>
  )
}

function ShardExpansionCard({ api, expansions, loading, onChanged }: {
	api: LLMGatewayAPI
	expansions: ShardExpansion[]
	loading: boolean
	onChanged: () => Promise<unknown>
}) {
	const [id, setID] = useState("shard-c")
	const [name, setName] = useState("北京分片 C")
	const [maxSets, setMaxSets] = useState("32")
	const [redisDBStart, setRedisDBStart] = useState("512")
	const [redisDBLimit, setRedisDBLimit] = useState("768")
	const create = useMutation({
		mutationFn: () => api.createShardExpansion({
			idempotency_key: `console:${id.trim()}:${Date.now()}`,
			shard_id: id.trim(),
			name: name.trim(),
			max_sets: Math.max(1, numberInput(maxSets, 32)),
			redis_db_start: Math.max(0, numberInput(redisDBStart, 0)),
			redis_db_limit: Math.max(1, numberInput(redisDBLimit, 256)),
		}),
		onSuccess: () => onChanged(),
	})
	const retry = useMutation({ mutationFn: (expansionID: string) => api.retryShardExpansion(expansionID), onSuccess: () => onChanged() })
	const cancel = useMutation({ mutationFn: (expansionID: string) => api.cancelShardExpansion(expansionID), onSuccess: () => onChanged() })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plus className="size-4" />
					申请扩容
        </CardTitle>
				<CardDescription>提交意图后，系统会跟踪云资源、集群接入和服务验证</CardDescription>
      </CardHeader>
			<CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
						create.mutate()
          }}
        >
          <Field label="分片 ID">
            <Input value={id} onChange={(event) => setID(event.target.value)} />
          </Field>
          <Field label="显示名称">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
						<Field label="最多承载 Set">
							<Input inputMode="numeric" value={maxSets} onChange={(event) => setMaxSets(event.target.value)} />
            </Field>
						<Field label="Redis DB 起点">
							<Input inputMode="numeric" value={redisDBStart} onChange={(event) => setRedisDBStart(event.target.value)} />
            </Field>
						<Field label="Redis DB 终点（不含）">
							<Input inputMode="numeric" value={redisDBLimit} onChange={(event) => setRedisDBLimit(event.target.value)} />
            </Field>
          </div>
					{create.error ? <p className="text-sm text-destructive">{create.error.message}</p> : null}
					<Button type="submit" disabled={create.isPending || id.trim() === "" || name.trim() === ""}>
						{create.isPending ? <Loader2 className="animate-spin" /> : <DatabaseZap />}
						提交扩容流程
          </Button>
        </form>
				<div className="border-t pt-4">
					<div className="mb-3 text-sm font-medium">最近流程</div>
					{loading ? <div className="h-16 rounded-md bg-muted" /> : null}
					{!loading && expansions.length === 0 ? <p className="text-sm text-muted-foreground">暂无扩容流程</p> : null}
					<div className="flex flex-col gap-3">
						{expansions.slice(0, 5).map((expansion) => (
							<div key={expansion.id} className="rounded-md border p-3">
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="truncate font-medium">{expansion.name || expansion.shard_id}</div>
										<div className="mt-1 text-xs text-muted-foreground">{shardExpansionNextAction(expansion)}</div>
									</div>
									<ShardExpansionBadge status={expansion.status} />
								</div>
								<ShardExpansionSteps status={expansion.status} />
								{expansion.last_error ? <p className="mt-2 text-xs text-destructive">{expansion.last_error}</p> : null}
								{expansion.status === "error" ? (
									<div className="mt-3 flex gap-2">
										<Button size="sm" variant="outline" onClick={() => retry.mutate(expansion.id)} disabled={retry.isPending}><RefreshCw />重试</Button>
										<Button size="sm" variant="ghost" onClick={() => cancel.mutate(expansion.id)} disabled={cancel.isPending}><Trash2 />取消流程</Button>
									</div>
								) : null}
							</div>
						))}
					</div>
				</div>
      </CardContent>
    </Card>
  )
}

function ShardExpansionBadge({ status }: { status: string }) {
	if (status === "ready") return <Badge variant="outline">已可用</Badge>
	if (status === "error") return <Badge variant="destructive">需要处理</Badge>
	if (status === "cancelled") return <Badge variant="secondary">已取消</Badge>
	return <Badge variant="secondary">进行中</Badge>
}

function ShardExpansionSteps({ status }: { status: string }) {
	const steps = ["准备云资源", "接入集群", "验证服务", "已可用"]
	const current = shardExpansionStep(status)
	return (
		<div className="mt-3 grid grid-cols-4 gap-1" aria-label="扩容进度">
			{steps.map((step, index) => (
				<div key={step} className="min-w-0">
					<div className={cn("h-1.5 rounded-full", index <= current ? "bg-primary" : "bg-muted")} />
					<div className="mt-1 truncate text-[11px] text-muted-foreground">{step}</div>
				</div>
			))}
		</div>
	)
}

function shardExpansionStep(status: string) {
	if (["requested", "waiting_infrastructure", "infrastructure_ready"].includes(status)) return 0
	if (status === "waiting_fleet_projection") return 1
	if (status === "verifying" || status === "error") return 2
	if (status === "ready") return 3
	return -1
}

function shardExpansionNextAction(expansion: ShardExpansion) {
	switch (expansion.status) {
		case "requested": return "正在准备扩容流程"
		case "waiting_infrastructure": return "等待 Terraform 创建 MySQL 与 Redis"
		case "infrastructure_ready": return "云资源已就绪，正在接入集群"
		case "waiting_fleet_projection": return "等待 LLMFleet 确认真实资源"
		case "verifying": return "请通过正常 Set 路径完成冒烟验证"
		case "ready": return "扩容流程已完成"
		case "cancelled": return "流程已停止，不会自动销毁云资源"
		default: return expansion.last_error || "请处理失败后重试"
	}
}

function ShardDetailPanel({ detail }: { detail?: ShardDetail }) {
  if (!detail) {
    return (
      <div className="grid min-h-[620px] place-items-center rounded-lg border border-dashed bg-card">
        <div className="max-w-sm text-center">
          <DatabaseZap className="mx-auto size-8 text-muted-foreground" />
          <div className="mt-3 text-sm font-medium">请选择一个数据分片</div>
          <p className="mt-1 text-sm text-muted-foreground">登记后可查看连接容量和服务集群归属。</p>
        </div>
      </div>
    )
  }
  const shard = detail.shard
  const shardSets = detail.sets || []
  const connectionDataKnown = shardConnectionDataKnown(detail)
  return (
    <Card className="min-w-0">
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">{shard.name || shard.id}</CardTitle>
            <CardDescription className="truncate">{shard.endpoint || "未填写数据库地址"}</CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={shard.status === "disabled" ? "secondary" : "outline"}>
              {shard.status === "disabled" ? "停用" : "启用"}
            </Badge>
            {connectionDataKnown ? <ShardCapacityBadge status={detail.capacity_status} /> : <Badge variant="secondary">连接数据待刷新</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-4">
				<div className="grid gap-3 md:grid-cols-2">
					<div className="rounded-md border p-3">
						<div className="text-xs text-muted-foreground">MySQL</div>
						<div className="mt-1 truncate font-mono text-xs">{shard.endpoint || "等待 LLMFleet 上报"}</div>
					</div>
					<div className="rounded-md border p-3">
						<div className="text-xs text-muted-foreground">Redis</div>
						<div className="mt-1 truncate font-mono text-xs">{shard.redis_endpoint || "等待 LLMFleet 上报"}</div>
					</div>
				</div>
        <div className="grid gap-3 md:grid-cols-4">
          <StateField label="可分配连接" value={formatNumber(detail.allocatable_connections)} />
          <StateField label="已分配连接" value={connectionDataKnown ? formatNumber(detail.logical_connections) : "-"} />
          <StateField label="剩余连接" value={connectionDataKnown ? formatNumber(detail.remaining_connections) : "-"} />
          <StateField label="使用率" value={connectionDataKnown ? formatPercent(detail.utilization) : "-"} />
        </div>
        <div className="rounded-lg border bg-muted/20 p-4">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">连接预算</span>
            <span className="text-muted-foreground">
              {connectionDataKnown ? `${formatNumber(detail.logical_connections)} / ${formatNumber(detail.allocatable_connections)}` : "等待服务集群上报"}
            </span>
          </div>
          {connectionDataKnown ? (
            <div className="mt-3 h-3 overflow-hidden rounded-full bg-background">
              <div className="h-full bg-primary" style={{ width: `${Math.min(100, Math.round(detail.utilization * 100))}%` }} />
            </div>
          ) : null}
          <div className="mt-2 text-xs text-muted-foreground">
            逻辑连接 = 每个服务集群的 new-api 副本数 × SQL 最大打开连接数。
          </div>
        </div>
				<div className="rounded-lg border bg-muted/20 p-4">
					<div className="flex items-center justify-between gap-3 text-sm">
						<span className="font-medium">Redis DB</span>
						<span className="text-muted-foreground">{formatNumber(detail.redis_db_allocated || 0)} 已用 · {formatNumber(detail.redis_db_available || 0)} 可用</span>
					</div>
					<div className="mt-3 h-3 overflow-hidden rounded-full bg-background">
						<div className="h-full bg-primary" style={{ width: `${Math.min(100, Math.round((detail.redis_db_utilization || 0) * 100))}%` }} />
					</div>
					<div className="mt-2 text-xs text-muted-foreground">分配区间 [{shard.redis_db_start || 0}, {shard.redis_db_limit || 0})，每个 Set 独占一个 DB。</div>
				</div>
        <div className="overflow-auto rounded-lg border">
					<table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b text-xs text-muted-foreground">
              <tr>
                <th className="h-10 px-4 font-medium">服务集群</th>
								<th className="h-10 px-4 font-medium">数据库</th>
								<th className="h-10 px-4 font-medium">Redis DB</th>
                <th className="h-10 px-4 font-medium">状态</th>
                <th className="h-10 px-4 font-medium">副本数</th>
                <th className="h-10 px-4 font-medium">最大连接</th>
                <th className="h-10 px-4 font-medium">空闲连接</th>
                <th className="h-10 px-4 font-medium">逻辑占用</th>
              </tr>
            </thead>
            <tbody>
              {shardSets.length === 0 ? (
                <tr>
									<td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    暂无服务集群使用这个数据分片。
                  </td>
                </tr>
              ) : (
                shardSets.map((set) => (
                  <tr key={set.set_id} className="border-b last:border-b-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{set.name || set.set_id}</div>
                      <div className="text-xs text-muted-foreground">{set.set_id}</div>
                    </td>
									<td className="px-4 py-3 font-mono text-xs">{set.database_name || "-"}</td>
									<td className="px-4 py-3 font-mono text-xs">{set.redis_db || "-"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={set.status} setup={set.setup} />
                    </td>
                    <td className="px-4 py-3">{connectionDataKnown ? formatNumber(set.newapi_replicas) : "-"}</td>
                    <td className="px-4 py-3">{connectionDataKnown ? formatNumber(set.sql_max_open_conns) : "-"}</td>
                    <td className="px-4 py-3">{connectionDataKnown ? formatNumber(set.sql_max_idle_conns) : "-"}</td>
                    <td className="px-4 py-3 font-medium">{connectionDataKnown ? formatNumber(set.logical_connections) : "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function shardConnectionDataKnown(detail: ShardDetail) {
  if (detail.sets === undefined || detail.sets.length === 0) {
    return true
  }
  return detail.logical_connections > 0 || detail.sets.some((set) =>
    set.newapi_replicas > 0 || set.sql_max_open_conns > 0 || set.logical_connections > 0,
  )
}

export function ResourceAdminPage({ api }: { api: LLMGatewayAPI }) {
  const queryClient = useQueryClient()
  const [selectedResourceID, setSelectedResourceID] = useState("tenants")
  const [selectedRowID, setSelectedRowID] = useState("")
  const [offset, setOffset] = useState(0)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [routeSetID, setRouteSetID] = useState("")
  const limit = 50

  const resourcesQuery = useQuery({
    queryKey: ["resources"],
    queryFn: () => api.listResources(),
  })
  const resources = resourcesQuery.data || []
  const selectedResource = resources.find((resource) => resource.id === selectedResourceID) || resources[0]
  const resourceID = selectedResource?.id || selectedResourceID
  const rowsQuery = useQuery({
    queryKey: ["resource-rows", resourceID, limit, offset],
    queryFn: () => api.listResourceRows(resourceID, { limit, offset }),
    enabled: resourceID !== "",
  })
  const rowsResult = rowsQuery.data
  const rows = rowsResult?.rows || []
  const resource = rowsResult?.resource || selectedResource
  const selectedRow = rows.find((row) => row.id === selectedRowID) || rows[0]
  const editableColumns = (resource?.columns || []).filter((column) => column.editable)
  const pageEnd = Math.min((rowsResult?.offset || 0) + rows.length, rowsResult?.total || rows.length)

  useEffect(() => {
    if (!selectedRow) {
      setEditValues({})
      return
    }
    const nextValues: Record<string, string> = {}
    for (const column of editableColumns) {
      nextValues[column.key] = resourceValueToInput(selectedRow.values[column.key])
    }
    setEditValues(nextValues)
  }, [selectedRow?.id, resource?.id])

  function invalidateRows() {
    return queryClient.invalidateQueries({ queryKey: ["resource-rows", resourceID] })
  }

  const patchRow = useMutation({
    mutationFn: () => api.patchResourceRow(resourceID, selectedRow?.id || "", editValues),
    onSuccess: async (result) => {
      setSelectedRowID(result.row.id)
      await invalidateRows()
    },
  })
  const runAction = useMutation({
    mutationFn: (actionID: string) =>
      api.runResourceAction(
        resourceID,
        actionID,
        selectedRow?.id || "",
        actionID === "route_new" && routeSetID.trim() ? { set_id: routeSetID.trim() } : undefined,
      ),
    onSuccess: async (result) => {
      setSelectedRowID(result.row.id)
      await invalidateRows()
    },
  })

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-auto bg-muted/20 p-4 md:p-6">
      <div>
        <h2 className="text-base font-semibold">数据维护</h2>
        <p className="mt-1 text-xs text-muted-foreground">只开放常用状态表；密钥自动隐藏，关键变更走确认动作</p>
      </div>
      <section>
        <div className="grid min-h-[720px] gap-4 xl:grid-cols-[300px_minmax(0,1fr)_360px]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DatabaseZap className="size-4" />
                数据对象
              </CardTitle>
              <CardDescription>选择要查看的对象</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {resourcesQuery.isLoading ? (
                <>
                  <div className="h-12 rounded-lg bg-muted" />
                  <div className="h-12 rounded-lg bg-muted" />
                </>
              ) : null}
              {resourcesQuery.error ? <p className="text-sm text-destructive">{resourcesQuery.error.message}</p> : null}
              {resources.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedResourceID(item.id)
                    setSelectedRowID("")
                    setOffset(0)
                  }}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors",
                    resourceID === item.id ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                  )}
                >
                  <div className="truncate text-sm font-medium">{friendlyResourceLabel(item)}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{friendlyResourceDescription(item)}</div>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader className="border-b">
              <div className="min-w-0">
                <CardTitle className="truncate">{friendlyResourceLabel(resource)}</CardTitle>
                <CardDescription className="truncate">{friendlyResourceDescription(resource)}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {rowsQuery.error ? <div className="p-4 text-sm text-destructive">{rowsQuery.error.message}</div> : null}
              <ResourceRowsTable
                result={rowsResult}
                loading={rowsQuery.isLoading}
                selectedRowID={selectedRow?.id || ""}
                onSelect={setSelectedRowID}
              />
              <div className="flex items-center justify-between gap-3 border-t p-4 text-xs text-muted-foreground">
                <span>
                  {rowsResult ? `${rowsResult.offset + 1}-${pageEnd} / ${rowsResult.total}` : "暂无记录"}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0}>
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOffset(offset + limit)}
                    disabled={!rowsResult || offset + limit >= rowsResult.total}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <ResourceRowPanel
            resource={resource}
            row={selectedRow}
            editableColumns={editableColumns}
            editValues={editValues}
            routeSetID={routeSetID}
            pending={patchRow.isPending || runAction.isPending}
            error={patchRow.error?.message || runAction.error?.message}
            onEdit={(key, value) => setEditValues((current) => ({ ...current, [key]: value }))}
            onPatch={() => patchRow.mutate()}
            onAction={(actionID) => runAction.mutate(actionID)}
            onRouteSetID={setRouteSetID}
          />
        </div>
      </section>
    </div>
  )
}

function ResourceRowsTable({
  result,
  loading,
  selectedRowID,
  onSelect,
}: {
  result?: ResourceRowsResult
  loading: boolean
  selectedRowID: string
  onSelect: (id: string) => void
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <div className="h-12 rounded-lg bg-muted" />
        <div className="h-12 rounded-lg bg-muted" />
      </div>
    )
  }
  const resource = result?.resource
  const rows = result?.rows || []
  const columns = (resource?.columns || []).slice(0, 8)
  if (rows.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">暂无数据。</div>
  }
  return (
    <div className="overflow-auto">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="border-b text-xs text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className="h-10 px-4 text-left align-middle font-medium">
                <span className="inline-flex items-center gap-1">
                  {friendlyColumnLabel(column.key, column.label)}
                  {column.sensitive ? <Badge variant="secondary">已隐藏</Badge> : null}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn("cursor-pointer border-b transition-colors hover:bg-muted/60", row.id === selectedRowID && "bg-muted")}
              onClick={() => onSelect(row.id)}
            >
              {columns.map((column) => (
                <td key={column.key} className="max-w-[220px] px-4 py-3 align-top">
                  <div className="truncate font-mono text-xs">{formatResourceValue(row.values[column.key])}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ResourceRowPanel({
  resource,
  row,
  editableColumns,
  editValues,
  routeSetID,
  pending,
  error,
  onEdit,
  onPatch,
  onAction,
  onRouteSetID,
}: {
  resource?: ResourceDefinition
  row?: ResourceRow
  editableColumns: ResourceDefinition["columns"]
  editValues: Record<string, string>
  routeSetID: string
  pending: boolean
  error?: string
  onEdit: (key: string, value: string) => void
  onPatch: () => void
  onAction: (actionID: string) => void
  onRouteSetID: (value: string) => void
}) {
  const actions = resource?.actions || []
  return (
    <Card className="min-w-0">
      <CardHeader className="border-b">
        <CardTitle>详情</CardTitle>
        <CardDescription className="truncate">{row ? row.id : "选择一条记录"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-4">
        {row ? (
          <>
            <div className="max-h-56 overflow-auto rounded-lg border bg-muted/30 p-3">
              <dl className="grid gap-2 text-xs">
                {(resource?.columns || []).map((column) => (
                  <div key={column.key} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                    <dt className="truncate text-muted-foreground">{friendlyColumnLabel(column.key, column.label)}</dt>
                    <dd className="truncate font-mono">{formatResourceValue(row.values[column.key])}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {editableColumns && editableColumns.length > 0 ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  onPatch()
                }}
              >
                <div className="text-sm font-medium">可编辑信息</div>
                {editableColumns.map((column) => (
                  <Field key={column.key} label={friendlyColumnLabel(column.key, column.label)}>
                    <Input value={editValues[column.key] ?? ""} onChange={(event) => onEdit(column.key, event.target.value)} />
                  </Field>
                ))}
                <Button type="submit" disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                  保存修改
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">这里不能直接修改，可通过下方操作处理。</p>
            )}

            {actions.length > 0 ? (
              <div className="flex flex-col gap-3">
                <div className="text-sm font-medium">操作</div>
                {actions.some((action) => action.id === "route_new") ? (
                  <Field label="目标集群 ID">
                    <Input value={routeSetID} onChange={(event) => onRouteSetID(event.target.value)} placeholder="set-a" />
                  </Field>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {actions.map((action) => (
                    <Button key={action.id} type="button" variant="outline" size="sm" onClick={() => onAction(action.id)} disabled={pending}>
                      {friendlyActionLabel(action.id, action.label)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </>
        ) : (
          <div className="grid min-h-56 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
            选择一条记录后查看详情和可用操作。
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type TrafficProbeRun = {
  endpoint: string
  durationMs: number
  result: ChatCompletionProbeResult
}

export function TrafficProbePage({ api }: { api: LLMGatewayAPI }) {
  const [mode, setMode] = useState<TrafficProbeMode>("gateway")
  const [externalUserID, setExternalUserID] = useState("llmgateway-probe")
  const [apiKey, setAPIKey] = useState("")
  const [model, setModel] = useState("auto")
  const [prompt, setPrompt] = useState("请用一句话回答：平台模型调用是否可用？")
  const canRun = model.trim() !== "" && prompt.trim() !== "" && (apiKey.trim() !== "" || externalUserID.trim() !== "")
  const probe = useMutation<TrafficProbeRun>({
    mutationFn: async () => {
      const startedAt = performance.now()
      const result = await api.runChatCompletionProbe({
        mode,
        apiKey: apiKey.trim() || undefined,
        userID: apiKey.trim() ? undefined : externalUserID.trim(),
        model: model.trim(),
        prompt: prompt.trim(),
      })
      return {
        endpoint: result.endpoint,
        durationMs: result.duration_ms || Math.round(performance.now() - startedAt),
        result,
      }
    },
  })
  const run = probe.data

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-auto bg-muted/20 p-4 md:p-6">
      <DashboardSection title="推理自检" description="验证入口、密钥和模型服务是否可用">
        <div className="grid min-h-[680px] gap-4 xl:grid-cols-[430px_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquareText className="size-4" />
                推理自检
              </CardTitle>
              <CardDescription>使用当前代理链路发起一次非流式 chat 请求</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (canRun) {
                    probe.mutate()
                  }
                }}
              >
                <Field label="模型">
                  <Input value={model} onChange={(event) => setModel(event.target.value)} />
                </Field>
                <Field label="测试问题">
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    className="min-h-24 rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </Field>
                <details className="rounded-md border bg-muted/20">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">高级选项</summary>
                  <div className="flex flex-col gap-3 border-t p-3">
                    <Field label="测试路径">
                      <Tabs value={mode} onValueChange={(value) => setMode(value as TrafficProbeMode)}>
                        <TabsList className="grid w-full grid-cols-2">
                          <TabsTrigger value="gateway">统一网关</TabsTrigger>
                          <TabsTrigger value="set_direct">直连 Set</TabsTrigger>
                        </TabsList>
                      </Tabs>
                    </Field>
                    <StateField label="调用地址" value="/v1/chat/completions" />
                    <Field label="访问密钥（可选）">
                      <Input value={apiKey} onChange={(event) => setAPIKey(event.target.value)} placeholder="留空时复用用户的固定测试密钥" />
                    </Field>
                    <Field label="测试用户 ID">
                      <Input value={externalUserID} onChange={(event) => setExternalUserID(event.target.value)} disabled={apiKey.trim() !== ""} />
                    </Field>
                  </div>
                </details>
                <Button type="submit" disabled={!canRun || probe.isPending}>
                  {probe.isPending ? <Loader2 className="animate-spin" /> : <Send />}
                  开始测试
                </Button>
                {probe.error ? <p className="text-sm text-destructive">{probe.error.message}</p> : null}
              </form>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader className="border-b">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>返回结果</CardTitle>
                  <CardDescription>验证密钥归属、集群转发和模型响应</CardDescription>
                </div>
                {run ? <Badge>正常</Badge> : <Badge variant="outline">待测试</Badge>}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-4">
              {run ? (
                <TrafficProbeResult run={run} />
              ) : (
                <div className="grid min-h-[360px] place-items-center rounded-lg border border-dashed">
                  <div className="max-w-sm px-6 text-center">
                    <MessageSquareText className="mx-auto size-8 text-muted-foreground" />
                    <div className="mt-3 text-sm font-medium">等待测试</div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      点击开始后会向平台入口发起真实请求。
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </DashboardSection>
    </div>
  )
}

function TrafficProbeResult({ run }: { run: TrafficProbeRun }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <StateField label="调用地址" value={run.endpoint} />
        <StateField label="耗时" value={`${run.durationMs} ms`} />
        <StateField label="模型" value={run.result.model || "-"} />
        <StateField label="测试路径" value={run.result.mode === "set_direct" ? "直连 Set" : "统一网关"} />
        <StateField label="目标 Set" value={run.result.set_id || "自动路由"} />
        <StateField label="消耗总量" value={run.result.total_tokens !== undefined ? String(run.result.total_tokens) : "-"} />
        <StateField label="结束原因" value={run.result.finish_reason || "-"} />
        <StateField label="密钥来源" value={run.result.key_id ? (run.result.key_created ? "新建固定测试密钥" : "复用固定测试密钥") : "手动填写"} />
      </div>
      {run.result.key_id ? (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-xs">
          <div className="font-medium">固定测试密钥</div>
          <div className="text-muted-foreground">密钥 ID：{run.result.key_id}</div>
        </div>
      ) : null}
      <div className="rounded-lg border bg-muted/40 p-4">
        <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">助手回复</div>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{run.result.content}</p>
      </div>
    </div>
  )
}

const allChannelTargets = "__all__"

type ChannelPlanOperationResult =
  | { kind: "plan"; set_id: string; set_name: string; plan: ChannelBundlePlan }
  | { kind: "error"; set_id: string; set_name: string; message: string }

type ChannelPlanRun = {
  scope_key: string
  results: ChannelPlanOperationResult[]
}

export function channelPlanScopeKey(bundleID: string, targetSetID: string) {
  return `${bundleID.trim()}:${targetSetID.trim()}`
}

export function channelPlanResultsForScope(run: ChannelPlanRun | undefined, scopeKey: string) {
  return run?.scope_key === scopeKey ? run.results : []
}

type ChannelApplyOperationResult =
  | { kind: "apply"; set_id: string; set_name: string; state: ChannelBundleSyncState }
  | { kind: "error"; set_id: string; set_name: string; message: string }

export function PlanManagementPage({ api, sets }: { api: LLMGatewayAPI; sets: GatewaySet[] }) {
  const queryClient = useQueryClient()
  const [selectedPlanID, setSelectedPlanID] = useState("")
  const [editorMode, setEditorMode] = useState<"create" | "copy" | null>(null)
  const [retireDialogOpen, setRetireDialogOpen] = useState(false)
  const [planDraft, setPlanDraft] = useState({
    id: "", name: "", quotaAmount: "", resetPeriod: "monthly", customResetSeconds: "", isActive: true,
  })
  const plansQuery = useQuery({ queryKey: ["plans"], queryFn: () => api.listPlans() })
  const plans = plansQuery.data || []
  const activePlanID = selectedPlanID || plans[0]?.id || ""
  const setStatesQuery = useQuery({
    queryKey: ["plan-set-states", activePlanID],
    queryFn: () => api.listPlanSetStates(activePlanID),
    enabled: activePlanID !== "",
  })
  const syncMutation = useMutation({
    mutationFn: () => api.syncPlan(activePlanID),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["plan-set-states", activePlanID] })
      await queryClient.invalidateQueries({ queryKey: ["background-jobs"] })
    },
  })
  const saveMutation = useMutation({
    mutationFn: () => {
      const input = {
        name: planDraft.name.trim(),
        monthly_tokens: Number(planDraft.quotaAmount),
        quota_reset_period: planDraft.resetPeriod,
        ...(planDraft.resetPeriod === "custom" ? { quota_reset_custom_seconds: Number(planDraft.customResetSeconds) } : {}),
        is_active: planDraft.isActive,
      }
      return api.createPlan({ ...(planDraft.id.trim() ? { id: planDraft.id.trim() } : {}), ...input })
    },
    onSuccess: async (plan) => {
      setSelectedPlanID(plan.id)
      setEditorMode(null)
      await queryClient.invalidateQueries({ queryKey: ["plans"] })
      await queryClient.invalidateQueries({ queryKey: ["plan-set-states", plan.id] })
      await queryClient.invalidateQueries({ queryKey: ["background-jobs"] })
    },
  })
  const retireMutation = useMutation({
    mutationFn: (planID: string) => api.retirePlan(planID),
    onSuccess: async (plan) => {
      setSelectedPlanID(plan.id)
      setRetireDialogOpen(false)
      await queryClient.invalidateQueries({ queryKey: ["plans"] })
    },
  })
  const states = setStatesQuery.data || []
  const selectedPlan = plans.find((plan) => plan.id === activePlanID)
  const ready = states.filter((state) => state.status === "ready").length
  const failed = states.filter((state) => state.status === "error").length
  const unfinishedStates = states.filter((state) => state.status !== "ready")
  const openPlanEditor = (mode: "create" | "copy") => {
    const source = mode === "create" ? undefined : selectedPlan
    setPlanDraft({
      id: "",
      name: source?.name || "",
      quotaAmount: source ? String(source.monthly_tokens) : "",
      resetPeriod: source?.quota_reset_period || "monthly",
      customResetSeconds: source?.quota_reset_custom_seconds ? String(source.quota_reset_custom_seconds) : "",
      isActive: true,
    })
    saveMutation.reset()
    setEditorMode(mode)
  }
  const canSavePlan = planDraft.name.trim() !== "" &&
    planDraft.quotaAmount.trim() !== "" &&
    Number(planDraft.quotaAmount) >= 0 &&
    (planDraft.resetPeriod !== "custom" || Number(planDraft.customResetSeconds) > 0)

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-auto bg-muted/20 p-4 md:p-6">
      <div className="grid min-h-[620px] gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="border-b">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>模板清单</CardTitle>
                <CardDescription>业务有效期由上层管理；这里定义每个重置周期可用的模型额度</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="outline" disabled={!selectedPlan} onClick={() => openPlanEditor("copy")}>基于此创建新版</Button>
                <AlertDialog
                  open={retireDialogOpen}
                  onOpenChange={(open) => {
                    setRetireDialogOpen(open)
                    if (open) retireMutation.reset()
                  }}
                >
                  <AlertDialogTrigger asChild>
                    <Button type="button" size="sm" variant="outline" disabled={!selectedPlan?.is_active}>
                      <CirclePause />
                      停止新发放
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>停止此模板的新发放？</AlertDialogTitle>
                      <AlertDialogDescription>
                        此操作不可撤销。已发放给用户的权益仍然有效；后续若要调整额度或重新发放，请基于此模板创建新版。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    {retireMutation.error ? <p className="text-sm text-destructive">{retireMutation.error.message}</p> : null}
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction
                        disabled={!selectedPlan || retireMutation.isPending}
                        onClick={(event) => {
                          event.preventDefault()
                          if (selectedPlan) retireMutation.mutate(selectedPlan.id)
                        }}
                      >
                        {retireMutation.isPending ? <Loader2 className="animate-spin" /> : <CirclePause />}
                        确认停止
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button type="button" size="sm" onClick={() => openPlanEditor("create")}><Plus />新增模板</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {plansQuery.error ? <div className="p-4 text-sm text-destructive">{plansQuery.error.message}</div> : null}
            {plans.length === 0 && !plansQuery.isLoading ? (
              <div className="p-8 text-center text-sm text-muted-foreground">尚未定义权益模板。点击“新增模板”开始配置。</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>权益模板</TableHead>
                    <TableHead>周期额度</TableHead>
                    <TableHead>重置周期</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.map((plan) => (
                    <TableRow key={plan.id} className={cn("cursor-pointer", plan.id === activePlanID && "bg-muted/60")} onClick={() => setSelectedPlanID(plan.id)}>
                      <TableCell>
                        <div className="font-medium">{plan.name || plan.id}</div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">{plan.id}</div>
                      </TableCell>
                      <TableCell>{formatNumber(plan.monthly_tokens)}</TableCell>
                      <TableCell>{formatQuotaResetPeriod(plan)}</TableCell>
                      <TableCell><Badge variant={plan.is_active ? "outline" : "secondary"}>{plan.is_active ? "启用" : "停用"}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="border-b">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>集群下发</CardTitle>
                <CardDescription>
                  {selectedPlan ? `${selectedPlan.name} · ${ready} 个集群已就绪${failed > 0 ? ` · ${failed} 个失败` : ""}` : "选择一个权益模板查看状态"}
                </CardDescription>
              </div>
              <Button size="sm" variant="outline" disabled={!activePlanID || syncMutation.isPending} onClick={() => syncMutation.mutate()}>
                {syncMutation.isPending ? <Loader2 className="animate-spin" /> : unfinishedStates.length > 0 ? <Send /> : <RefreshCw />}
                {unfinishedStates.length > 0 ? "重试未完成" : "重新检查"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 p-4">
            {syncMutation.error ? <p className="text-sm text-destructive">{syncMutation.error.message}</p> : null}
            {setStatesQuery.error ? <p className="text-sm text-destructive">{setStatesQuery.error.message}</p> : null}
            {states.length === 0 && activePlanID ? <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">还没有集群下发记录。</div> : null}
            {unfinishedStates.length === 0 && states.length > 0 ? <div className="py-6 text-center text-sm text-muted-foreground">{ready} 个集群已全部就绪</div> : null}
            {unfinishedStates.map((state) => (
              <SetPlanStateRow key={`${state.plan_id}:${state.set_id}`} state={state} set={sets.find((item) => item.id === state.set_id)} />
            ))}
          </CardContent>
        </Card>
      </div>
      <Sheet open={editorMode !== null} onOpenChange={(open) => !open && setEditorMode(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{editorMode === "copy" ? "基于现有模板创建新版" : "新增权益模板"}</SheetTitle>
            <SheetDescription>权益模板创建后不可修改。保存后由后台任务下发到所有可用集群；不会改变上层套餐有效期。</SheetDescription>
          </SheetHeader>
          <form className="flex flex-1 flex-col gap-5 px-4 pb-4" onSubmit={(event) => { event.preventDefault(); if (canSavePlan) saveMutation.mutate() }}>
            <Field label="模板编号（可选）">
              <Input value={planDraft.id} onChange={(event) => setPlanDraft((current) => ({ ...current, id: event.target.value }))} placeholder="留空时由系统生成" autoComplete="off" />
            </Field>
            <Field label="模板名称">
              <Input value={planDraft.name} onChange={(event) => setPlanDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：入门型" autoComplete="off" />
            </Field>
            <Field label="周期额度">
              <Input type="number" min="0" step="1" value={planDraft.quotaAmount} onChange={(event) => setPlanDraft((current) => ({ ...current, quotaAmount: event.target.value }))} placeholder="例如：1000000" />
            </Field>
            <Field label="额度重置周期">
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50" value={planDraft.resetPeriod} onChange={(event) => setPlanDraft((current) => ({ ...current, resetPeriod: event.target.value }))}>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
                <option value="custom">自定义秒数</option>
                <option value="never">不重置</option>
              </select>
            </Field>
            {planDraft.resetPeriod === "custom" ? (
              <Field label="自定义周期（秒）">
                <Input type="number" min="1" step="1" value={planDraft.customResetSeconds} onChange={(event) => setPlanDraft((current) => ({ ...current, customResetSeconds: event.target.value }))} />
              </Field>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={planDraft.isActive} onChange={(event) => setPlanDraft((current) => ({ ...current, isActive: event.target.checked }))} />
              创建后允许发放
            </label>
            {saveMutation.error ? <p className="text-sm text-destructive">{saveMutation.error.message}</p> : null}
            <SheetFooter className="mt-auto px-0">
              <Button type="submit" disabled={!canSavePlan || saveMutation.isPending}>
                {saveMutation.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
                创建模板
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function SetPlanStateRow({ state, set }: { state: SetPlanState; set?: GatewaySet }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{set?.name || state.set_id}</div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{state.set_id}{state.upstream_plan_id ? ` · 内部编号 ${state.upstream_plan_id}` : ""}</div>
        </div>
        <SetPlanStatusBadge status={state.status} />
      </div>
      {state.last_error ? <p className="mt-2 text-xs text-destructive">{state.last_error}</p> : null}
      {state.synced_at ? <p className="mt-2 text-xs text-muted-foreground">最近完成于 {formatDateTime(state.synced_at)}</p> : null}
    </div>
  )
}

function SetPlanStatusBadge({ status }: { status: string }) {
  if (status === "ready") return <Badge variant="outline">已就绪</Badge>
  if (status === "error") return <Badge variant="destructive">失败</Badge>
  if (status === "syncing") return <Badge variant="secondary">下发中</Badge>
  return <Badge variant="secondary">待下发</Badge>
}

function formatQuotaResetPeriod(plan: EntitlementPlan) {
  if (plan.quota_reset_period === "daily") return "每天重置"
  if (plan.quota_reset_period === "weekly") return "每周重置"
  if (plan.quota_reset_period === "monthly") return "每月重置"
  if (plan.quota_reset_period === "never") return "不重置"
  if (plan.quota_reset_period === "custom") return `每 ${formatNumber(plan.quota_reset_custom_seconds || 0)} 秒重置`
  return plan.quota_reset_period || "每月重置"
}

export function ChannelManagementPage({ api, sets }: { api: LLMGatewayAPI; sets: GatewaySet[] }) {
  const queryClient = useQueryClient()
  const backupFileRef = useRef<HTMLInputElement>(null)
  const [bundleID, setBundleID] = useState("golden-channels")
  const [sourceBundleSetID, setSourceBundleSetID] = useState("")
  const [bundleSetID, setBundleSetID] = useState(allChannelTargets)
  const [activeTab, setActiveTab] = useState("delivery")
  const [sourceSheetOpen, setSourceSheetOpen] = useState(false)
  const [otherBundlesOpen, setOtherBundlesOpen] = useState(false)
  const bundlesQuery = useQuery({
    queryKey: ["channel-bundles"],
    queryFn: () => api.listChannelBundles(),
  })
  const bundles = bundlesQuery.data || []
  const publishableSets = sets.filter((set) => set.status === "active" && set.setup)
  const sourceSets = sets.length > 0 ? sets : publishableSets
  const availableTargetSets = publishableSets
  const selectedSourceBundleSetID = sourceBundleSetID || sourceSets[0]?.id || ""
  const selectedTargetSetID = bundleSetID || allChannelTargets
  const selectedTargetSets =
    selectedTargetSetID === allChannelTargets
      ? availableTargetSets
      : availableTargetSets.filter((set) => set.id === selectedTargetSetID)
  const primaryBundle = bundles.find((bundle) => bundle.id === "golden-channels") || bundles[0]
  const selectedBundle = bundles.find((bundle) => bundle.id === bundleID) || primaryBundle
  const otherBundles = bundles.filter((bundle) => bundle.id !== primaryBundle?.id)
  const isPrimaryBundle = selectedBundle !== undefined && selectedBundle.id === primaryBundle?.id
  const activeBundleID = selectedBundle?.id || bundleID.trim()
  const activeBundleName = selectedBundle?.name || "生产模型配置"
  const previewChannels = selectedBundle?.spec?.channels || []
  const templateID = activeBundleID || "golden-channels"
  const templateName = activeBundleName
  const redactedSpec = redactChannelBundleSpec(selectedBundle?.spec || { channels: [] })
  const invalidateBundles = () => queryClient.invalidateQueries({ queryKey: ["channel-bundles"] })
  const invalidateChannelReleaseState = async (targetBundleID = activeBundleID) => {
    await Promise.all([
      invalidateBundles(),
      queryClient.invalidateQueries({ queryKey: ["channel-bundle-revisions", targetBundleID] }),
      queryClient.invalidateQueries({ queryKey: ["channel-bundle-releases", targetBundleID] }),
    ])
  }
  const targetSummary =
    selectedTargetSetID === allChannelTargets ? "全部可用集群" : selectedTargetSets[0]?.name || selectedTargetSetID || "未选择"
  const currentPlanScopeKey = channelPlanScopeKey(activeBundleID, selectedTargetSetID)
  const deliveryStatusQuery = useQuery({
    queryKey: ["channel-bundle-delivery-status", activeBundleID],
    queryFn: () => api.getChannelBundleDeliveryStatus(activeBundleID),
    enabled: activeBundleID !== "" && selectedBundle !== undefined,
  })
  const selectedDeliveryStatus = selectChannelDeliveryStatus(deliveryStatusQuery.data, selectedTargetSetID)
  const revisionsQuery = useQuery({
    queryKey: ["channel-bundle-revisions", activeBundleID],
    queryFn: () => api.listChannelBundleRevisions(activeBundleID),
    enabled: activeBundleID !== "" && selectedBundle !== undefined,
  })
  const releasesQuery = useQuery({
    queryKey: ["channel-bundle-releases", activeBundleID],
    queryFn: () => api.listChannelBundleReleases(activeBundleID),
    enabled: activeBundleID !== "" && selectedBundle !== undefined,
  })

  const importBundle = useMutation({
    mutationFn: () =>
      api.importChannelBundle({
        source_set_id: selectedSourceBundleSetID,
        id: templateID,
        name: templateName,
      }),
    onSuccess: async (bundle) => {
      planBundle.reset()
      releaseBundle.reset()
      setBundleID(bundle.id)
      setActiveTab("delivery")
      setSourceSheetOpen(false)
      await invalidateBundles()
      await queryClient.invalidateQueries({ queryKey: ["channel-bundle-delivery-status", bundle.id] })
    },
  })
  const exportDesiredConfig = useMutation({
    mutationFn: () =>
      api.exportDesiredConfig({
        source_set_id: selectedSourceBundleSetID,
        id: templateID,
        name: templateName,
      }),
    onSuccess: (config) => downloadDesiredConfig(config, templateID),
  })
  const importDesiredConfig = useMutation({
    mutationFn: (config: DesiredConfig) => api.importDesiredConfig(config),
    onSuccess: async (imported) => {
      planBundle.reset()
      releaseBundle.reset()
      const first = imported[0]
      if (first) {
        setBundleID(first.id)
      }
      setActiveTab("delivery")
      await invalidateBundles()
    },
  })
  const restoreDesiredConfig = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    try {
      importDesiredConfig.mutate(JSON.parse(await file.text()) as DesiredConfig)
    } catch (error) {
      window.alert(`无法读取备份文件：${humanError(error)}`)
    }
  }
  const planBundle = useMutation({
    mutationFn: async (input: { bundle_id: string; scope_key: string; sets: GatewaySet[] }): Promise<ChannelPlanRun> => {
      if (input.sets.length === 0) {
        throw new Error("没有可检查的集群。请先纳管并初始化至少一个集群。")
      }
      const results: ChannelPlanOperationResult[] = []
      for (const set of input.sets) {
        try {
          const plan = await api.planChannelBundle(input.bundle_id, { set_id: set.id })
          results.push({ kind: "plan", set_id: set.id, set_name: set.name || set.id, plan })
        } catch (error) {
          results.push({ kind: "error", set_id: set.id, set_name: set.name || set.id, message: humanError(error) })
        }
      }
      return { scope_key: input.scope_key, results }
    },
    onSuccess: async (_run, input) => {
      await invalidateBundles()
      await queryClient.invalidateQueries({ queryKey: ["channel-bundle-delivery-status", input.bundle_id] })
    },
  })
  const releaseBundle = useMutation({
    mutationFn: (input: { bundle_id: string; set_ids: string[]; force_drift: boolean }) =>
      api.createChannelBundleRelease(input.bundle_id, {
        set_ids: input.set_ids,
        force_drift: input.force_drift,
        stop_on_failure: true,
        triggered_by: "console",
      }),
    onSuccess: async (_release, input) => {
      await invalidateChannelReleaseState(input.bundle_id)
      await queryClient.invalidateQueries({ queryKey: ["channel-bundle-delivery-status", input.bundle_id] })
    },
  })
  const rollbackBundle = useMutation({
    mutationFn: (revisionID: string) => api.rollbackChannelBundle(templateID, revisionID),
    onSuccess: async (bundle) => {
      planBundle.reset()
      releaseBundle.reset()
      setBundleID(bundle.id)
      setActiveTab("delivery")
      await invalidateChannelReleaseState()
      await queryClient.invalidateQueries({ queryKey: ["channel-bundle-delivery-status", bundle.id] })
    },
  })

  const canImportBundle = templateID !== "" && selectedSourceBundleSetID !== ""
  const canOperateBundle = templateID !== "" && selectedTargetSets.length > 0 && previewChannels.length > 0
  const planResults = channelPlanResultsForScope(planBundle.data, currentPlanScopeKey)
  const selectBundle = (nextBundleID: string) => {
    planBundle.reset()
    releaseBundle.reset()
    rollbackBundle.reset()
    setBundleID(nextBundleID)
    setBundleSetID(allChannelTargets)
    setActiveTab("delivery")
    setOtherBundlesOpen(false)
  }
  const selectTargetSet = (nextSetID: string) => {
    planBundle.reset()
    releaseBundle.reset()
    setBundleSetID(nextSetID)
  }
  const startCheck = () => planBundle.mutate({
    bundle_id: templateID,
    scope_key: currentPlanScopeKey,
    sets: [...selectedTargetSets],
  })
  const startRelease = (forceDrift: boolean) => releaseBundle.mutate({
    bundle_id: templateID,
    set_ids: selectedTargetSets.map((set) => set.id),
    force_drift: forceDrift,
  })

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-muted/20 p-4 md:p-6">
      <DashboardSection title="模型配置" description="查看各服务集群是否一致，需要时再下发更新">
        <ChannelWorkflowGuide status={selectedDeliveryStatus?.status} />
        <Card className="min-w-0">
          <CardHeader className="border-b">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{activeBundleName}</CardTitle>
                  <Badge variant={isPrimaryBundle ? "secondary" : "outline"}>{!selectedBundle ? "尚未配置" : isPrimaryBundle ? "当前生产配置" : "其他配置"}</Badge>
                </div>
                <CardDescription>{previewChannels.length} 个渠道 · {countBundleModels(previewChannels)} 个模型</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!isPrimaryBundle && primaryBundle ? (
                  <Button type="button" variant="outline" onClick={() => selectBundle(primaryBundle.id)}>
                    <ChevronLeft />返回生产配置
                  </Button>
                ) : null}
                {otherBundles.length > 0 ? (
                  <Button type="button" variant="outline" onClick={() => setOtherBundlesOpen(true)}>
                    <Layers3 />其他配置
                  </Button>
                ) : null}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {bundlesQuery.error ? <div className="p-4 text-sm text-destructive">{bundlesQuery.error.message}</div> : null}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-0">
              <TabsList variant="line" className="w-full justify-start overflow-x-auto border-b px-4">
                <TabsTrigger value="delivery" className="px-3">检查与下发</TabsTrigger>
                <TabsTrigger value="content" className="px-3">配置内容</TabsTrigger>
                <TabsTrigger value="history" className="px-3">版本与记录</TabsTrigger>
              </TabsList>
              <TabsContent value="delivery" forceMount className="p-4 data-[state=inactive]:hidden md:p-5">
                <ChannelDeliveryTab
                  status={selectedDeliveryStatus}
                  loading={deliveryStatusQuery.isLoading}
                  error={deliveryStatusQuery.error?.message || planBundle.error?.message || releaseBundle.error?.message}
                  targetSummary={targetSummary}
                  targetSetID={selectedTargetSetID}
                  targetSets={availableTargetSets}
                  planResults={planResults}
                  checking={planBundle.isPending}
                  publishing={releaseBundle.isPending}
                  hasBundle={selectedBundle !== undefined}
                  canOperate={canOperateBundle}
                  onTargetChange={selectTargetSet}
                  onCheck={startCheck}
                  onPublish={() => startRelease(false)}
                  onForcePublish={() => startRelease(true)}
                />
              </TabsContent>
              <TabsContent value="content" forceMount className="p-4 data-[state=inactive]:hidden md:p-5">
                <ChannelContentTab
                  channels={previewChannels}
                  redactedSpec={redactedSpec}
                  sourceSets={sourceSets}
                  selectedSourceSetID={selectedSourceBundleSetID}
                  sourceSheetOpen={sourceSheetOpen}
                  pending={importBundle.isPending}
                  error={importBundle.error?.message || exportDesiredConfig.error?.message || importDesiredConfig.error?.message}
                  canImport={canImportBundle}
                  backupFileRef={backupFileRef}
                  onSourceSheetOpenChange={setSourceSheetOpen}
                  onSourceSetChange={setSourceBundleSetID}
                  onImport={() => importBundle.mutate()}
                  onDownload={() => exportDesiredConfig.mutate()}
                  onRestore={() => backupFileRef.current?.click()}
                  onRestoreFile={restoreDesiredConfig}
                  downloadPending={exportDesiredConfig.isPending}
                  restorePending={importDesiredConfig.isPending}
                />
              </TabsContent>
              <TabsContent value="history" forceMount className="p-4 data-[state=inactive]:hidden md:p-5">
                <ChannelHistoryTab
                  revisions={revisionsQuery.data || []}
                  releases={releasesQuery.data || []}
                  currentFingerprint={selectedBundle?.fingerprint}
                  pending={rollbackBundle.isPending}
                  error={rollbackBundle.error?.message}
                  onRestore={(revisionID) => rollbackBundle.mutate(revisionID)}
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        <Sheet open={otherBundlesOpen} onOpenChange={setOtherBundlesOpen}>
          <SheetContent className="w-full sm:max-w-lg">
            <SheetHeader>
              <SheetTitle>其他配置</SheetTitle>
              <SheetDescription>测试或历史配置不会替代当前生产配置，只有明确选择后才会进入操作页面。</SheetDescription>
            </SheetHeader>
            <div className="flex flex-1 flex-col overflow-auto px-4 pb-4">
              <div className="overflow-hidden rounded-md border">
                {otherBundles.map((bundle) => {
                  const sameAsPrimary = Boolean(bundle.fingerprint && primaryBundle?.fingerprint && bundle.fingerprint === primaryBundle.fingerprint)
                  const channels = bundle.spec?.channels || []
                  return (
                    <div key={bundle.id} className="flex items-center justify-between gap-3 border-b p-3 last:border-b-0">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{bundle.name}</span>
                          {sameAsPrimary ? <Badge variant="outline">内容相同</Badge> : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{channels.length} 个渠道 · {countBundleModels(channels)} 个模型</p>
                      </div>
                      <Button type="button" size="sm" variant="outline" onClick={() => selectBundle(bundle.id)} disabled={bundle.id === activeBundleID}>查看</Button>
                    </div>
                  )
                })}
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </DashboardSection>
    </div>
  )
}

function ChannelWorkflowGuide({ status }: { status?: string }) {
  const recommendedStep = status === "pending" || status === "drift" ? 4 : status === "unchecked" || status === "stale" || status === "error" ? 3 : 1
  const steps = [
    { number: 1, title: "查看结果", detail: "全部一致即可结束" },
    { number: 2, title: "更新配置", detail: "仅在渠道变化时" },
    { number: 3, title: "检查差异", detail: "只读取，不会下发" },
    { number: 4, title: "下发更新", detail: "仅需要更新时出现" },
  ]
  return (
    <section className="border-y bg-background px-4 py-4 md:px-5" aria-label="模型配置操作引导">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">操作顺序</h3>
        <span className="text-xs text-muted-foreground">日常查看通常停在第 1 步</span>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((step) => (
          <li key={step.number} className={cn("flex min-w-0 gap-3 border-l-2 pl-3", recommendedStep === step.number ? "border-primary" : "border-border")}>
            <span className={cn("grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold", recommendedStep === step.number ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{step.number}</span>
            <div className="min-w-0">
              <div className="text-sm font-medium">{step.title}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{step.detail}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function ChannelDeliveryTab({
  status,
  loading,
  error,
  targetSummary,
  targetSetID,
  targetSets,
  planResults,
  checking,
  publishing,
  hasBundle,
  canOperate,
  onTargetChange,
  onCheck,
  onPublish,
  onForcePublish,
}: {
  status?: ChannelBundleDeliveryStatus
  loading: boolean
  error?: string
  targetSummary: string
  targetSetID: string
  targetSets: GatewaySet[]
  planResults: ChannelPlanOperationResult[]
  checking: boolean
  publishing: boolean
  hasBundle: boolean
  canOperate: boolean
  onTargetChange: (value: string) => void
  onCheck: () => void
  onPublish: () => void
  onForcePublish: () => void
}) {
  const summary = channelDeliverySummary(status, checking, publishing, hasBundle)
  const exceptionalSets = status?.sets.filter((set) => set.status !== "synced") || []
  const canPublish = status?.status === "pending" && canOperate && !checking && !publishing
  const canForcePublish = status?.status === "drift" && planResults.some((result) => result.kind === "plan") && !checking && !publishing
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="下发范围">
          <select
            value={targetSetID}
            onChange={(event) => onTargetChange(event.target.value)}
            className="h-9 min-w-48 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <option value={allChannelTargets}>全部可用集群</option>
            {targetSets.map((set) => <option key={set.id} value={set.id}>{set.name || set.id}</option>)}
          </select>
        </Field>
        {status && status.status !== "empty" ? (
          <Button type="button" variant="outline" onClick={onCheck} disabled={!canOperate || checking || publishing}>
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            重新检查
          </Button>
        ) : null}
      </div>

      <Alert variant={summary.variant}>
        {summary.icon}
        <AlertTitle>{summary.title}</AlertTitle>
        <AlertDescription>{summary.description}</AlertDescription>
      </Alert>

      {loading ? <div className="py-8 text-center text-sm text-muted-foreground">正在读取最近检查结果...</div> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {status?.coverage_checked_at ? <p className="text-xs text-muted-foreground">最近检查：{formatDateTime(status.coverage_checked_at)} · {targetSummary}</p> : null}

      {exceptionalSets.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          {exceptionalSets.map((set) => <ChannelDeliverySetRow key={set.set_id} set={set} />)}
        </div>
      ) : status?.status === "synced" ? (
        <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">{status.counts.synced} 个集群均无需更新</div>
      ) : null}

      {planResults.length > 0 ? (
        <details className="rounded-md border bg-muted/20" open={status?.status === "drift"}>
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">查看本次检查详情</summary>
          <div className="flex flex-col gap-3 border-t p-3">
            {planResults.map((result) => <ChannelPlanResult key={`${result.kind}:${result.set_id}`} result={result} />)}
          </div>
        </details>
      ) : null}

      <div className="flex justify-end gap-2">
        {canPublish ? <Button type="button" onClick={onPublish}><Send />下发更新</Button> : null}
        {canForcePublish ? <Button type="button" variant="destructive" onClick={onForcePublish}><RefreshCw />确认覆盖远端</Button> : null}
      </div>
    </div>
  )
}

function ChannelDeliverySetRow({ set }: { set: ChannelBundleDeliverySetStatus }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-3 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{set.set_name || set.set_id}</div>
        <div className="mt-1 text-xs text-muted-foreground">{channelDeliverySetHint(set)}</div>
        {set.last_error ? <div className="mt-1 text-xs text-destructive">{set.last_error}</div> : null}
      </div>
      <ChannelDeliveryStatusBadge status={set.status} />
    </div>
  )
}

function selectChannelDeliveryStatus(
  status: ChannelBundleDeliveryStatus | undefined,
  targetSetID: string,
): ChannelBundleDeliveryStatus | undefined {
  if (!status || targetSetID === allChannelTargets) {
    return status
  }
  const selectedSet = status.sets.find((set) => set.set_id === targetSetID)
  if (!selectedSet) {
    return {
      ...status,
      status: "empty",
      eligible_sets: 0,
      checked_sets: 0,
      coverage_checked_at: undefined,
      has_stale_results: false,
      counts: emptyChannelDeliveryCounts(),
      sets: [],
    }
  }
  const counts = emptyChannelDeliveryCounts()
  const countKey = selectedSet.status as keyof typeof counts
  if (countKey in counts) {
    counts[countKey] = 1
  }
  return {
    ...status,
    status: selectedSet.status,
    eligible_sets: 1,
    checked_sets: selectedSet.last_checked_at ? 1 : 0,
    coverage_checked_at: selectedSet.last_checked_at,
    has_stale_results: selectedSet.status === "unchecked" || selectedSet.status === "stale",
    counts,
    sets: [selectedSet],
  }
}

function emptyChannelDeliveryCounts() {
  return { synced: 0, pending: 0, drift: 0, error: 0, unchecked: 0, stale: 0 }
}

function countBundleModels(channels: ChannelBundleSpec["channels"]) {
  const models = new Set<string>()
  for (const channel of channels) {
    for (const model of (channel.models || "").split(",")) {
      const normalized = model.trim()
      if (normalized) models.add(normalized)
    }
  }
  return models.size
}

function channelDeliverySummary(
  status: ChannelBundleDeliveryStatus | undefined,
  checking: boolean,
  publishing: boolean,
  hasBundle = true,
): { title: string; description: string; icon: ReactNode; variant?: "default" | "destructive" } {
  if (checking) {
    return { title: "正在检查集群配置", description: "检查只会读取远端状态，不会改动配置。", icon: <Loader2 className="animate-spin" /> }
  }
  if (publishing) {
    return { title: "正在下发配置", description: "下发结果会自动记录到发布记录。", icon: <Loader2 className="animate-spin" /> }
  }
  if (!hasBundle) {
    return { title: "尚未创建生产配置", description: "先在“配置内容”中从黄金集群读取一份可用配置。", icon: <CircleDashed /> }
  }
  if (!status) {
    return { title: "正在读取最近检查结果", description: "这里默认展示后台任务最近一次保存的结果。", icon: <CircleDashed /> }
  }
  if (status.status === "empty") {
    return { title: "暂无可下发的服务集群", description: "先完成集群纳管和初始化。", icon: <CircleDashed /> }
  }
  if (status.status === "error") {
    return { title: `${status.counts.error} 个集群检查失败`, description: "请重新检查；确认原因后再下发。", icon: <TriangleAlert />, variant: "destructive" }
  }
  if (status.status === "unchecked") {
    return { title: `${status.counts.unchecked} 个集群尚未检查`, description: "后台检查尚未覆盖全部集群，可以立即重新检查。", icon: <CircleDashed /> }
  }
  if (status.status === "stale") {
    return { title: `${status.counts.stale} 个集群的结果已过期`, description: "当前配置或远端状态可能已经变化，请重新检查。", icon: <TriangleAlert /> }
  }
  if (status.status === "drift") {
    return { title: `${status.counts.drift} 个集群存在远端改动`, description: "先查看检查详情，确认后才能覆盖远端。", icon: <TriangleAlert />, variant: "destructive" }
  }
  if (status.status === "pending") {
    return { title: `${status.counts.pending} 个集群需要更新`, description: "检查已完成，可以把当前配置下发到这些集群。", icon: <Send /> }
  }
  return { title: "所有集群配置一致", description: "当前无需下发；后台任务会继续定期检查。", icon: <CheckCircle2 /> }
}

function ChannelDeliveryStatusBadge({ status }: { status: ChannelBundleDeliverySetStatus["status"] }) {
  if (status === "synced") return <Badge>已一致</Badge>
  if (status === "pending") return <Badge variant="secondary">待更新</Badge>
  if (status === "drift") return <Badge variant="destructive">存在远端改动</Badge>
  if (status === "error") return <Badge variant="destructive">检查失败</Badge>
  if (status === "stale") return <Badge variant="outline">结果过期</Badge>
  return <Badge variant="outline">未检查</Badge>
}

function channelDeliverySetHint(set: ChannelBundleDeliverySetStatus) {
  const checkedAt = set.last_checked_at ? `最近检查 ${formatDateTime(set.last_checked_at)}` : "尚未检查"
  if (set.status === "pending") return `${checkedAt}，等待下发当前配置`
  if (set.status === "drift") return `${checkedAt}，远端包含未纳入当前配置的改动`
  if (set.status === "error") return `${checkedAt}，检查未完成`
  if (set.status === "stale") return `${checkedAt}，结果不再可信`
  if (set.status === "synced") return `${checkedAt}，无需更新`
  return checkedAt
}

function ChannelContentTab({
  channels,
  redactedSpec,
  sourceSets,
  selectedSourceSetID,
  sourceSheetOpen,
  pending,
  error,
  canImport,
  backupFileRef,
  onSourceSheetOpenChange,
  onSourceSetChange,
  onImport,
  onDownload,
  onRestore,
  onRestoreFile,
  downloadPending,
  restorePending,
}: {
  channels: ChannelBundleSpec["channels"]
  redactedSpec: ChannelBundleSpec
  sourceSets: GatewaySet[]
  selectedSourceSetID: string
  sourceSheetOpen: boolean
  pending: boolean
  error?: string
  canImport: boolean
  backupFileRef: RefObject<HTMLInputElement | null>
  onSourceSheetOpenChange: (open: boolean) => void
  onSourceSetChange: (value: string) => void
  onImport: () => void
  onDownload: () => void
  onRestore: () => void
  onRestoreFile: (event: ChangeEvent<HTMLInputElement>) => void
  downloadPending: boolean
  restorePending: boolean
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">渠道与模型</h3>
          <p className="mt-1 text-xs text-muted-foreground">这是下一次下发使用的当前配置</p>
        </div>
        <Button type="button" variant="outline" onClick={() => onSourceSheetOpenChange(true)}><Download />从黄金集群更新</Button>
      </div>
      <ChannelTemplatePreview channels={channels} />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <details className="rounded-md border bg-muted/20">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">高级操作</summary>
        <div className="flex flex-wrap items-center gap-2 border-t p-3">
          <p className="mr-auto text-xs text-muted-foreground">备份文件含渠道密钥，请按敏感凭据保管。</p>
          <input ref={backupFileRef} type="file" accept="application/json,.json" className="hidden" onChange={onRestoreFile} />
          <Button type="button" size="sm" variant="outline" onClick={onDownload} disabled={downloadPending}>
            {downloadPending ? <Loader2 className="animate-spin" /> : <Download />}下载完整备份
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onRestore} disabled={restorePending}>
            {restorePending ? <Loader2 className="animate-spin" /> : <Upload />}从备份恢复
          </Button>
        </div>
        <pre className="max-h-64 overflow-auto border-t p-3 text-xs leading-5 text-muted-foreground">{JSON.stringify(redactedSpec, null, 2)}</pre>
      </details>
      <Sheet open={sourceSheetOpen} onOpenChange={onSourceSheetOpenChange}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>从黄金集群更新</SheetTitle>
            <SheetDescription>读取该集群当前配置；内容有变化时会生成一个新版本。</SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-5 px-4 pb-4">
            <Field label="来源集群">
              <select
                value={selectedSourceSetID}
                onChange={(event) => onSourceSetChange(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {sourceSets.length === 0 ? <option value="">暂无可用集群</option> : null}
                {sourceSets.map((set) => <option key={set.id} value={set.id}>{set.name || set.id}</option>)}
              </select>
            </Field>
            <Alert><AlertTitle>确认后立即读取</AlertTitle><AlertDescription>配置未变化时会保留当前版本，不会创建重复版本。</AlertDescription></Alert>
            <SheetFooter className="mt-auto px-0">
              <Button type="button" onClick={onImport} disabled={!canImport || pending}>
                {pending ? <Loader2 className="animate-spin" /> : <Download />}确认更新
              </Button>
            </SheetFooter>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function ChannelHistoryTab({ revisions, releases, currentFingerprint, pending, error, onRestore }: {
  revisions: ChannelBundleRevision[]
  releases: ChannelBundleReleaseRun[]
  currentFingerprint?: string
  pending: boolean
  error?: string
  onRestore: (revisionID: string) => void
}) {
  const [restoreCandidate, setRestoreCandidate] = useState<ChannelBundleRevision>()
  const currentRevisionID = revisions.find((revision) => revision.fingerprint === currentFingerprint)?.revision_id
  return (
    <>
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">发布记录</h3><Badge variant="outline">{releases.length} 次</Badge></div>
          <div className="overflow-hidden rounded-md border">
            {releases.length === 0 ? <div className="p-5 text-sm text-muted-foreground">还没有发布记录。</div> : releases.map((run) => (
              <div key={run.id} className="border-b p-3 last:border-b-0">
                <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{formatDateTime(run.created_at)}</span><ChannelReleaseStatusBadge status={run.status} /></div>
                <div className="mt-1 text-xs text-muted-foreground">{run.items?.length || 0} 个集群</div>
                {run.last_error ? <div className="mt-1 text-xs text-destructive">{run.last_error}</div> : null}
              </div>
            ))}
          </div>
        </section>
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">配置版本</h3><Badge variant="outline">{revisions.length} 个</Badge></div>
          <div className="overflow-hidden rounded-md border">
            {revisions.length === 0 ? <div className="p-5 text-sm text-muted-foreground">保存配置后会生成版本，之后可以恢复历史版本。</div> : revisions.map((revision) => {
              const isCurrent = revision.revision_id === currentRevisionID
              const hasCurrentContent = !isCurrent && revision.fingerprint !== "" && revision.fingerprint === currentFingerprint
              return (
                <div key={revision.revision_id} className="flex flex-wrap items-center justify-between gap-3 border-b p-3 last:border-b-0">
                  <div><div className="text-sm font-medium">版本 {revision.version || "-"}</div><div className="mt-1 text-xs text-muted-foreground">{formatDateTime(revision.created_at)}</div></div>
                  {!currentFingerprint ? <Badge variant="outline">状态待确认</Badge> : isCurrent ? <Badge>当前版本</Badge> : hasCurrentContent ? <Badge variant="outline">内容相同</Badge> : <Button type="button" size="sm" variant="outline" onClick={() => setRestoreCandidate(revision)} disabled={pending}>恢复历史版本</Button>}
                </div>
              )
            })}
          </div>
          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        </section>
      </div>
      <Sheet open={restoreCandidate !== undefined} onOpenChange={(open) => { if (!open) setRestoreCandidate(undefined) }}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>恢复版本 {restoreCandidate?.version || "-"}</SheetTitle>
            <SheetDescription>恢复后会生成一个新的当前版本，但不会自动下发到服务集群。</SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col px-4 pb-4">
            <Alert><AlertTitle>仍需重新检查</AlertTitle><AlertDescription>恢复完成后，请回到“检查与下发”，确认差异后再下发。</AlertDescription></Alert>
            <SheetFooter className="mt-auto px-0">
              <Button type="button" variant="outline" onClick={() => setRestoreCandidate(undefined)}>取消</Button>
              <Button type="button" onClick={() => { if (restoreCandidate) onRestore(restoreCandidate.revision_id); setRestoreCandidate(undefined) }} disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}确认恢复
              </Button>
            </SheetFooter>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function downloadDesiredConfig(config: DesiredConfig, bundleID: string) {
  const blob = new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  const safeID = bundleID.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "backup"
  link.href = url
  link.download = `llmgateway-desired-config-${safeID}.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function ChannelTemplatePreview({ channels }: { channels: ChannelBundleSpec["channels"] }) {
  return (
    <div className="rounded-lg border bg-muted/20">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">渠道模板预览</span>
        <span className="text-xs text-muted-foreground">{channels.length} 个渠道</span>
      </div>
      {channels.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">还没有渠道。先从黄金集群导入一个已经跑通的配置。</div>
      ) : (
        <div className="overflow-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="h-9 px-3 font-medium">渠道</th>
                <th className="h-9 px-3 font-medium">模型</th>
                <th className="h-9 px-3 font-medium">服务地址</th>
                <th className="h-9 px-3 font-medium">分组</th>
                <th className="h-9 px-3 font-medium">密钥</th>
                <th className="h-9 px-3 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.id || channel.name} className="border-b last:border-b-0">
                  <td className="px-3 py-2">
                    <div className="font-medium">{channel.name || channel.id}</div>
                  </td>
                  <td className="max-w-[220px] px-3 py-2">
                    <span className="block truncate">{summarizeModels(channel.models)}</span>
                  </td>
                  <td className="max-w-[220px] px-3 py-2">
                    <span className="block truncate">{channel.base_url || "-"}</span>
                  </td>
                  <td className="px-3 py-2">{channel.group || "default"}</td>
                  <td className="px-3 py-2">{channel.key_hash ? "已配置" : "未配置"}</td>
                  <td className="px-3 py-2">
                    <Badge variant={channel.status === "disabled" ? "secondary" : "outline"}>
                      {channel.status === "disabled" ? "停用" : "启用"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ChannelDiffPanel({
  planResults,
  applyResults,
  redactedSpec,
}: {
  planResults: ChannelPlanOperationResult[]
  applyResults: ChannelApplyOperationResult[]
  redactedSpec: ChannelBundleSpec
}) {
  return (
    <div className="rounded-lg border bg-muted/20">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div>
          <div className="text-sm font-medium">差异可视化</div>
          <p className="mt-1 text-xs text-muted-foreground">检查只读远端；发布结果会展示在同一区域，方便确认每个集群状态。</p>
        </div>
        <Badge variant={planResults.length > 0 ? "secondary" : "outline"}>
          {planResults.length > 0 ? `${planResults.length} 个检查结果` : "还没有检查差异"}
        </Badge>
      </div>
      <div className="flex flex-col gap-3 p-3">
        {applyResults.length > 0 ? <ChannelApplyResults results={applyResults} /> : null}
        {planResults.length === 0 ? (
          <div className="rounded-lg border bg-background p-4 text-sm text-muted-foreground">
            还没有检查差异。点击“检查差异”后，这里会按集群展示新增、变更、远端多余配置和 JSON diff。
          </div>
        ) : (
          planResults.map((result) => <ChannelPlanResult key={`${result.kind}:${result.set_id}`} result={result} />)
        )}
        <details className="rounded-lg border bg-background p-3">
          <summary className="cursor-pointer text-sm font-medium">高级 JSON 详情</summary>
          <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
            {JSON.stringify(redactedSpec, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  )
}

function ChannelPlanResult({ result }: { result: ChannelPlanOperationResult }) {
  if (result.kind === "error") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{result.set_name}</span>
          <Badge variant="destructive">检查失败</Badge>
        </div>
        <p className="mt-2 text-sm text-destructive">{result.message}</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{result.set_name}</div>
          <div className="mt-1 text-xs text-muted-foreground">{result.plan.steps.length} 个待确认动作</div>
        </div>
        <ChannelPlanStatusBadge status={result.plan.status} />
      </div>
      {result.plan.steps.length > 0 ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {result.plan.steps.map((step) => (
            <div key={`${step.kind}:${step.resource_id}:${step.action}`} className="rounded-lg border bg-muted/30 p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{step.resource_id}</span>
                <Badge variant={step.requires_force ? "destructive" : "secondary"}>{friendlyChannelAction(step.action)}</Badge>
              </div>
              <div className="mt-1 text-muted-foreground">{friendlyChannelStep(step.kind)}</div>
              {step.reason ? <div className="mt-1 text-muted-foreground">{friendlyChannelReason(step.reason)}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      <JsonVisualDiff desired={result.plan.desired} actual={result.plan.actual} />
    </div>
  )
}

function ChannelApplyResults({ results }: { results: ChannelApplyOperationResult[] }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">发布结果</span>
        <Badge variant="secondary">{results.length} 个集群</Badge>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {results.map((result) => (
          <div key={`${result.kind}:${result.set_id}`} className="rounded-lg border bg-muted/30 p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{result.set_name}</span>
              {result.kind === "apply" ? <ChannelSyncBadge status={result.state.status} /> : <Badge variant="destructive">失败</Badge>}
            </div>
            {result.kind === "error" ? <p className="mt-1 text-destructive">{result.message}</p> : null}
            {result.kind === "apply" && result.state.last_error ? (
              <p className="mt-1 text-destructive">{result.state.last_error}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function ChannelReleasePanel({
  revisions,
  releases,
  targetSummary,
  canRelease,
  pending,
  error,
  onRelease,
  onRollback,
}: {
  revisions: ChannelBundleRevision[]
  releases: ChannelBundleReleaseRun[]
  targetSummary: string
  canRelease: boolean
  pending: boolean
  error?: string
  onRelease: (forceDrift: boolean) => void
  onRollback: (revisionID: string) => void
}) {
  const latestRelease = releases[0]
  return (
    <div className="rounded-lg border bg-muted/20">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-3 py-3">
        <div>
          <div className="text-sm font-medium">批量发布</div>
          <p className="mt-1 text-xs text-muted-foreground">默认失败即停；发布记录会保留下来用于排障和回滚。</p>
        </div>
        <Badge variant="secondary">{targetSummary}</Badge>
      </div>
      <div className="flex flex-col gap-4 p-3">
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => onRelease(false)} disabled={!canRelease || pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Send />}
            批量发布
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onRelease(true)} disabled={!canRelease || pending}>
            {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            覆盖远端发布
          </Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="grid gap-3 xl:grid-cols-2">
          <div className="rounded-lg border bg-background">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <span className="text-sm font-medium">发布历史</span>
              <Badge variant="outline">{releases.length} 次</Badge>
            </div>
            <div className="flex max-h-64 flex-col gap-2 overflow-auto p-3">
              {releases.length === 0 ? (
                <div className="text-sm text-muted-foreground">还没有发布记录。</div>
              ) : (
                releases.slice(0, 6).map((run) => (
                  <div key={run.id} className="rounded-lg border bg-muted/20 p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono">{run.id}</span>
                      <ChannelReleaseStatusBadge status={run.status} />
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {formatDateTime(run.created_at)} · {run.items?.length || 0} 个 Set
                    </div>
                    {run.last_error ? <div className="mt-1 text-destructive">{run.last_error}</div> : null}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-background">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <span className="text-sm font-medium">版本历史</span>
              <Badge variant="outline">{revisions.length} 个版本</Badge>
            </div>
            <div className="flex max-h-64 flex-col gap-2 overflow-auto p-3">
              {revisions.length === 0 ? (
                <div className="text-sm text-muted-foreground">保存或导入模板后会生成版本；选择历史版本后可回滚到此版本。</div>
              ) : (
                revisions.slice(0, 6).map((revision) => (
                  <div key={revision.revision_id} className="rounded-lg border bg-muted/20 p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">版本 {revision.version || "-"}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() => onRollback(revision.revision_id)}
                        disabled={pending}
                      >
                        回滚到此版本
                      </Button>
                    </div>
                    <div className="mt-1 truncate text-muted-foreground">{maskFingerprint(revision.fingerprint)}</div>
                    <div className="mt-1 text-muted-foreground">{formatDateTime(revision.created_at)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {latestRelease ? <ChannelReleaseItems run={latestRelease} /> : null}
      </div>
    </div>
  )
}

function ChannelReleaseItems({ run }: { run: ChannelBundleReleaseRun }) {
  if (!run.items || run.items.length === 0) {
    return null
  }
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">最近发布进度</span>
        <ChannelReleaseStatusBadge status={run.status} />
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {run.items.map((item) => (
          <div key={`${item.run_id}:${item.set_id}`} className="rounded-lg border bg-muted/20 p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{item.set_id}</span>
              <ChannelReleaseStatusBadge status={item.status} />
            </div>
            {item.last_error ? <p className="mt-1 text-destructive">{item.last_error}</p> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function ChannelReleaseStatusBadge({ status }: { status: string }) {
  if (status === "success") {
    return <Badge>成功</Badge>
  }
  if (status === "running") {
    return <Badge variant="secondary">运行中</Badge>
  }
  if (status === "skipped") {
    return <Badge variant="outline">已跳过</Badge>
  }
  if (status === "partial") {
    return <Badge variant="secondary">部分完成</Badge>
  }
  if (status === "error") {
    return <Badge variant="destructive">失败</Badge>
  }
  return <Badge variant="outline">{status || "未知"}</Badge>
}

function ChannelPlanStatusBadge({ status }: { status: string }) {
  if (status === "synced") {
    return <Badge>已一致</Badge>
  }
  if (status === "pending") {
    return <Badge variant="secondary">有待发布</Badge>
  }
  if (status === "drift") {
    return <Badge variant="destructive">发现差异</Badge>
  }
  if (status === "error" || status === "conflict") {
    return <Badge variant="destructive">检查失败</Badge>
  }
  return <Badge variant="outline">{status || "未知"}</Badge>
}

function redactChannelBundleSpec(spec: ChannelBundleSpec): ChannelBundleSpec {
  return {
    ...spec,
    channels: (spec.channels || []).map(({ key: _key, ...channel }) => channel),
  }
}

function summarizeModels(models?: string) {
  if (!models) {
    return "-"
  }
  const items = models
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  if (items.length <= 2) {
    return items.join(", ") || models
  }
  return `${items.slice(0, 2).join(", ")} 等 ${items.length} 个`
}

function maskFingerprint(value?: string) {
  if (!value) {
    return "未返回"
  }
  if (value.length <= 14) {
    return value
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

function friendlyChannelAction(action: string) {
  if (action === "create") return "新增"
  if (action === "update") return "更新"
  if (action === "delete" || action === "extra") return "远端多余"
  if (action === "noop") return "一致"
  if (action === "skip") return "跳过"
  return action || "待处理"
}

function friendlyChannelStep(kind: string) {
  if (kind === "create_channel") return "新增渠道"
  if (kind === "update_channel") return "更新渠道"
  if (kind === "extra_channel") return "远端存在但模板未包含"
  if (kind === "synced_channel") return "已一致"
  if (kind === "noop") return "无需改动"
  return kind || "渠道动作"
}

function friendlyChannelReason(reason: string) {
  if (reason === "noop") return "无需改动"
  if (reason === "drift") return "远端有手工改动"
  if (reason === "missing") return "远端缺少这条配置"
  return reason
}

function humanError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

type JsonDiffKind = "added" | "removed" | "changed"

type JsonDiffRow = {
  path: string
  kind: JsonDiffKind
  desired?: unknown
  actual?: unknown
}

function JsonVisualDiff({ desired, actual }: { desired?: ChannelBundleSpec; actual?: ChannelBundleSpec }) {
  const rows = collectJsonDiff(normalizeChannelJsonForDiff(desired || {}), normalizeChannelJsonForDiff(actual || {}), "$")
  if (rows.length === 0) {
    return (
      <div className="mt-3 rounded-lg border bg-background p-3 text-sm text-muted-foreground">
        模板和远端 JSON 已一致。
      </div>
    )
  }
  return (
    <div className="mt-3 max-h-72 overflow-auto rounded-lg border bg-background">
      <table className="w-full min-w-[760px] text-left text-xs">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="h-9 px-3 font-medium">路径</th>
            <th className="h-9 px-3 font-medium">类型</th>
            <th className="h-9 px-3 font-medium">期望值</th>
            <th className="h-9 px-3 font-medium">当前值</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.kind}:${row.path}`} className="border-b last:border-b-0">
              <td className="max-w-[260px] px-3 py-2 font-mono text-muted-foreground">
                <span className="block truncate">{row.path}</span>
              </td>
              <td className="px-3 py-2">
                <JsonDiffBadge kind={row.kind} />
              </td>
              <td className="max-w-[260px] px-3 py-2 font-mono">
                <span className="block truncate">{formatJsonDiffValue(row.desired)}</span>
              </td>
              <td className="max-w-[260px] px-3 py-2 font-mono">
                <span className="block truncate">{formatJsonDiffValue(row.actual)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function normalizeChannelJsonForDiff(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeChannelJsonForDiff)
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "key" && key !== "key_hash")
        .map(([key, entry]) => [key, normalizeChannelJsonForDiff(entry)]),
    )
  }
  return value
}

function JsonDiffBadge({ kind }: { kind: JsonDiffKind }) {
  if (kind === "added") {
    return <Badge>新增</Badge>
  }
  if (kind === "removed") {
    return <Badge variant="secondary">删除</Badge>
  }
  return <Badge variant="outline">变更</Badge>
}

function collectJsonDiff(desired: unknown, actual: unknown, path: string): JsonDiffRow[] {
  if (jsonEquivalent(desired, actual)) {
    return []
  }
  if (isRecord(desired) && isRecord(actual)) {
    const keys = Array.from(new Set([...Object.keys(desired), ...Object.keys(actual)])).sort()
    return keys.flatMap((key) => {
      const childPath = `${path}.${key}`
      if (!(key in actual)) {
        return [{ path: childPath, kind: "added" as const, desired: desired[key] }]
      }
      if (!(key in desired)) {
        return [{ path: childPath, kind: "removed" as const, actual: actual[key] }]
      }
      return collectJsonDiff(desired[key], actual[key], childPath)
    })
  }
  if (Array.isArray(desired) && Array.isArray(actual)) {
    const size = Math.max(desired.length, actual.length)
    const rows: JsonDiffRow[] = []
    for (let index = 0; index < size; index += 1) {
      const childPath = `${path}[${index}]`
      if (index >= actual.length) {
        rows.push({ path: childPath, kind: "added", desired: desired[index] })
      } else if (index >= desired.length) {
        rows.push({ path: childPath, kind: "removed", actual: actual[index] })
      } else {
        rows.push(...collectJsonDiff(desired[index], actual[index], childPath))
      }
    }
    return rows
  }
  return [{ path, kind: "changed", desired, actual }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonEquivalent(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function formatJsonDiffValue(value: unknown) {
  if (value === undefined) {
    return "-"
  }
  if (typeof value === "string") {
    return value
  }
  return JSON.stringify(value)
}

function ChannelSyncBadge({ status }: { status: string }) {
  if (status === "synced") {
    return <Badge>已发布</Badge>
  }
  if (status === "pending") {
    return <Badge variant="secondary">待发布</Badge>
  }
  if (status === "drift") {
    return <Badge variant="destructive">配置不同</Badge>
  }
  if (status === "error" || status === "conflict") {
    return <Badge variant="destructive">失败</Badge>
  }
  return <Badge variant="outline">{status || "未知"}</Badge>
}

export function TenantManagementPage({
  api,
  sets,
  initialUserID = "",
}: {
  api: LLMGatewayAPI
  sets: GatewaySet[]
  initialUserID?: string
}) {
  const [keyword, setKeyword] = useState(initialUserID)
  const [backend, setBackend] = useState("")
  const [setID, setSetID] = useState("")
  const [cursor, setCursor] = useState("")
  const [cursorStack, setCursorStack] = useState<string[]>([])

  useEffect(() => {
    setCursor("")
    setCursorStack([])
  }, [keyword, backend, setID])

  const tenantsQuery = useQuery({
    queryKey: ["tenants", keyword, backend, setID, cursor],
    queryFn: () =>
      api.listTenants({
        keyword,
        backend,
        set_id: setID,
        cursor,
        limit: 50,
        include_total: false,
      }),
    placeholderData: keepPreviousData,
  })
  const statisticsQuery = useQuery({
    queryKey: ["tenant-statistics"],
    queryFn: () => api.getTenantStatistics(),
  })
  const tenants = tenantsQuery.data?.items || []
  const selectedTenant = tenants.find((tenant) => tenant.user_id === initialUserID) || tenants[0]
  const statistics = statisticsQuery.data
  const nextCursor = tenantsQuery.data?.next_cursor || ""
  const canGoPrevious = cursorStack.length > 0
  const canGoNext = nextCursor !== ""

  function goToNextTenantPage() {
    if (!nextCursor) {
      return
    }
    setCursorStack((stack) => [...stack, cursor])
    setCursor(nextCursor)
  }

  function goToPreviousTenantPage() {
    if (cursorStack.length === 0) {
      return
    }
    setCursor(cursorStack[cursorStack.length - 1] || "")
    setCursorStack(cursorStack.slice(0, -1))
  }

  if (initialUserID) {
    return (
      <div className="flex flex-1 flex-col gap-4 overflow-auto bg-muted/20 p-4 md:p-6">
        <a href={consoleRouteForView("tenants")} className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" />返回租户列表
        </a>
        <TenantDetailPanel api={api} tenant={selectedTenant} onChanged={() => tenantsQuery.refetch()} fullPage />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-muted/20 p-4 md:p-6">
      <DashboardSection title="租户" description="查询租户、查看当前套餐和积分">
        <Card className="min-w-0 overflow-hidden shadow-none">
          <CardHeader className="border-b">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>租户列表</CardTitle>
                <CardDescription>
                  {statistics?.ready && statistics.total !== null ? (
                    <>
                      约 {formatNumber(statistics.total)} 位租户 · 统计于 {formatDateTime(statistics.generated_at || undefined)}
                      {statistics.stale ? " · 数据较旧" : ""}
                    </>
                  ) : statisticsQuery.error ? (
                    "租户数量暂不可用"
                  ) : (
                    "租户数量统计中"
                  )}
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={goToPreviousTenantPage} disabled={!canGoPrevious}>
                  上一页
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={goToNextTenantPage} disabled={!canGoNext}>
                  下一页
                </Button>
              </div>
            </div>
            <div className="grid gap-2 pt-3 md:grid-cols-[minmax(320px,520px)_240px]">
              <Input
                value={keyword}
                onChange={(event) => {
                  const value = event.target.value
                  setKeyword(value)
                  if (value) {
                    setBackend("")
                    setSetID("")
                  }
                }}
                placeholder="搜索用户 ID 或内部账号"
              />
              <div>
                <Input
                  value={setID}
                  list="tenant-set-options"
                  disabled={keyword !== ""}
                  onChange={(event) => {
                    setSetID(event.target.value)
                    if (event.target.value) setKeyword("")
                  }}
                  placeholder="所有集群"
                />
                <datalist id="tenant-set-options">
                  {sets.map((set) => <option key={set.id} value={set.id}>{set.name || set.id}</option>)}
                </datalist>
              </div>
            </div>
            <div className="pt-2 text-xs text-muted-foreground">
              {cursor ? "当前页" : "第一页"} · 显示 {tenants.length} 条 · 每页 50 条
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {tenantsQuery.error ? (
              <div className="p-4 text-sm text-destructive">{tenantsQuery.error.message}</div>
            ) : null}
            <TenantTable tenants={tenants} loading={tenantsQuery.isLoading} />
          </CardContent>
        </Card>
      </DashboardSection>
    </div>
  )
}

function TenantTable({
  tenants,
  loading,
}: {
  tenants: TenantSummary[]
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <div className="h-12 rounded-lg bg-muted" />
        <div className="h-12 rounded-lg bg-muted" />
        <div className="h-12 rounded-lg bg-muted" />
      </div>
    )
  }
  if (tenants.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">没有匹配的租户。</div>
  }
  return (
    <Table className="min-w-[960px] table-fixed">
        <colgroup>
          <col className="w-[200px]" />
          <col className="w-[135px]" />
          <col className="w-[170px]" />
          <col className="w-[120px]" />
          <col className="w-[100px]" />
          <col className="w-[55px]" />
          <col className="w-[180px]" />
        </colgroup>
        <TableHeader className="text-xs text-muted-foreground">
          <TableRow>
            <TableHead className="px-4">租户</TableHead>
            <TableHead className="px-4">服务集群</TableHead>
            <TableHead className="px-4">当前套餐</TableHead>
            <TableHead className="px-4">可用积分</TableHead>
            <TableHead className="px-4">权益状态</TableHead>
            <TableHead className="px-4">密钥</TableHead>
            <TableHead className="px-4">最近更新</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tenants.map((tenant) => {
            const detailHref = `/admin/tenants/${encodeURIComponent(tenant.user_id)}`
            const openDetail = () => {
              if (typeof window !== "undefined") {
                window.location.assign(detailHref)
              }
            }
            return (
            <TableRow
              key={tenant.user_id}
              role="link"
              tabIndex={0}
              aria-label={`查看租户 ${tenant.user_id}`}
              className="group h-16 cursor-pointer"
              onClick={openDetail}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  openDetail()
                }
              }}
            >
              <TableCell className="px-4 py-3 align-middle">
                <a
                  href={detailHref}
                  onClick={(event) => event.stopPropagation()}
                  className="flex min-w-0 flex-col gap-0.5 hover:underline"
                >
                  <span className="truncate font-medium leading-5">{tenant.display_name || tenant.user_id}</span>
                  <span className="truncate text-xs leading-4 text-muted-foreground">
                    {tenant.display_name ? tenant.user_id : tenant.username || tenant.source || tenant.assignment_status}
                  </span>
                </a>
              </TableCell>
              <TableCell className="px-4 py-3 align-middle">
                <span className="block truncate">{tenant.set_id || "-"}</span>
              </TableCell>
              <TableCell className="px-4 py-3 align-middle">
                <span className="block truncate">{tenant.observed_plan_id || tenant.last_plan_id || "-"}</span>
              </TableCell>
              <TableCell className="px-4 py-3 align-middle">
                {tenant.observed_at ? (
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-semibold leading-5 tabular-nums">{formatNumber(tenant.observed_credit_available || 0)}</span>
                    <span className="truncate text-xs leading-4 text-muted-foreground">
                      {friendlyCreditStatus(tenant.observed_credit_status || "unknown")}
                    </span>
                  </div>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell className="px-4 py-3 align-middle">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-medium leading-5">{friendlyTenantStatus(tenant.status)}</span>
                  <span className="truncate text-xs leading-4 text-muted-foreground">{friendlySubscriptionStatus(tenant.observed_subscription_status)}</span>
                </div>
              </TableCell>
              <TableCell className="px-4 py-3 align-middle tabular-nums">{tenant.key_count}</TableCell>
              <TableCell className="px-4 py-3 align-middle">
                <div className="flex items-center justify-between gap-2">
                  <span className="block min-w-0 truncate text-xs text-muted-foreground">{formatDateTime(tenant.updated_at)}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </div>
              </TableCell>
            </TableRow>
          )})}
        </TableBody>
      </Table>
  )
}

function TenantDetailPanel({
  api,
  tenant,
  onChanged,
  fullPage = false,
}: {
  api: LLMGatewayAPI
  tenant?: TenantSummary
  onChanged: () => Promise<unknown>
  fullPage?: boolean
}) {
  const userID = tenant?.user_id || ""
  const queryClient = useQueryClient()
  const [showFullDetail] = useState(fullPage)
  const [showDeletion, setShowDeletion] = useState(false)
  const [deletionConfirm, setDeletionConfirm] = useState("")
  const [deletionJob, setDeletionJob] = useState<TenantDeletionJob>()
  const detailQuery = useQuery({
    queryKey: ["tenant-detail", userID],
    queryFn: () => api.getTenantDetail(userID),
    enabled: userID !== "" && showFullDetail,
  })
  const createKey = useMutation({
    mutationFn: () => api.createExternalKey(userID),
    onSuccess: async () => {
      await Promise.all([
        onChanged(),
        queryClient.invalidateQueries({ queryKey: ["tenant-detail", userID] }),
      ])
    },
  })
  const observeTenant = useMutation({
    mutationFn: () => api.observeTenant(userID),
    onSuccess: (observation) => {
      queryClient.invalidateQueries({ queryKey: ["tenant-detail", userID] })
      onChanged()
    },
  })
  const syncBYOK = useMutation({
    mutationFn: () => api.runTenantAction(userID, "sync-byok"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tenant-detail", userID] }),
  })
  const previewDeletion = useMutation({
    mutationFn: () => api.previewTenantDeletion({ user_ids: [userID] }),
    onSuccess: setDeletionJob,
  })
  const refreshDeletion = useMutation({
    mutationFn: () => api.getTenantDeletion(deletionJob?.id || ""),
    onSuccess: setDeletionJob,
  })
  const startDeletion = useMutation({
    mutationFn: () => {
      if (!deletionJob) {
        throw new Error("请先核对删除范围")
      }
      return api.startTenantDeletion(deletionJob.id, {
        expected_target_count: deletionJob.target_count,
        expected_target_digest: deletionJob.target_digest,
        idempotency_key: operationKey("tenant-delete", userID),
      })
    },
    onSuccess: async (job) => {
      setDeletionJob(job)
      await Promise.all([
        onChanged(),
        queryClient.invalidateQueries({ queryKey: ["tenant-deletions"] }),
        queryClient.invalidateQueries({ queryKey: ["tenant-statistics"] }),
      ])
    },
  })

  useEffect(() => {
    setShowDeletion(false)
    setDeletionConfirm("")
    setDeletionJob(undefined)
  }, [userID])

  if (!tenant) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>未选择租户</CardTitle>
          <CardDescription>从列表选择一个租户查看详情。</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className={cn("min-w-0 shadow-none", fullPage && "mx-auto w-full max-w-5xl")}>
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">{tenant.display_name || tenant.user_id}</CardTitle>
            <CardDescription className="truncate">
              {tenant.display_name ? tenant.user_id : tenant.username || tenant.source || tenant.assignment_status}
            </CardDescription>
          </div>
          <TenantStatusBadge status={tenant.status} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-4">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <StateField label="集群" value={tenant.set_id || "-"} />
          <StateField label="最近套餐" value={tenant.observed_plan_id || tenant.last_plan_id || "-"} />
          <StateField label="密钥" value={String(tenant.key_count)} />
          <StateField label="状态" value={friendlyTenantStatus(tenant.status)} />
        </div>
        {tenant.last_provision_error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            {tenant.last_provision_error}
          </p>
        ) : null}

        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">最近刷新</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">{formatDateTime(tenant.observed_at)}</div>
            </div>
            <CreditStatusBadge status={tenant.observed_credit_status || "unavailable"} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <StateField label="快照套餐" value={tenant.observed_plan_id || "-"} />
            <StateField label="可用积分" value={formatNumber(tenant.observed_credit_available || 0)} />
          </div>
        </div>

        <Button type="button" variant="outline" onClick={() => observeTenant.mutate()} disabled={observeTenant.isPending || userID === ""}>
          {observeTenant.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          刷新观测
        </Button>
        {observeTenant.error ? <p className="text-sm text-destructive">{observeTenant.error.message}</p> : null}

        {!fullPage ? (
          <Button asChild type="button" variant="outline">
            <a href={`/admin/tenants/${encodeURIComponent(userID)}`}><Activity />查看完整详情</a>
          </Button>
        ) : null}

        <details className="rounded-md border bg-muted/20">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">更多操作</summary>
          <div className="grid gap-2 border-t p-3 sm:grid-cols-2">
            <Button type="button" variant="outline" onClick={() => syncBYOK.mutate()} disabled={syncBYOK.isPending || userID === ""}>
              {syncBYOK.isPending ? <Loader2 className="animate-spin" /> : <SlidersHorizontal />}
              重新同步 BYOK
            </Button>
            <Button type="button" variant="outline" onClick={() => createKey.mutate()} disabled={createKey.isPending || userID === ""}>
              {createKey.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
              签发密钥
            </Button>
          </div>
        </details>
        {syncBYOK.error ? <p className="text-sm text-destructive">{syncBYOK.error.message}</p> : null}
        {createKey.error ? <p className="text-sm text-destructive">{createKey.error.message}</p> : null}
        {createKey.data ? (
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-xs">
            <div className="font-medium">新访问密钥</div>
            <code className="break-all rounded-lg bg-background p-2">{createKey.data.external_key}</code>
            <div className="text-muted-foreground">归属集群：{createKey.data.set_id}</div>
          </div>
        ) : null}

        {showFullDetail ? <TenantFullDetail detail={detailQuery.data} loading={detailQuery.isLoading} error={detailQuery.error?.message} /> : null}

        <div className="border-t pt-4">
          {!showDeletion ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setShowDeletion(true)
                previewDeletion.mutate()
              }}
              disabled={tenant.status === "deleting" || tenant.status === "deleted"}
            >
              <Trash2 />
              删除用户
            </Button>
          ) : (
            <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div>
                  <div className="text-sm font-medium">永久删除 {userID}</div>
                  <p className="mt-1 text-xs text-muted-foreground">将停止该用户流量，并清理访问密钥、BYOK、订阅投影和 new-api 用户。此操作不可恢复。</p>
                </div>
              </div>
              {previewDeletion.isPending ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="animate-spin" />正在核对删除范围</div>
              ) : deletionJob ? (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <StateField label="影响用户" value={formatNumber(deletionJob.target_count || 0)} />
                  <StateField label="当前状态" value={friendlyDeletionStatus(deletionJob.status)} />
                </div>
              ) : null}
              {deletionJob && deletionJob.status !== "previewed" && deletionJob.status !== "queued" && deletionJob.status !== "running" && deletionJob.status !== "succeeded" ? (
                <Button type="button" size="sm" variant="outline" onClick={() => refreshDeletion.mutate()} disabled={refreshDeletion.isPending}>
                  {refreshDeletion.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  刷新核对结果
                </Button>
              ) : null}
              {deletionJob?.status === "previewed" ? (
                <>
                  <Field label={`输入 ${userID} 确认`}>
                    <Input value={deletionConfirm} onChange={(event) => setDeletionConfirm(event.target.value)} autoComplete="off" />
                  </Field>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => startDeletion.mutate()}
                    disabled={deletionConfirm !== userID || startDeletion.isPending}
                  >
                    {startDeletion.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    确认永久删除
                  </Button>
                </>
              ) : null}
              {deletionJob && ["queued", "running", "succeeded"].includes(deletionJob.status) ? (
                <p className="text-xs text-muted-foreground">删除任务已提交，可到“自动任务”查看进度。</p>
              ) : null}
              {previewDeletion.error || refreshDeletion.error || startDeletion.error ? (
                <p className="text-xs text-destructive">{previewDeletion.error?.message || refreshDeletion.error?.message || startDeletion.error?.message}</p>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowDeletion(false)
                  setDeletionConfirm("")
                }}
                disabled={startDeletion.isPending}
              >
                取消
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function TenantFullDetail({
  detail,
  loading,
  error,
}: {
  detail?: TenantDetail
  loading: boolean
  error?: string
}) {
  if (loading) {
    return <div className="h-36 rounded-lg bg-muted" />
  }
  if (error) {
    return <p className="text-sm text-destructive">{error}</p>
  }
  if (!detail) {
    return null
  }
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">完整详情</div>
          <p className="mt-1 text-xs text-muted-foreground">本地投影、访问密钥、BYOK 和最近错误</p>
        </div>
        <Badge variant="secondary">{detail.keys?.length || 0} 个密钥</Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <StateField label="服务线路" value={friendlySource(detail.tenant.backend)} />
        <StateField label="当前集群" value={detail.tenant.set_id || "-"} />
        <StateField label="当前套餐" value={detail.observation?.current_plan_id || detail.tenant.observed_plan_id || "-"} />
        <StateField label="可用积分" value={formatNumber(detail.observation?.credit_available || detail.tenant.observed_credit_available || 0)} />
      </div>
      {detail.keys && detail.keys.length > 0 ? (
        <div className="mt-3 rounded-lg border bg-background p-2">
          <div className="text-xs font-medium">访问密钥摘要</div>
          <div className="mt-2 flex flex-col gap-1">
            {detail.keys.slice(0, 4).map((key) => (
              <div key={key.external_key_id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono">{key.external_key_id}</span>
                <span className="text-muted-foreground">{key.key_hash_prefix || "-"}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {detail.recent_errors && detail.recent_errors.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {detail.recent_errors.map((item) => (
            <div key={`${item.kind}:${item.message}`} className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
              {item.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function tenantObservationToUserState(observation: TenantObservation): UserState {
  return {
    user_id: observation.user_id,
    backend: observation.backend,
    set_id: observation.set_id,
    upstream_user_id: observation.upstream_user_id,
    username: observation.username,
    current_plan_id: observation.current_plan_id,
    last_applied_plan_id: observation.last_applied_plan_id,
    subscription_status: observation.subscription_status,
    has_active_subscription: observation.has_active_subscription,
    token_balance: observation.token_balance,
    credit_available: observation.credit_available,
    credit_status: observation.credit_status,
    credit_error: observation.credit_error,
    unlimited: observation.unlimited,
    period_start: observation.period_start,
    period_end: observation.period_end,
    source: observation.source,
  }
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode
  label: string
  value: string
  detail: string
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-0">
        <CardTitle className="truncate text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <div className="shrink-0 text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="truncate text-2xl font-bold tracking-normal">{value}</div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

function UserStateSummary({ state }: { state: UserState }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{state.user_id}</div>
          <div className="truncate text-xs text-muted-foreground">{state.username || "暂无内部账号"}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <BackendBadge backend={state.backend} />
          <CreditStatusBadge status={state.credit_status} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <StateField label="集群" value={state.set_id || "-"} />
        <StateField label="当前套餐" value={state.current_plan_id || "-"} />
        <StateField label="最近开通" value={state.last_applied_plan_id || "-"} />
        <StateField label="订阅状态" value={friendlySubscriptionStatus(state.subscription_status)} />
        <StateField label="可用积分" value={formatNumber(state.credit_available)} />
        <StateField label="剩余额度" value={state.unlimited ? "不限量" : formatNumber(state.token_balance)} />
        <StateField label="来源" value={friendlySource(state.source || "-")} />
        <StateField label="内部用户" value={state.upstream_user_id ? `#${state.upstream_user_id}` : "-"} />
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <StateField label="周期开始" value={formatDateTime(state.period_start)} />
        <StateField label="周期结束" value={formatDateTime(state.period_end)} />
      </div>
      {state.credit_error ? <p className="text-xs text-destructive">{state.credit_error}</p> : null}
    </div>
  )
}

function StateField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-l-2 border-border py-1 pl-3">
      <div className="truncate text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-medium">{value}</div>
    </div>
  )
}

function BackendBadge({ backend }: { backend: string }) {
  if (backend === "new") {
    return <Badge>Set 承载</Badge>
  }
  if (backend === "pending") {
    return <Badge variant="secondary">待开通</Badge>
  }
  return <Badge variant="outline">{backend || "未知"}</Badge>
}

function TenantStatusBadge({ status }: { status: string }) {
  if (status === "active") {
    return <Badge variant="outline">正常</Badge>
  }
  if (status === "disabled") {
    return <Badge variant="secondary">停用</Badge>
  }
  if (status === "deleted") {
    return <Badge variant="destructive">已删除</Badge>
  }
  return <Badge variant="outline">{status || "未知"}</Badge>
}

function CreditStatusBadge({ status }: { status: string }) {
  if (status === "ok") {
    return <Badge>积分正常</Badge>
  }
  if (status === "error") {
    return <Badge variant="destructive">积分异常</Badge>
  }
  if (status === "unavailable") {
    return <Badge variant="outline">未刷新</Badge>
  }
  return <Badge variant="outline">{friendlyCreditStatus(status)}</Badge>
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value || 0)
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) {
    return "-"
  }
  return `${Math.round(value * 1000) / 10}%`
}

function formatDurationSeconds(value: number) {
  const total = Math.max(0, Math.floor(value || 0))
  if (total === 0) {
    return "0秒"
  }
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) {
    return `${hours}时${minutes}分`
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`
  }
  return `${seconds}秒`
}

function formatDateTime(value?: string) {
  if (!value) {
    return "-"
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  if (date.getUTCFullYear() < 2000) {
    return "-"
  }
  return date.toLocaleString()
}

function shortText(value: string, size: number) {
  if (value.length <= size) {
    return value
  }
  return `${value.slice(0, size)}...`
}

function formatTimeOnly(value?: string) {
  if (!value) {
    return "-"
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleTimeString()
}

function friendlyAlertKind(kind: string) {
  switch (kind) {
    case "set_reconcile_error":
      return "集群纳管失败"
    case "set_provision_error":
      return "扩容创建失败"
    case "set_unready":
      return "集群不可用"
    case "channel_drift":
      return "渠道存在漂移"
    case "channel_sync_error":
      return "渠道同步失败"
    case "worker_job_error":
      return "后台任务失败"
    case "byok_sync_backlog":
      return "BYOK 队列积压"
    case "byok_sync_error":
      return "BYOK 同步失败"
    case "byok_sync_expired_lease":
      return "BYOK 租约过期"
    default:
      return kind || "告警"
  }
}

function friendlySeverity(severity: string) {
  if (severity === "critical") return "紧急"
  if (severity === "warning") return "提醒"
  return severity || "提示"
}

function friendlyJobName(name: string) {
  switch (name) {
    case "refresh_tenant_observations":
      return "刷新租户观测"
    case "check_channel_drift":
      return "渠道差异检查"
    case "sync_plans":
      return "下发权益模板"
    case "refresh_tenant_statistics":
      return "统计租户数量"
	case "rebuild_api_key_routes":
		return "恢复密钥路由"
    case "reconcile_set_facts":
      return "消费 Set 事实"
    case "retry_byok_sync":
      return "重试 BYOK 同步"
    case "cleanup_pending":
      return "清理过期待处理"
    default:
      return name || "后台任务"
  }
}

function friendlyJobStatus(status?: string) {
  switch (status) {
    case "running":
      return "运行中"
    case "success":
      return "成功"
    case "error":
      return "失败"
    case "idle":
      return "待运行"
    default:
      return status || "待运行"
  }
}

const resourceCopy: Record<string, { label: string; description: string }> = {
  tenants: { label: "租户承载", description: "用户在 new-api Set 中的开通与承载状态" },
  sets: { label: "集群", description: "已纳管的模型服务集群" },
  shards: { label: "Shard", description: "数据库分片和连接预算" },
  user_bindings: { label: "用户绑定", description: "用户在集群中的开通进度" },
  api_key_bindings: { label: "密钥绑定", description: "访问密钥和归属用户" },
  plans: { label: "权益模板", description: "平台不可变的周期订阅权益" },
  set_plans: { label: "集群下发", description: "权益模板在各服务集群的下发状态" },
  channel_specs: { label: "模型渠道", description: "模型服务的本地配置" },
  channel_sync_states: { label: "发布状态", description: "每个集群的渠道发布结果" },
  tenant_observations: { label: "权益快照", description: "最近一次刷新到的套餐和积分" },
  subscription_period_overlays: { label: "周期修正", description: "续费周期的对齐记录" },
}

const columnCopy: Record<string, string> = {
  id: "编号",
  user_id: "用户 ID",
  external_user_id: "用户 ID",
  external_key_id: "密钥 ID",
  external_key_hash: "密钥摘要",
  set_id: "集群",
  backend: "服务线路",
  status: "状态",
  source: "来源",
  display_name: "显示名",
  name: "名称",
  base_url: "服务地址",
  setup: "初始化",
  admin_user_id: "管理员",
  admin_username: "管理员账号",
  admin_role: "管理员角色",
  admin_status: "管理员状态",
  admin_group: "管理员分组",
  admin_access_token: "管理员密钥",
  shard_id: "Shard",
  newapi_replicas: "服务副本",
  sql_max_open_conns: "最大连接",
  sql_max_idle_conns: "空闲连接",
  admission_status: "准入状态",
  admission_error: "准入错误",
  admission_checked_at: "准入检查时间",
  kind: "类型",
  endpoint: "地址",
  max_connections: "最大连接预算",
  reserved_connections: "保留连接",
  warn_ratio: "预警线",
  critical_ratio: "危险线",
  upstream_user_id: "内部用户",
  username: "内部账号",
  password: "密码",
  last_plan_id: "最近套餐",
  last_extended_period_end: "最近续费到期",
  provision_status: "开通进度",
  last_provision_error: "最近错误",
  upstream_key: "内部密钥",
  upstream_key_id: "内部密钥 ID",
  monthly_tokens: "周期额度",
  quota_reset_period: "额度重置周期",
  quota_reset_custom_seconds: "自定义周期秒数",
  is_active: "是否启用",
  upstream_plan_id: "内部套餐",
  plan_id: "权益模板",
  attempts: "尝试次数",
  synced_at: "完成时间",
  type: "类型",
  key_hash: "密钥摘要",
  models: "模型列表",
  group: "分组",
  model_mapping: "模型别名",
  priority: "优先级",
  weight: "权重",
  remark: "备注",
  fingerprint: "配置指纹",
  desired_remote_name: "远端名称",
  channel_id: "渠道 ID",
  remote_channel_id: "远端记录",
  last_error: "最近错误",
  desired_fingerprint: "目标配置",
  applied_fingerprint: "已发布配置",
  remote_fingerprint: "远端配置",
  last_applied_key_hash: "已发布密钥",
  last_synced_at: "发布时间",
  last_checked_at: "检查时间",
  current_plan_id: "当前套餐",
  subscription_status: "订阅状态",
  has_active_subscription: "是否有权益",
  token_balance: "剩余额度",
  credit_available: "可用积分",
  credit_status: "积分状态",
  credit_error: "积分错误",
  unlimited: "不限量",
  period_start: "周期开始",
  period_end: "周期结束",
  observed_at: "刷新时间",
  created_at: "创建时间",
  updated_at: "更新时间",
}

const actionCopy: Record<string, string> = {
  enable: "启用",
  disable: "停用",
  delete: "标记删除",
  route_new: "分配到集群",
  drain: "停止接新流量",
  bootstrap: "初始化",
  clear_error: "清除错误",
}

function friendlyResourceLabel(resource?: ResourceDefinition) {
  if (!resource) {
    return "数据对象"
  }
  return resourceCopy[resource.id]?.label || resource.label || resource.id
}

function friendlyResourceDescription(resource?: ResourceDefinition) {
  if (!resource) {
    return "选择要查看的对象"
  }
  return resourceCopy[resource.id]?.description || resource.description || "安全白名单对象"
}

function friendlyColumnLabel(key: string, fallback?: string) {
  return columnCopy[key] || fallback || key
}

function friendlyActionLabel(id: string, fallback?: string) {
  return actionCopy[id] || fallback || id
}

function friendlySource(value?: string) {
  switch (value) {
    case "new-api":
      return "new-api"
    case "pending":
      return "待开通"
    case "assignment":
      return "人工分配"
    case "tenant":
      return "租户主表"
    case "bound_unassigned":
      return "已分配待开通"
    default:
      return value || "-"
  }
}

function friendlyAssignmentStatus(value?: string) {
  switch (value) {
    case "explicit":
      return "已明确分配"
    case "bound_unassigned":
      return "已分配待开通"
    case "tenant":
      return "按租户记录"
    default:
      return value || "-"
  }
}

function friendlyProvisionStatus(value?: string) {
  switch (value) {
    case "allocated":
      return "已分配集群"
    case "user_ready":
      return "用户已开通"
    case "token_ready":
      return "密钥已就绪"
    case "failed":
      return "开通失败"
    default:
      return value || "-"
  }
}

function friendlyTenantStatus(value?: string) {
  switch (value) {
    case "active":
      return "正常"
    case "disabled":
      return "停用"
    case "deleted":
      return "已删除"
    default:
      return value || "-"
  }
}

function friendlyCreditStatus(value?: string) {
  switch (value) {
    case "ok":
      return "积分正常"
    case "error":
      return "积分异常"
    case "unavailable":
      return "未刷新"
    case "not_found":
      return "未找到"
    case "unknown":
      return "未知"
    default:
      return value || "未知"
  }
}

function friendlySubscriptionStatus(value?: string) {
  switch (value) {
    case "active":
      return "有效"
    case "cancelled":
    case "canceled":
      return "已取消"
    case "expired":
      return "已过期"
    case "inactive":
      return "未生效"
    case "":
    case undefined:
      return "无订阅"
    default:
      return value
  }
}

function friendlyDeletionStatus(status?: string) {
  switch (status) {
    case "materializing":
      return "正在核对"
    case "previewed":
      return "等待确认"
    case "claiming":
      return "正在冻结"
    case "queued":
    case "pending":
      return "等待执行"
    case "running":
      return "正在清理"
    case "purging_tenants":
      return "正在撤销用户访问"
    case "removing_runtime":
      return "正在移除运行实例"
    case "cleaning_runtime":
      return "正在清理存储"
    case "finalizing":
    case "cleanup_ack_pending":
      return "正在收尾"
    case "paused":
      return "已暂停"
    case "partial":
      return "部分失败"
    case "error":
      return "失败"
    case "cancelled":
      return "已取消"
    case "succeeded":
      return "已完成"
    default:
      return status || "未知"
  }
}

function DeletionStatusBadge({ status }: { status: string }) {
  const variant = status === "error" || status === "partial" ? "destructive" : status === "succeeded" ? "outline" : "secondary"
  return <Badge variant={variant}>{friendlyDeletionStatus(status)}</Badge>
}

function setDecommissionBlockerTotal(blockers: SetDecommissionPreview["blockers"]) {
  return Object.entries(blockers).reduce((total, [key, value]) => key === "runtime_leases" ? total : total + (Number(value) || 0), 0)
}

function operationKey(operation: string, resourceID: string) {
  const entropy = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)
  return `${operation}:${resourceID}:${entropy}`
}

function formatResourceValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-"
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否"
  }
  if (typeof value === "object") {
    return JSON.stringify(value)
  }
  return String(value)
}

function resourceValueToInput(value: unknown) {
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "object") {
    return JSON.stringify(value)
  }
  return String(value)
}

function SetList({
  api,
  sets,
  loading,
  selectedSetID,
  onSelect,
  onChanged,
}: {
  api: LLMGatewayAPI
  sets: GatewaySet[]
  loading: boolean
  selectedSetID: string
  onSelect: (id: string) => void
  onChanged: () => Promise<unknown>
}) {
  const queryClient = useQueryClient()
  const [decommissionSetID, setDecommissionSetID] = useState("")
  const [decommissionConfirm, setDecommissionConfirm] = useState("")
  const [decommissionPreview, setDecommissionPreview] = useState<SetDecommissionPreview>()
  const decommissionsQuery = useQuery({
    queryKey: ["set-decommissions"],
    queryFn: () => api.listSetDecommissions(),
  })
  const previewDecommission = useMutation({
    mutationFn: (setID: string) => api.previewSetDecommission(setID),
    onSuccess: setDecommissionPreview,
  })
  const startDecommission = useMutation({
    mutationFn: () => {
      if (!decommissionPreview) {
        throw new Error("请先核对集群是否为空")
      }
      const set = sets.find((candidate) => candidate.id === decommissionPreview.set_id)
      const runtimeLeases = Number(decommissionPreview.blockers.runtime_leases) || 0
      const allowOrphan = runtimeLeases === 0
      return api.startSetDecommission({
        set_id: decommissionPreview.set_id,
        expected_digest: decommissionPreview.digest,
        idempotency_key: operationKey("set-decommission", decommissionPreview.set_id),
        cascade_tenants: !decommissionPreview.empty || allowOrphan,
        allow_orphan: allowOrphan && set?.status === "disabled",
      })
    },
    onSuccess: async () => {
      setDecommissionConfirm("")
      setDecommissionSetID("")
      setDecommissionPreview(undefined)
      await Promise.all([
        onChanged(),
        queryClient.invalidateQueries({ queryKey: ["set-decommissions"] }),
      ])
    },
  })
  const cancelDecommission = useMutation({
    mutationFn: (job: SetDecommissionJob) => api.cancelSetDecommission(job.id, {
      expected_version: job.version,
      idempotency_key: operationKey("set-decommission-cancel", job.id),
    }),
    onSuccess: async () => {
      setDecommissionSetID("")
      setDecommissionPreview(undefined)
      await Promise.all([
        onChanged(),
        queryClient.invalidateQueries({ queryKey: ["set-decommissions"] }),
      ])
    },
  })
  const retryDecommission = useMutation({
    mutationFn: (job: SetDecommissionJob) => api.retrySetDecommission(job.id, {
      expected_version: job.version,
      idempotency_key: operationKey("set-decommission-retry", job.id),
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["set-decommissions"] })
    },
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>集群列表</CardTitle>
            <CardDescription>{sets.length} 个自动管理的服务集群</CardDescription>
          </div>
          <Badge variant="secondary">自动管理</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          {loading ? (
            <div className="flex flex-col gap-2">
              <div className="h-16 rounded-md bg-muted" />
              <div className="h-16 rounded-md bg-muted" />
            </div>
          ) : null}
          {sets.map((set) => {
            const job = (decommissionsQuery.data || []).find((candidate) =>
              candidate.set_id === set.id && !["succeeded", "cancelled"].includes(candidate.status),
            )
            const showingPreview = decommissionSetID === set.id
            const previewForSet = decommissionPreview?.set_id === set.id ? decommissionPreview : undefined
            const runtimeLeases = Number(previewForSet?.blockers.runtime_leases) || 0
            const hasConflictingOperations = Boolean(
              (Number(previewForSet?.blockers.active_operation_leases) || 0) > 0 ||
              (Number(previewForSet?.blockers.deletion_targets) || 0) > 0,
            )
            const orphanCleanup = Boolean(previewForSet && runtimeLeases === 0)
            const safeEmptyCleanup = Boolean(previewForSet?.empty && runtimeLeases === 1)
            const canStartCleanup = Boolean(
              previewForSet &&
              !hasConflictingOperations &&
              (runtimeLeases === 1 || (orphanCleanup && set.status === "disabled")),
            )
            return (
            <div
              key={set.id}
              className={cn(
                "flex flex-col gap-3 rounded-md border bg-card p-3 transition-colors hover:bg-accent",
                selectedSetID === set.id && "border-primary bg-accent",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(set.id)} type="button">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold">{set.name || set.id}</span>
                      <StatusBadge status={set.status} setup={set.setup} />
                      <AdmissionBadge status={set.admission_status} />
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{set.base_url}</div>
                    <div className="mt-2 text-xs text-muted-foreground">管理员 #{set.admin_user_id || "-"}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <CapacityStatusBadge status={capacityStatusFromSet(set)} accepting={acceptingFromSet(set)} />
                      <span>
                        {formatNumber(set.observed_user_count || 0)}
                        {set.max_users ? ` / ${formatNumber(set.max_users)}` : ""}
                      </span>
                      {set.reserved_users ? <span>预留 {formatNumber(set.reserved_users)}</span> : null}
                    </div>
                  </div>
                </button>
                {selectedSetID === set.id ? (
                  <details className="shrink-0 rounded-md border bg-background">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">更多操作</summary>
                    <div className="border-t p-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        type="button"
                        aria-label={`检查并销毁集群 ${set.name || set.id}`}
                        onClick={() => {
                          setDecommissionSetID(set.id)
                          setDecommissionConfirm("")
                          setDecommissionPreview(undefined)
                          previewDecommission.mutate(set.id)
                        }}
                        disabled={Boolean(job)}
                      >
                        <Trash2 />
                        销毁集群
                      </Button>
                    </div>
                  </details>
                ) : null}
              </div>
              {job ? (
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">注销任务进行中</span>
                    <DeletionStatusBadge status={job.status} />
                  </div>
                  {job.last_error ? <p className="text-destructive">{job.last_error}</p> : null}
                  {job.status === "pending" ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => cancelDecommission.mutate(job)} disabled={cancelDecommission.isPending}>
                      {cancelDecommission.isPending ? <Loader2 className="animate-spin" /> : null}
                      取消注销
                    </Button>
                  ) : null}
                  {job.status === "error" ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => retryDecommission.mutate(job)} disabled={retryDecommission.isPending}>
                      {retryDecommission.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      重新尝试注销
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {showingPreview ? (
                <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                  <div className="flex items-start gap-2">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <div>
                      <div className="text-sm font-medium">销毁 {set.name || set.id}</div>
                      <p className="mt-1 text-xs text-muted-foreground">先检查占用情况。销毁完成后，这个集群的专属数据库和 Redis 数据将无法恢复。</p>
                    </div>
                  </div>
                  {previewForSet ? (
                    <>
                      {safeEmptyCleanup ? (
                        <div className="rounded-lg border bg-background p-3 text-xs">检查通过：没有用户、密钥或后台任务占用这个集群。</div>
                      ) : hasConflictingOperations ? (
                        <div className="rounded-lg border bg-background p-3 text-xs text-destructive">
                          仍有用户删除任务或正在执行的操作。请等待任务结束后重新检查，系统不会并发强制销毁。
                        </div>
                      ) : runtimeLeases > 1 ? (
                        <div className="rounded-lg border bg-background p-3 text-xs text-destructive">
                          发现多份运行记录，无法确定应该清理哪份存储，已禁止销毁。
                        </div>
                      ) : orphanCleanup && set.status !== "disabled" ? (
                        <div className="rounded-lg border bg-background p-3 text-xs text-destructive">
                          这个集群缺少运行记录。请先将它停用，再以孤儿集群方式强制销毁。
                        </div>
                      ) : (
                        <div className="rounded-lg border border-destructive/30 bg-background p-3 text-xs text-destructive">
                          强制销毁会撤销这个集群中的全部用户访问，并清除 {formatNumber(setDecommissionBlockerTotal(previewForSet.blockers))} 项本地记录。不会逐个调用上游删除用户。
                        </div>
                      )}
                      <Field label={`输入 ${set.id} 确认`}>
                        <Input value={decommissionConfirm} onChange={(event) => setDecommissionConfirm(event.target.value)} autoComplete="off" />
                      </Field>
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => startDecommission.mutate()}
                        disabled={!canStartCleanup || decommissionConfirm !== set.id || startDecommission.isPending}
                      >
                        {startDecommission.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
                        {safeEmptyCleanup ? "确认注销" : "强制销毁"}
                      </Button>
                    </>
                  ) : previewDecommission.isPending ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="animate-spin" />正在检查集群占用</div>
                  ) : null}
                  {previewDecommission.error || startDecommission.error ? (
                    <p className="text-xs text-destructive">{previewDecommission.error?.message || startDecommission.error?.message}</p>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDecommissionSetID("")
                      setDecommissionPreview(undefined)
                      setDecommissionConfirm("")
                    }}
                  >
                    取消
                  </Button>
                </div>
              ) : null}
              {setConsoleAvailable(set) ? <SetConsoleDeepLinks set={set} /> : null}
            </div>
          )})}
          {!loading && sets.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              暂无服务集群。容量控制器会根据水位自动创建。
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

function SetConsoleDeepLinks({ set }: { set: GatewaySet }) {
  const title = set.name || set.id
  return (
    <div className="flex flex-wrap gap-1.5 border-t pt-2">
      {setConsoleLinks.map((link) => {
        const Icon = link.icon
        return (
          <Button
            key={link.path}
            asChild
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <a
              aria-label={link.ariaLabel(title)}
              href={consoleFrameURL(set.id, link.path)}
              rel="noreferrer"
              target="_blank"
            >
              <Icon />
              {link.label}
            </a>
          </Button>
        )
      })}
    </div>
  )
}

function setConsoleAvailable(set: GatewaySet) {
  return set.setup && set.status === "active"
}

export function SetWorkspace({
  api,
  set,
}: {
  api?: LLMGatewayAPI
  set: GatewaySet
}) {
  const consoleURL = consoleFrameURL(set.id)
  const [expanded, setExpanded] = useState(false)
  const title = set.name || set.id
  const consoleAvailable = setConsoleAvailable(set)

  return (
    <>
      <Card className="flex min-w-0 flex-col overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <CardTitle className="truncate text-base">{title}</CardTitle>
                <StatusBadge status={set.status} setup={set.setup} />
              </div>
              <CardDescription className="mt-1 truncate">{set.base_url}</CardDescription>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <AdmissionBadge status={set.admission_status} />
                {set.admission_error ? <Badge variant="destructive">准入失败</Badge> : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
	              <Button
	                aria-label="放大控制台"
	                title="放大控制台"
	                type="button"
	                variant="outline"
	                size="icon"
	                onClick={() => setExpanded(true)}
	                disabled={!consoleAvailable}
	              >
	                <Maximize2 />
	              </Button>
            </div>
          </div>
	        </CardHeader>
	        {api ? <SetUpgradePanel api={api} set={set} /> : null}
	        <CardContent className="min-h-0 flex-1 p-0">
	          {consoleAvailable ? (
	            <ConsoleFrame setID={set.id} src={consoleURL} className="h-[calc(100vh-18.5rem)] min-h-[650px]" />
	          ) : (
	            <UnavailableSetConsole set={set} />
	          )}
	        </CardContent>
	      </Card>
	      {expanded && consoleAvailable ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-sm font-semibold">{title}</h2>
                <StatusBadge status={set.status} setup={set.setup} />
              </div>
              <p className="truncate text-xs text-muted-foreground">{set.base_url}</p>
            </div>
            <Button
              aria-label="收起控制台"
              title="收起控制台"
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setExpanded(false)}
            >
              <Minimize2 />
            </Button>
          </div>
          <ConsoleFrame setID={set.id} src={consoleURL} className="min-h-0 flex-1" />
        </div>
      ) : null}
    </>
  )
}

function SetUpgradePanel({ api, set }: { api: LLMGatewayAPI; set: GatewaySet }) {
  const queryClient = useQueryClient()
  const [targetImage, setTargetImage] = useState("")
  const runsQuery = useQuery({
    queryKey: ["set-upgrade-runs", set.id],
    queryFn: () => api.listSetUpgradeRuns(set.id),
    refetchInterval: 5_000,
  })
  const runs = runsQuery.data || []
  const current = runs.find((run) => !["completed", "failed", "rolled_back"].includes(run.status)) || runs[0]
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["set-upgrade-runs", set.id] }),
      queryClient.invalidateQueries({ queryKey: ["sets"] }),
    ])
  }
  const createUpgrade = useMutation({
    mutationFn: () => api.createSetUpgrade({ set_ids: [set.id], target_image: targetImage.trim(), max_parallel: 1 }),
    onSuccess: async () => {
      setTargetImage("")
      await invalidate()
    },
  })
  const rollback = useMutation({
    mutationFn: (run: SetUpgradeRun) => api.rollbackSetUpgrade(run.id, "operator requested rollback"),
    onSuccess: invalidate,
  })
  const retry = useMutation({ mutationFn: (run: SetUpgradeRun) => api.retrySetUpgrade(run.id), onSuccess: invalidate })
  const error = createUpgrade.error?.message || rollback.error?.message || retry.error?.message || runsQuery.error?.message
  return (
    <div className="grid gap-3 border-b bg-muted/20 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <StateField label="当前镜像" value={shortImage(set.admin_image)} />
        <StateField label="运行代际" value={`g${set.active_runtime_generation ?? 0}`} />
        <StateField label="路由版本" value={String(set.route_revision ?? 0)} />
        <StateField label="升级状态" value={friendlyUpgradeStatus(current?.status)} />
        {current?.switched_at ? <StateField label="切流时间" value={formatDateTime(current.switched_at)} /> : null}
        {current?.drain_deadline ? <StateField label="排空截止" value={formatDateTime(current.drain_deadline)} /> : null}
        {current?.last_error ? <div className="col-span-2 text-destructive sm:col-span-4">{current.last_error}</div> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 gap-2">
          <Input
            aria-label="目标镜像 digest"
            placeholder="registry/new-api@sha256:..."
            value={targetImage}
            onChange={(event) => setTargetImage(event.target.value)}
            disabled={Boolean(current && !["completed", "failed", "rolled_back"].includes(current.status))}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => createUpgrade.mutate()}
            disabled={!targetImage.trim() || createUpgrade.isPending || Boolean(current && !["completed", "failed", "rolled_back"].includes(current.status))}
          >
            {createUpgrade.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
            升级
          </Button>
        </div>
        <div className="flex gap-2">
          {current?.status === "draining" ? (
            <Button type="button" size="sm" variant="outline" onClick={() => rollback.mutate(current)} disabled={rollback.isPending}>
              {rollback.isPending ? <Loader2 className="animate-spin" /> : <Route />}
              回滚
            </Button>
          ) : null}
          {current?.status === "failed" ? (
            <Button type="button" size="sm" variant="outline" onClick={() => retry.mutate(current)} disabled={retry.isPending}>
              {retry.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              重试
            </Button>
          ) : null}
          {error ? <span className="self-center truncate text-xs text-destructive">{error}</span> : null}
        </div>
      </div>
    </div>
  )
}

function friendlyUpgradeStatus(status?: string) {
  const labels: Record<string, string> = {
    pending: "等待执行", preparing: "准备新版本", probing: "验证新版本", switching: "发布路由",
    draining: "旧版本排空", rollback_switching: "回滚切流", rollback_draining: "新版本排空",
    upgrading_master: "升级管理节点", completed: "升级完成", failed: "升级失败", rolled_back: "已回滚",
  }
  return status ? labels[status] || status : "暂无任务"
}

function shortImage(image?: string) {
  if (!image) return "未记录"
  const digest = image.match(/@sha256:([a-f0-9]{8})/i)?.[1]
  return digest ? `${image.split("@")[0]}@${digest}` : image
}

function UnavailableSetConsole({ set }: { set: GatewaySet }) {
  return (
    <div className="grid h-[calc(100vh-18.5rem)] min-h-[650px] place-items-center bg-muted/20 p-6">
      <div className="max-w-sm text-center">
        <CircleDashed className="mx-auto mb-3 size-8 text-muted-foreground" />
        <h2 className="text-base font-semibold">集群控制台不可用</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          当前集群状态为 {set.status || "unknown"}，暂不打开原生控制台。自动控制器会继续检查初始化与准入状态。
        </p>
      </div>
    </div>
  )
}

function ConsoleFrame({ setID, src, className }: { setID: string; src: string; className?: string }) {
  return (
    <iframe
      title={`${setID} console`}
      src={src}
      className={cn("w-full border-0 bg-background", className)}
    />
  )
}

function EmptyWorkspace() {
  return (
    <div className="grid min-h-[650px] place-items-center rounded-lg border border-dashed bg-card">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <CircleDashed className="size-8 text-muted-foreground" />
        <div>
          <h2 className="text-base font-semibold">请选择一个集群</h2>
          <p className="text-sm text-muted-foreground">选择自动创建的存量 Set，即可查看原生控制台。</p>
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status, setup }: { status: string; setup: boolean }) {
  if (!setup) {
    return <Badge variant="outline">未初始化</Badge>
  }
  if (status === "active") {
    return <Badge>可用</Badge>
  }
  if (status === "draining") {
    return <Badge variant="secondary">排水中</Badge>
  }
  if (status === "disabled") {
    return <Badge variant="secondary">停用</Badge>
  }
  return <Badge variant="outline">{status || "未知"}</Badge>
}

function CapacityStatusBadge({ status, accepting }: { status?: string; accepting?: boolean }) {
  if (status === "full") {
    return <Badge variant="destructive">已满</Badge>
  }
  if (status === "warn") {
    return <Badge variant="secondary">接近上限</Badge>
  }
  if (status === "unlimited") {
    return <Badge variant="outline">不限量</Badge>
  }
  if (accepting === false) {
    return <Badge variant="secondary">暂停接人</Badge>
  }
  return <Badge variant="outline">可接人</Badge>
}

function RuntimeHAStatusBadge({ status, ready, desired }: { status?: string; ready?: number; desired?: number }) {
  if (!desired) {
    return null
  }
  if (status === "healthy") {
    return <Badge variant="outline">推理 {ready ?? desired}/{desired}</Badge>
  }
  if (status === "pending") {
    return <Badge variant="secondary">推理副本准备中</Badge>
  }
  return <Badge variant="destructive">推理 {ready ?? 0}/{desired}</Badge>
}

function AdmissionBadge({ status }: { status?: string }) {
  if (!status || status === "passed") {
    return <Badge variant="outline">准入通过</Badge>
  }
  if (status === "failed") {
    return <Badge variant="destructive">准入失败</Badge>
  }
  if (status === "checking") {
    return <Badge variant="secondary">检查中</Badge>
  }
  if (status === "pending") {
    return <Badge variant="secondary">待准入</Badge>
  }
  return <Badge variant="outline">{status}</Badge>
}

function ShardCapacityBadge({ status }: { status?: string }) {
  if (status === "critical") {
    return <Badge variant="destructive">连接紧张</Badge>
  }
  if (status === "warn") {
    return <Badge variant="secondary">接近上限</Badge>
  }
  if (status === "ok") {
    return <Badge variant="outline">余量正常</Badge>
  }
  return <Badge variant="outline">未设预算</Badge>
}

function capacityStatusFromSet(set: GatewaySet) {
  const maxUsers = set.max_users || 0
  const userCount = set.observed_user_count || 0
  const reservedUsers = set.reserved_users || 0
  if (maxUsers <= 0) {
    return "unlimited"
  }
  if (maxUsers - userCount - reservedUsers <= 0) {
    return "full"
  }
  if (set.warn_users && userCount >= set.warn_users) {
    return "warn"
  }
  return "ok"
}

function acceptingFromSet(set: GatewaySet) {
  const admitted = !set.admission_status || set.admission_status === "passed"
  return set.status === "active" && set.setup && admitted && capacityStatusFromSet(set) !== "full"
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}
